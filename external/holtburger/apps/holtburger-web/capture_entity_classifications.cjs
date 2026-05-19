// Phase E.F — `capture-entity-classifications`
//
// Live capture-replay validator for the entity-completeness contract
// (docs/entity-completeness-method.md). Boots holtburger-web in headless
// Chromium against the live local ACE, spawns into Holtburg, lets the
// burst of `ObjectCreate` events drain, then captures
// `window.__wom.snapshot()` — a structured dump of every live
// WorldObject's typed classification + the three wire inputs that
// produced it.
//
// **Sister script to** `validate_entity_classification.cjs` (E.D —
// synthetic payloads) **and** `scripts/cross_port_parity.cjs` (E.E —
// JS↔C# port parity). Where those two assert algorithm correctness over
// hand-curated inputs, THIS validator asserts algorithm coverage over
// real wire payloads — every entity ACE actually ships in a populated
// zone must classify to a real ObjectClass, not the `Unknown` sentinel.
//
// **Probe scenario:**
//   1. Boot at Holtburg (LB 0xA9B4 — retail-active, ~30 NPCs/vendors in PVS).
//   2. /godly to prevent fall damage during drain.
//   3. Wait 60 s for ObjectCreate burst to plateau.
//   4. Capture `window.__wom.snapshot()`.
//   5. Assert: total > MIN_SPAWNS, unknownCount <= MAX_UNKNOWN_TOLERANCE.
//   6. Write snapshot JSON to /mnt/wbterminal1/holtburger-captures/.
//
// **What this catches that E.D/E.E don't:**
//   - Real wire payload combinations our synthetic test suite missed
//     (every real Unknown is a coverage gap in the classifier)
//   - Wire-format drift: if ACE starts sending a previously-unset bit,
//     the classifier may behave differently from what unit tests covered
//   - Inhabited-zone sanity: Holtburg should have Vendor + NPC + Monster
//     + Door + Lifestone + Static in plausible ratios
//
// **Pre-reqs** (mirror existing capture_academy_entities.cjs):
//   - Live ACE on Tailscale 100.116.47.66 UDP 9000/9001
//   - holtburger-wsbridge on ws://127.0.0.1:8080/
//   - `python3 -m http.server 8765` from `external/holtburger/`
//   - Manifest + shards baked under `dist/`
//   - Playwright in npx cache at `PLAYWRIGHT_CACHE`
//
// **Run from `apps/holtburger-web/`:**
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_entity_classifications.cjs
//
// **Exit:** 0 on PASS, 1 on coverage/Unknown failure, 2 on infra error.

const path = require("node:path");
const fs = require("node:fs");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

let chromium;
try {
  // eslint-disable-next-line global-require
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
    // eslint-disable-next-line global-require
    ({ chromium } = require(path.join(PLAYWRIGHT_CACHE, "playwright")));
  } catch (e) {
    console.error(
      "FAIL: playwright not found in NODE_PATH or " + PLAYWRIGHT_CACHE +
      "\nSet NODE_PATH or PLAYWRIGHT_CACHE."
    );
    process.exit(2);
  }
}

