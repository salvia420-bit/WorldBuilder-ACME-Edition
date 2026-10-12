// pw1070/playwright.js — run the rynth live smokes (apps/holtburger-web/rynth_*_smoke.cjs) on the
// 1070's off-screen, muted test Chrome instead of a local headless Chromium (the 8 GB laptop must not
// host one). The smokes are unchanged: they `require("playwright")`, which this directory answers.
//
//   cd apps/holtburger-web
//   NODE_PATH=$HB/scripts/perf-worker/coldboot/pw1070 node rynth_combat_smoke.cjs
//   NODE_PATH=$HB/scripts/perf-worker/coldboot/pw1070 node rynth_test_all.cjs --only=...
//
// chromium.launch() becomes: owner presence gate (../gate1070.sh — needs watch1070.sh running) →
// the -L 9333 CDP tunnel → our test Chrome on the box (started through the hbprobe task when CDP is
// not up; the box's own hbgate.ps1 checks presence again) → connectOverCDP. Every page.goto() URL is
// rewritten from the laptop-local http://127.0.0.1:8765 to the laptop's tailnet front (proxy.cjs
// :7080 → serve.py + /wsbridge) and gets bridge_url/server_host/server_port, so the box reaches
// serve.py, the wsbridge and ACE over the tailnet. browser.close() closes the pages it opened and
// disconnects; our test Chrome stays up for the next smoke (kill it afterwards with
// hbbench-kill.ps1, or let watch1070.sh do it the moment a person shows up).
"use strict";
const { execFileSync, spawnSync } = require("node:child_process");
const path = require("node:path");
const core = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");

const BOX = "young@100.127.215.75";
const CDP = process.env.PW1070_CDP || "http://127.0.0.1:9333";
const FRONT = (process.env.PW1070_FRONT || "http://100.116.47.66:7080").replace(/\/$/, "");
const GATE = path.join(__dirname, "..", "gate1070.sh");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ssh = (c) => execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", BOX, c], { encoding: "utf8", timeout: 60000 });

async function cdpUp() {
  try { return (await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(3000) })).ok; } catch (_) { return false; }
}

function tunnelUp() {
  const r = spawnSync("ss", ["-tln"], { encoding: "utf8" });
  return /127\.0\.0\.1:9333\b/.test(r.stdout || "");
}

/** Rewrite a laptop-local smoke URL so the 1070 can load it over the tailnet. */
function rewriteUrl(u) {
  if (typeof u !== "string" || !u.startsWith("http://127.0.0.1:8765")) return u;
  const url = new URL(FRONT + u.slice("http://127.0.0.1:8765".length));
  const p = url.searchParams;
  if (!p.has("bridge_url")) p.set("bridge_url", `${FRONT.replace(/^http/, "ws")}/wsbridge`);
  if (!p.has("server_host")) p.set("server_host", "127.0.0.1");
  if (!p.has("server_port")) p.set("server_port", "9000");
  if (!p.has("nosw")) p.set("nosw", "1");
  return url.toString();
}

function patchPage(page) {
  const goto = page.goto.bind(page);
  page.goto = (u, opts) => goto(rewriteUrl(u), opts);
  return page;
}

async function ensureChrome() {
  // Owner rule: never start (or attach to) test Chrome while a person is on the box.
  try { execFileSync(GATE, { stdio: "inherit" }); }
  catch (_) { throw new Error("pw1070: 1070 in use or watch1070.sh not running — refusing to launch"); }
  if (!tunnelUp()) {
    execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ExitOnForwardFailure=yes", "-fN", "-L", "9333:127.0.0.1:9333", BOX], { timeout: 30000 });
  }
  if (await cdpUp()) return;
  ssh(`echo hbb-pw1070-${Date.now()}> D:\\Temp\\hbbench\\profile.txt`);
  ssh("echo 1280,720> D:\\Temp\\hbbench\\winsize.txt");
  ssh('schtasks /create /tn hbprobe /tr "D:\\Temp\\hbbench\\hbprobe-launch.bat" /sc once /st 00:00 /it /f >nul 2>nul & schtasks /run /tn hbprobe >nul');
  for (let i = 0; i < 40; i++) { if (await cdpUp()) return; await sleep(1000); }
  throw new Error("pw1070: test Chrome did not come up on :9333 (box gate refused? see D:\\Temp\\hbbench\\gate.log)");
}

const chromium = {
  async launch(_opts) {
    await ensureChrome();
    const browser = await core.chromium.connectOverCDP(CDP);
    const ctx = browser.contexts()[0];
    const opened = new Set();
    return {
      async newPage() {
        const page = patchPage(await ctx.newPage());
        opened.add(page);
        page.on("close", () => opened.delete(page));
        return page;
      },
      async newContext() {
        return {
          newPage: async () => {
            const page = patchPage(await ctx.newPage());
            opened.add(page);
            return page;
          },
          close: async () => {},
        };
      },
      contexts: () => browser.contexts(),
      version: () => browser.version(),
      isConnected: () => browser.isConnected(),
      async close() {
        for (const p of [...opened]) await p.close().catch(() => null);
        await browser.close().catch(() => null); // CDP-attached: disconnects, does not kill Chrome
      },
    };
  },
};

module.exports = { chromium, rewriteUrl, _core: core };
