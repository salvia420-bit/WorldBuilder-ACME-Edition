#!/usr/bin/env node
// wbt_sidecar.cjs — HTTP sidecar that owns one long-lived WorldBuilder.Terminal
// `--stdin` process (JSON-line protocol: one JSON object per line in, exactly
// one JSON line out per command, plus a single {"command":"ready"} banner at
// boot) and exposes it to the browser-side rynth AI director
// (rynth/ai/tools/wbt.js). Same conventions as apps/rynthnav-sidecar:
// 127.0.0.1 bind, permissive CORS on EVERY response (the page on :8765 is a
// different origin), /health, well-formed JSON on every branch.
//
// Endpoints:
//   GET  /health            -> { ok, ready, pid, uptimeMs, served, project, policy }
//   GET  /catalog?filter=   -> { ok, commands: [{name, args, description, allowed}] }
//   POST /command           -> body IS the WBT JSON command object (flat fields,
//                              e.g. {"command":"describe-landblock","lbX":..}).
//                              Optional "timeoutMs" (consumed here, capped).
//                              -> { ok:true, response } | { ok:false, error }
//   POST /ticket            -> { title, body, severity?, character?, position?,
//                              context? } -> { ok, id, file } (playtest tickets)
//   GET  /tickets?limit=    -> { ok, tickets: [...] } newest first
//
// Policy: deny-by-default. Only the read-only oracle allowlist below is
// callable; WBT_ALLOW="all" or a comma list widens it, WBT_DENY narrows it.
// "quit" is always refused (it kills the child). Terrain/DAT/DB mutation and
// long batch jobs stay operator-only.
//
// Env: WBT_LISTEN (127.0.0.1:8768), WBT_DOTNET, WBT_DLL, WBT_PROJECT (issue a
// `load` at boot so project-scoped reads work), WBT_SPAWN (full command
// override, for tests), WBT_CMD_TIMEOUT (ms, default 120000),
// WBT_TICKETS_DIR, WBT_ALLOW, WBT_DENY.

"use strict";

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const LISTEN = process.env.WBT_LISTEN || "127.0.0.1:8768";
const DOTNET = process.env.WBT_DOTNET || path.join(os.homedir(), ".local/bin/dotnet");
const DLL =
  process.env.WBT_DLL ||
  path.join(
    os.homedir(),
    "WorldBuilder-ACME-Edition/WorldBuilder.Terminal/bin/Release/net8.0/WorldBuilder.Terminal.dll"
  );
const PROJECT = process.env.WBT_PROJECT || null;
const CMD_TIMEOUT = clampInt(process.env.WBT_CMD_TIMEOUT, 1000, 600000, 120000);
const MAX_BODY = 1 << 20; // 1 MB
const RESTART_BACKOFF_MS = 5000;

// ── policy ──────────────────────────────────────────────────────────────────
// Read-only oracle surface, curated from the live `help` catalog 2026-07-17.
// Everything not listed is denied unless WBT_ALLOW opens it.
const READ_ALLOW = new Set([
  "help", "info", "get-world-info",
  // terrain / landblock reads
  "get-height", "get-heightmap", "get-bulk-heightmap", "get-terrain-data",
  "get-terrain-layers", "get-terrain-textures", "terrain-info", "diff-terrain",
  "list-landblocks", "list-objects", "describe-landblock",
  "get-dungeon-info", "placement-list",
  // asset / ontology reads
  "get-object-detail", "asset-refs", "asset-used-by", "surface-fingerprint",
  "query-ontology", "query-radius", "ontology-stats", "mine-strings",
  "scene-export-json", "scene-where-used", "region-export-json", "region-diff",
  "scene-diff", "get-region", "dat-list", "melt-reference",
  // spells / weenies / creatures (read side)
  "spell-get", "spell-list", "weenie-list-property-keys", "creature-get",
  // UI layouts (read side)
  "layout-list", "layout-get", "ui-layout-list",
  // diagnostics (compute-only)
  "pvs-visibility-snapshot", "physics-jump-formula", "physics-jump-formula-sweep",
  "region-day-night-curve", "region-skybox-snapshot", "compare-render-corners",
  "diag-status", "wave4-status", "tile-stats",
  "open-log-folder",
  // validators (report-only)
  "validate-all", "validate-terrain", "validate-landblock", "validate-dungeon",
  "validate-building-portals", "validate-building-shells",
  // DB status probes (no mutation)
  "ace-db-status", "ace-shard-db-status",
  // visual (base64 PNG — big, browser side clips for the LLM)
  "render-preview", "get-tile",
]);
const ALWAYS_DENY = new Set(["quit"]);

