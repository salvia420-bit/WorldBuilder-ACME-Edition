// K.1 drive: full interactive validation against the 1070 Chrome.
//
// 1. Hard-bust the service-worker cache so freshly-edited JS lands.
// 2. Login as tailnet1/tailnet1 with retry — per the user's note, if
//    the character is already in-game ACE uses the first connection
//    to log it out (~7s); a second attempt after the kick succeeds.
// 3. Spawn → @telepoi Holtburg → poll entityMap for a creature.
// 4. Toggle combat mode → assert the stance label flipped (verifies
//    the applyConfirmedStance → playerStatsUpdated fix).
// 5. Attack the nearest creature → watch chat log + ACE log for the
//    actual damage / attack-done events.
//
// Renders 2D (no `?renderer=3d`) for a lighter test surface — combat
// chat lines still flow.

const { chromium } = require("playwright");
const fs = require("node:fs");
const path = require("node:path");

const CDP_URL = process.env.K1_CDP_URL || "http://127.0.0.1:9223";
// Use 2D, no atmosphere/clouds; that keeps the page light AND
// guarantees the wasm/recv loop is the only moving target.
const PAGE_URL = process.env.K1_PAGE_URL
  || "http://localhost:7080/apps/holtburger-web/index.html";
const OUT_DIR = "/mnt/wbterminal1/tmp/claude-scratch/k1";
const ACE_LOG_PATH = "/mnt/wbterminal1/tmp/claude-scratch/k1/ace.log";

const ACCOUNT = "tailnet1";
const PASSWORD = "tailnet1";

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function tailAceLog(sinceOffset, sinceTs) {
  if (!fs.existsSync(ACE_LOG_PATH)) return "";
  const sz = fs.statSync(ACE_LOG_PATH).size;
  const newBytes = sz - sinceOffset;
  if (newBytes <= 0) return "";
  const fd = fs.openSync(ACE_LOG_PATH, "r");
  const buf = Buffer.alloc(newBytes);
  fs.readSync(fd, buf, 0, newBytes, sinceOffset);
  fs.closeSync(fd);
  return buf.toString("utf8");
}

