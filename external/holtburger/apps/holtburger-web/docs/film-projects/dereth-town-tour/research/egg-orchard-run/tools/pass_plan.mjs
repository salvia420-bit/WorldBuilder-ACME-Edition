#!/usr/bin/env node
// tools/pass_plan.mjs — run the pass-plan JEV task (tools/film/lib/jev_tasks.mjs planPasses) on the Egg Orchard
// pass input and write passes.json. Same task as `film jev task pass-plan --input=<json>` (once film.mjs lists it),
// but it writes the file and a JEV event log next to it.
//
//   node tools/pass_plan.mjs --input=data/pass_input.json --out=data/passes.code.json --code      (no key, free)
//   node tools/pass_plan.mjs --input=data/pass_input.json --out=data/passes.json [--batch]        (JEV when a key
//        exists: OPENROUTER_API_KEY or ~/.config/holtburger-film/openrouter.key; else the code rule)
//
// --code never resolves (reads) the key. Exit 2 on a fatal JEV error (auth/credits/config), 0 otherwise.
import fs from "node:fs";
import path from "node:path";

const REPO = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web";
const { planPasses } = await import(path.join(REPO, "tools/film/lib/jev_tasks.mjs"));
const { createJevClient, resolveJevKey, JevError } = await import(path.join(REPO, "tools/film/lib/jev.mjs"));

const args = Object.fromEntries(process.argv.slice(2).map((a) => {
  const m = /^--([^=]+)(?:=(.*))?$/.exec(a);
  return m ? [m[1], m[2] ?? true] : [a, true];
}));
const here = path.dirname(path.dirname(new URL(import.meta.url).pathname));
const inputPath = path.resolve(here, args.input ?? "data/pass_input.json");
const outPath = path.resolve(here, args.out ?? (args.code ? "data/passes.code.json" : "data/passes.json"));
const input = JSON.parse(fs.readFileSync(inputPath, "utf8"));

let client = null;
let keySource = null;
const logPath = outPath.replace(/\.json$/, ".log.jsonl");
const log = (e) => fs.appendFileSync(logPath, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`);
if (!args.code) {
  const k = resolveJevKey();
  keySource = k.source;
  if (k.key) client = createJevClient({ apiKey: k.key, log, budget: { maxUsdPerHour: 0.5, maxCallsPerMin: 120 }, sessionId: `egg-orchard-pass-plan-${Date.now()}` });
}
let result;
try {
  result = await planPasses(client, input, { batch: Boolean(args.batch), log });
} catch (e) {
  if (e instanceof JevError) {
    console.error(`pass-plan: JEV ${e.kind}: ${e.message}`);
    process.exit(2);
  }
  throw e;
} finally {
  client?.close();
}
const doc = {
  about: "Egg Orchard creature passes (over / left / right) for the FPV racing line. left/right = the side of the creature the drone flies on, seen in the direction of travel. Produced by tools/pass_plan.mjs -> jev_tasks.mjs planPasses.",
  generated: new Date().toISOString(),
  input: path.relative(here, inputPath),
  keySource: keySource ?? (args.code ? "--code (key not read)" : "none"),
  model: client ? client.model : null,
  ...result,
};
fs.writeFileSync(outPath, JSON.stringify(doc, null, 1));
console.log(`pass-plan: ${result.passes.length} creatures · over ${result.counts.over} · left ${result.counts.left} · right ${result.counts.right} · ${result.source}` +
  `${result.usage.calls ? ` · ${result.usage.calls} JEV calls · $${result.usage.costUsd.toFixed(6)}` : ""} -> ${path.relative(here, outPath)}`);
for (const w of result.warnings) console.log(`  warning: ${w}`);
