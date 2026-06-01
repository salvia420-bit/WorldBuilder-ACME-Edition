#!/usr/bin/env node
// gen-oracles.mjs — batch-generate per-LB expectation oracles via WB.Terminal
// `dump-lb-expectations`, for the verify sweep's setExpected/loadExpected.
// Loads the RetailSmoke project ONCE, dumps every LB, quits — so the DAT load
// cost is paid once and WB.Terminal frees before the (chromium) sweep runs.
//
// Usage:
//   node gen-oracles.mjs --lbs=<file|csv-of-0xLLLL> --out=<dir> \
//        [--scenery=/mnt/wbterminal2/holtburger-dist/scenery/] \
//        [--events=/mnt/wbterminal2/holtburger-dist/events/]
import { spawn } from "node:child_process";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";

const DOTNET = "/home/wbterminal/.dotnet/dotnet";
const WBT = "/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll";
const PROJ = "/home/wbterminal/projects/RetailSmoke/RetailSmoke.wbproj";

function parseArgs(argv) {
  const a = {
    lbs: "", out: "",
    scenery: "/mnt/wbterminal2/holtburger-dist/scenery/",
    events: "/mnt/wbterminal2/holtburger-dist/events/",
  };
  for (const arg of argv.slice(2)) {
    const m = arg.match(/^--([a-z]+)=(.*)$/);
    if (m) a[m[1]] = m[2];
  }
  return a;
}
async function loadLbList(spec) {
  let text;
  if (existsSync(spec)) text = await readFile(spec, "utf8");
  else text = spec.replace(/,/g, "\n");
  return text.split("\n").map((s) => s.trim())
    .filter((s) => s && !s.startsWith("#"))
    .map((s) => parseInt(s, 16) & 0xffff);
}

const args = parseArgs(process.argv);
if (!args.lbs || !args.out) { console.error("need --lbs and --out"); process.exit(2); }
const lbs = await loadLbList(args.lbs);
await mkdir(args.out, { recursive: true });

const cmds = [JSON.stringify({ command: "load", path: PROJ })];
for (const lb of lbs) {
  const lbX = (lb >> 8) & 0xff, lbY = lb & 0xff;
  const hex = "0x" + lb.toString(16).toUpperCase().padStart(4, "0");
  cmds.push(JSON.stringify({
    command: "dump-lb-expectations", lbX, lbY,
    sceneryBakeDir: args.scenery, eventsBakeDir: args.events,
    out: `${args.out}/${hex}.json`,
  }));
}
cmds.push(JSON.stringify({ command: "quit" }));

console.log(`[gen-oracles] ${lbs.length} LBs -> ${args.out}`);
const t0 = Date.now();
const proc = spawn(DOTNET, [WBT, "--stdin"], { stdio: ["pipe", "ignore", "inherit"] });
proc.stdin.write(cmds.join("\n") + "\n");
proc.stdin.end();
await new Promise((res) => proc.on("exit", res));
const written = (await readdir(args.out)).filter((f) => f.endsWith(".json")).length;
console.log(`[gen-oracles] wrote ${written} oracle files in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