(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.connectOverCDP(CDP_URL);
  const ctx = browser.contexts()[0];
  const pages = ctx.pages();
  const HB_PREFIX = "http://localhost:7080/apps/holtburger-web/";
  let page = pages.find((p) => p.url().startsWith(HB_PREFIX));
  if (!page) {
    page = await ctx.newPage();
  }
  console.log(`page: ${page.url()}`);

  // ── 1. cache-bust ────────────────────────────────────────────
  console.log("\n# 1. cache-bust");
  await page.goto("about:blank");
  // Clear browser-level HTTP cache via CDP (covers both disk +
  // in-memory caches). Without this, the wasm bundle and the
  // `?v=h3-e1` cache-busted JS imports keep serving the previous
  // build even after we unregister the service worker.
  const cdp = await page.context().newCDPSession(page);
  try {
    await cdp.send("Network.clearBrowserCache");
    await cdp.send("Network.clearBrowserCookies");
    console.log("CDP: Network.clearBrowserCache OK");
  } catch (e) {
    console.warn("CDP cache clear failed:", e.message);
  }
  // Unregister service workers + clear caches.
  await page.evaluate(async () => {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) {
        try {
          await r.unregister();
        } catch (_) {}
      }
    }
    if ("caches" in window) {
      const keys = await caches.keys();
      for (const k of keys) {
        try {
          await caches.delete(k);
        } catch (_) {}
      }
    }
  }).catch((e) => console.warn("cache clear:", e.message));
  // Goto with a cache-busting query so any HTTP-level cached
  // entries are also bypassed.
  const cacheBuster = `?v=${Date.now()}`;
  const url = PAGE_URL + cacheBuster;
  console.log(`reload: ${url}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });

  // Console + WS frame stream — surface everything for diagnosis.
  page.on("console", (msg) => {
    const t = msg.type();
    const txt = msg.text();
    // Print everything but throttle noise during entity rendering.
    if (
      /combat|stance|attack|spell|teleport|character|spawn|login|error|warn|fail|HandleAction|forget|telepoi/i.test(
        txt
      )
    ) {
      console.log(`[browser ${t}] ${txt}`);
    }
  });
  page.on("pageerror", (err) =>
    console.error(`[pageerror] ${err.message}\n${err.stack || ""}`)
  );

  // ── 2. wait for smoke ────────────────────────────────────────
  await page.waitForFunction(
    () => {
      const r = document.getElementById("results");
      return r && /PASS/.test(r.innerHTML);
    },
    { timeout: 30_000 }
  );
  console.log("smoke: PASS");

  // ── 3. login with retry (handles double-connect kick) ────────
  async function attemptLogin(attempt) {
    console.log(`\n# login attempt ${attempt}`);
    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', "ws://127.0.0.1:8080/");
    await page.fill('input[name="server_host"]', "127.0.0.1");
    await page.fill('input[name="server_port"]', "9000");
    await page
      .click("#login-form button[type=submit]", { noWaitAfter: true })
      .catch(() => null);
    try {
      await page.waitForSelector("#selection:not([hidden])", { timeout: 25_000 });
      return true;
    } catch (_) {
      const status = await page
        .locator("#login-status")
        .innerText()
        .catch(() => "(no status)");
      console.log(`  attempt ${attempt} status: ${status}`);
      return false;
    }
  }
  let loggedIn = false;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    loggedIn = await attemptLogin(attempt);
    if (loggedIn) break;
    console.log(`  waiting 12s for ACE to log out stale session…`);
    await sleep(12_000);
  }
  if (!loggedIn) {
    console.error("FAIL: login never reached character selection");
    await browser.close();
    process.exit(1);
  }
  console.log("login OK");

  // ── 4. spawn (reuse first character) ─────────────────────────
  const charButtons = page.locator("#character-ul button[data-id]");
  const n = await charButtons.count();
  console.log(`characters on account: ${n}`);
  if (n === 0) {
    console.error("FAIL: no characters on account");
    await browser.close();
    process.exit(1);
  }
  await charButtons.first().click();
  await page.waitForFunction(
    () => {
      const s = document.getElementById("login-status");
      return s && /InWorld|Spawned/.test(s.innerText);
    },
    { timeout: 25_000 }
  );
  console.log("spawned");

  // Wait for the post-spawn teleport block to unhide.
  try {
    await page.waitForSelector("#post-spawn:not([hidden])", { timeout: 8_000 });
  } catch (_) {}

  // ── 5. teleport to Holtburg (proven mob area nearby) ─────────
  async function sendChat(line) {
    return page.evaluate(
      (l) => window.__sessionHandle?.sendChat?.(l),
      line
    );
  }
  console.log("\n# 5. teleport to Holtburg");
  await sendChat("@telepoi holtburg");
  await sleep(4_000);
  // Spawn 10 Drudge Skulkers (wcid 7) — ACE's physics placement
  // spreads them outside our 1 m collision radius. The furthest
  // ends up 3–5 m away, just past MELEE_RANGE_M (2.5 m), so the
  // attack scenario below exercises picking.js's startCharge rAF
  // auto-pursue loop.
  console.log("spawning 10 Drudge Skulkers via @create 7 10");
  await sendChat("@create 7 10");
  await sleep(3_500);
  const startPose = await page.evaluate(() => {
    const p = window.__sessionHandle?.getLocalPlayerPose?.();
    return p ? { x: p.x, y: p.y, z: p.z, heading: p.heading } : null;
  });
  console.log("pose:", JSON.stringify(startPose));

  // ── 6. snapshot pre-toggle state ─────────────────────────────
  const aceOffsetBeforeToggle = fs.existsSync(ACE_LOG_PATH)
    ? fs.statSync(ACE_LOG_PATH).size
    : 0;
  const before = await page.evaluate(() => ({
    stanceLow: window.__getCurrentStanceLow?.() ?? null,
    stanceLabel: window.__getCurrentStanceLabel?.() ?? null,
    entityMapSize: window.entityMap?.size ?? 0,
    localGuid: window.getLocalPlayerGuid?.() ?? null,
  }));
  console.log("before toggle:", JSON.stringify(before));

  // ── 7. toggle combat mode ─────────────────────────────────────
  console.log("\n# 7. toggle combat mode");
  await page.evaluate(() => window.__sessionHandle.toggleCombatMode());
  // Wait for ACE round-trip + UpdateMotion processing.
  await sleep(2_500);
  const after = await page.evaluate(() => ({
    stanceLow: window.__getCurrentStanceLow?.() ?? null,
    stanceLabel: window.__getCurrentStanceLabel?.() ?? null,
  }));
  console.log("after toggle: ", JSON.stringify(after));
  const stanceChanged =
    before.stanceLow !== after.stanceLow && after.stanceLow !== 0x3d;
  console.log(`stance changed: ${stanceChanged}`);

  // ── 8. find a creature target ────────────────────────────────
  console.log("\n# 8. find creature");
  // Walk the entityMap; pick the first entry with kind/type ≈ creature.
  // Fall back: any entity that's not the local player.
  const entityProbe = await page.evaluate(() => {
    if (!window.entityMap) return { error: "no entityMap" };
    const localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0;
    const out = [];
    let count = 0;
    for (const [guid, entry] of window.entityMap) {
      count += 1;
      const g = guid >>> 0;
      if (g === localGuid) continue;
      out.push({
        guid: g,
        guidHex: "0x" + g.toString(16).toUpperCase().padStart(8, "0"),
        name: entry?.name ?? entry?.weenieName ?? null,
        objectClass: entry?.objectClass ?? null,
        physicsState: entry?.physicsState ?? null,
        x: entry?.x,
        y: entry?.y,
        z: entry?.z,
      });
      if (out.length >= 30) break;
    }
    return { count, candidates: out };
  });
  console.log(`entityMap size: ${entityProbe.count}, sample:`);
  for (const c of (entityProbe.candidates || []).slice(0, 15)) {
    console.log(
      `  ${c.guidHex}  name=${c.name}  oc=${c.objectClass}  pos=(${c.x},${c.y},${c.z})`
    );
  }

  // ── 9. attack a creature (or report none found) ──────────────
  // Pick the most-recently-allocated dynamic entity — `@create`
  // bumps ACE's GuidAllocator, so the freshly-spawned drudges have
  // the highest GUIDs in the 0x80xxxxxx range.
  const dynamicEntries = (entityProbe.candidates || [])
    .filter((c) => (c.guid >>> 0) >= 0x80000000)
    .sort((a, b) => (b.guid >>> 0) - (a.guid >>> 0));
  const target =
    (entityProbe.candidates || []).find((c) =>
      /drudge|chicken|shreth|gnawer|monster|rat|mosswart|olthoi/i.test(
        c.name || ""
      )
    ) || dynamicEntries[0];
  console.log(
    `top-5 highest-GUID dynamic entities: ${dynamicEntries
      .slice(0, 5)
      .map((c) => c.guidHex)
      .join(", ")}`
  );
  if (!target) {
    console.warn(
      "no obvious creature in range; will skip the attack scenario"
    );
  } else {
    console.log(
      `\n# 9. attack target ${target.guidHex} (${target.name || "(unnamed)"})`
    );
    // Hook client.events for damage/combat callbacks. They fire from
    // the wasm recv-loop's kind=14 dispatch when ACE broadcasts
    // GameEventAttackerNotification etc.
    await page.evaluate(() => {
      window.__k1CombatEvents = [];
      const c = window.__pluginClient;
      const push = (name) => (detail) => {
        window.__k1CombatEvents.push({ name, t: Date.now(), detail });
      };
      [
        "damageDealt",
        "damageTaken",
        "evadedTarget",
        "evadedAttacker",
        "attackDone",
        "combatCommenceAttack",
        "playerStatsUpdated",
      ].forEach((n) => c?.events?.on?.(n, push(n)));
    });
    const aceOffsetBeforeAttack = fs.existsSync(ACE_LOG_PATH)
      ? fs.statSync(ACE_LOG_PATH).size
      : 0;
    // Drive the same path picking.js would: select then attack.
    await page.evaluate(
      ({ guid }) => {
        window.liveScene3d?.entityManager?.setSelectedTarget?.(guid >>> 0);
        window.__sessionHandle.attack(guid >>> 0, 2, 0.5);
      },
      { guid: target.guid }
    );
    await sleep(4_500);
    const attackTail = await tailAceLog(aceOffsetBeforeAttack);
    const attackHits = attackTail
      .split("\n")
      .filter((l) =>
        /HandleActionTargetedMeleeAttack|AttackerNotification|DefenderNotification|CombatCommenceAttack|AttackDone|attack/i.test(
          l
        )
      );
    console.log(`ACE log lines matching combat (${attackHits.length}):`);
    for (const l of attackHits.slice(0, 12)) console.log(`  ${l}`);
    const events = await page.evaluate(() => window.__k1CombatEvents || []);
    console.log(`\nclient.events fired (${events.length}):`);
    for (const e of events.slice(0, 12)) {
      const d = e.detail?.detail || e.detail;
      console.log(`  ${e.name}: ${JSON.stringify(d).slice(0, 200)}`);
    }
    // Also dump the chat log (the [Combat] tab catches damage lines).
    const chatLines = await page.evaluate(() => {
      const lines = [];
      document.querySelectorAll(".chat-line").forEach((el) => {
        lines.push(el.innerText);
      });
      return lines.slice(-25);
    });
    console.log(`\nrecent chat lines (${chatLines.length}):`);
    for (const l of chatLines) console.log(`  ${l}`);
  }

  // ── 10. screenshot final state ───────────────────────────────
  const sp = path.join(OUT_DIR, "k1-drive-final.png");
  await page.screenshot({ path: sp, fullPage: false }).catch(() => null);
  console.log(`\nscreenshot: ${sp}`);

  const toggleTail = await tailAceLog(aceOffsetBeforeToggle);
  const toggleHits = toggleTail
    .split("\n")
    .filter((l) => /Combat|Stance|telepoi/i.test(l));
  console.log(`\nACE lines around toggle (${toggleHits.length}):`);
  for (const l of toggleHits.slice(0, 12)) console.log(`  ${l}`);

  // ── summary ──────────────────────────────────────────────────
  console.log("\n=== SUMMARY ===");
  console.log(`login.................. PASS`);
  console.log(`stance toggle changes.. ${stanceChanged ? "PASS" : "FAIL"}`);
  console.log(`target acquired........ ${target ? "yes" : "no"}`);

  await browser.close();
})();
