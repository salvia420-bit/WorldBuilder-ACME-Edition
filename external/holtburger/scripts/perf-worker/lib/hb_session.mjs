// lib/hb_session.mjs — the page half of harness v2 (2026-10-30): connect right after launch, size the
// window to an exact INNER resolution, boot to ready, teleport + settle (hbbench.mjs's loops,
// unchanged), attach to an already-running session (hbsess.mjs's 15 s race + raw-CDP fallback), the
// ACE "account free" wait, and the served-wasm profile check (harness/lib/wasm_profile.mjs).
//
// Playwright is loaded LAZILY (first connect), so importing this module costs nothing and works in
// the node suite. playwright-core 1.59.1 connectOverCDP hangs on the box's Chrome 156 once
// `browser_ui` targets exist (lib/cdp_raw.mjs): connectAtLaunch() connects right after launch, as
// hbbench.mjs always has; attach() falls back to raw CDP for later attaches.
import { createRequire } from "node:module";
import { statSync, openSync, readSync, closeSync } from "node:fs";
import { ACE_LOG, CDP } from "./hb_box.mjs";
import { detectWasmProfile } from "../../../apps/holtburger-web/harness/lib/wasm_profile.mjs";

const require = createRequire(import.meta.url);
export const PLAYWRIGHT_CORE = process.env.PLAYWRIGHT_CORE || "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core";
let _chromium = null;
function chromium() {
  if (_chromium === null) _chromium = require(PLAYWRIGHT_CORE).chromium;
  return _chromium;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function aceTail(bytes = 262144) {
  const size = statSync(ACE_LOG).size, fd = openSync(ACE_LOG, "r");
  const b = Buffer.alloc(Math.min(bytes, size));
  readSync(fd, b, 0, b.length, size - b.length); closeSync(fd);
  return b.toString("utf8");
}

/** Wait until ACE's log says the bench account logged out (or never logged in). */
export async function waitAccountFree(account = "tailnet1", maxMs = 150000) {
  const re = new RegExp(`\\[(LOGIN|LOGOUT)\\] Account ${account} `);
  const end = Date.now() + maxMs;
  while (Date.now() < end) {
    let ev = [];
    try { ev = aceTail().split("\n").filter((l) => re.test(l)); } catch (_) { return null; }
    const last = ev[ev.length - 1];
    if (!last || /\[LOGOUT\]/.test(last)) return true;
    await sleep(2000);
  }
  return false;
}

/** Playwright connectOverCDP right after launch (before browser_ui targets exist). 30 s cap. */
export async function connectAtLaunch(cdp = CDP) {
  const pw = chromium().connectOverCDP(cdp);
  const browser = await Promise.race([pw, sleep(30000).then(() => null)]);
  if (!browser) { pw.then((b) => b.close().catch(() => {}), () => {}); throw new Error("connectOverCDP did not attach in 30 s right after launch"); }
  const ctx = browser.contexts()[0];
  const pg = ctx.pages()[0] || (await ctx.newPage());
  return { browser, ctx, pg };
}

/** Attach to the running game page: Playwright for 15 s, then raw CDP (hbsess.mjs page()). */
export async function attach(cdp = CDP) {
  const pw = chromium().connectOverCDP(cdp).then((browser) => {
    const ctx = browser.contexts()[0];
    const pg = ctx.pages().find((p) => p.url().includes("holtburger-web")) || ctx.pages()[0];
    return { browser, ctx, pg };
  });
  const r = await Promise.race([pw, sleep(15000).then(() => null)]);
  if (r) return r;
  pw.catch(() => {});
  console.error("[hb_session] connectOverCDP did not attach in 15 s: raw CDP to the page target (lib/cdp_raw.mjs)");
  const { rawSession } = await import("./cdp_raw.mjs");
  return rawSession(cdp);
}

/**
 * Make the page's INNER size exactly target {w, h}: read inner/outer, set the window bounds through
 * CDP Browser.setWindowBounds (width/height only — the window stays off-screen), up to 3 passes.
 * FALLBACK: Windows caps a window's tracking size near the desktop size, so on a 1920x1080 panel an
 * inner 1920x1080 under the browser's tab strip may be unreachable; then the viewport is pinned with
 * Emulation.setDeviceMetricsOverride (the canvas renders at the target; the compositor clips to the
 * window) and `emulated: true` is recorded. That override lives as long as its CDP session, so the
 * session is kept on the non-enumerable `_session` (not serialised) and only detached when unused.
 * Returns {target, inner, outer, dpr, passes, ok, emulated, error?}. Playwright pages only.
 */
export async function sizeWindow(ctx, pg, target, { emulateFallback = true } = {}) {
  const out = { target: [target.w, target.h], passes: 0, ok: false, emulated: false };
  try {
    const s = await ctx.newCDPSession(pg);
    const { windowId } = await s.send("Browser.getWindowForTarget");
    for (let i = 0; i < 3; i++) {
      const m = await pg.evaluate(() => ({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, dpr: devicePixelRatio }));
      out.inner = [m.iw, m.ih]; out.outer = [m.ow, m.oh]; out.dpr = m.dpr;
      if (Math.abs(m.iw - target.w) <= 1 && Math.abs(m.ih - target.h) <= 1) { out.ok = true; break; }
      // inner/outer are CSS px and the bounds are DIPs: equal at the box's devicePixelRatio 1, and the
      // loop re-reads and corrects (3 passes) if a scale factor makes one pass land off by a few px.
      const w = Math.round(m.ow + (target.w - m.iw));
      const h = Math.round(m.oh + (target.h - m.ih));
      await s.send("Browser.setWindowBounds", { windowId, bounds: { width: w, height: h, windowState: "normal" } });
      out.passes++;
      await sleep(600);
    }
    if (!out.ok) {
      const m = await pg.evaluate(() => ({ iw: innerWidth, ih: innerHeight, ow: outerWidth, oh: outerHeight, dpr: devicePixelRatio }));
      out.inner = [m.iw, m.ih]; out.outer = [m.ow, m.oh]; out.dpr = m.dpr;
      out.ok = Math.abs(m.iw - target.w) <= 1 && Math.abs(m.ih - target.h) <= 1;
    }
    if (!out.ok && emulateFallback) {
      out.windowInner = out.inner;
      await s.send("Emulation.setDeviceMetricsOverride", { width: target.w, height: target.h, deviceScaleFactor: 0, mobile: false });
      const m = await pg.evaluate(() => ({ iw: innerWidth, ih: innerHeight, dpr: devicePixelRatio }));
      out.inner = [m.iw, m.ih]; out.dpr = m.dpr; out.emulated = true;
      out.ok = Math.abs(m.iw - target.w) <= 1 && Math.abs(m.ih - target.h) <= 1;
      Object.defineProperty(out, "_session", { value: s, enumerable: false });
    } else {
      try { await s.detach(); } catch (_) { /* gone */ }
    }
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 200); }
  return out;
}

