#!/usr/bin/env node
// s14boot.mjs — launch a DETACHED headless Chrome on the T4, navigate holtburger-web,
// drive it to __bootState === 'ready', then EXIT leaving the browser alive.
//
// Why detached rather than arm.mjs's one-shot step program: every S14 arm must come
// from ONE login at ONE identical camera pose (statPom is a live uniform, so the
// arms are uniform flips, not reboots). A one-shot program cannot be steered from
// what the previous frame showed; a persistent browser can. The 3-min per-account
// login cooldown makes re-booting per arm untenable anyway.
//
// usage: node s14boot.mjs <cdpPort> <url>
import { spawn } from "node:child_process";
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const PORT = Number(process.argv[2] || 9342);
const URL_ = process.argv[3];
if (!URL_) { console.error("usage: node s14boot.mjs <cdpPort> <url>"); process.exit(1); }
const PROFILE = `/tmp/cdp-s14-${PORT}`;
const OUT = "/home/wbterminal/fanout-s12/B/eyetest-B/out";
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const say = (...a) => console.log("[s14boot]", ...a);

fs.rmSync(PROFILE, { recursive: true, force: true });
const child = spawn("google-chrome", [
  "--headless=new", "--no-sandbox", "--use-gl=angle", "--use-angle=gl-egl",
  "--mute-audio", "--enable-unsafe-webgpu", "--ignore-gpu-blocklist",
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${PROFILE}`,
  "--window-size=1600,1000", "--hide-scrollbars", "about:blank",
], { stdio: ["ignore", "ignore", "ignore"], detached: true });
child.unref();
say("chrome spawned detached, pid", child.pid, "profile", PROFILE);

let browser = null;
for (let i = 0; i < 80; i++) {
  try { browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: { width: 1600, height: 1000 } }); break; }
  catch (_) { await sleep(500); }
}
if (!browser) { console.error("could not connect CDP"); process.exit(2); }

const page = (await browser.pages())[0] || await browser.newPage();
await page.setViewport({ width: 1600, height: 1000 });

// three.js builds its context with preserveDrawingBuffer:false, so any capture
// taken outside the render call reads a cleared (black) buffer. Same fix arm.mjs uses.
await page.evaluateOnNewDocument(() => {
  const orig = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    if (type === "webgl2" || type === "webgl" || type === "experimental-webgl") {
      attrs = Object.assign({}, attrs || {}, { preserveDrawingBuffer: true });
    }
    return orig.call(this, type, attrs);
  };
  window.__preserveDrawingBufferForced = true;
  // Keep a rolling console tail on the page so a later attach can read it.
  window.__s14log = [];
  for (const lvl of ["log", "warn", "error"]) {
    const o = console[lvl].bind(console);
    console[lvl] = (...a) => { try { window.__s14log.push(lvl + ": " + a.map(String).join(" ")); if (window.__s14log.length > 4000) window.__s14log.shift(); } catch (_) {} return o(...a); };
  }
});

say("navigating", URL_);
await page.goto(URL_, { waitUntil: "domcontentloaded", timeout: 120000 });

// Renderer proof from INSIDE the page — a software renderer would misrepresent the look.
const renderer = await page.evaluate(() => {
  const c = document.createElement("canvas");
  const gl = c.getContext("webgl2") || c.getContext("webgl");
  if (!gl) return "NO-GL";
  const d = gl.getExtension("WEBGL_debug_renderer_info");
  return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
});
say("renderer:", renderer);

const t0 = Date.now();
let st = null;
while (Date.now() - t0 < 300000) {
  st = await page.evaluate(() => ({
    boot: window.__bootState || null,
    hist: (window.__bootStateHistory || []).map((e) => e.state),
    last: (window.__bootStateHistory || []).slice(-1)[0] || null,
    live: !!window.liveScene3d, cam: !!window.__cam,
  })).catch(() => null);
  if (st && st.boot === "ready") break;
  await sleep(2000);
}
say("bootState:", JSON.stringify(st));
fs.writeFileSync(`${OUT}/s14-boot.json`, JSON.stringify({ url: URL_, port: PORT, renderer, state: st, atMs: Date.now() - t0 }, null, 2));

await browser.disconnect();          // leave chrome RUNNING
say(st && st.boot === "ready" ? "READY — browser left alive" : "NOT-READY — browser left alive for diagnosis");
process.exit(st && st.boot === "ready" ? 0 : 3);
