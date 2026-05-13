// Academy EnvCells capture — validates the Phase 1 dynamic EnvCell
// loading wiring (scene3d/index.js:644-646 `loadEnvCellsForLandblock`
// + index.html:4169-4171 `handlePositionUpdate` call) by spawning a
// fresh character into the AC Training Academy (LB 0x8602) and
// asserting the 3D EnvCell pipeline lit up dynamically — NOT via the
// pre-existing hardcoded Mite Maze / Holtburg Dungeon init-time
// bakes.
//
// Per memory `project_holtburger_academy_landblock.md`, NEW retail
// characters spawn directly in LB 0x8602 (no `@teleloc` needed). Per
// DAT facts the user supplied:
//   - 568 EnvCells, 54 unique env templates
//   - Entry hub: cell 0x0100 → 0x0101 / 0x0102 / 0x0163 wings
//   - Static mesh DIDs: 0x02000360 walls (×41), 0x02000BD4, 0x02000817,
//     0x02000AE1
//   - Spawns: Training Master, Sentries, Sparring Golems, Carpenter
//     Wasps, Life Stone, Portal Linkspots (NOT load-bearing for this
//     capture — we only check the env-cell pipeline, not the entity
//     pipeline).
//
// Strategy:
//   1. Same boot + login pattern as `capture_academy_rubberband.cjs`
//      (the canonical academy-spawn capture — uses fresh per-run
//      account so the character is always brand-new and academy-bound).
//      Page URL uses ?renderer=3d so init3D fires (loadEnvCellsForLandblock
//      lives on liveScene3d, not the 2D path).
//   2. Wait for InWorld, then poll the player pose until landblockId
//      stabilises at LB 0x8602.
//   3. `/godly` for fall-damage immunity (academy floors are real
//      geometry; the fall-damage workaround from
//      `project_holtburger_godmode_falldamage.md` applies).
//   4. Assert `liveScene3d.envCellLoadedLbs` contains 0x86020000
//      (the lbKey form per `cells.js:101` — `landblockId & 0xffff_0000`).
//      This is the load-bearing assertion: it proves
//      `loadEnvCellsForLandblock` fired from `handlePositionUpdate`.
//   5. Assert `liveScene3d.cellContainers3d.size` is non-trivial.
//      Academy has 568 cells; we expect at least 100 (depth=1 BFS may
//      hide most at any given time but the BAKE populates all of
//      them — `cellsGroup.children.length` = `cellContainers3d.size`).
//   6. Sum BufferGeometry vertex counts across all academy cells;
//      expect > 1000.
//   7. Inspect the entry cell (lookup by cellId; try 0x86020100 first,
//      fallback to whichever cell userData.cellId matches the player's
//      current cell): count THREE.Mesh leaves that are NOT inside the
//      `meshGroup` (i.e. the static-mesh placements with
//      `userData.isCellStatic`). Expect ≥ 1.
//   8. Assert `__sessionHandle.isCurrentCellIndoor()` is true.
//   9. (Stretch — skipped to avoid scope creep) Walk forward; not
//      load-bearing.
//   10. Save screenshot to /mnt/wbterminal1/holtburger-captures/.
//
// Pre-reqs:
//   - Live ACE on Tailscale 100.116.47.66 UDP 9000/9001.
//   - holtburger-wsbridge on ws://127.0.0.1:8080/.
//   - python3 -m http.server 8765 from external/holtburger/ (verified
//     200 from both 127.0.0.1:8765 and 100.116.47.66:8765 at run time).
//   - Manifest+shards baked under dist/ (eor-cell.bin manifest verified
//     200 / 15 MB at run time).
//   - Playwright in npx cache at PLAYWRIGHT_CACHE.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_academy_envcells.cjs

const path = require("node:path");

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
        "\n" +
        "Set NODE_PATH or PLAYWRIGHT_CACHE to a valid playwright install."
    );
    process.exit(2);
  }
}

