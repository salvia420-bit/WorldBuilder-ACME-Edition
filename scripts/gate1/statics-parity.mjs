#!/usr/bin/env node
// Gate-1 STATICS parity (G2, 2026-06-21) — independent verification of EVERY
// LandblockInfo static object (loose `objects` + `buildings`, including the ~720
// non-building statics the frozen snapshot never carried).
//
// Two independent parsers of the same client_cell.dat LandblockInfo:
//   CLIENT  = holtburger-dat (Rust)  via `dat-tool landblock <cell.dat> <lb> --objects-jsonl`
//   ORACLE  = DatReaderWriter (C#)   via WB.Terminal `list-objects` (GetStaticObjects)
// dat-tool emits LANDBLOCK-LOCAL coords; list-objects emits WORLD coords, so the
// client side is lifted to world frame (wx = lbX*192 + localx) before matching.
// list-objects rounds coords to 2dp, so match at ~2cm by (id, x, y, z).
//
// Usage:
//   node statics-parity.mjs --ring <file|csv of 0xLLLL> --cell-dat <client_cell.dat> \
//        --project <RetailSmoke.wbproj> [--dat-tool <path>] [--dll <WorldBuilder.Terminal.dll>] \
//        [--tol 0.02] [--out <report.json>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

// execFileSync does not run a shell, so leading ~ is not expanded.
const expandTilde = (p) => (p && p.startsWith("~") ? os.homedir() + p.slice(1) : p);

const DEF_DAT_TOOL =
  "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/target/debug/dat-tool";
const DOTNET = "/home/wbterminal/.dotnet/dotnet";

function parseArgs(argv) {
  const o = { tol: 0.02, datTool: DEF_DAT_TOOL, dll: null, out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === "--ring") o.ring = next();
    else if (a === "--cell-dat") o.cellDat = next();
    else if (a === "--project") o.project = next();
    else if (a === "--dat-tool") o.datTool = next();
    else if (a === "--dll") o.dll = next();
    else if (a === "--tol") o.tol = Number(next());
    else if (a === "--out") o.out = next();
    else throw new Error(`unknown arg ${a}`);
  }
  for (const k of ["ring", "cellDat", "project"]) {
    if (!o[k]) throw new Error(`missing --${k.replace(/[A-Z]/g, (m) => "-" + m.toLowerCase())}`);
  }
  o.cellDat = expandTilde(o.cellDat);
  o.project = expandTilde(o.project);
  o.datTool = expandTilde(o.datTool);
  if (o.dll) o.dll = expandTilde(o.dll);
  if (!o.dll) {
    // resolve the newest built WorldBuilder.Terminal.dll
    const base =
      "/home/wbterminal/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release";
    const nets = fs.existsSync(base) ? fs.readdirSync(base).filter((d) => d.startsWith("net")) : [];
    if (!nets.length) throw new Error("could not auto-resolve --dll; pass it explicitly");
    o.dll = path.join(base, nets.sort().pop(), "WorldBuilder.Terminal.dll");
  }
  return o;
}

