#!/usr/bin/env node
// soak_launch.cjs — launch the HEADLESS explorer discovery soak with the perf
// sampler attached, and tap [perfsample] into a JSONL. Replaces the streamed
// kiosk bot: no X, no ffmpeg, wireframe frames only (cheap, real — measurable).
//
// The LLM director drives the explorer's movement (kernel off, so no grind);
// therefore the OpenRouter key MUST be live at first boot. We pre-seed it into
// localStorage via addInitScript so createGrindBot (bot.js:380) finds it on the
// first wire — no reload, no Account-In-Use churn.
//
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//     node perf/soak_launch.cjs --out perf/samples-<ts>.jsonl [--minutes N] [--fps 30]
//
// Health line every 60s: calls / lb / baked / samples / availMB.

const fs = require("fs");
const path = require("path");
const { SAMPLER_FN } = require("./perf_sampler.cjs");

const HERE = path.dirname(__dirname); // apps/holtburger-web
const KEY_FILE = "/mnt/wbterminal2/stream/.keys/openrouter-key";
const KEY_STORAGE = "holtburger_ai_key_v1";
const BASE = "http://127.0.0.1:8765/apps/holtburger-web/index.html";

// Fork #2 — coverage floor (prompt insurance). The explorer's coverage is the
// ONLY thing the LLM prompt controls; a wedged/weak director must not stall the
// whole loop. When new-landblock coverage dries up (or the director stops moving
// AND stops thinking), jailbreak to fresh content with @telepoi — a Developer
// command the soak account (accessLevel 4) can issue. This decouples loop
// PROGRESS from prompt QUALITY: a bad prompt just means the floor does more work.
// Rotation = geographically/content-diverse POIs (world DB points_of_interest),
// leading with the two historically perf-hostile targets so discovery keeps
// hammering the known offenders even if the director never chooses them.
const POI_ROTATION = [
  "Town Network", "Marketplace",              // known offenders (handoff)
  "Arwic", "Holtburg", "Cragstone", "Rithwic", "Eastham", "Glenden Wood",
  "Yaraq", "Shoushi", "Nanto", "Zaikhal", "Qalabar", "Hebian-to", "Mayoi",
  "Sawato", "Uziz", "Xarabydun", "Ayan Baqur", "Samsur", "Lin", "Baishi",
  "Sanamar", "Timaru", "Fort Tethana", "Linvak Tukal", "Neydisa", "Fiun",
];
const COVERAGE_FLOOR_MS = 4 * 60000; // no new landblock in this window => jailbreak