(async () => {
  const RUN_TAG = process.env.ACAD_RUN_TAG || `acev${Date.now().toString(36)}`;
  const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
  const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
  const CHAR_NAME = process.env.ACAD_CHAR_NAME || `Aev${RUN_TAG.slice(-6)}`;
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
  // Post-spawn drain: position updates need to fire so handlePositionUpdate
  // triggers loadEnvCellsForLandblock for LB 0x8602. The academy's EnvCell
  // bake itself can also take time (568 cells, real DAT round-trips).
  const POST_SPAWN_DRAIN_MS = Number(process.env.ACAD_POST_SPAWN_DRAIN_MS || 6000);
  // EnvCell bake budget — academy has 568 cells with many static-mesh
  // placements; on cold cache this can take ~30 s. Generous timeout.
  const ENVCELL_BAKE_TIMEOUT_MS = Number(
    process.env.ACAD_ENVCELL_BAKE_TIMEOUT_MS || 120_000
  );
  const GODMODE_CHAT = process.env.ACAD_GODMODE_CHAT || "/godly";
  const ENABLE_GODMODE = process.env.ACAD_ENABLE_GODMODE !== "0";
  // Output dir per /mnt/wbterminal1 — never /home (1.8 GB free on /).
  const SCREENSHOT_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `academy-envcells-${Date.now()}.png`
  );

  // Expected academy LB key — `landblockId & 0xffff_0000` for LB 0x8602.
  const ACADEMY_LB_KEY = 0x86020000 >>> 0;
  // Entry cell ID hint per DAT facts: cell 0x0100 in LB 0x8602.
  const ACADEMY_ENTRY_CELL_ID = 0x86020100 >>> 0;

  console.log(`launching chromium → ${PAGE_URL}`);
  console.log(`target ACE: ${SERVER_IP}:${SERVER_PORT} via ${BRIDGE_URL}`);
  console.log(`account: ${ACCOUNT}, character: ${CHAR_NAME}`);
  console.log(`expected LB key: 0x${ACADEMY_LB_KEY.toString(16).padStart(8, "0")}`);
  console.log(`screenshot path: ${SCREENSHOT_PATH}`);

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
  // Diag transcript: every browser console line gets appended so we
  // never lose [academy-diag] output, regardless of the runner filter.
  const DIAG_LOG_PATH = path.resolve(
    "/mnt/wbterminal1/holtburger-captures",
    `academy-diag-${Date.now()}.log`
  );
  const fs = require("node:fs");
  fs.writeFileSync(DIAG_LOG_PATH, `# academy-envcells diag transcript ${new Date().toISOString()}\n`);
  console.log(`diag transcript: ${DIAG_LOG_PATH}`);
  page.on("console", (msg) => {
    const text = msg.text();
    // Always append to transcript file (so grep -E '\[academy-diag\]'
    // works post-hoc).
    try {
      fs.appendFileSync(DIAG_LOG_PATH, `[${msg.type()}] ${text}\n`);
    } catch (_) {}
    if (msg.type() === "error") {
      consoleErrors += 1;
      console.log(`[browser error] ${text}`);
      if (consoleErrorMessages.length < 10) consoleErrorMessages.push(text);
    } else if (
      /\[academy-diag\]|\bEnvCell\b|cellContainers3d|envCellLoadedLbs|loadEnvCellsForLandblock|landblock|\bacademy\b/i.test(text)
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
    const ssRes = await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false }).catch((err) => `screenshot err: ${err?.message ?? err}`);
    console.error(`screenshot result: ${ssRes === undefined ? "OK at " + SCREENSHOT_PATH : ssRes}`);
    const html = await page.content().catch((err) => `(no content: ${err?.message ?? err})`);
    try {
      fs.writeFileSync(DIAG_LOG_PATH.replace(/\.log$/, "-pagedump.html"), html);
      console.error(`page HTML dumped to ${DIAG_LOG_PATH.replace(/\.log$/, "-pagedump.html")}`);
    } catch (_) {}
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

  // === Spawn into the academy (no @telepoi — academy is default for new chars) ===
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

  // Drain so handlePositionUpdate has a chance to fire +
  // loadEnvCellsForLandblock has a chance to start its bake.
  await page.waitForTimeout(POST_SPAWN_DRAIN_MS);

  // === Send /godly so fall damage doesn't kill us during the test =======
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

  // === Wait for player pose to stabilise at LB 0x8602 ===================
  // The wasm-side `getLocalPlayerPose()` returns a full landblockId in
  // `0xXXXXNNNN` form; we extract the LB key as `& 0xffff_0000`.
  let lbStable = false;
  let lastLbId = 0;
  const lbDeadline = Date.now() + 30_000;
  while (Date.now() < lbDeadline) {
    const lbId = await page.evaluate(() => {
      const h = window.__sessionHandle;
      if (h && typeof h.getLocalPlayerPose === "function") {
        try {
          const wp = h.getLocalPlayerPose();
          if (wp) return (wp.landblockId >>> 0);
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
      `(LB key 0x${((lastLbId & 0xffff_0000) >>> 0).toString(16).padStart(8, "0")}; ` +
      `expected 0x${ACADEMY_LB_KEY.toString(16).padStart(8, "0")}; stable=${lbStable})`
  );

  if (!lbStable) {
    console.error(
      `FAIL: player never reached LB 0x8602 after spawn (last LB key was ` +
        `0x${((lastLbId & 0xffff_0000) >>> 0).toString(16).padStart(8, "0")}). ` +
        `On this ACE server the heritage spawn may have been overridden to a different LB. ` +
        `Try @teleloc 0x86020100 (academy entry cell) via the post-spawn chat hook.`
    );
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  // === Wait for the dynamic EnvCell bake to complete ====================
  // loadEnvCellsForLandblock returns a Promise; we wait for
  // envCellLoadedLbs to include 0x86020000 AND cellContainers3d to be
  // populated (the bake is async — academy = 568 cells = real work).
  console.log(`waiting up to ${ENVCELL_BAKE_TIMEOUT_MS}ms for academy EnvCell bake to settle`);
  // Readiness needs ACADEMY-specific cells in cellContainers3d, not just
  // "any cells" — Mite Maze (879) + Holtburg Dungeon (429) eager-load
  // 1308 cells at init, so `cellsBaked > 0` is trivially true at startup.
  // We also require a 2-second stability window: academy bake is ~568
  // cells × material preload × static fetch; count needs to plateau
  // before we sample.
  let bakeDone = false;
  const bakeDeadline = Date.now() + ENVCELL_BAKE_TIMEOUT_MS;
  let bakeProgress = { loaded: false, totalCells: 0, academyCells: 0, lastLog: 0 };
  let stableSince = 0;
  while (Date.now() < bakeDeadline) {
    const status = await page.evaluate((expectedKey) => {
      const ls = window.liveScene3d;
      if (!ls) return { ready: false, reason: "liveScene3d not present" };
      const loaded =
        ls.envCellLoadedLbs instanceof Set
          ? ls.envCellLoadedLbs.has(expectedKey >>> 0)
          : false;
      let totalCells = 0;
      let academyCells = 0;
      if (ls.cellContainers3d instanceof Map) {
        totalCells = ls.cellContainers3d.size;
        const expectedHigh = (expectedKey >>> 16) & 0xffff;
        for (const cellId of ls.cellContainers3d.keys()) {
          if (((cellId >>> 16) & 0xffff) === expectedHigh) academyCells += 1;
        }
      }
      return { loaded, totalCells, academyCells };
    }, ACADEMY_LB_KEY);

    if (
      status.academyCells !== bakeProgress.academyCells ||
      status.loaded !== bakeProgress.loaded
    ) {
      // Bake is still progressing — reset stability window.
      stableSince = Date.now();
      if (Date.now() - bakeProgress.lastLog > 1000) {
        console.log(
          `  bake progress: loaded=${status.loaded}, academyCells=${status.academyCells}, totalCells=${status.totalCells}`
        );
        bakeProgress.lastLog = Date.now();
      }
      bakeProgress.loaded = status.loaded;
      bakeProgress.totalCells = status.totalCells;
      bakeProgress.academyCells = status.academyCells;
    } else if (status.loaded && status.academyCells > 0 && stableSince > 0) {
      // Count is stable. If 2s have passed since the last change, declare done.
      if (Date.now() - stableSince >= 2000) {
        bakeDone = true;
        break;
      }
    }
    await page.waitForTimeout(500);
  }

  if (!bakeDone) {
    console.error(
      `FAIL: academy EnvCell bake never completed within ${ENVCELL_BAKE_TIMEOUT_MS}ms. ` +
        `Final: loaded=${bakeProgress.loaded}, academyCells=${bakeProgress.academyCells}, totalCells=${bakeProgress.totalCells}.`
    );
  } else {
    console.log(
      `academy EnvCell bake completed (academyCells=${bakeProgress.academyCells}, totalCells=${bakeProgress.totalCells})`
    );
  }

  // === Probe the wired state ============================================
  const probe = await page.evaluate(
    ({ expectedKey, entryCellHint }) => {
      const out = {};
      try {
        const ls = window.liveScene3d;
        if (!ls) {
          out.error = "liveScene3d not present";
          return out;
        }

        // Phase 1 contract: envCellLoadedLbs records the LB key.
        out.hasLoadEnvCellsMethod =
          typeof ls.loadEnvCellsForLandblock === "function";
        out.envCellLoadedLbsType =
          ls.envCellLoadedLbs instanceof Set ? "Set" : typeof ls.envCellLoadedLbs;
        out.envCellLoadedLbsSize =
          ls.envCellLoadedLbs instanceof Set ? ls.envCellLoadedLbs.size : 0;
        out.envCellLoadedLbsHasAcademy =
          ls.envCellLoadedLbs instanceof Set
            ? ls.envCellLoadedLbs.has(expectedKey >>> 0)
            : false;
        out.envCellLoadedLbsKeys =
          ls.envCellLoadedLbs instanceof Set
            ? Array.from(ls.envCellLoadedLbs).map(
                (k) => "0x" + (k >>> 0).toString(16).padStart(8, "0")
              )
            : [];

        // cellContainers3d size + cellsGroup children count.
        out.cellContainers3dType =
          ls.cellContainers3d instanceof Map ? "Map" : typeof ls.cellContainers3d;
        out.cellContainers3dSize =
          ls.cellContainers3d instanceof Map ? ls.cellContainers3d.size : 0;
        out.cellsGroupChildren = ls.cellsGroup
          ? ls.cellsGroup.children.length
          : -1;

        // Sum vertex counts across all academy-LB cell containers.
        let totalVerts = 0;
        let staticChildrenInEntryCell = 0;
        let entryCellFound = false;
        let entryCellResolvedId = 0;
        let academyCellCount = 0;
        let sampleAcademyCells = [];

        // Pick the entry cell. Try hint first (0x86020100); fall back
        // to whatever the player's currentCellId points to.
        let currentCellId = 0;
        try {
          if (window.__sessionHandle && typeof window.__sessionHandle.getCurrentCellId === "function") {
            currentCellId = window.__sessionHandle.getCurrentCellId() >>> 0;
          }
        } catch (_) {}
        out.currentCellId =
          "0x" + currentCellId.toString(16).padStart(8, "0");

        if (ls.cellContainers3d instanceof Map) {
          for (const [cellId, container] of ls.cellContainers3d) {
            // Only sum verts for cells belonging to LB 0x8602 (the bake
            // also has Mite Maze + Holtburg Dungeon from the init-time
            // hardcoded bake; those would inflate the count).
            const cellLbKey = (cellId & 0xffff_0000) >>> 0;
            if (cellLbKey !== (expectedKey >>> 0)) continue;
            academyCellCount += 1;

            // Walk children for THREE.Mesh leaves; sum verts.
            for (const child of container.children) {
              if (child.isMesh && child.geometry) {
                const g = child.geometry;
                const pos = g.attributes && g.attributes.position;
                if (pos && typeof pos.count === "number") {
                  totalVerts += pos.count;
                }
              }
              // meshGroup is a Group; walk its children too.
              if (child.children && child.children.length) {
                for (const grand of child.children) {
                  if (grand.isMesh && grand.geometry) {
                    const g = grand.geometry;
                    const pos = g.attributes && g.attributes.position;
                    if (pos && typeof pos.count === "number") {
                      totalVerts += pos.count;
                    }
                  }
                }
              }
            }

            // Entry-cell hunt: prefer the 0x86020100 hint, otherwise
            // match the player's currentCellId, otherwise grab the
            // first academy cell as a sample for diagnostics.
            const isEntryHint = (cellId >>> 0) === (entryCellHint >>> 0);
            const isCurrentCell =
              currentCellId !== 0 && (cellId >>> 0) === currentCellId;

            if ((isEntryHint || (isCurrentCell && !entryCellFound)) && !entryCellFound) {
              entryCellFound = true;
              entryCellResolvedId = cellId >>> 0;
              // Count direct THREE.Mesh leaves with isCellStatic; these
              // are the static-mesh placements (walls 0x02000360,
              // 0x02000BD4, etc.) per cells.js:316-336.
              for (const child of container.children) {
                if (child.isMesh && child.userData?.isCellStatic) {
                  staticChildrenInEntryCell += 1;
                }
              }
            }
            if (sampleAcademyCells.length < 5) {
              let directMeshes = 0;
              let groupMeshes = 0;
              for (const child of container.children) {
                if (child.isMesh) directMeshes += 1;
                if (child.children) {
                  for (const grand of child.children) {
                    if (grand.isMesh) groupMeshes += 1;
                  }
                }
              }
              sampleAcademyCells.push({
                cellId: "0x" + (cellId >>> 0).toString(16).padStart(8, "0"),
                directMeshLeaves: directMeshes,
                groupMeshLeaves: groupMeshes,
                portalCount: container.userData?.portalCellIds?.length ?? 0,
                isEnvCell: !!container.userData?.isEnvCell,
              });
            }
          }
        }
        out.academyCellCount = academyCellCount;
        out.totalAcademyVerts = totalVerts;
        out.entryCellFound = entryCellFound;
        out.entryCellResolvedId =
          "0x" + entryCellResolvedId.toString(16).padStart(8, "0");
        out.staticChildrenInEntryCell = staticChildrenInEntryCell;
        out.sampleAcademyCells = sampleAcademyCells;

        // Indoor mode + outdoor-group visibility.
        out.isCurrentCellIndoor = false;
        try {
          if (
            window.__sessionHandle &&
            typeof window.__sessionHandle.isCurrentCellIndoor === "function"
          ) {
            out.isCurrentCellIndoor =
              !!window.__sessionHandle.isCurrentCellIndoor();
          }
        } catch (_) {}
        out.terrainGroupVisible = ls.terrainGroup ? ls.terrainGroup.visible : null;
        out.buildingsGroupVisible = ls.buildingsGroup
          ? ls.buildingsGroup.visible
          : null;
        out.staticsGroupVisible = ls.staticsGroup
          ? ls.staticsGroup.visible
          : null;
      } catch (e) {
        out.error = String(e?.message ?? e);
        out.errorStack = String(e?.stack ?? "").slice(0, 1200);
      }
      return out;
    },
    { expectedKey: ACADEMY_LB_KEY, entryCellHint: ACADEMY_ENTRY_CELL_ID }
  );

  console.log("academy capture probe:", JSON.stringify(probe, null, 2));

  // Settle one more rAF for visibility tick to land.
  await page.waitForTimeout(1000);

  // === Save screenshot ==================================================
  await page.screenshot({ path: SCREENSHOT_PATH, fullPage: false });
  console.log(`saved ${SCREENSHOT_PATH}`);

  // === Verdict ==========================================================
  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  if (probe.error) {
    check("academy: probe ran cleanly", false, probe.error);
    if (probe.errorStack) console.error(probe.errorStack);
  } else {
    // ---- Load-bearing: Phase 1 dynamic wiring -------------------------
    // These checks validate the wiring shipped at scene3d/index.js:644
    // + index.html:4169-4171 — they MUST all PASS regardless of
    // dist coverage.
    check(
      "Phase 1 wiring: liveScene3d.loadEnvCellsForLandblock method present",
      probe.hasLoadEnvCellsMethod === true
    );
    check(
      "Phase 1 wiring: liveScene3d.envCellLoadedLbs is a Set",
      probe.envCellLoadedLbsType === "Set",
      `was ${probe.envCellLoadedLbsType}`
    );
    check(
      "Phase 1 wiring: envCellLoadedLbs contains 0x86020000 (handlePositionUpdate triggered the dynamic call for LB 0x8602)",
      probe.envCellLoadedLbsHasAcademy === true,
      `loaded keys: ${JSON.stringify(probe.envCellLoadedLbsKeys)}`
    );
    check(
      "Phase 1 wiring: player landed in indoor cell (isCurrentCellIndoor() === true)",
      probe.isCurrentCellIndoor === true,
      `isIndoor=${probe.isCurrentCellIndoor}, currentCellId=${probe.currentCellId}`
    );
    check(
      "Phase 1 wiring: indoor visibility tick hid terrainGroup",
      probe.terrainGroupVisible === false,
      `terrainGroup.visible=${probe.terrainGroupVisible}`
    );
    check(
      "Phase 1 wiring: indoor visibility tick hid buildingsGroup",
      probe.buildingsGroupVisible === false,
      `buildingsGroup.visible=${probe.buildingsGroupVisible}`
    );

    // ---- Academy data coverage (dependent on dist bake) ---------------
    // These checks validate that the academy's EnvCells are actually
    // present in dist/ so the dynamic bake had data to load. If FAIL,
    // the wiring is correct but the manifest doesn't cover LB 0x8602.
    const academyDataPresent = probe.academyCellCount > 0;
    check(
      "academy data: at least one cell with LB key 0x8602 in cellContainers3d (dist covers LB 0x8602)",
      academyDataPresent,
      `academyCellCount=${probe.academyCellCount}, cellContainers3dSize=${probe.cellContainers3dSize} ` +
        `(if 0, fetchEnvCellsInLandblock(0x86020000) returned empty — dist/ doesn't have LB 0x8602's ` +
        `LandblockInfo (eor/cell:0x8602FFFE) or its EnvCell shards. The Phase 1 wiring fired ` +
        `correctly per envCellLoadedLbs above; the data simply isn't baked yet.)`
    );

    if (academyDataPresent) {
      check(
        "academy data: cellContainers3d size >= 100 (academy has 568 cells per DAT facts)",
        probe.cellContainers3dSize >= 100,
        `size=${probe.cellContainers3dSize}`
      );
      check(
        "academy data: total vertex count across academy cells > 1000",
        probe.totalAcademyVerts > 1000,
        `totalAcademyVerts=${probe.totalAcademyVerts}`
      );
      check(
        "academy data: entry cell located in registry",
        probe.entryCellFound === true,
        `currentCellId=${probe.currentCellId}, resolved=${probe.entryCellResolvedId}, ` +
          `sampleAcademyCells=${JSON.stringify(probe.sampleAcademyCells)}`
      );
      // Academy cells are pure architectural mesh: walls/floors/ceilings live
      // in the cell mesh itself (per-poly), NOT as separate static-object
      // placements. Per WB.Terminal + the wasm probe (probe_academy_bake.cjs),
      // academy staticObjectCount === 0 across all 568 cells. So just assert
      // the entry cell carries at least one mesh group (the architectural
      // geometry) rather than expecting a non-existent static placement.
      check(
        "academy data: entry cell has architectural geometry (>= 1 mesh group)",
        probe.sampleAcademyCells.some(
          (s) => s.cellId === probe.entryCellResolvedId && (s.groupMeshLeaves > 0 || s.directMeshLeaves > 0)
        ),
        `entry cell ${probe.entryCellResolvedId}: sampleAcademyCells=${JSON.stringify(probe.sampleAcademyCells.find((s) => s.cellId === probe.entryCellResolvedId))}`
      );
    } else {
      console.log(
        "  [SKIP] academy data depth checks (size / verts / entry cell / static children) — " +
          "skipped because LB 0x8602 EnvCells aren't in dist."
      );
    }
  }

  check(
    "academy: zero browser console errors during boot + spawn + EnvCell bake",
    consoleErrors === 0,
    `errors=${consoleErrors}` +
      (consoleErrorMessages.length
        ? `\n     first errors: ${JSON.stringify(consoleErrorMessages.slice(0, 3))}`
        : "")
  );

  await browser.close();

  if (failures > 0) {
    console.log(`FAIL: ${failures} check(s) failed.`);
    console.log(`screenshot: ${SCREENSHOT_PATH}`);
    process.exit(1);
  } else {
    console.log("PASS: all academy EnvCell capture checks green.");
    console.log(`screenshot: ${SCREENSHOT_PATH}`);
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
