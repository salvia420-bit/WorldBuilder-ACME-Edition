#!/usr/bin/env node
// wbt_sidecar_test.cjs — end-to-end test of wbt_sidecar.cjs against
// mock_wbt.cjs (WBT_SPAWN override; no dotnet, no infra). Covers: boot +
// /health, /catalog with policy annotation, /command allow + deny + always-
// deny(quit), args passthrough, /ticket + /tickets, CORS headers, and the
// timeout->respawn path (last — it kills the child).
//
// Run: node wbt_sidecar_test.cjs   (exits 1 on any FAIL; ~12s incl. respawn)

"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const PORT = 18768;
const BASE = `http://127.0.0.1:${PORT}`;

let pass = 0, fail = 0;
function check(name, ok, detail) {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name}${detail ? " — " + detail : ""}`); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function req(pathname, init) {
  const res = await fetch(`${BASE}${pathname}`, init);
  return { status: res.status, headers: res.headers, body: await res.json() };
}

async function waitReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const { body } = await req("/health");
      if (body.ready) return true;
    } catch {}
    await sleep(200);
  }
  return false;
}

(async () => {
  const ticketsDir = fs.mkdtempSync(path.join(os.tmpdir(), "wbt-tickets-"));
  const datRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wbt-dats-"));
  process.env.WBT_DAT_ROOTS_TEST_OK = datRoot;
  const sidecar = spawn(process.execPath, [path.join(__dirname, "wbt_sidecar.cjs")], {
    env: {
      ...process.env,
      WBT_LISTEN: `127.0.0.1:${PORT}`,
      WBT_SPAWN: `${process.execPath} ${path.join(__dirname, "mock_wbt.cjs")}`,
      WBT_TICKETS_DIR: ticketsDir,
      WBT_DAT_ROOTS: datRoot,
      WBT_ALLOW: "extra-allowed-cmd,slow-cmd",
      WBT_DENY: "spell-list",
    },
    stdio: ["ignore", "ignore", "pipe"],
  });
  const errLines = [];
  sidecar.stderr.on("data", (d) => errLines.push(String(d)));

  try {
    check("sidecar becomes ready", await waitReady(10000), errLines.join("").slice(-500));

    // --- health + CORS ----------------------------------------------------
    {
      const { body, headers } = await req("/health");
      check("health shape", body.ok === true && body.ready === true && typeof body.pid === "number");
      check("health policy is read-only", body.policy.mode === "read-only");
      check("CORS header on every response", headers.get("access-control-allow-origin") === "*");
      const opt = await fetch(`${BASE}/anything`, { method: "OPTIONS" });
      check("OPTIONS preflight 204", opt.status === 204);
    }

    // --- catalog ----------------------------------------------------------
    {
      const { body } = await req("/catalog");
      check("catalog ok", body.ok === true && Array.isArray(body.commands) && body.commands.length === 4);
      const by = Object.fromEntries(body.commands.map((c) => [c.name, c]));
      check("catalog: read cmd allowed", by["info"].allowed === true && by["describe-landblock"].allowed === true);
      check("catalog: write cmd denied", by["paint"].allowed === false);
      check("catalog: quit always denied", by["quit"].allowed === false);
      const f = await req("/catalog?filter=landblock");
      check("catalog filter", f.body.commands.length === 1 && f.body.commands[0].name === "describe-landblock");
    }

    // --- command policy + passthrough ------------------------------------
    {
      const ok = await req("/command", { method: "POST", body: JSON.stringify({ command: "describe-landblock", lbX: 42, lbY: 33 }) });
      check("allowed command passes through", ok.status === 200 && ok.body.ok === true
        && ok.body.response.echo.lbX === 42 && ok.body.response.echo.lbY === 33);
      check("timeoutMs consumed, not forwarded", ok.body.response.echo.timeoutMs === undefined);
      const denied = await req("/command", { method: "POST", body: JSON.stringify({ command: "paint", x: 1, y: 1 }) });
      check("write command 403", denied.status === 403 && /allowlist/.test(denied.body.error));
      const quit = await req("/command", { method: "POST", body: JSON.stringify({ command: "quit" }) });
      check("quit always 403", quit.status === 403);
      const extra = await req("/command", { method: "POST", body: JSON.stringify({ command: "extra-allowed-cmd" }) });
      check("WBT_ALLOW extends allowlist", extra.status === 200 && extra.body.ok === true);
      const envDeny = await req("/command", { method: "POST", body: JSON.stringify({ command: "spell-list" }) });
      check("WBT_DENY narrows allowlist", envDeny.status === 403);
      const bad = await req("/command", { method: "POST", body: "not json" });
      check("bad body 400", bad.status === 400);
      const noCmd = await req("/command", { method: "POST", body: JSON.stringify({ nope: 1 }) });
      check("missing command field 400", noCmd.status === 400);
    }

    // --- argument screening (write-audit 2026-07-17) ----------------------
    {
      const w = await req("/command", { method: "POST", body: JSON.stringify({ command: "info", outputPath: "/home/user/.bashrc" }) });
      check("write-path arg refused", w.status === 403 && /file-output paths/.test(w.body.error));
      const w2 = await req("/command", { method: "POST", body: JSON.stringify({ command: "info", out: "/etc/passwd" }) });
      check("'out' arg refused", w2.status === 403);
      const rBad = await req("/command", { method: "POST", body: JSON.stringify({ command: "info", datPath: "/etc/shadow" }) });
      check("read-path outside roots refused", rBad.status === 403 && /must be a path under/.test(rBad.body.error));
      const rTrav = await req("/command", { method: "POST", body: JSON.stringify({ command: "info", datPath: `${process.env.WBT_DAT_ROOTS_TEST_OK}/../../etc/passwd` }) });
      check("read-path traversal refused", rTrav.status === 403);
      const rOk = await req("/command", { method: "POST", body: JSON.stringify({ command: "info", datPath: `${process.env.WBT_DAT_ROOTS_TEST_OK}/client_portal.dat` }) });
      check("read-path under roots passes", rOk.status === 200 && rOk.body.ok === true);
      const h = await req("/health");
      check("health reports argScreen on", h.body.policy.argScreen === true && Array.isArray(h.body.policy.datRoots));
    }

    // --- serialization under concurrency ----------------------------------
    {
      const rs = await Promise.all(
        [1, 2, 3, 4, 5].map((i) => req("/command", { method: "POST", body: JSON.stringify({ command: "info", seq: i }) }))
      );
      check("5 concurrent commands all answered, in order",
        rs.every((r) => r.body.ok === true) && rs.every((r, i) => r.body.response.echo.seq === i + 1));
    }

    // --- tickets ----------------------------------------------------------
    {
      const t = await req("/ticket", {
        method: "POST",
        body: JSON.stringify({ title: "Vendor empty", body: "Holtburg vendor has no stock", severity: "high", character: "Brakis", position: { objCellId: 0xa9b40015 } }),
      });
      check("ticket filed", t.status === 200 && t.body.ok === true && typeof t.body.id === "string");
      check("ticket file exists", fs.existsSync(t.body.file));
      const list = await req("/tickets?limit=5");
      check("tickets listed newest-first", list.body.ok === true && list.body.tickets.length === 1
        && list.body.tickets[0].title === "Vendor empty" && list.body.tickets[0].severity === "high");
      const badT = await req("/ticket", { method: "POST", body: JSON.stringify({ title: "", body: "" }) });
      check("empty ticket 400", badT.status === 400);
    }

    // --- 404 --------------------------------------------------------------
    {
      const nf = await req("/nope");
      check("unknown path 404 JSON", nf.status === 404 && nf.body.ok === false);
    }

    // --- timeout -> respawn (LAST: kills the child) -----------------------
    {
      const t0 = Date.now();
      const slow = await req("/command", { method: "POST", body: JSON.stringify({ command: "slow-cmd", timeoutMs: 1000 }) });
      check("timeout surfaces as error", slow.status === 502 && /timed out/.test(slow.body.error), JSON.stringify(slow.body));
      check("timeout honored (~1s, not 3s)", Date.now() - t0 < 2500);
      check("child respawns after timeout", await waitReady(10000));
      const after = await req("/command", { method: "POST", body: JSON.stringify({ command: "info" }) });
      check("commands work after respawn", after.body.ok === true);
    }
  } finally {
    sidecar.kill();
    try { fs.rmSync(ticketsDir, { recursive: true, force: true }); } catch {}
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
