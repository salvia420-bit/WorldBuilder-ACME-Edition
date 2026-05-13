// AC Training Academy entity tour (2026-05-13 v2) — Task #17 follow-on to
// capture_academy_entities.cjs, now DB-driven via ace_world landblock_instance.
//
// `capture_academy_entities.cjs` proved ACE only ships ~24 entities to a
// freshly-spawned character — that's everything in spawn cell 0x860201AD's
// `visible_cells` PVS list. The remaining ~80 academy fixtures (Carpenter
// Wasps, Thieving Thrungus, Tutorial Chests, Sentries, Life Stone, exit
// portals, …) live in cells the spawn cell's PVS doesn't include, so they
// don't appear in `entityMap` until the player actually visits a cell
// whose visible_cells list mentions them.
//
// `visible_cells` is a hardcoded `Vec<u16>` per env_cell in the DAT
// (env_cell.rs:55 — retail-AC behaviour, no ACE knob). So the ONLY way to
// surface those fixtures is to physically move the player into them.
//
// This capture walks the player through the academy via the `@teleloc`
// admin chat command (canonical retail-AC format already proven by
// capture_phase6_step_f_dungeon.cjs:
//     "@teleloc <cellHex> <x> <y> <z>" via __sessionHandle.sendChat(line))
// at 6 tour stages, sampling the EntityManager.entityMap after each hop.
//
// v2 tour topology (DB-picked from ace_world.landblock_instance —
// landblock=34306 i.e. LB 0x8602):
//   spawn (0x860201AD)
//   -> 0x86020134  Life Stone (wcid 509)   — 1 instance, the only academy lifestone
//   -> 0x860201AE  Carpenter Wasp (12704)  — 4 instances, highest-density wasp cell
//   -> 0x860201B6  Hub cell                — 4 unique wcids (13237/13239/13241/15759)
//   -> 0x860201E8  Thieving Thrungus 29333 — 3 instances, highest-density thrungus cell
//   -> 0x8602023C  Hub cell                — 4 unique wcids (12761/12762/12766/21093)
//   -> 0x86020280  Interior probe          — proved itself in v1 (+8 new wcids)
//
// Cells ordered by ascending cellLow so each @teleloc covers fresh ground
// without the prior hop's PVS overlap pre-loading it.
//
// Hard guarantees this capture upholds:
//   - If `@teleloc` doesn't move the player (cellLow doesn't change), we
//     log it and continue rather than abort. Pass criteria fail naturally.
//   - We treat the tour as a "discover what surfaces" probe — pass means
//     final entity count >= 40 AND at least 2 target wcids surfaced. If we
//     don't reach those, we REPORT THE TRUTH; we don't relax the bar to
//     make the test trivially green.
//
// Pre-reqs (mirror sister captures):
//   - Live ACE on Tailscale 100.116.47.66 UDP 9000/9001.
//   - holtburger-wsbridge on ws://127.0.0.1:8080/.
//   - python3 -m http.server 8765 from external/holtburger/.
//   - Manifest+shards baked under dist/.
//   - Playwright in NODE_PATH (npx cache).
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_academy_tour.cjs

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

// Top fixture wcids worth surfacing (per Phase A2 DB query in brief).
// We score the tour by how many of these appear after each hop.
const TARGET_FIXTURES = [
  { wcid: 12704, name: "Carpenter Wasp",     totalExpected: 13 },
  { wcid: 29333, name: "Thieving Thrungus",  totalExpected: 12 },
  { wcid: 30989, name: "Tutorial Chest",     totalExpected: 11 },
  { wcid: 12698, name: "Sparring Golem",     totalExpected: 10 },
  { wcid: 29332, name: "Olthoi NPC",         totalExpected:  7 },
  { wcid:  4451, name: "Olthoi Door",        totalExpected:  4 },
  { wcid: 10762, name: "Portal Linkspot",    totalExpected:  2 },
  { wcid: 29320, name: "Training Master",    totalExpected:  1 },
  { wcid: 30994, name: "Sentry",             totalExpected:  1 },
  { wcid:   509, name: "Life Stone",         totalExpected:  1 },
  { wcid:  5108, name: "Lifestone Sign",     totalExpected:  1 },
  { wcid: 29331, name: "Olthoi Boss",        totalExpected:  1 },
];