/**
 * Wait for the boot. readyWhen "boot-ready" (default, hbbench's rule): liveScene3d + session handle +
 * `__bootStateHistory` reached "ready". "live-scene": liveScene3d + session handle only (a
 * ?nullRender=1 floor arm may never paint the frame that marks the boot ready).
 */
export async function waitBootReady(pg, { readyWhen = "boot-ready", tries = 150 } = {}) {
  const t0 = Date.now();
  let ok = false;
  for (let i = 0; i < tries && !ok; i++) {
    ok = await pg.evaluate((mode) => !!window.liveScene3d && !!window.__sessionHandle &&
      (mode === "live-scene" || (window.__bootStateHistory || []).some((s) => (s.state || s) === "ready")), readyWhen).catch(() => false);
    if (!ok) await sleep(1000);
  }
  return { ok, ms: Date.now() - t0, readyWhen };
}

/** @teleloc / @telepoi the bench account, then hbbench's settle loop (LRU size + geometry count steady 12 s). */
export async function teleportSettle(pg, spot = "0xA9B40001 96 96 80", { landMs = 8000, maxMs = 150000, quietMs = 12000 } = {}) {
  const cmd = String(spot).startsWith("poi:") ? `@telepoi ${String(spot).slice(4)}` : `@teleloc ${spot}`;
  await pg.evaluate((c) => window.__sessionHandle.sendChat(c), cmd);
  await sleep(landMs);
  let last = null, since = Date.now();
  const ts = Date.now();
  let quiet = false;
  while (Date.now() - ts < maxMs) {
    const cur = await pg.evaluate(() => `${window.__landblockLru?.entries?.size}|${window.liveScene3d?.renderer?.info?.memory?.geometries}`).catch(() => null);
    if (cur !== last) { last = cur; since = Date.now(); } else if (Date.now() - since >= quietMs) { quiet = true; break; }
    await sleep(1000);
  }
  return { cmd, settled: last, quiet, ms: Date.now() - ts };
}

const _wasmCache = new Map();
/** Release-or-dev of a wasm URL served on this laptop (fetched once per URL). */
export async function wasmProfileOf(url) {
  if (_wasmCache.has(url)) return _wasmCache.get(url);
  let r;
  try {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    const d = detectWasmProfile(bytes);
    r = { url, profile: d.profile, reason: d.reason, size: d.size };
  } catch (e) { r = { url, profile: "unknown", reason: `fetch failed: ${String((e && e.message) || e).slice(0, 120)}`, size: null }; }
  _wasmCache.set(url, r);
  return r;
}

/** The served pkg wasm of an app base URL (…/apps/holtburger-web/index.html). */
export function servedWasmUrl(app) {
  return String(app).replace(/index\.html(\?.*)?$/, "") + "pkg/holtburger_web_bg.wasm";
}