(async () => {
  const RUN_TAG    = process.env.ECF_RUN_TAG || `eclas${Date.now().toString(36)}`;
  const ACCOUNT    = process.env.PHASE4_TEST_ACCOUNT  || RUN_TAG;
  const PASSWORD   = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
  const CHAR_NAME  = process.env.ECF_CHAR_NAME || `EcF${RUN_TAG.slice(-5)}`;
  const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL    || "ws://127.0.0.1:8080/";
  const SERVER_IP  = process.env.PHASE4_SERVER_IP     || "100.116.47.66";
  const SERVER_PORT = process.env.PHASE4_SERVER_PORT  || "9000";
  const PAGE_URL   = process.env.PHASE4_PAGE_URL ||
    "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d";

  const SMOKE_TIMEOUT_MS   = Number(process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000);
  const SPAWN_TIMEOUT_MS   = Number(process.env.ECF_SPAWN_TIMEOUT_MS    || 60_000);
  const CREATE_TIMEOUT_MS  = Number(process.env.ECF_CREATE_TIMEOUT_MS   || 30_000);
  const ENTITY_DRAIN_MS    = Number(process.env.ECF_ENTITY_DRAIN_MS     || 60_000);
  const GODMODE_CHAT       = process.env.ECF_GODMODE_CHAT || "/godly";
  const ENABLE_GODMODE     = process.env.ECF_ENABLE_GODMODE !== "0";

  // Acceptance thresholds — calibrated by 2026-05-19 live capture:
  //   - 36 entities spawn in Holtburg PVS at character creation
  //   - 6 of those are Writable-without-Book items (Letter From Home +
  //     manual screens + quest book) for which ACPlugin's GetObjectClass
  //     intentionally returns Unknown. This is upstream-faithful
  //     behavior, not a port bug. See docs/entity-completeness-method.md
  //     §E.F for the gap analysis.
  // Default tolerance accommodates the known upstream gap; CI / operator
  // can override via env var if drift detection is needed.
  const MIN_SPAWNS         = Number(process.env.ECF_MIN_SPAWNS         || 5);
  const MAX_UNKNOWN_TOL    = Number(process.env.ECF_MAX_UNKNOWN_TOL    || 10);

  // LB 0xA9B4 = Holtburg per memory `project_holtburg_h2_h3_done_2026-05-12.md`.
  // Reserved for future explicit LB-stability gate; spawn-to-Holtburg is the
  // default character-creation destination so we don't need to assert today.
  // eslint-disable-next-line no-unused-vars
  const HOLTBURG_LB_KEY = 0xA9B40000 >>> 0;

  const TS = Date.now();
  const CAP_DIR = process.env.ECF_CAP_DIR || "/mnt/wbterminal1/holtburger-captures";
  fs.mkdirSync(CAP_DIR, { recursive: true });
  const SCREENSHOT_PATH = path.resolve(CAP_DIR, `entity-class-${TS}.png`);
  const SNAPSHOT_PATH   = path.resolve(CAP_DIR, `entity-class-${TS}.json`);
  const DIAG_LOG_PATH   = path.resolve(CAP_DIR, `entity-class-diag-${TS}.log`);

  console.log(`launching chromium → ${PAGE_URL}`);
  console.log(`target ACE: ${SERVER_IP}:${SERVER_PORT} via ${BRIDGE_URL}`);
  console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
  console.log(`snapshot path: ${SNAPSHOT_PATH}`);

  fs.writeFileSync(DIAG_LOG_PATH,
    `# entity-classification capture transcript ${new Date().toISOString()}\n`);

  const browser = await chromium.launch({
    args: [
      "--use-gl=swiftshader", "--disable-dev-shm-usage", "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-features=PaintHoldingCrossOrigin,PaintHolding",
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
  const page = await context.newPage();

  page.on("console", (msg) => {
    const text = msg.text();
    try { fs.appendFileSync(DIAG_LOG_PATH, `[${msg.type()}] ${text}\n`); } catch (_) {}
    if (/\[wom\]|ObjectCreate|canonical/i.test(text)) {
      console.log(`[browser ${msg.type()}] ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    console.error("[pageerror]", err.message);
    try { fs.appendFileSync(DIAG_LOG_PATH, `[pageerror] ${err.message}\n`); } catch (_) {}
  });

  // ── Boot page ────────────────────────────────────────────────────
  try {
    await page.goto(PAGE_URL, { waitUntil: "domcontentloaded" });
    await page.waitForFunction(
      () => {
        const r = document.getElementById("results");
        return r && /PASS/.test(r.innerHTML);
      },
      { timeout: SMOKE_TIMEOUT_MS }
    );
    console.log("in-page smoke panel: PASS");
  } catch (e) {
    console.error(`FAIL: smoke panel never reached PASS within ${SMOKE_TIMEOUT_MS}ms`);
    await page.screenshot({ path: SCREENSHOT_PATH }).catch(() => {});
    await browser.close();
    process.exit(2);
  }

  // ── Login ────────────────────────────────────────────────────────
  try {
    await page.fill('input[name="account"]',     ACCOUNT);
    await page.fill('input[name="password"]',    PASSWORD);
    await page.fill('input[name="bridge_url"]',  BRIDGE_URL);
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 90_000 });
    console.log(`logged in as ${ACCOUNT}`);
  } catch (e) {
    console.error(`FAIL: login timeout: ${e?.message ?? e}`);
    await page.screenshot({ path: SCREENSHOT_PATH }).catch(() => {});
    await browser.close();
    process.exit(2);
  }
  await page.waitForTimeout(500);

  // ── Character create if needed ───────────────────────────────────
  const initialCount = await page.locator('#character-ul button[data-id]').count();
  if (initialCount === 0) {
    console.log(`creating character "${CHAR_NAME}"`);
    await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
    await page.click('#create-button');
    await page.waitForFunction(() => {
      const s = document.getElementById("create-status");
      return s && /Created\b/.test(s.innerText);
    }, { timeout: CREATE_TIMEOUT_MS });
    await page.waitForFunction(
      () => document.querySelectorAll('#character-ul button[data-id]').length > 0,
      { timeout: 10_000 }
    );
    console.log("character created");
  }

  // ── Spawn ────────────────────────────────────────────────────────
  await page.locator('#character-ul button[data-id]').first().click();
  console.log("clicked first Spawn button");
  await page.waitForFunction(
    () => {
      const s = document.getElementById("login-status");
      return s && /InWorld|Spawned/.test(s.innerText);
    },
    { timeout: SPAWN_TIMEOUT_MS }
  );
  console.log("Spawned/InWorld status reached");
  await page.waitForTimeout(3000);

  // ── /godly ───────────────────────────────────────────────────────
  if (ENABLE_GODMODE) {
    const godResult = await page.evaluate((line) => {
      const h = window.__sessionHandle;
      if (h && typeof h.sendChat === "function") {
        try { h.sendChat(line); return "sent"; }
        catch (e) { return `err: ${e.message || e}`; }
      }
      return "no handle";
    }, GODMODE_CHAT);
    console.log(`${GODMODE_CHAT} dispatch: ${godResult}`);
    await page.waitForTimeout(1500);
  }

  // ── Wait for WorldObjectManager to be ready ──────────────────────
  console.log(`waiting up to 10s for window.__wom to be loaded...`);
  await page.waitForFunction(
    () => window.__wom && window.__wom.loaded === true,
    { timeout: 10_000 }
  ).catch(() => {
    console.error(`FAIL: window.__wom never loaded — was the manager wired in?`);
  });

  // ── Drain entity spawn burst ─────────────────────────────────────
  console.log(`draining for ${ENTITY_DRAIN_MS}ms (sampling __wom.count() every 5s)...`);
  const drainDeadline = Date.now() + ENTITY_DRAIN_MS;
  const trajectory = [];
  while (Date.now() < drainDeadline) {
    const status = await page.evaluate(() => {
      const wom = window.__wom;
      if (!wom) return { total: -1 };
      return { total: wom.count(), loaded: wom.loaded };
    });
    trajectory.push({ t: Date.now(), ...status });
    console.log(`  drain: __wom.count() = ${status.total}`);
    await page.waitForTimeout(5000);
  }

  // ── Capture the snapshot ─────────────────────────────────────────
  const snapshot = await page.evaluate(() => {
    return window.__wom?.snapshot?.() ?? null;
  });
  if (!snapshot) {
    console.error(`FAIL: window.__wom.snapshot() returned null/undefined`);
    await page.screenshot({ path: SCREENSHOT_PATH }).catch(() => {});
    await browser.close();
    process.exit(2);
  }

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify({
    captureScript: "capture_entity_classifications.cjs",
    contractDoc:   "docs/entity-completeness-method.md §E.F",
    classifier:    "plugins/world-objects/canonical_classify.js",
    runTag:        RUN_TAG,
    pageUrl:       PAGE_URL,
    aceTarget:     `${SERVER_IP}:${SERVER_PORT}`,
    drainMs:       ENTITY_DRAIN_MS,
    trajectory,
    snapshot,
  }, null, 2));
  console.log(`snapshot written to ${SNAPSHOT_PATH}`);
  await page.screenshot({ path: SCREENSHOT_PATH }).catch(() => {});

  // ── Assert + report ──────────────────────────────────────────────
  console.log("");
  console.log("entity-classification capture report");
  console.log("====================================");
  console.log(`total spawned: ${snapshot.total}`);
  console.log(`unknown count: ${snapshot.unknownCount}`);
  console.log("");
  console.log(`item fallback count: ${snapshot.itemFallbackCount ?? 0}` +
    `  (canonical returned a valid ObjectClass but no typed JS class exists ` +
    `— instantiated as Item; mirrors ACPlugin's World.cs:622-706 dispatch)`);
  console.log("");
  console.log("JS class distribution:");
  const sortedClasses = Object.entries(snapshot.byClass).sort((a, b) => b[1] - a[1]);
  for (const [cls, count] of sortedClasses) {
    console.log(`  ${cls.padEnd(20)} ${count}`);
  }
  console.log("");
  if (snapshot.byCanonical) {
    console.log("Canonical ObjectClass distribution (pre-JS-dispatch):");
    const sortedCanonical = Object.entries(snapshot.byCanonical).sort((a, b) => b[1] - a[1]);
    for (const [cls, count] of sortedCanonical) {
      console.log(`  ${cls.padEnd(20)} ${count}`);
    }
    console.log("");
  }

  // Sample one of each class for the diag log
  console.log("sample by class (one example each):");
  const seenClasses = new Set();
  for (const obj of snapshot.objects) {
    if (seenClasses.has(obj.className)) continue;
    seenClasses.add(obj.className);
    console.log(`  [${obj.className}] guid=0x${obj.guid.toString(16).padStart(8,'0')} ` +
                `wcid=0x${obj.classId.toString(16).padStart(8,'0')} name="${obj.name}" ` +
                `src=${obj.classificationSource}`);
  }
  console.log("");

  let failure = false;
  if (snapshot.total < MIN_SPAWNS) {
    console.error(`FAIL: only ${snapshot.total} entities spawned; expected ≥ ${MIN_SPAWNS}. ` +
      `Holtburg should have more — likely ACE wasn't populated or the drain was too short.`);
    failure = true;
  }
  if (snapshot.unknownCount > MAX_UNKNOWN_TOL) {
    console.error(`FAIL: ${snapshot.unknownCount} entities classified as Unknown ` +
      `(tolerance ${MAX_UNKNOWN_TOL}). Each Unknown is a coverage gap in canonical_classify.js — ` +
      `inspect the snapshot's objects[] for classificationSource: 'unknown' entries, ` +
      `then port the missing algorithm branch from ACPlugin/API/WorldObject.cs.`);
    // Show the Unknown samples
    const unknowns = snapshot.objects.filter(o => o.classificationSource === 'unknown').slice(0, 10);
    for (const u of unknowns) {
      console.error(`  unknown: guid=0x${u.guid.toString(16)} wcid=0x${u.classId.toString(16)} ` +
        `name="${u.name}" itemType=0x${u.itemType.toString(16)} ` +
        `objDescFlags=0x${u.objDescFlags.toString(16)} weenieFlags=0x${u.weenieFlags.toString(16)}`);
    }
    failure = true;
  }

  await browser.close();

  if (failure) {
    console.error("");
    console.error(`E.F FAIL — see ${SNAPSHOT_PATH} for full diagnostic.`);
    process.exit(1);
  }
  console.log(`E.F PASS — ${snapshot.total} entities classified, ${snapshot.unknownCount} Unknown.`);
  process.exit(0);
})().catch(e => {
  console.error("capture crashed:", e);
  process.exit(2);
});
