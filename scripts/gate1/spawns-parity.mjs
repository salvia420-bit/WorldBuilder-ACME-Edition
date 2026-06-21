#!/usr/bin/env node
// Gate-1 SPAWNS parity (G3, 2026-06-21) — snapshot-free spawn verification.
//
// Replaces the frozen 2026-06-01 oracle snapshot's `npcs` with a LIVE query of
// the ACE world DB `landblock_instance` table (the authoritative server truth):
//   ORACLE = live ACE `landblock_instance` (mysql ace_world)
//   CLIENT = the staged `ace_spawn_records.jsonl` the client injects
// Both are LANDBLOCK-LOCAL frame and keyed by (wcid, x, y, z). Matching the live
// DB against the staged file catches staleness/drift the frozen snapshot hid.
//
// Usage:
//   node spawns-parity.mjs --ring <file|csv of 0xLLLL> --spawn-source <ace_spawn_records.jsonl> \
//        [--db ace_world] [--db-user ace] [--db-pass ace] [--db-host 127.0.0.1] \
//        [--tol 0.02] [--out <report.json>]
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const expandTilde = (p) => (p && p.startsWith("~") ? os.homedir() + p.slice(1) : p);

function parseArgs(argv) {
  const o = { tol: 0.02, db: "ace_world", dbUser: "ace", dbPass: "ace", dbHost: "127.0.0.1", out: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    const next = () => argv[(i += 1)];
    if (a === "--ring") o.ring = next();
    else if (a === "--spawn-source") o.spawnSource = next();
    else if (a === "--db") o.db = next();
    else if (a === "--db-user") o.dbUser = next();
    else if (a === "--db-pass") o.dbPass = next();
    else if (a === "--db-host") o.dbHost = next();
    else if (a === "--tol") o.tol = Number(next());
    else if (a === "--out") o.out = next();
    else throw new Error(`unknown arg ${a}`);
  }
  if (!o.ring) throw new Error("missing --ring");
  if (!o.spawnSource) throw new Error("missing --spawn-source");
  o.spawnSource = expandTilde(o.spawnSource);
  return o;
}

function readRing(ring) {
  const toks = fs.existsSync(ring) ? fs.readFileSync(ring, "utf8").split(/\s+/) : ring.split(",");
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

// ORACLE: live ACE landblock_instance, grouped by landblock id (decimal int).
function oracleSpawns(o, lbs) {
  const inList = lbs.join(",");
  const q =
    `SELECT landblock, weenie_Class_Id, origin_X, origin_Y, origin_Z ` +
    `FROM landblock_instance WHERE landblock IN (${inList});`;
  const out = execFileSync(
    "mysql",
    [`-u${o.dbUser}`, `-p${o.dbPass}`, `-h${o.dbHost}`, o.db, "-N", "-e", q],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  const byLb = new Map();
  for (const line of out.split("\n")) {
    if (!line) continue;
    const [lb, wcid, x, y, z] = line.split("\t");
    const key = hex4(parseInt(lb, 10) & 0xffff);
    let arr = byLb.get(key);
    if (!arr) { arr = []; byLb.set(key, arr); }
    arr.push({ id: `0x${(Number(wcid) >>> 0).toString(16)}`, x: +x, y: +y, z: +z });
  }
  return byLb;
}

// CLIENT: staged ace_spawn_records.jsonl, grouped by landblockId, ring-filtered.
function sourceSpawns(o, ringSet) {
  const txt = fs.readFileSync(o.spawnSource, "utf8");
  const byLb = new Map();
  for (const line of txt.split("\n")) {
    if (line.length < 2 || line.charCodeAt(0) !== 123) continue; // fast skip non-{ lines
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const lb = r.landblockId & 0xffff;
    if (!ringSet.has(lb)) continue;
    const key = hex4(lb);
    let arr = byLb.get(key);
    if (!arr) { arr = []; byLb.set(key, arr); }
    arr.push({ id: `0x${(Number(r.wcid) >>> 0).toString(16)}`, x: +r.x, y: +r.y, z: +r.z });
  }
  return byLb;
}

function diffLb(oracle, client, tol) {
  const used = new Array(client.length).fill(false);
  let matched = 0, missing = 0;
  for (const o of oracle) {
    let hit = -1;
    for (let i = 0; i < client.length; i += 1) {
      if (used[i] || client[i].id !== o.id) continue;
      const c = client[i];
      if (Math.abs(o.x - c.x) <= tol && Math.abs(o.y - c.y) <= tol && Math.abs(o.z - c.z) <= tol) {
        hit = i; break;
      }
    }
    if (hit >= 0) { used[hit] = true; matched += 1; } else missing += 1;
  }
  return { oracle: oracle.length, client: client.length, matched, missing, extra: used.filter((u) => !u).length };
}

function main() {
  const o = parseArgs(process.argv);
  const lbs = readRing(o.ring);
  const ringSet = new Set(lbs);
  process.stderr.write(`spawns-parity: ${lbs.length} LBs, tol ${o.tol}m\n`);
  const oracle = oracleSpawns(o, lbs);
  const source = sourceSpawns(o, ringSet);
  const rows = [];
  const tot = { oracle: 0, client: 0, matched: 0, missing: 0, extra: 0, pass: 0, drift: 0, skip: 0 };
  for (const lb of lbs) {
    const h = hex4(lb);
    const orc = oracle.get(h) || [];
    const cli = source.get(h) || [];
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
    `\nSPAWNS PARITY (live ACE landblock_instance vs staged jsonl): ${tot.pass} PASS / ${tot.drift} DRIFT / ${tot.skip} empty  |  ` +
      `spawns oracle=${tot.oracle} client=${tot.client} matched=${tot.matched} missing=${tot.missing} extra=${tot.extra}\n`,
  );
  if (o.out) {
    fs.mkdirSync(path.dirname(o.out), { recursive: true });
    fs.writeFileSync(o.out, JSON.stringify({ tol: o.tol, totals: tot, rows }, null, 2));
    process.stdout.write(`report -> ${o.out}\n`);
  }
  process.exitCode = tot.drift > 0 ? 1 : 0;
}

main();
