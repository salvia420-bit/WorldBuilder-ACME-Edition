// harness/portal-gate-probe.mjs — LANE A (2026-08-14).
//
// Answers ONE question with data instead of reading: why does `?portalStencil=on`
// make the `?portalPunch` feed inert (`_portalPunchDiag` offered/kept 0/0)?
//
// Boots the real client three times — "off" (default), "portalStencil"
// (?portalStencil=on, the historical way to reach the punch occlusion gate) and
// "punchOcclusion" (?punchOcclusion=on, the gate's own flag) — teleports to a town
// with buildings, and samples the punch diag + each pass's own internal state
// every 2 s.
//
// `?nullRender=1`: the punch FEED (cells.js tickPortalPunch) runs in the tick,
// which is the subject here; only the GPU submission is skipped. This box has no
// GPU anyway (SwiftShader), and the full-render arm starved the 30 s login
// handshake on this 8 GB laptop — an unbootable arm is not an arm.
//
//   node harness/portal-gate-probe.mjs [--port=8771] [--account=agentp07] [--seconds=40]
//
import { createRequire } from "node:module";
import { writeFileSync } from "node:fs";
import { PLAYWRIGHT_CACHE } from "./lib/boot.mjs";

const require = createRequire(import.meta.url);
const arg = (k, d) => {
  const h = process.argv.find((a) => a.startsWith(`--${k}=`));
  return h ? h.slice(k.length + 3) : d;
};
const PORT = arg("port", "8771");
const ACCOUNT = arg("account", "agentp07");
const SECONDS = Number(arg("seconds", "40"));
const POI = arg("poi", "Holtburg");
const OUT = arg("out", "/tmp/portal-gate-probe.json");
// `--arms=off,punchOcclusion` — re-run a subset (one arm per account per window;
// see the COOLDOWN below).
const ARMS = arg("arms", "").split(",").filter(Boolean);

function loadChromium() {
  for (const p of ["playwright", `${PLAYWRIGHT_CACHE}/playwright`, `${PLAYWRIGHT_CACHE}/playwright-core`]) {
    try { return require(p).chromium; } catch {}
  }
  throw new Error("playwright chromium not loadable");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const BASE =
  `http://127.0.0.1:${PORT}/apps/holtburger-web/index.html` +
  `?renderer=3d&nosw=1&agent=1&autoLogin=1&account=${ACCOUNT}&password=${ACCOUNT}` +
  `&autoSpawn=first&server_host=127.0.0.1&server_port=9000` +
  `&nullRender=1&renderOnDemand=1&netDrainHz=30`;

async function runArm(chromium, label, extra) {
  const url = BASE + extra;
  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--enable-unsafe-swiftshader",
      "--ignore-gpu-blocklist",
    ],
  });
  const page = await browser.newPage();
  await page.setViewportSize({ width: 960, height: 540 });
  const errors = [];
  const portalLogs = [];
  page.on("console", (m) => {
    const t = m.text();
    if (/portal|stencil|punch/i.test(t)) portalLogs.push(`${m.type()}: ${t.slice(0, 240)}`);
    if (m.type() === "error") errors.push(t.slice(0, 240));
  });
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e?.message || e).slice(0, 240)));

  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 120000 });
  let inWorld = false;
  try {
    await page.waitForFunction(() => {
      const hist = Array.isArray(window.__bootStateHistory) ? window.__bootStateHistory : [];
      const reached = window.__bootState === "in-world" || hist.some((e) => e && e.state === "in-world");
      if (!reached) return false;
      const h = window.__sessionHandle;
      if (!h || typeof h.getLocalPlayerPose !== "function") return false;
      try { return h.getLocalPlayerPose() != null; } catch { return false; }
    }, { timeout: 180000, polling: 250 });
    inWorld = true;
  } catch {}

  // Get somewhere with buildings.
  try {
    await page.evaluate((poi) => window.__sessionHandle?.sendChat?.("@telepoi " + poi), POI);
  } catch {}

  const samples = [];
  const tEnd = Date.now() + SECONDS * 1000;
  while (Date.now() < tEnd) {
    await sleep(2000);
    const s = await page.evaluate(() => {
      const s3 = window.liveScene3d;
      const pp = s3?._portalPunchPass ?? null;
      const ps = s3?._portalStencilPass ?? null;
      const comp = window.__atmospherePipeline?.composer ?? null;
      let indoor = null;
      try { indoor = !!window.__sessionHandle?.isCurrentCellIndoor?.(); } catch {}
      let cellCount = null;
      try { cellCount = s3?.cellContainers3d instanceof Map ? s3.cellContainers3d.size : null; } catch {}
      let interiorVisible = null;
      try {
        interiorVisible = 0;
        if (s3?.cellContainers3d instanceof Map) {
          for (const [cid, c] of s3.cellContainers3d) {
            if (c?.visible && ((cid >>> 0) & 0xffff) >= 0x100) interiorVisible++;
          }
        }
      } catch {}
      return {
        t: Date.now(),
        indoor,
        pose: (() => { try { const p = window.__sessionHandle.getLocalPlayerPose(); return p ? { lb: p.landblockId } : null; } catch { return null; } })(),
        diag: s3?._portalPunchDiag ?? null,
        punch: pp
          ? { present: true, errored: pp._errored, gated: pp.occlusionGated, apertures: pp._apertureCount, hasApertures: pp.hasApertures }
          : { present: false },
        stencil: ps
          ? { present: true, errored: ps._errored, apertures: ps._apertureCount, cells: ps._cells?.length ?? null }
          : { present: false },
        movedCells: s3?._portalMovedCells?.size ?? null,
        cellCount,
        interiorVisible,
        stencilBuffer: comp?.inputBuffer?.stencilBuffer ?? null,
      };
    }).catch((e) => ({ evalError: String(e?.message || e) }));
    samples.push(s);
  }
  await browser.close();
  return { label, url, inWorld, errors: errors.slice(0, 15), portalLogs: portalLogs.slice(0, 15), samples };
}

const chromium = loadChromium();
const results = [];
for (const [label, extra] of [
  ["off", ""],
  ["portalStencil", "&portalStencil=on"],
  ["punchOcclusion", "&punchOcclusion=on"],
].filter(([l]) => !ARMS.length || ARMS.includes(l))) {
  // COOLDOWN between arms. ACE boots the previous session on a same-account
  // login ("Account In Use: Found another session already logged in"), and the
  // client then times out its handshake at 30 s — which reads as an arm that
  // "did not reach in-world" and silently voids it. One arm per account per
  // window; wait for the server to drop the old one.
  if (results.length) await sleep(25000);
  console.log(`[probe] arm ${label} …`);
  const r = await runArm(chromium, label, extra);
  results.push(r);
  const last = r.samples[r.samples.length - 1];
  console.log(`[probe] arm ${label}: inWorld=${r.inWorld} last=`, JSON.stringify(last));
  for (const l of r.portalLogs) console.log(`   log ${label}: ${l}`);
}
writeFileSync(OUT, JSON.stringify(results, null, 2));
console.log(`[probe] wrote ${OUT}`);