const allowEnv = String(process.env.WBT_ALLOW || "").trim();
const allowAll = allowEnv.toLowerCase() === "all";
const extraAllow = new Set(allowAll ? [] : allowEnv.split(",").map((s) => s.trim()).filter(Boolean));
const extraDeny = new Set(String(process.env.WBT_DENY || "").split(",").map((s) => s.trim()).filter(Boolean));

function commandAllowed(name) {
  if (typeof name !== "string" || !name) return false;
  if (ALWAYS_DENY.has(name) || extraDeny.has(name)) return false;
  return allowAll || READ_ALLOW.has(name) || extraAllow.has(name);
}

// ── argument screening (2026-07-17 write-audit) ─────────────────────────────
// Several otherwise-read-only commands accept an OUTPUT path (out/outputPath →
// Directory.CreateDirectory + File.Write* at an arbitrary absolute path =
// arbitrary-overwrite primitive) or an INPUT path (datPath/otherDat/… → parse
// any file on disk). The audit's must-fix list: refuse the write args
// outright (the commands return their payload inline without them) and pin
// the read-path args under WBT_DAT_ROOTS. Applied to EVERY /command call —
// including WBT_ALLOW-extended ones — unless WBT_UNSAFE_ARGS=1 (operator
// escape for trusted local drivers, never for the bot).
const WRITE_PATH_ARGS = new Set(["out", "outputPath", "outPath", "outputDir", "outDir"]);
const READ_PATH_ARGS = new Set([
  "datPath", "otherDat", "otherJson", "path", "gradientPath",
  "sceneryBakeDir", "eventsBakeDir", "lsdPath",
]);
const UNSAFE_ARGS = process.env.WBT_UNSAFE_ARGS === "1";
const DAT_ROOTS = String(process.env.WBT_DAT_ROOTS || path.join(os.homedir(), "ac_base_dats"))
  .split(":")
  .map((s) => s.trim())
  .filter(Boolean)
  .map((p) => path.resolve(p) + path.sep);

function pathUnderRoots(p) {
  const abs = path.resolve(String(p)) + (String(p).endsWith(path.sep) ? path.sep : "");
  return DAT_ROOTS.some((root) => (abs + path.sep).startsWith(root) || abs === root.slice(0, -1));
}

/** -> null when clean, else a refusal string naming the offending arg. */
function screenArgs(cmdObj) {
  if (UNSAFE_ARGS) return null;
  for (const key of Object.keys(cmdObj)) {
    if (key === "command") continue;
    if (WRITE_PATH_ARGS.has(key))
      return `arg "${key}" is refused: file-output paths are not allowed through the sidecar (the command returns its payload inline without it)`;
    if (READ_PATH_ARGS.has(key)) {
      const v = cmdObj[key];
      if (typeof v !== "string" || !pathUnderRoots(v))
        return `arg "${key}" must be a path under ${DAT_ROOTS.join(" or ")} (got ${JSON.stringify(v).slice(0, 120)})`;
    }
  }
  return null;
}

// ── tickets ─────────────────────────────────────────────────────────────────
function pickTicketsDir() {
  const candidates = [
    process.env.WBT_TICKETS_DIR,
    "/mnt/wbterminal2/playtest-tickets",
    path.join(os.homedir(), ".wbt-playtest-tickets"),
  ].filter(Boolean);
  for (const d of candidates) {
    try {
      fs.mkdirSync(d, { recursive: true });
      fs.accessSync(d, fs.constants.W_OK);
      return d;
    } catch {
      /* try next */
    }
  }
  return null;
}
const TICKETS_DIR = pickTicketsDir();

function fileTicket(t) {
  if (!TICKETS_DIR) return { ok: false, error: "no writable tickets dir" };
  const title = clipStr(t.title, 200);
  const body = clipStr(t.body, 8000);
  if (!title || !body) return { ok: false, error: "title and body must be non-empty strings" };
  const ticket = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    title,
    body,
    severity: ["low", "medium", "high", "critical"].includes(t.severity) ? t.severity : "medium",
    character: clipStr(t.character, 100) || null,
    position: t.position && typeof t.position === "object" ? t.position : null,
    context: clipStr(typeof t.context === "string" ? t.context : t.context ? JSON.stringify(t.context) : "", 4000) || null,
  };
  const file = path.join(TICKETS_DIR, `${ticket.id}.json`);
  try {
    fs.writeFileSync(file, JSON.stringify(ticket, null, 2));
    fs.appendFileSync(path.join(TICKETS_DIR, "tickets.jsonl"), JSON.stringify(ticket) + "\n");
  } catch (e) {
    return { ok: false, error: `ticket write failed: ${e.message}` };
  }
  return { ok: true, id: ticket.id, file };
}