function arg(name, def) {
  const i = process.argv.indexOf("--" + name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--") ? process.argv[i + 1] : def;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function availMB() {
  try { const m = fs.readFileSync("/proc/meminfo", "utf8").match(/MemAvailable:\s+(\d+)/); return m ? Math.round(+m[1] / 1024) : -1; } catch (e) { return -1; }
}
function log(m) { console.log(new Date().toISOString() + " [soak] " + m); }

(async function main() {
  const outF = arg("out", path.join(__dirname, "samples-" + Date.now() + ".jsonl"));
  const minutes = parseFloat(arg("minutes", "100000"));
  const fps = arg("fps", "30");
  const account = arg("account", "vendortest");
  const emitMs = parseInt(arg("emit", "10000"), 10);
  const key = fs.readFileSync(KEY_FILE, "utf8").trim();
  if (!key) { console.error("no OpenRouter key at " + KEY_FILE); process.exit(1); }

  let chromium;
  try { ({ chromium } = require("playwright")); }
  catch (e) { try { ({ chromium } = require("playwright-core")); } catch (e2) { console.error("Playwright not on NODE_PATH"); process.exit(1); } }

  // Explorer discovery URL: wireframe (cheap real frames), LLM-driven movement,
  // kernel off (no grind), fps cap high enough that slow landblocks still fall
  // below it (a cap only hides differences ABOVE it; offenders sit below).
  const url = BASE + "?nosw=1&nullRender=0&wireframe=1&targetFps=" + fps +
    "&netDrainHz=30&autoLogin=1&account=" + account + "&password=" + account +
    "&autoSpawn=first&kickDance=1&agent=1&bot=1&botModel=z-ai/glm-5.2&botInterval=1" +
    "&botPersona=explorer&botKernel=off";

  log("launching headless · " + url);
  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu", "--disable-dev-shm-usage"] });
  const ctx = await browser.newContext();
  await ctx.addInitScript(([k, v]) => { try { localStorage.setItem(k, v); } catch (e) {} }, [KEY_STORAGE, key]);
  const page = await ctx.newPage();

  // Console tap: [perfsample] -> stamped JSONL. Driver clock is the only trusted clock.
  const stream = fs.createWriteStream(outF, { flags: "a" });
  let sampleCount = 0;
  page.on("console", (m) => {
    const t = m.text();
    if (t.startsWith("[perfsample] ")) {
      try { const s = JSON.parse(t.slice(13)); s.wallT = Date.now(); stream.write(JSON.stringify(s) + "\n"); sampleCount++; } catch (e) {}
    }
  });

  // Boot with reload-retry around single-shot autoLogin (mirrors rynth_boot_helper).
  let inWorld = false;
  for (let attempt = 1; attempt <= 5 && !inWorld; attempt++) {
    await page.goto(url + "&v=" + Date.now(), { waitUntil: "domcontentloaded", timeout: 60000 }).catch(() => {});
    for (let i = 0; i < 60; i++) {
      const st = await page.evaluate(() => window.__bootState || "").catch(() => "");
      if (st === "in-world" || st === "ready") { inWorld = true; break; }
      if (st === "error") break;
      await sleep(2000);
    }
    if (!inWorld) log("boot attempt " + attempt + " not in-world; retrying");
  }
  if (!inWorld) { log("FAILED to reach in-world after 5 attempts — aborting"); await browser.close(); process.exit(2); }
  log("in-world");

  // Install the sampler.
  await page.evaluate(SAMPLER_FN, { emitMs });
  log("sampler installed (emit " + emitMs + "ms) -> " + path.relative(HERE, outF));

  // Health loop: verify the director is driving (calls climbing) and the
  // explorer is roaming (landblock changing). Enforce the coverage floor: if no
  // NEW landblock appears within COVERAGE_FLOOR_MS — or the explorer is fully
  // wedged (no move + no call) — jailbreak to the next POI.
  let lastCalls = -1, lastLb = null, stalls = 0, poiIdx = 0, jailbreaks = 0;
  const seen = new Set();
  let lastNewCoverage = Date.now();
  async function jailbreak(why) {
    const poi = POI_ROTATION[poiIdx % POI_ROTATION.length]; poiIdx++;
    try { await page.evaluate((c) => window.__bot.host.WriteToChat(c), "@telepoi " + poi); jailbreaks++;
      log("JAILBREAK #" + jailbreaks + " -> @telepoi " + poi + " (" + why + ")"); }
    catch (e) { log("jailbreak failed: " + (e && e.message)); }
    lastNewCoverage = Date.now(); stalls = 0; // give the new area time before re-firing
  }
  const deadline = Date.now() + minutes * 60000;
  while (Date.now() < deadline) {
    await sleep(60000);
    const h = await page.evaluate(() => {
      let calls = -1, lb = null, baked = null;
      try { calls = window.rynthAI && window.rynthAI.status ? window.rynthAI.status().calls : -1; } catch (e) {}
      try { const p = window.__bot.host.TryGetPlayerPose(); lb = p ? "0x" + ((p.objCellId >>> 16) >>> 0).toString(16) : null; } catch (e) {}
      try { baked = window.liveScene3d && window.liveScene3d.terrainBakedLbs ? window.liveScene3d.terrainBakedLbs.size : null; } catch (e) {}
      return { calls, lb, baked };
    }).catch(() => ({ calls: -2, lb: null, baked: null }));
    if (h.lb && !seen.has(h.lb)) { seen.add(h.lb); lastNewCoverage = Date.now(); }
    const moving = h.lb !== lastLb, thinking = h.calls > lastCalls;
    if (!moving && !thinking) stalls++; else stalls = 0;
    lastCalls = h.calls; lastLb = h.lb;
    const am = availMB();
    const coverAgeS = Math.round((Date.now() - lastNewCoverage) / 1000);
    log("calls=" + h.calls + " lb=" + h.lb + " baked=" + h.baked + " seen=" + seen.size + " samples=" + sampleCount + " availMB=" + am + (stalls ? " STALL×" + stalls : "") + " coverAge=" + coverAgeS + "s");
    if (am >= 0 && am < 300) log("ALERT: memory low availMB=" + am);
    // Coverage floor: fire on wedge (fast) or on coverage drought (slower).
    if (stalls >= 3) await jailbreak("wedged ×" + stalls);
    else if (Date.now() - lastNewCoverage > COVERAGE_FLOOR_MS) await jailbreak("no new LB " + coverAgeS + "s");
  }
  log("minutes elapsed — stopping");
  try { await page.evaluate(() => window.__perfSampler && window.__perfSampler.stop()); } catch (e) {}
  stream.end(); await browser.close();
})().catch((e) => { console.error("[soak] fatal " + (e && e.stack || e)); process.exit(1); });