// Pass criteria (per task brief v2 — DB-driven tour).
//   - Final entity count >= 50 (v1 hit 57 with 5 hops; v2 should >=50)
//   - Final NEW wcids includes AT LEAST 2 of:
//       Carpenter Wasp 12704, Thieving Thrungus 29333,
//       Tutorial Chest 30989, Life Stone 509
const PRIMARY_TARGET_WCIDS = new Set([12704, 29333, 30989, 509]);
const PASS_FINAL_TOTAL_THRESHOLD = 50;
const PASS_PRIMARY_WCID_THRESHOLD = 2;

(async () => {
  const RUN_TAG = process.env.ACAD_RUN_TAG || `atour${Date.now().toString(36)}`;
  const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
  const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
  const CHAR_NAME = process.env.ACAD_CHAR_NAME || `AtoE${RUN_TAG.slice(-5)}`;
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
  // Initial drain so handlePositionUpdate fires + EnvCell bake starts.
  const POST_SPAWN_DRAIN_MS = Number(process.env.ACAD_POST_SPAWN_DRAIN_MS || 6000);
  // EnvCell bake budget.
  const ENVCELL_BAKE_TIMEOUT_MS = Number(
    process.env.ACAD_ENVCELL_BAKE_TIMEOUT_MS || 120_000
  );
  // Spawn settle (initial PVS drain). Sister capture proved entities arrive
  // within ~3 s of spawn so 10 s is comfortable.
  const SPAWN_SETTLE_MS = Number(process.env.ACAD_TOUR_SETTLE_MS || 10_000);
  // Per-hop wait after each @teleloc. Sister capture showed ObjectCreate
  // burst lands within 3 s; we use 12 s to absorb network jitter + Phase 1
  // EnvCell bake (academy is dense — 568 cells in the DAT).
  const HOP_WAIT_MS = Number(process.env.ACAD_TOUR_HOP_WAIT_MS || 12_000);
  // Rare-fixture hops get longer to absorb ACE's spawn-trickle for sparse
  // creatures. Brief says: "Bump per-stage wait to 20s on the rare-fixture
  // hops" if a stage doesn't surface its target. We default rare hops to
  // 20 s so we don't have to re-run the capture.
  const HOP_WAIT_MS_RARE = Number(
    process.env.ACAD_TOUR_HOP_WAIT_MS_RARE || 20_000
  );
  const GODMODE_CHAT = process.env.ACAD_GODMODE_CHAT || "/godly";
  const ENABLE_GODMODE = process.env.ACAD_ENABLE_GODMODE !== "0";

  const TS = Date.now();
  const CAP_DIR = "/mnt/wbterminal1/holtburger-captures";
  const SCREENSHOT_PATH = path.resolve(
    CAP_DIR,
    `academy-tour-${TS}.png`
  );
  const TRAJECTORY_PATH = path.resolve(
    CAP_DIR,
    `academy-tour-trajectory-${TS}.json`
  );
  const DIAG_LOG_PATH = path.resolve(
    CAP_DIR,
    `academy-tour-diag-${TS}.log`
  );

  const ACADEMY_LB_KEY = 0x86020000 >>> 0;
  const ACADEMY_LB_HIGH = 0x8602;

  // Tour stages. Each cellHex is backed by an ace_world.landblock_instance
  // row, so we know a real entity lives in that cell. Origin coords are
  // best-effort — for interior cells ACE usually allows (0, 0, 0) or any
  // in-bounds local point. If the @teleloc command rejects the coord, we
  // detect it via cellLow not changing and log it.
  //
  // DB query that drove these picks (ace_world, read-only):
  //   SELECT weenie_Class_Id, obj_Cell_Id, COUNT(*) AS instances
  //     FROM landblock_instance
  //     WHERE landblock = 34306 AND weenie_Class_Id IN (12704, 29333, 509)
  //     GROUP BY weenie_Class_Id, obj_Cell_Id
  //     ORDER BY weenie_Class_Id, instances DESC LIMIT 30;
  //
  //   wcid     obj_Cell_Id (= 0x8602xxxx)   pick reason
  //   509      0x86020134                   only academy life-stone instance
  //   12704    0x860201AE                   4 wasps, highest-density wasp cell
  //   29333    0x860201E8                   3 thrungi, highest-density cell
  //
  // Hub cells (most diverse — 4 unique wcids each per DB):
  //   0x860201B6 — Restoring the Training Academies + 3 armor wcids
  //   0x8602023C — Combat/Healing guides + Tinkering quest
  //
  // Rare-fixture hops get HOP_WAIT_MS_RARE for extra drain budget.
  const TOUR_STAGES = [
    { cellHex: "0x86020134", origin: "0 0 0", label: "Life Stone (wcid 509)",   rare: true },
    { cellHex: "0x860201AE", origin: "0 0 0", label: "Carpenter Wasp (12704)",  rare: true },
    { cellHex: "0x860201B6", origin: "0 0 0", label: "Hub cell (training arc)", rare: false },
    { cellHex: "0x860201E8", origin: "0 0 0", label: "Thieving Thrungus (29333)", rare: true },
    { cellHex: "0x8602023C", origin: "0 0 0", label: "Hub cell (guides arc)",   rare: false },
    { cellHex: "0x86020280", origin: "0 0 0", label: "Interior probe (v1-proved)", rare: false },
  ];

  console.log(`launching chromium → ${PAGE_URL}`);
  console.log(`target ACE: ${SERVER_IP}:${SERVER_PORT} via ${BRIDGE_URL}`);
  console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
  console.log(`screenshot:  ${SCREENSHOT_PATH}`);
  console.log(`trajectory:  ${TRAJECTORY_PATH}`);
  console.log(`diag log:    ${DIAG_LOG_PATH}`);
  console.log(`tour stages: ${TOUR_STAGES.length} hops, ${HOP_WAIT_MS}ms each`);

  fs.writeFileSync(
    DIAG_LOG_PATH,
    `# academy-tour diag transcript ${new Date().toISOString()}\n`
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
      /\[entity-diag\]|\[phase7\.4b\]|ObjectCreate|EntityManager|entityMap|spawnCount|teleloc/i.test(
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

  // === Boot page + wait for smoke PASS ==================================
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

  // === Create character if account is empty =============================
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

  // === sendChat helper (same pattern as capture_phase6_step_f_dungeon.cjs)
  async function sendChat(line) {
    return page.evaluate((l) => {
      const h = window.__sessionHandle;
      if (h && typeof h.sendChat === "function") {
        try {
          h.sendChat(l);
          return "sent";
        } catch (e) {
          return `err: ${e.message || e}`;
        }
      }
      return "no handle";
    }, line);
  }

  // === /godly so fall damage doesn't kill us ===========================
  if (ENABLE_GODMODE && GODMODE_CHAT) {
    const godResult = await sendChat(GODMODE_CHAT);
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

  // === Wait for the EnvCell bake to plateau ============================
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

  // === Entity sample helper ============================================
  // Returns { total, academy, wcidSet, samples, landblockId } for the
  // current EntityManager.entityMap state.
  async function sampleEntities() {
    return await page.evaluate((academyHigh) => {
      try {
        const ls = window.liveScene3d;
        if (!ls || !ls.entityManager) {
          return {
            total: -1, academy: -1, wcids: [], landblockId: 0,
            err: "no entityManager",
          };
        }
        const map = ls.entityManager.entityMap;
        if (!(map instanceof Map)) {
          return {
            total: -1, academy: -1, wcids: [], landblockId: 0,
            err: "entityMap not a Map",
          };
        }
        let academy = 0;
        const wcids = new Set();
        const wcidNames = {}; // wcid -> first name seen
        for (const [, inst] of map) {
          const meta = inst?.meta || {};
          const cellId = (meta.landblockId >>> 0);
          const lbHigh = (cellId >>> 16) & 0xffff;
          const wcid = (meta.wcid >>> 0);
          if (lbHigh === (academyHigh >>> 0)) academy += 1;
          if (wcid !== 0) {
            wcids.add(wcid);
            if (typeof meta.name === "string" && meta.name && !wcidNames[wcid]) {
              wcidNames[wcid] = meta.name;
            }
          }
        }
        // Player landblockId — drives the cellLow-change detection.
        let landblockId = 0;
        try {
          const h = window.__sessionHandle;
          if (h && typeof h.getLocalPlayerPose === "function") {
            const wp = h.getLocalPlayerPose();
            if (wp) landblockId = wp.landblockId >>> 0;
          }
        } catch (_) {}
        return {
          total: map.size,
          academy,
          wcids: Array.from(wcids),
          wcidNames,
          spawnCount: (ls.entityManager.spawnCount | 0),
          removeCount: (ls.entityManager.removeCount | 0),
          landblockId,
        };
      } catch (e) {
        return {
          total: -1, academy: -1, wcids: [], landblockId: 0,
          err: String(e?.message ?? e),
        };
      }
    }, ACADEMY_LB_HIGH);
  }

  // === Tour loop ========================================================
  const trajectory = [];
  const allSeenWcids = new Set();
  const wcidFirstName = {};

  function addToTrajectory(stage, sample, telelocResult, hopMeta) {
    const newWcids = sample.wcids.filter((w) => !allSeenWcids.has(w));
    for (const w of sample.wcids) {
      allSeenWcids.add(w);
      if (sample.wcidNames && sample.wcidNames[w] && !wcidFirstName[w]) {
        wcidFirstName[w] = sample.wcidNames[w];
      }
    }
    const hitTargets = TARGET_FIXTURES
      .filter((t) => sample.wcids.includes(t.wcid))
      .map((t) => ({ wcid: t.wcid, name: t.name }));
    const newTargetWcids = newWcids
      .filter((w) => TARGET_FIXTURES.some((t) => t.wcid === w));
    const entry = {
      stage,
      cellHex: hopMeta.cellHex || null,
      origin: hopMeta.origin || null,
      telelocResult: telelocResult || null,
      landblockId: "0x" + (sample.landblockId >>> 0).toString(16).padStart(8, "0"),
      cellLow: "0x" + ((sample.landblockId >>> 0) & 0xffff).toString(16).padStart(4, "0"),
      totalEntities: sample.total,
      academyEntities: sample.academy,
      uniqueWcids: sample.wcids.length,
      newWcids: newWcids.length,
      newTargetWcids,
      hitTargets,
      spawnCount: sample.spawnCount ?? null,
      removeCount: sample.removeCount ?? null,
      err: sample.err || null,
    };
    trajectory.push(entry);
    console.log(
      `  [tour:${stage}] cellLow=${entry.cellLow} total=${entry.totalEntities} ` +
        `academy=${entry.academyEntities} uniqueWcids=${entry.uniqueWcids} ` +
        `newWcids=${entry.newWcids} hitTargets=${hitTargets.length}/${TARGET_FIXTURES.length}` +
        (hitTargets.length > 0
          ? ` [${hitTargets.map((t) => t.name).join(", ")}]`
          : "")
    );
    return entry;
  }

  // Initial spawn-settle baseline.
  console.log(`stage spawn: settling for ${SPAWN_SETTLE_MS}ms (initial PVS drain)`);
  await page.waitForTimeout(SPAWN_SETTLE_MS);
  const spawnSample = await sampleEntities();
  addToTrajectory("spawn", spawnSample, "(none)", { cellHex: null, origin: null });

  // Iterate tour stages.
  for (let i = 0; i < TOUR_STAGES.length; i++) {
    const stage = TOUR_STAGES[i];
    const stageName = `hop${i + 1}`;
    const prevSample = trajectory[trajectory.length - 1];
    const prevCellLow = parseInt(prevSample.cellLow, 16);

    const telelocCmd = `@teleloc ${stage.cellHex} ${stage.origin}`;
    const stageWaitMs = stage.rare ? HOP_WAIT_MS_RARE : HOP_WAIT_MS;
    console.log(
      `stage ${stageName}: dispatching '${telelocCmd}' (${stage.label}` +
        (stage.rare ? ", rare" : "") + `, wait=${stageWaitMs}ms)`
    );
    let telelocResult;
    try {
      telelocResult = await sendChat(telelocCmd);
    } catch (e) {
      telelocResult = `dispatch-err: ${e?.message ?? e}`;
    }
    console.log(`  teleloc result: ${telelocResult}`);

    // Wait for ObjectCreate burst to drain.
    await page.waitForTimeout(stageWaitMs);

    const sample = await sampleEntities();
    const entry = addToTrajectory(stageName, sample, telelocResult, {
      cellHex: stage.cellHex,
      origin: stage.origin,
    });

    // Detect: did @teleloc actually move the player?
    const newCellLow = parseInt(entry.cellLow, 16);
    const expectedCellLow = parseInt(stage.cellHex, 16) & 0xffff;
    if (newCellLow === prevCellLow) {
      console.log(
        `  WARN: cellLow didn't change after teleport (still 0x${newCellLow.toString(16).padStart(4, "0")}). ` +
          `@teleloc may have rejected this cell — possibly nonexistent / inaccessible. Continuing.`
      );
      entry.teleportMoved = false;
    } else if (newCellLow === expectedCellLow) {
      console.log(
        `  OK: player moved to expected cell 0x${expectedCellLow.toString(16).padStart(4, "0")}.`
      );
      entry.teleportMoved = true;
    } else {
      console.log(
        `  WARN: player moved to cell 0x${newCellLow.toString(16).padStart(4, "0")} ` +
          `but @teleloc requested 0x${expectedCellLow.toString(16).padStart(4, "0")}. ` +
          `ACE may have re-routed via portal collision — continuing.`
      );
      entry.teleportMoved = true;
      entry.teleportMismatch = true;
    }
  }

  // === Final assertions =================================================
  const finalSample = trajectory[trajectory.length - 1];
  const finalTotal = finalSample.totalEntities;

  // Primary target wcids surfaced across the whole tour (any stage).
  const primaryTargetWcidsSeen = Array.from(allSeenWcids)
    .filter((w) => PRIMARY_TARGET_WCIDS.has(w));

  // Stage-wise teleport effectiveness.
  const stagesAttempted = trajectory.filter((t) => t.stage.startsWith("hop")).length;
  const stagesMoved = trajectory.filter(
    (t) => t.stage.startsWith("hop") && t.teleportMoved === true
  ).length;

  console.log("");
  console.log("=== tour summary ===");
  console.log(`spawn (settle) sample:   total=${trajectory[0].totalEntities}, academy=${trajectory[0].academyEntities}`);
  console.log(`final sample:            total=${finalTotal}, academy=${finalSample.academyEntities}`);
  console.log(`tour stages attempted:   ${stagesAttempted}`);
  console.log(`tour stages that moved:  ${stagesMoved} (cellLow changed in player pose)`);
  console.log(`unique wcids across tour: ${allSeenWcids.size}`);
  console.log(`target fixtures seen:    ${TARGET_FIXTURES.filter((t) => allSeenWcids.has(t.wcid)).length}/${TARGET_FIXTURES.length}`);
  console.log(`primary-target wcids:    ${primaryTargetWcidsSeen.length}/${PRIMARY_TARGET_WCIDS.size}` +
    (primaryTargetWcidsSeen.length > 0
      ? ` [${primaryTargetWcidsSeen.map((w) => {
          const f = TARGET_FIXTURES.find((t) => t.wcid === w);
          return f ? f.name : `wcid${w}`;
        }).join(", ")}]`
      : ""));

  // Persist trajectory JSON.
  const trajectoryDoc = {
    timestamp: new Date().toISOString(),
    runTag: RUN_TAG,
    account: ACCOUNT,
    charName: CHAR_NAME,
    serverIp: SERVER_IP,
    serverPort: SERVER_PORT,
    academyLbKey: "0x" + ACADEMY_LB_KEY.toString(16).padStart(8, "0"),
    tourStages: TOUR_STAGES,
    spawnSettleMs: SPAWN_SETTLE_MS,
    hopWaitMs: HOP_WAIT_MS,
    targetFixtures: TARGET_FIXTURES,
    primaryTargetWcids: Array.from(PRIMARY_TARGET_WCIDS),
    passThresholds: {
      finalTotal: PASS_FINAL_TOTAL_THRESHOLD,
      primaryWcids: PASS_PRIMARY_WCID_THRESHOLD,
    },
    trajectory,
    summary: {
      finalTotal,
      finalAcademy: finalSample.academyEntities,
      stagesAttempted,
      stagesMoved,
      uniqueWcidsAcrossTour: allSeenWcids.size,
      targetFixturesSeen: TARGET_FIXTURES.filter((t) => allSeenWcids.has(t.wcid))
        .map((t) => ({ wcid: t.wcid, name: t.name })),
      primaryTargetWcidsSeen: primaryTargetWcidsSeen.map((w) => {
        const f = TARGET_FIXTURES.find((t) => t.wcid === w);
        return f ? { wcid: w, name: f.name } : { wcid: w, name: "(unknown)" };
      }),
      allSeenWcids: Array.from(allSeenWcids).map((w) => ({
        wcid: w,
        name: wcidFirstName[w] || "(unnamed)",
      })),
      consoleErrors,
    },
  };
  fs.writeFileSync(TRAJECTORY_PATH, JSON.stringify(trajectoryDoc, null, 2));
  console.log(`saved trajectory → ${TRAJECTORY_PATH}`);

  // === Screenshot ======================================================
  await page.waitForTimeout(500);
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false }).catch(() => {});
  console.log(`saved screenshot → ${SCREENSHOT_PATH}`);

  // === Pass / fail verdict =============================================
  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  console.log("");
  console.log("=== pass criteria ===");
  // Soft pass on teleport mechanism: only count it if teleport actually moves the player.
  check(
    "at least one @teleloc hop actually moved the player",
    stagesMoved >= 1,
    `${stagesMoved}/${stagesAttempted} hops moved player`
  );
  check(
    `final entity count >= ${PASS_FINAL_TOTAL_THRESHOLD}`,
    finalTotal >= PASS_FINAL_TOTAL_THRESHOLD,
    `final=${finalTotal} (spawn baseline was ${trajectory[0].totalEntities})`
  );
  check(
    `at least ${PASS_PRIMARY_WCID_THRESHOLD} primary-target wcids surfaced across tour`,
    primaryTargetWcidsSeen.length >= PASS_PRIMARY_WCID_THRESHOLD,
    `${primaryTargetWcidsSeen.length}/${PRIMARY_TARGET_WCIDS.size}: ` +
      `[${primaryTargetWcidsSeen.map((w) => {
        const f = TARGET_FIXTURES.find((t) => t.wcid === w);
        return f ? `${f.name}` : `wcid${w}`;
      }).join(", ")}]`
  );
  check(
    "zero browser console errors during tour",
    consoleErrors === 0,
    `errors=${consoleErrors}` +
      (consoleErrorMessages.length
        ? `\n     first errors: ${JSON.stringify(consoleErrorMessages.slice(0, 3))}`
        : "")
  );

  await browser.close();

  if (failures > 0) {
    console.log("");
    console.log(`FAIL: ${failures} check(s) failed.`);
    console.log(`trajectory: ${TRAJECTORY_PATH}`);
    console.log(`screenshot: ${SCREENSHOT_PATH}`);
    console.log(`diag log:   ${DIAG_LOG_PATH}`);
    process.exit(1);
  } else {
    console.log("");
    console.log("PASS: academy tour completed.");
    console.log(`trajectory: ${TRAJECTORY_PATH}`);
    console.log(`screenshot: ${SCREENSHOT_PATH}`);
    console.log(`diag log:   ${DIAG_LOG_PATH}`);
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