function listTickets(limit) {
  if (!TICKETS_DIR) return [];
  try {
    const lines = fs
      .readFileSync(path.join(TICKETS_DIR, "tickets.jsonl"), "utf8")
      .split("\n")
      .filter(Boolean);
    return lines
      .slice(-limit)
      .reverse()
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

// ── WBT process manager ─────────────────────────────────────────────────────
// One child, strictly serialized commands: a command is written only when no
// other is in flight, so "next parsed stdout line" IS the response. A timeout
// means the child is wedged or desynced — kill + respawn rather than risk
// pairing later responses with the wrong requests.
class WbtProc {
  constructor({ log = console.error } = {}) {
    this.log = log;
    this.child = null;
    this.ready = false;
    this.served = 0;
    this.startedAt = 0;
    this.pending = null; // { resolve, timer } — single in-flight command
    this.queue = []; // [{ obj, timeoutMs, resolve }]
    this.stopping = false;
    this._buf = "";
  }

  spawnCmd() {
    const override = process.env.WBT_SPAWN;
    if (override) {
      const parts = override.split(/\s+/).filter(Boolean);
      return { cmd: parts[0], args: parts.slice(1) };
    }
    return { cmd: DOTNET, args: [DLL, "--stdin"] };
  }

  start() {
    if (this.child || this.stopping) return;
    const { cmd, args } = this.spawnCmd();
    this.log(`[wbt-sidecar] spawning: ${cmd} ${args.join(" ")}`);
    let child;
    try {
      child = spawn(cmd, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, DOTNET_ROLL_FORWARD: "LatestMajor" },
      });
    } catch (e) {
      this.log(`[wbt-sidecar] spawn failed: ${e.message}; retry in ${RESTART_BACKOFF_MS}ms`);
      setTimeout(() => this.start(), RESTART_BACKOFF_MS).unref();
      return;
    }
    this.child = child;
    this.ready = false;
    this.startedAt = Date.now();
    this._buf = "";

    child.stdout.on("data", (d) => this._onData(String(d)));
    child.stderr.on("data", (d) => {
      const s = String(d).trim();
      if (s) this.log(`[wbt stderr] ${s.slice(0, 500)}`);
    });
    child.on("error", (e) => this.log(`[wbt-sidecar] child error: ${e.message}`));
    child.on("exit", (code, sig) => {
      this.log(`[wbt-sidecar] child exited code=${code} sig=${sig}`);
      this.child = null;
      this.ready = false;
      this._failAll(`WorldBuilder.Terminal exited (code=${code})`);
      if (!this.stopping) setTimeout(() => this.start(), RESTART_BACKOFF_MS).unref();
    });
  }

  _onData(chunk) {
    this._buf += chunk;
    let idx;
    while ((idx = this._buf.indexOf("\n")) >= 0) {
      const line = this._buf.slice(0, idx).trim();
      this._buf = this._buf.slice(idx + 1);
      if (!line) continue;
      let obj;
      try {
        obj = JSON.parse(line);
      } catch {
        this.log(`[wbt-sidecar] non-JSON stdout line ignored: ${line.slice(0, 200)}`);
        continue;
      }
      if (this.pending) {
        const p = this.pending;
        this.pending = null;
        clearTimeout(p.timer);
        this.served++;
        p.resolve({ ok: true, response: obj });
        this._pump();
      } else if (!this.ready && obj && obj.command === "ready") {
        this.ready = true;
        this.log(`[wbt-sidecar] WBT ready (version ${obj.version || "?"})`);
        this._boot();
        this._pump();
      } else {
        this.log(`[wbt-sidecar] unsolicited line ignored: ${line.slice(0, 200)}`);
      }
    }
  }

  _boot() {
    if (PROJECT) {
      // Queue-jump is unnecessary: nothing can be in flight before ready.
      this.send({ command: "load", path: PROJECT }, CMD_TIMEOUT).then((r) => {
        const ok = r.ok && r.response && r.response.success !== false;
        this.log(`[wbt-sidecar] project load ${ok ? "ok" : "FAILED"}: ${PROJECT}`);
      });
    }
  }

  _failAll(error) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve({ ok: false, error });
      this.pending = null;
    }
    for (const q of this.queue.splice(0)) q.resolve({ ok: false, error });
  }

  _pump() {
    if (this.pending || !this.ready || !this.child) return;
    const next = this.queue.shift();
    if (!next) return;
    const timer = setTimeout(() => {
      // Wedged or desynced: the only safe recovery is a respawn.
      this.log(`[wbt-sidecar] command timeout (${next.timeoutMs}ms) on "${next.obj.command}" — restarting WBT`);
      const p = this.pending;
      this.pending = null;
      if (p) p.resolve({ ok: false, error: `command timed out after ${next.timeoutMs}ms` });
      try {
        this.child && this.child.kill("SIGKILL");
      } catch {}
    }, next.timeoutMs);
    this.pending = { resolve: next.resolve, timer };
    try {
      this.child.stdin.write(JSON.stringify(next.obj) + "\n");
    } catch (e) {
      clearTimeout(timer);
      this.pending = null;
      next.resolve({ ok: false, error: `stdin write failed: ${e.message}` });
    }
  }

  /** -> Promise<{ok:true,response}|{ok:false,error}> — never rejects. */
  send(obj, timeoutMs) {
    return new Promise((resolve) => {
      if (this.stopping) return resolve({ ok: false, error: "sidecar shutting down" });
      this.queue.push({ obj, timeoutMs: clampInt(timeoutMs, 1000, 600000, CMD_TIMEOUT), resolve });
      this._pump();
    });
  }

  stop() {
    this.stopping = true;
    this._failAll("sidecar shutting down");
    try {
      this.child && this.child.kill();
    } catch {}
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
function clampInt(v, min, max, dflt) {
  const n = Math.floor(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : dflt;
}
function clipStr(v, n) {
  return typeof v === "string" ? v.trim().slice(0, n) : "";
}
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

// ── HTTP server ─────────────────────────────────────────────────────────────
const proc = new WbtProc({ log: (...a) => console.error(...a) });
proc.start();

let catalogCache = null; // [{name, args, description}]
async function getCatalog() {
  if (catalogCache) return catalogCache;
  const r = await proc.send({ command: "help" }, CMD_TIMEOUT);
  const cmds = r.ok && r.response && Array.isArray(r.response.commands) ? r.response.commands : null;
  if (cmds) catalogCache = cmds;
  return cmds;
}

const server = http.createServer(async (req, res) => {
  // CORS on every response, incl. errors (rynthnav Program.cs:166-171 parity).
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    if (req.method === "GET" && url.pathname === "/health") {
      return sendJson(res, 200, {
        ok: true,
        ready: proc.ready,
        pid: proc.child ? proc.child.pid : null,
        uptimeMs: proc.startedAt ? Date.now() - proc.startedAt : 0,
        served: proc.served,
        project: PROJECT,
        ticketsDir: TICKETS_DIR,
        policy: {
          mode: allowAll ? "all" : "read-only",
          allowed: allowAll ? "all" : READ_ALLOW.size + extraAllow.size,
          argScreen: !UNSAFE_ARGS,
          datRoots: DAT_ROOTS,
        },
      });
    }
    if (req.method === "GET" && url.pathname === "/catalog") {
      const cmds = await getCatalog();
      if (!cmds) return sendJson(res, 503, { ok: false, error: "WBT not ready (help unavailable)" });
      const filter = (url.searchParams.get("filter") || "").toLowerCase();
      const rows = cmds
        .filter((c) => !filter || c.name.toLowerCase().includes(filter) || String(c.description || "").toLowerCase().includes(filter))
        .map((c) => ({ name: c.name, args: c.args || "", description: c.description || "", allowed: commandAllowed(c.name) }));
      return sendJson(res, 200, { ok: true, commands: rows });
    }
    if (req.method === "POST" && url.pathname === "/command") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: `bad JSON body: ${e.message}` });
      }
      if (!body || typeof body !== "object" || typeof body.command !== "string" || !body.command)
        return sendJson(res, 400, { ok: false, error: "body must be a JSON object with a string 'command' field" });
      if (!commandAllowed(body.command))
        return sendJson(res, 403, {
          ok: false,
          error: `command "${body.command}" is not in the sidecar's read-only allowlist (GET /catalog shows allowed:true rows)`,
        });
      const { timeoutMs, ...cmdObj } = body;
      const refusal = screenArgs(cmdObj);
      if (refusal) return sendJson(res, 403, { ok: false, error: refusal });
      const r = await proc.send(cmdObj, timeoutMs);
      return sendJson(res, r.ok ? 200 : 502, r);
    }
    if (req.method === "POST" && url.pathname === "/ticket") {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: `bad JSON body: ${e.message}` });
      }
      const r = fileTicket(body && typeof body === "object" ? body : {});
      return sendJson(res, r.ok ? 200 : 400, r);
    }
    if (req.method === "GET" && url.pathname === "/tickets") {
      const limit = clampInt(url.searchParams.get("limit"), 1, 200, 20);
      return sendJson(res, 200, { ok: true, tickets: listTickets(limit) });
    }
    return sendJson(res, 404, { ok: false, error: `unknown ${req.method} ${url.pathname}` });
  } catch (e) {
    return sendJson(res, 500, { ok: false, error: String((e && e.message) || e) });
  }
});

const [host, portStr] = LISTEN.includes(":") ? [LISTEN.slice(0, LISTEN.lastIndexOf(":")), LISTEN.slice(LISTEN.lastIndexOf(":") + 1)] : ["127.0.0.1", LISTEN];
server.listen(Number(portStr), host, () => {
  console.error(`[wbt-sidecar] listening on http://${host}:${portStr} (tickets: ${TICKETS_DIR || "DISABLED"})`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    proc.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