function readRing(ring) {
  const toks = fs.existsSync(ring)
    ? fs.readFileSync(ring, "utf8").split(/\s+/)
    : ring.split(",");
  const out = [];
  for (let t of toks) {
    t = t.trim();
    if (!t) continue;
    const v = parseInt(t.replace(/^0x/i, ""), 16);
    if (Number.isFinite(v)) out.push(v & 0xffff);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

const hex4 = (v) => `0x${v.toString(16).toUpperCase().padStart(4, "0")}`;

// CLIENT: dat-tool per LB -> local objects, lifted to world frame.
function clientObjects(o, lb) {
  const lbX = (lb >> 8) & 0xff;
  const lbY = lb & 0xff;
  // NB: `>>> 0` gives the unsigned 32-bit value; do NOT `| 0` after — that
  // re-signs it back to negative and toString(16) emits a bogus "-…" id.
  const id = `0x${((lb << 16) >>> 0).toString(16).toUpperCase().padStart(8, "0")}`;
  let txt = "";
  try {
    txt = execFileSync(o.datTool, ["landblock", o.cellDat, id, "--objects-jsonl"], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    return [];
  }
  const recs = [];
  for (const line of txt.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{")) continue;
    const r = JSON.parse(s);
    recs.push({ id: String(r.id).toLowerCase(), x: r.x + lbX * 192, y: r.y + lbY * 192, z: r.z });
  }
  return recs;
}

// ORACLE: one WB.Terminal --stdin session for all LBs -> world coords already.
function oracleObjects(o, lbs) {
  const cmds = lbs
    .map((lb) => JSON.stringify({ command: "list-objects", lbX: (lb >> 8) & 0xff, lbY: lb & 0xff }))
    .concat(JSON.stringify({ command: "quit" }))
    .join("\n");
  const out = execFileSync(DOTNET, [o.dll, "--stdin", "--project", o.project], {
    input: cmds + "\n",
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    env: { ...process.env, DOTNET_ROOT: "/home/wbterminal/.dotnet" },
  });
  const byLb = new Map();
  for (const line of out.split("\n")) {
    const s = line.trim();
    if (!s.startsWith("{") || !s.includes('"command":"list-objects"')) continue;
    let d;
    try { d = JSON.parse(s); } catch { continue; }
    if (typeof d.landblock !== "string") continue; // skip input echo / non-response lines
    const recs = (d.objects || []).map((ob) => ({
      id: String(ob.modelId).toLowerCase(),
      x: ob.x, y: ob.y, z: ob.z,
    }));
    // d.landblock is already "0xLLLL" with uppercase hex digits (C# X4),
    // matching hex4() — do NOT toUpperCase (that would make "0X..." and miss).
    byLb.set(d.landblock, recs);
  }
  return byLb;
}

function diffLb(oracle, client, tol) {
  const used = new Array(client.length).fill(false);
  let matched = 0;
  let missing = 0;
  for (const o of oracle) {
    let hit = -1;
    for (let i = 0; i < client.length; i += 1) {
      if (used[i] || client[i].id !== o.id) continue;
      const c = client[i];
      if (Math.abs(o.x - c.x) <= tol && Math.abs(o.y - c.y) <= tol && Math.abs(o.z - c.z) <= tol) {
        hit = i;
        break;
      }
    }
    if (hit >= 0) { used[hit] = true; matched += 1; } else missing += 1;
  }
  const extra = used.filter((u) => !u).length;
  return { oracle: oracle.length, client: client.length, matched, missing, extra };
}

function main() {
  const o = parseArgs(process.argv);
  const lbs = readRing(o.ring);
  process.stderr.write(`statics-parity: ${lbs.length} LBs, tol ${o.tol}m\n`);
  const oracle = oracleObjects(o, lbs);
  const rows = [];
  let tot = { oracle: 0, client: 0, matched: 0, missing: 0, extra: 0, pass: 0, drift: 0, skip: 0 };
  for (const lb of lbs) {
    const h = hex4(lb);
    const orc = oracle.get(h) || [];
    const cli = clientObjects(o, lb);
    if (orc.length === 0 && cli.length === 0) { tot.skip += 1; continue; }
    const d = diffLb(orc, cli, o.tol);
    const verdict = d.missing === 0 && d.extra === 0 ? "PASS" : "DRIFT";
    if (verdict === "PASS") tot.pass += 1; else tot.drift += 1;
    for (const k of ["oracle", "client", "matched", "missing", "extra"]) tot[k] += d[k];
    rows.push({ lb: h, ...d, verdict });
  }
  rows.sort((a, b) => (a.lb < b.lb ? -1 : 1));
  for (const r of rows.filter((r) => r.verdict !== "PASS").slice(0, 40)) {
    process.stdout.write(
      `${r.lb}: oracle=${r.oracle} client=${r.client} matched=${r.matched} missing=${r.missing} extra=${r.extra}  ${r.verdict}\n`,
    );
  }
  process.stdout.write(
    `\nSTATICS PARITY: ${tot.pass} PASS / ${tot.drift} DRIFT / ${tot.skip} empty  |  ` +
      `objects oracle=${tot.oracle} client=${tot.client} matched=${tot.matched} missing=${tot.missing} extra=${tot.extra}\n`,
  );
  if (o.out) {
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    fs.writeFileSync(o.out, JSON.stringify({ tol: o.tol, totals: tot, rows }, null, 2));
    process.stdout.write(`report -> ${o.out}\n`);
  }
  process.exitCode = tot.drift > 0 ? 1 : 0;
}

main();
