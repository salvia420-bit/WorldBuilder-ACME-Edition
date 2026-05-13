// Academy entity capture (2026-05-13) — sister to capture_academy_envcells.cjs.
//
// Spawns a fresh character into the AC Training Academy (LB 0x8602), waits
// for the Phase 1 EnvCell bake to settle, then waits an extra 12 s for ACE
// to blast initial ObjectCreate / PrivateUpdatePosition for every entity
// in the player's PVS, and snapshots the 3D EntityManager's `entityMap`.
//
// The point: we expect ~104 academy fixtures per the WorldBuilder.Terminal
// survey (Training Master, Sentries, 10 Sparring Golems, 13 Carpenter
// Wasps, 12 Thieving Thrungus, treasure chests, Life Stone, Portal
// Linkspots, …). This capture tells us what ACE is actually shipping
// today vs. what's expected, so the Phase B synthesis agent has a
// ground-truth diff to work from.
//
// Entity registry shape (per scene3d/entities.js:374 EntityManager):
//   liveScene3d.entityManager.entityMap : Map<guid:u32, EntityInstance>
//   EntityInstance = { guid, root: THREE.Group, parts, mixer, meta, ... }
//   meta = toMeta(upd) from scene3d/loop.js:320 carrying:
//     guid, modelId/setupId, landblockId (full 32-bit cell id form),
//     x, y, z, qw, qx, qy, qz, wcid, itemType, name, paletteId,
//     mtableId, motionCommand, motionStance, physicsScriptDid,
//     soundTableDid, modelChanges, textureChanges, subPalettes.
//
// Cell-id derivation: ACE's wire `landblock_id` is the full
// `(x_byte << 24) | (y_byte << 16) | cell` form. For an entity in LB
// 0x8602, `landblockId >>> 16 === 0x8602` and the cell index in low 16.
//
// We DON'T touch the wasm pkg or dist/. We DO read liveScene3d in
// page.evaluate without any DOM mutations.
//
// Pre-reqs (mirror capture_academy_envcells.cjs):
//   - Live ACE on Tailscale 100.116.47.66 UDP 9000/9001.
//   - holtburger-wsbridge on ws://127.0.0.1:8080/.
//   - python3 -m http.server 8765 from external/holtburger/.
//   - Manifest+shards baked under dist/.
//   - Playwright in npx cache at PLAYWRIGHT_CACHE.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_academy_entities.cjs

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
      "FAIL: playwright not found in NODE_PATH or " +
        PLAYWRIGHT_CACHE +
        "\nSet NODE_PATH or PLAYWRIGHT_CACHE."
    );
    process.exit(2);
  }
}

(async () => {
  const RUN_TAG = process.env.ACAD_RUN_TAG || `aentv${Date.now().toString(36)}`;
  const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
  const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
  const CHAR_NAME = process.env.ACAD_CHAR_NAME || `AevE${RUN_TAG.slice(-5)}`;
  const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
  const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
  const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
  const PAGE_URL =
    process.env.PHASE4_PAGE_URL ||
    "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(
    process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000
  );
  const SPAWN_TIMEOUT_MS = Number(process.env.ACAD_SPAWN_TIMEOUT_MS || 60_000);
  const CREATE_TIMEOUT_MS = Number(process.env.ACAD_CREATE_TIMEOUT_MS || 30_000);
  // Initial drain so handlePositionUpdate fires + the EnvCell bake starts.
  const POST_SPAWN_DRAIN_MS = Number(process.env.ACAD_POST_SPAWN_DRAIN_MS || 6000);
  // EnvCell bake budget.
  const ENVCELL_BAKE_TIMEOUT_MS = Number(
    process.env.ACAD_ENVCELL_BAKE_TIMEOUT_MS || 120_000
  );
  // After envcells are loaded, ACE has typically already shipped most
  // ObjectCreate events for entities in PVS; we still want a generous
  // drain window for slow networks / first-spawn jitter.
  // 2026-05-13: bumped 12 s → 90 s with 10-s interval snapshots to
  // determine whether the "24 of 104" coverage gap closes itself with
  // more time (generator init delays) or is a real PVS depth limit.
  const ENTITY_DRAIN_MS = Number(process.env.ACAD_ENTITY_DRAIN_MS || 90_000);
  const ENTITY_DRAIN_SAMPLE_MS = Number(
    process.env.ACAD_ENTITY_DRAIN_SAMPLE_MS || 10_000
  );
  const GODMODE_CHAT = process.env.ACAD_GODMODE_CHAT || "/godly";
  const ENABLE_GODMODE = process.env.ACAD_ENABLE_GODMODE !== "0";

  const TS = Date.now();
  const CAP_DIR = "/mnt/wbterminal1/holtburger-captures";
  const SCREENSHOT_PATH = path.resolve(
    CAP_DIR,
    `academy-entities-${TS}.png`
  );
  const SNAPSHOT_PATH = path.resolve(
    CAP_DIR,
    `academy-entities-${TS}.json`
  );
  const DIAG_LOG_PATH = path.resolve(
    CAP_DIR,
    `academy-entities-diag-${TS}.log`
  );

  const ACADEMY_LB_KEY = 0x86020000 >>> 0;
  const ACADEMY_LB_HIGH = 0x8602;

  console.log(`launching chromium → ${PAGE_URL}`);
  console.log(`target ACE: ${SERVER_IP}:${SERVER_PORT} via ${BRIDGE_URL}`);
  console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
  console.log(`screenshot: ${SCREENSHOT_PATH}`);
  console.log(`snapshot:   ${SNAPSHOT_PATH}`);
  console.log(`diag log:   ${DIAG_LOG_PATH}`);

  fs.writeFileSync(
    DIAG_LOG_PATH,
    `# academy-entities diag transcript ${new Date().toISOString()}\n`
  );

  const browser = await chromium.launch({
    args: [
      "--use-gl=swiftshader",
      "--disable-dev-shm-usage",
      "--no-sandbox",
      "--disable-gpu-sandbox",
      "--disable-features=PaintHoldingCrossOrigin,PaintHolding",
    ],
  });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 1024 },
  });
  const page = await context.newPage();

  let consoleErrors = 0;
  const consoleErrorMessages = [];
  page.on("console", (msg) => {
    const text = msg.text();
    try {
      fs.appendFileSync(DIAG_LOG_PATH, `[${msg.type()}] ${text}\n`);
    } catch (_) {}
    if (msg.type() === "error") {
      consoleErrors += 1;
      console.log(`[browser error] ${text}`);
      if (consoleErrorMessages.length < 10) consoleErrorMessages.push(text);
    } else if (
      /\[entity-diag\]|\[phase7\.4b\]|ObjectCreate|EntityManager|entityMap|spawnCount/i.test(
        text
      )
    ) {
      console.log(`[browser ${msg.type()}] ${text}`);
    }
  });
  page.on("pageerror", (err) => {
    consoleErrors += 1;
    console.error("[pageerror]", err.message);
    try {
      fs.appendFileSync(DIAG_LOG_PATH, `[pageerror] ${err.message}\n`);
    } catch (_) {}
    if (consoleErrorMessages.length < 10) consoleErrorMessages.push(err.message);
  });

  // === Boot the page and wait for smoke PASS ============================
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
    const html = await page
      .locator("#results")
      .innerHTML()
      .catch(() => "(no #results)");
    console.error(
      `FAIL: in-page smoke panel never reached PASS within ${SMOKE_TIMEOUT_MS}ms`
    );
    console.error(`results HTML: ${html.slice(0, 500)}`);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  // === Login ============================================================
  try {
    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    await page.click('#login-form button[type=submit]');
    console.log(`login form submitted; waiting up to 90s for #selection`);
    await page.waitForSelector("#selection:not([hidden])", { timeout: 90_000 });
    console.log(`logged in as ${ACCOUNT}`);
  } catch (e) {
    const status = await page
      .locator("#login-status")
      .innerText()
      .catch((err) => `(unavailable: ${err?.message ?? err})`);
    console.error(`FAIL: login timeout — login-status was: ${JSON.stringify(status)}`);
    console.error(`error: ${e?.message ?? e}`);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  await page.waitForTimeout(500);

  // === Create character if account is empty (always for fresh RUN_TAG) ==
  const initialCount = await page.locator('#character-ul button[data-id]').count();
  if (initialCount === 0) {
    const createVisible =
      (await page.locator("#create-form:not([hidden])").count()) > 0;
    if (!createVisible) {
      console.error("FAIL: Create-character form hidden — bailing.");
      await browser.close();
      process.exit(1);
    }
    console.log(`creating character "${CHAR_NAME}"`);
    await page.fill('#create-form input[name="char_name"]', CHAR_NAME);
    await page.click('#create-button');
    await page.waitForFunction(
      () => {
        const s = document.getElementById("create-status");
        return s && /Created\b/.test(s.innerText);
      },
      { timeout: CREATE_TIMEOUT_MS }
    );
    await page.waitForFunction(
      () => document.querySelectorAll('#character-ul button[data-id]').length > 0,
      { timeout: 10_000 }
    );
    console.log("character created");
  }

  // === Spawn into the academy ==========================================
  const spawnButtons = page.locator('#character-ul button[data-id]');
  if ((await spawnButtons.count()) === 0) {
    console.error("FAIL: No spawnable characters — bailing.");
    await browser.close();
    process.exit(1);
  }
  await spawnButtons.first().click();
  console.log("clicked first Spawn button");

  await page.waitForFunction(
    () => {
      const s = document.getElementById("login-status");
      return s && /InWorld|Spawned/.test(s.innerText);
    },
    { timeout: SPAWN_TIMEOUT_MS }
  );
  console.log("Spawned/InWorld status reached");

  await page.waitForTimeout(POST_SPAWN_DRAIN_MS);

  // === /godly so fall damage doesn't kill us ===========================
  if (ENABLE_GODMODE && GODMODE_CHAT) {
    const godResult = await page.evaluate((line) => {
      const h = window.__sessionHandle;
      if (h && typeof h.sendChat === "function") {
        try {
          h.sendChat(line);
          return "sent";
        } catch (e) {
          return `err: ${e.message || e}`;
        }
      }
      return "no handle";
    }, GODMODE_CHAT);
    console.log(`${GODMODE_CHAT} dispatch: ${godResult}`);
    await page.waitForTimeout(1500);
  }

  // === Wait for player pose to land in LB 0x8602 =======================
  let lbStable = false;
  let lastLbId = 0;
  const lbDeadline = Date.now() + 30_000;
  while (Date.now() < lbDeadline) {
    const lbId = await page.evaluate(() => {
      const h = window.__sessionHandle;
      if (h && typeof h.getLocalPlayerPose === "function") {
        try {
          const wp = h.getLocalPlayerPose();
          if (wp) return wp.landblockId >>> 0;
        } catch (_) {}
      }
      return 0;
    });
    const lbKey = (lbId & 0xffff_0000) >>> 0;
    if (lbKey === ACADEMY_LB_KEY) {
      lbStable = true;
      lastLbId = lbId;
      break;
    }
    lastLbId = lbId;
    await page.waitForTimeout(500);
  }
  console.log(
    `player landblockId after spawn drain: 0x${lastLbId.toString(16).padStart(8, "0")} ` +
      `(LB key 0x${((lastLbId & 0xffff_0000) >>> 0).toString(16).padStart(8, "0")}; stable=${lbStable})`
  );
  if (!lbStable) {
    console.error(`FAIL: player never reached LB 0x8602 after spawn.`);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  // === Wait for the EnvCell bake to plateau (so cellContainers3d is stable) ===
  console.log(`waiting up to ${ENVCELL_BAKE_TIMEOUT_MS}ms for academy EnvCell bake to settle`);
  let bakeDone = false;
  const bakeDeadline = Date.now() + ENVCELL_BAKE_TIMEOUT_MS;
  let bakeProgress = { loaded: false, academyCells: 0, lastLog: 0 };
  let stableSince = 0;
  while (Date.now() < bakeDeadline) {
    const status = await page.evaluate((expectedKey) => {
      const ls = window.liveScene3d;
      if (!ls) return { ready: false, reason: "liveScene3d not present" };
      const loaded =
        ls.envCellLoadedLbs instanceof Set
          ? ls.envCellLoadedLbs.has(expectedKey >>> 0)
          : false;
      let academyCells = 0;
      if (ls.cellContainers3d instanceof Map) {
        const expectedHigh = (expectedKey >>> 16) & 0xffff;
        for (const cellId of ls.cellContainers3d.keys()) {
          if (((cellId >>> 16) & 0xffff) === expectedHigh) academyCells += 1;
        }
      }
      return { loaded, academyCells };
    }, ACADEMY_LB_KEY);

    if (
      status.academyCells !== bakeProgress.academyCells ||
      status.loaded !== bakeProgress.loaded
    ) {
      stableSince = Date.now();
      if (Date.now() - bakeProgress.lastLog > 1000) {
        console.log(
          `  bake progress: loaded=${status.loaded}, academyCells=${status.academyCells}`
        );
        bakeProgress.lastLog = Date.now();
      }
      bakeProgress.loaded = status.loaded;
      bakeProgress.academyCells = status.academyCells;
    } else if (status.loaded && status.academyCells > 0 && stableSince > 0) {
      if (Date.now() - stableSince >= 2000) {
        bakeDone = true;
        break;
      }
    }
    await page.waitForTimeout(500);
  }
  if (!bakeDone) {
    console.error(
      `WARN: academy EnvCell bake never plateaued within ${ENVCELL_BAKE_TIMEOUT_MS}ms; proceeding anyway.`
    );
  } else {
    console.log(
      `academy EnvCell bake plateaued (academyCells=${bakeProgress.academyCells})`
    );
  }

  // === EXTRA entity drain: let ACE finish blasting ObjectCreate / PrivateUpdatePosition
  // for everything in PVS. ACE's PlayerLocationBroadcast emits in burst on
  // first spawn; bumped to 90 s with 10-s sampling so we can see whether
  // late entities trickle in (generator init delays) or coverage plateaus
  // immediately (real PVS gap).
  console.log(
    `waiting ${ENTITY_DRAIN_MS}ms (samples every ${ENTITY_DRAIN_SAMPLE_MS}ms) ` +
      `for ObjectCreate / PrivateUpdatePosition burst to drain`
  );
  const drainTrajectory = [];
  const drainStart = Date.now();
  const drainDeadline = drainStart + ENTITY_DRAIN_MS;
  const drainProbe = async () => {
    return await page.evaluate((academyHigh) => {
      try {
        const ls = window.liveScene3d;
        if (!ls || !ls.entityManager) return { total: -1, academy: -1 };
        const map = ls.entityManager.entityMap;
        if (!(map instanceof Map)) return { total: -1, academy: -1 };
        let academy = 0;
        for (const [, inst] of map) {
          const meta = inst?.meta || {};
          const cellId = (meta.landblockId >>> 0);
          const lbHigh = (cellId >>> 16) & 0xffff;
          if (lbHigh === (academyHigh >>> 0)) academy += 1;
        }
        return {
          total: map.size,
          academy,
          spawnCount: (ls.entityManager.spawnCount | 0),
          removeCount: (ls.entityManager.removeCount | 0),
        };
      } catch (e) {
        return { total: -1, academy: -1, err: String(e?.message ?? e) };
      }
    }, ACADEMY_LB_HIGH);
  };
  // First sample at t=0 so we have a baseline.
  {
    const s = await drainProbe();
    const tag = { t: 0, ...s };
    drainTrajectory.push(tag);
    console.log(
      `  [drain] t=0s   total=${s.total} academy=${s.academy} ` +
        `spawn=${s.spawnCount ?? "?"} remove=${s.removeCount ?? "?"}`
    );
  }
  while (Date.now() < drainDeadline) {
    const nextSample = Math.min(
      drainDeadline,
      Date.now() + ENTITY_DRAIN_SAMPLE_MS
    );
    const wait = nextSample - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    const elapsed = Math.round((Date.now() - drainStart) / 1000);
    const s = await drainProbe();
    drainTrajectory.push({ t: elapsed, ...s });
    console.log(
      `  [drain] t=${elapsed}s  total=${s.total} academy=${s.academy} ` +
        `spawn=${s.spawnCount ?? "?"} remove=${s.removeCount ?? "?"}`
    );
  }

  // === Probe the EntityManager.entityMap ================================
  const snapshot = await page.evaluate(({ academyHigh, lpgFunc }) => {
    const out = {};
    try {
      const ls = window.liveScene3d;
      if (!ls) {
        out.error = "liveScene3d not present";
        return out;
      }
      const em = ls.entityManager;
      if (!em) {
        out.error = "liveScene3d.entityManager not present";
        return out;
      }
      const map = em.entityMap;
      if (!(map instanceof Map)) {
        out.error =
          "entityManager.entityMap not a Map (was " + typeof map + ")";
        return out;
      }

      // Local player guid (used to annotate the dump).
      let localPlayerGuid = 0;
      try {
        if (typeof window.getLocalPlayerGuid === "function") {
          const v = window.getLocalPlayerGuid();
          if (v !== null && v !== undefined) localPlayerGuid = v >>> 0;
        }
      } catch (_) {}

      // Also peek at the 2D entityMap (window.entityMap) for cross-check —
      // the 2D drainEvents loop ingests the SAME ACE events, so if ObjectCreate
      // is firing at all, this map should be populated too.
      let twoDSize = -1;
      let twoDAcademyCount = 0;
      try {
        if (window.entityMap && typeof window.entityMap.size === "number") {
          twoDSize = window.entityMap.size;
          // The 2D map's entries store meta on the entry; sprite-relative
          // position is in pixel-world coords, not LB coords. Can't easily
          // filter by LB here without re-decoding — so just record count.
        }
      } catch (_) {}

      const entries = [];
      let academyCount = 0;
      let nameCount = 0;
      let withSetupCount = 0;
      let withPaletteCount = 0;
      let withMotionCount = 0;
      let withPesCount = 0;
      let withStbCount = 0;

      // Item-type bitmask values (mirror ITEM_TYPE from index.html:2771).
      const ITEM_TYPE_NAMES = {
        0x00000001: "MELEE_WEAPON",
        0x00000002: "ARMOR",
        0x00000004: "CLOTHING",
        0x00000008: "JEWELRY",
        0x00000010: "CREATURE",
        0x00000020: "FOOD",
        0x00000040: "MONEY",
        0x00000080: "MISC",
        0x00000100: "MISSILE_WEAPON",
        0x00000200: "CONTAINER",
        0x00000400: "USELESS",
        0x00000800: "GEM",
        0x00001000: "SPELL_COMPONENT",
        0x00002000: "KEY",
        0x00004000: "MANASTONE",
        0x00008000: "PROMISSORYNOTE",
        0x00010000: "PORTAL",
        0x00020000: "LOCKABLE",
        0x00040000: "PROMISSORY_NOTE2",
        0x00100000: "WRITABLE",
        0x00200000: "CASTER",
        0x00400000: "TINKERING_TOOL",
        0x00800000: "TINKERING_MATERIAL",
        0x01000000: "GAMEBOARD",
        0x02000000: "PORTAL_MAGIC_TARGET",
        0x04000000: "LIFESTONE",
        0x08000000: "VESTMENTS",
      };
      function itemTypeLabel(t) {
        const u = (t >>> 0);
        if (u === 0) return "";
        // First match wins; many entities have a single bit set.
        for (const k of Object.keys(ITEM_TYPE_NAMES)) {
          if ((u & Number(k)) !== 0) return ITEM_TYPE_NAMES[k];
        }
        return "MASK_0x" + u.toString(16);
      }

      for (const [guid, inst] of map) {
        const meta = inst?.meta || {};
        const root = inst?.root || null;
        const pos = root && root.position
          ? { x: root.position.x, y: root.position.y, z: root.position.z }
          : { x: meta.x ?? 0, y: meta.y ?? 0, z: meta.z ?? 0 };
        // The wire `landblockId` IS the cell id form: high 16 = LB, low 16 = cell index.
        const cellId = (meta.landblockId >>> 0);
        const lbHigh = (cellId >>> 16) & 0xffff;
        const cellLow = cellId & 0xffff;
        const isAcademy = lbHigh === (academyHigh >>> 0);
        if (isAcademy) academyCount += 1;
        const hasName = typeof meta.name === "string" && meta.name.length > 0;
        if (hasName) nameCount += 1;
        const setupId = (meta.modelId ?? meta.setupId ?? 0) >>> 0;
        if (setupId !== 0) withSetupCount += 1;
        const paletteId = (meta.paletteId ?? 0) >>> 0;
        if (paletteId !== 0) withPaletteCount += 1;
        const motion = (meta.motionCommand ?? 0) >>> 0;
        if (motion !== 0) withMotionCount += 1;
        const pesId = (meta.physicsScriptDid ?? 0) >>> 0;
        if (pesId !== 0) withPesCount += 1;
        const stbId = (meta.soundTableDid ?? 0) >>> 0;
        if (stbId !== 0) withStbCount += 1;

        entries.push({
          guid: "0x" + (guid >>> 0).toString(16).padStart(8, "0"),
          name: meta.name || "",
          wcid: (meta.wcid >>> 0),
          wcidHex: "0x" + (meta.wcid >>> 0).toString(16),
          itemType: (meta.itemType >>> 0),
          itemTypeLabel: itemTypeLabel(meta.itemType),
          setupId: "0x" + setupId.toString(16).padStart(8, "0"),
          paletteId: "0x" + paletteId.toString(16).padStart(8, "0"),
          mtableId: "0x" + ((meta.mtableId ?? 0) >>> 0).toString(16).padStart(8, "0"),
          motionCommand: "0x" + motion.toString(16),
          motionStance: "0x" + ((meta.motionStance ?? 0) >>> 0).toString(16),
          cellId: "0x" + cellId.toString(16).padStart(8, "0"),
          lbHigh: "0x" + lbHigh.toString(16).padStart(4, "0"),
          cellLow: "0x" + cellLow.toString(16).padStart(4, "0"),
          isAcademy,
          isLocalPlayer: (guid >>> 0) === localPlayerGuid,
          objScale: meta.objScale ?? 1.0,
          x: pos.x, y: pos.y, z: pos.z,
          physicsScriptDid: pesId !== 0 ? ("0x" + pesId.toString(16)) : "",
          soundTableDid: stbId !== 0 ? ("0x" + stbId.toString(16)) : "",
        });
      }

      out.totalEntities = map.size;
      out.academyCount = academyCount;
      out.nameCount = nameCount;
      out.withSetupCount = withSetupCount;
      out.withPaletteCount = withPaletteCount;
      out.withMotionCount = withMotionCount;
      out.withPesCount = withPesCount;
      out.withStbCount = withStbCount;
      out.localPlayerGuid =
        "0x" + (localPlayerGuid >>> 0).toString(16).padStart(8, "0");
      out.spawnCount = em.spawnCount | 0;
      out.removeCount = em.removeCount | 0;
      out.motionSwitchCount = em.motionSwitchCount | 0;
      out.lastError = em.lastError || null;
      out.twoDEntityMapSize = twoDSize;
      out.twoDEntityMapAcademyCount = twoDAcademyCount;
      out.entries = entries;

      // Expected academy fixtures (per task brief + WorldBuilder.Terminal
      // survey). We check name substrings (case-insensitive) and well-known
      // weenie class ids where possible.
      const lowerNames = entries.map((e) => e.name.toLowerCase());
      function nameHit(pattern) {
        return lowerNames.filter((n) => n.indexOf(pattern) !== -1).length;
      }
      out.expectedFixtures = {
        trainingMaster: nameHit("training master"),
        sentry: nameHit("sentry"),
        sparringGolem: nameHit("sparring golem"),
        carpenterWasp: nameHit("carpenter wasp"),
        thievingThrungus: nameHit("thieving thrungus"),
        treasureChest: nameHit("chest"),
        lifeStone: nameHit("life stone") + nameHit("lifestone"),
        portalLinkspot: nameHit("portal") + nameHit("linkspot"),
        instructor: nameHit("instructor"),
        // Item-type-driven fallback for portals (some have no name).
        portalsByItemType: entries.filter(
          (e) => (e.itemType & 0x00010000) !== 0
        ).length,
        lifestonesByItemType: entries.filter(
          (e) => (e.itemType & 0x04000000) !== 0
        ).length,
        creaturesByItemType: entries.filter(
          (e) => (e.itemType & 0x00000010) !== 0
        ).length,
      };

      // Distribution by cell.
      const byCellLow = new Map();
      for (const e of entries) {
        if (!e.isAcademy) continue;
        const k = e.cellLow;
        byCellLow.set(k, (byCellLow.get(k) || 0) + 1);
      }
      out.entitiesByAcademyCell = Object.fromEntries(
        Array.from(byCellLow.entries()).sort((a, b) => b[1] - a[1])
      );

      // Distribution by wcid (top 20).
      const byWcid = new Map();
      for (const e of entries) {
        const k = e.wcidHex;
        byWcid.set(k, (byWcid.get(k) || 0) + 1);
      }
      out.topWcids = Object.fromEntries(
        Array.from(byWcid.entries()).sort((a, b) => b[1] - a[1]).slice(0, 20)
      );
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, { academyHigh: ACADEMY_LB_HIGH });

  console.log("=== entity snapshot summary ===");
  if (snapshot.error) {
    console.error(`probe error: ${snapshot.error}`);
    if (snapshot.errorStack) console.error(snapshot.errorStack);
  } else {
    console.log(
      JSON.stringify(
        {
          totalEntities: snapshot.totalEntities,
          academyCount: snapshot.academyCount,
          nameCount: snapshot.nameCount,
          withSetupCount: snapshot.withSetupCount,
          withPaletteCount: snapshot.withPaletteCount,
          withMotionCount: snapshot.withMotionCount,
          withPesCount: snapshot.withPesCount,
          withStbCount: snapshot.withStbCount,
          spawnCount: snapshot.spawnCount,
          removeCount: snapshot.removeCount,
          twoDEntityMapSize: snapshot.twoDEntityMapSize,
          localPlayerGuid: snapshot.localPlayerGuid,
          expectedFixtures: snapshot.expectedFixtures,
          entitiesByAcademyCell: snapshot.entitiesByAcademyCell,
          topWcids: snapshot.topWcids,
        },
        null,
        2
      )
    );

    // Sample entries: 10 academy-bound entities, preferring those with names.
    const acad = (snapshot.entries || []).filter((e) => e.isAcademy);
    const named = acad.filter((e) => e.name);
    const anonymous = acad.filter((e) => !e.name);
    const samples = []
      .concat(named.slice(0, 6))
      .concat(anonymous.slice(0, 10 - Math.min(6, named.length)));
    console.log("=== 10 sample academy entities ===");
    for (const s of samples) {
      console.log(
        `  guid=${s.guid} wcid=${s.wcidHex} setup=${s.setupId} ` +
        `name="${s.name}" type=${s.itemTypeLabel} cell=${s.cellId} ` +
        `pos=(${s.x.toFixed(1)},${s.y.toFixed(1)},${s.z.toFixed(1)})` +
        (s.isLocalPlayer ? " [LOCAL_PLAYER]" : "")
      );
    }

    // Persist full JSON snapshot (with drain trajectory appended).
    snapshot.drainTrajectory = drainTrajectory;
    snapshot.drainParams = {
      entityDrainMs: ENTITY_DRAIN_MS,
      sampleIntervalMs: ENTITY_DRAIN_SAMPLE_MS,
    };
    fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
    console.log(`saved entity snapshot → ${SNAPSHOT_PATH}`);
  }

  // === Screenshot ======================================================
  await page.waitForTimeout(500);
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
  console.log(`saved screenshot → ${SCREENSHOT_PATH}`);

  // === Verdict =========================================================
  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  if (snapshot.error) {
    check("entity-snapshot probe ran cleanly", false, snapshot.error);
  } else {
    check(
      "EntityManager present and entityMap is a Map",
      true,
      `size=${snapshot.totalEntities}`
    );
    check(
      "at least 1 entity in entityMap after entity drain",
      snapshot.totalEntities >= 1,
      `total=${snapshot.totalEntities}`
    );
    // Soft expectation — we don't FAIL the run on coverage, since the
    // POINT of this capture is to surface the actual count vs. expected.
    const expected104 = snapshot.academyCount >= 50;
    console.log(
      `  [INFO] academy-bound entities: ${snapshot.academyCount} ` +
        `(WB.Terminal expected ~104; threshold-50 ${expected104 ? "MET" : "not met"})`
    );
  }

  check(
    "zero browser console errors during entity capture",
    consoleErrors === 0,
    `errors=${consoleErrors}` +
      (consoleErrorMessages.length
        ? `\n     first errors: ${JSON.stringify(consoleErrorMessages.slice(0, 3))}`
        : "")
  );

  await browser.close();

  if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed.`);
    console.log(`snapshot:   ${SNAPSHOT_PATH}`);
    console.log(`screenshot: ${SCREENSHOT_PATH}`);
    console.log(`diag log:   ${DIAG_LOG_PATH}`);
    process.exit(1);
  } else {
    console.log("PASS: entity capture completed.");
    console.log(`snapshot:   ${SNAPSHOT_PATH}`);
    console.log(`screenshot: ${SCREENSHOT_PATH}`);
    console.log(`diag log:   ${DIAG_LOG_PATH}`);
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
