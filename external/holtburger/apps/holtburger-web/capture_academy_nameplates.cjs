// Academy nameplate capture (task #13, 2026-05-13).
//
// Sister to capture_academy_entities.cjs. Boots a fresh character into
// the AC Training Academy (LB 0x8602), waits for the EnvCell bake +
// ObjectCreate drain, then walks `liveScene3d.entityManager.entityMap`
// and asserts:
//
//   - For each named academy entity, a THREE.Sprite child of the rig
//     `root` Group exists.
//   - The sprite's `.userData.nameplateText` matches `meta.name`.
//   - The sprite is positioned above the rig (`sprite.position.z > 0`).
//   - The sprite has a SpriteMaterial with a CanvasTexture map.
//
// Run from `apps/holtburger-web/`:
//   NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
//   node capture_academy_nameplates.cjs

const path = require("node:path");
const fs = require("node:fs");

const PLAYWRIGHT_CACHE =
  process.env.PLAYWRIGHT_CACHE ||
  "/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules";

let chromium;
try {
  ({ chromium } = require("playwright"));
} catch (_) {
  try {
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
  const RUN_TAG = process.env.ACAD_RUN_TAG || `anpv${Date.now().toString(36)}`;
  const ACCOUNT = process.env.PHASE4_TEST_ACCOUNT || RUN_TAG;
  const PASSWORD = process.env.PHASE4_TEST_PASSWORD || RUN_TAG;
  const CHAR_NAME = process.env.ACAD_CHAR_NAME || `AnpE${RUN_TAG.slice(-5)}`;
  const BRIDGE_URL = process.env.PHASE4_BRIDGE_URL || "ws://127.0.0.1:8080/";
  const SERVER_IP = process.env.PHASE4_SERVER_IP || "100.116.47.66";
  const SERVER_PORT = process.env.PHASE4_SERVER_PORT || "9000";
  const PAGE_URL =
    process.env.PHASE4_PAGE_URL ||
    "http://127.0.0.1:8765/apps/holtburger-web/index.html?renderer=3d";
  const SMOKE_TIMEOUT_MS = Number(process.env.PHASE7_SMOKE_TIMEOUT_MS || 60_000);
  const SPAWN_TIMEOUT_MS = Number(process.env.ACAD_SPAWN_TIMEOUT_MS || 60_000);
  const CREATE_TIMEOUT_MS = Number(process.env.ACAD_CREATE_TIMEOUT_MS || 30_000);
  const POST_SPAWN_DRAIN_MS = Number(process.env.ACAD_POST_SPAWN_DRAIN_MS || 6000);
  const ENVCELL_BAKE_TIMEOUT_MS = Number(
    process.env.ACAD_ENVCELL_BAKE_TIMEOUT_MS || 120_000
  );
  // Entity drain — name + sprite attach is sync after spawn, so the
  // sample budget can be tighter than the entity-coverage capture.
  const ENTITY_DRAIN_MS = Number(process.env.ACAD_ENTITY_DRAIN_MS || 40_000);
  const GODMODE_CHAT = process.env.ACAD_GODMODE_CHAT || "/godly";
  const ENABLE_GODMODE = process.env.ACAD_ENABLE_GODMODE !== "0";

  const TS = Date.now();
  const CAP_DIR = "/mnt/wbterminal1/holtburger-captures";
  const SCREENSHOT_PATH = path.resolve(CAP_DIR, `academy-nameplates-${TS}.png`);
  const SNAPSHOT_PATH = path.resolve(CAP_DIR, `academy-nameplates-${TS}.json`);
  const DIAG_LOG_PATH = path.resolve(CAP_DIR, `academy-nameplates-diag-${TS}.log`);

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
    `# academy-nameplates diag transcript ${new Date().toISOString()}\n`
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
      /\[task-13\]|nameplate|EntityManager|spawnCount|\[scene3d\]/i.test(text)
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

  // Boot the page, wait for smoke pass.
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
    console.error(`FAIL: in-page smoke panel never reached PASS`);
    console.error(`results HTML: ${html.slice(0, 500)}`);
    await page.screenshot({ path: SCREENSHOT_PATH }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  // Login.
  try {
    await page.fill('input[name="account"]', ACCOUNT);
    await page.fill('input[name="password"]', PASSWORD);
    await page.fill('input[name="bridge_url"]', BRIDGE_URL);
    await page.fill('input[name="server_host"]', SERVER_IP);
    await page.fill('input[name="server_port"]', SERVER_PORT);
    await page.click('#login-form button[type=submit]');
    await page.waitForSelector("#selection:not([hidden])", { timeout: 90_000 });
    console.log(`logged in as ${ACCOUNT}`);
  } catch (e) {
    const status = await page
      .locator("#login-status")
      .innerText()
      .catch((err) => `(unavailable: ${err?.message ?? err})`);
    console.error(`FAIL: login timeout — login-status was: ${JSON.stringify(status)}`);
    await page.screenshot({ path: SCREENSHOT_PATH }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  await page.waitForTimeout(500);

  // Create character if account is empty.
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

  // Spawn into the academy.
  const spawnButtons = page.locator('#character-ul button[data-id]');
  if ((await spawnButtons.count()) === 0) {
    console.error("FAIL: No spawnable characters.");
    await browser.close();
    process.exit(1);
  }
  await spawnButtons.first().click();
  console.log("clicked Spawn");

  await page.waitForFunction(
    () => {
      const s = document.getElementById("login-status");
      return s && /InWorld|Spawned/.test(s.innerText);
    },
    { timeout: SPAWN_TIMEOUT_MS }
  );
  console.log("Spawned/InWorld status reached");

  await page.waitForTimeout(POST_SPAWN_DRAIN_MS);

  // /godly.
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

  // Wait for academy LB.
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
    `player landblockId after spawn drain: 0x${lastLbId.toString(16).padStart(8, "0")} stable=${lbStable}`
  );
  if (!lbStable) {
    console.error(`FAIL: player never reached LB 0x8602.`);
    await page.screenshot({ path: SCREENSHOT_PATH }).catch(() => {});
    await browser.close();
    process.exit(1);
  }

  // Wait for EnvCell bake to plateau.
  console.log(`waiting up to ${ENVCELL_BAKE_TIMEOUT_MS}ms for academy EnvCell bake to settle`);
  let bakeDone = false;
  const bakeDeadline = Date.now() + ENVCELL_BAKE_TIMEOUT_MS;
  let bakeProgress = { loaded: false, academyCells: 0 };
  let stableSince = 0;
  while (Date.now() < bakeDeadline) {
    const status = await page.evaluate((expectedKey) => {
      const ls = window.liveScene3d;
      if (!ls) return { ready: false };
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
  console.log(
    `academy EnvCell bake plateaued=${bakeDone} (academyCells=${bakeProgress.academyCells})`
  );

  // Wait for ObjectCreate drain.
  console.log(`waiting ${ENTITY_DRAIN_MS}ms for ObjectCreate drain`);
  await page.waitForTimeout(ENTITY_DRAIN_MS);

  // Snapshot the entity map and walk for nameplates.
  const snapshot = await page.evaluate(({ academyHigh }) => {
    const out = { errors: [] };
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
        out.error = "entityManager.entityMap not a Map";
        return out;
      }

      let localPlayerGuid = 0;
      try {
        if (typeof window.getLocalPlayerGuid === "function") {
          const v = window.getLocalPlayerGuid();
          if (v !== null && v !== undefined) localPlayerGuid = v >>> 0;
        }
      } catch (_) {}

      let totalEntities = 0;
      let academyEntities = 0;
      let namedAcademy = 0;
      let namedAcademyWithSprite = 0;
      let namedAcademyWithCorrectText = 0;
      let namedAcademyWithSpriteAbove = 0;
      let namedAcademyWithSpriteMaterial = 0;
      let namedAcademyWithCanvasTexture = 0;
      let skippedLocalPlayer = 0;
      let skippedInventory = 0;
      const samples = [];
      const missingNames = [];

      for (const [guid, inst] of map) {
        totalEntities += 1;
        const meta = inst?.meta || {};
        const cellId = (meta.landblockId >>> 0);
        const lbHigh = (cellId >>> 16) & 0xffff;
        const isAcademy = lbHigh === (academyHigh >>> 0);
        const isLocalPlayer = (guid >>> 0) === localPlayerGuid;
        const isInventory = ((cellId & 0xffff_0000) >>> 0) === 0;

        if (isLocalPlayer) skippedLocalPlayer += 1;
        if (isInventory) skippedInventory += 1;

        if (!isAcademy) continue;
        academyEntities += 1;
        const name = (typeof meta.name === "string") ? meta.name : "";
        if (!name) continue;
        if (isLocalPlayer) continue;
        if (isInventory) continue;
        namedAcademy += 1;

        // Walk root.children for a Sprite child.
        const root = inst.root;
        if (!root || !Array.isArray(root.children)) {
          missingNames.push({ guid, name, reason: "no root or no children" });
          continue;
        }
        let sprite = null;
        for (const child of root.children) {
          // Sprite check: three.js Sprite has `.isSprite === true` AND
          // `.type === "Sprite"`. Either marker works; check the type
          // so the test is independent of any prototype walk.
          if (child && (child.isSprite === true || child.type === "Sprite")) {
            sprite = child;
            break;
          }
        }
        if (!sprite) {
          missingNames.push({ guid: "0x" + guid.toString(16), name, reason: "no Sprite child" });
          continue;
        }
        namedAcademyWithSprite += 1;

        // Validate sprite metadata.
        const ud = sprite.userData || {};
        if (ud.nameplateText === name) namedAcademyWithCorrectText += 1;
        if (typeof sprite.position?.z === "number" && sprite.position.z > 0) {
          namedAcademyWithSpriteAbove += 1;
        }
        const mat = sprite.material;
        if (mat && (mat.isSpriteMaterial === true || mat.type === "SpriteMaterial")) {
          namedAcademyWithSpriteMaterial += 1;
          const map = mat.map;
          if (map && (map.isCanvasTexture === true || map.type === "CanvasTexture")) {
            namedAcademyWithCanvasTexture += 1;
          }
        }

        if (samples.length < 10) {
          samples.push({
            guid: "0x" + guid.toString(16).padStart(8, "0"),
            name,
            spriteName: sprite.name || "",
            position: {
              x: sprite.position.x,
              y: sprite.position.y,
              z: sprite.position.z,
            },
            scale: {
              x: sprite.scale.x,
              y: sprite.scale.y,
              z: sprite.scale.z,
            },
            color: ud.color || "",
            materialType: mat?.type || "",
            mapType: mat?.map?.type || "",
            mapWidth: mat?.map?.image?.width || 0,
            mapHeight: mat?.map?.image?.height || 0,
          });
        }
      }

      out.totalEntities = totalEntities;
      out.academyEntities = academyEntities;
      out.namedAcademy = namedAcademy;
      out.namedAcademyWithSprite = namedAcademyWithSprite;
      out.namedAcademyWithCorrectText = namedAcademyWithCorrectText;
      out.namedAcademyWithSpriteAbove = namedAcademyWithSpriteAbove;
      out.namedAcademyWithSpriteMaterial = namedAcademyWithSpriteMaterial;
      out.namedAcademyWithCanvasTexture = namedAcademyWithCanvasTexture;
      out.skippedLocalPlayer = skippedLocalPlayer;
      out.skippedInventory = skippedInventory;
      out.localPlayerGuid = "0x" + localPlayerGuid.toString(16).padStart(8, "0");
      out.spawnCount = em.spawnCount | 0;
      out.removeCount = em.removeCount | 0;
      out.samples = samples;
      out.missingNames = missingNames.slice(0, 20);
    } catch (e) {
      out.error = String(e?.message ?? e);
      out.errorStack = String(e?.stack ?? "").slice(0, 1200);
    }
    return out;
  }, { academyHigh: ACADEMY_LB_HIGH });

  console.log("=== nameplate snapshot summary ===");
  console.log(
    JSON.stringify(
      {
        totalEntities: snapshot.totalEntities,
        academyEntities: snapshot.academyEntities,
        namedAcademy: snapshot.namedAcademy,
        namedAcademyWithSprite: snapshot.namedAcademyWithSprite,
        namedAcademyWithCorrectText: snapshot.namedAcademyWithCorrectText,
        namedAcademyWithSpriteAbove: snapshot.namedAcademyWithSpriteAbove,
        namedAcademyWithSpriteMaterial: snapshot.namedAcademyWithSpriteMaterial,
        namedAcademyWithCanvasTexture: snapshot.namedAcademyWithCanvasTexture,
        skippedLocalPlayer: snapshot.skippedLocalPlayer,
        skippedInventory: snapshot.skippedInventory,
        spawnCount: snapshot.spawnCount,
        removeCount: snapshot.removeCount,
      },
      null,
      2
    )
  );

  if (snapshot.samples && snapshot.samples.length > 0) {
    console.log("=== sample nameplated entities ===");
    for (const s of snapshot.samples) {
      console.log(
        `  guid=${s.guid} name="${s.name}" pos=(${s.position.x.toFixed(2)},${s.position.y.toFixed(2)},${s.position.z.toFixed(2)}) ` +
          `scale=(${s.scale.x.toFixed(2)},${s.scale.y.toFixed(2)}) color=${s.color} ` +
          `mat=${s.materialType} map=${s.mapType} ${s.mapWidth}x${s.mapHeight}`
      );
    }
  }
  if (snapshot.missingNames && snapshot.missingNames.length > 0) {
    console.log("=== entities missing nameplates (first 20) ===");
    for (const m of snapshot.missingNames) {
      console.log(`  guid=${m.guid} name="${m.name}" reason=${m.reason}`);
    }
  }

  fs.writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
  console.log(`saved snapshot → ${SNAPSHOT_PATH}`);

  // Take screenshot of just the canvas region so the 3D world (and the
  // nameplates) are framed without the surrounding HUD/chat scrolling
  // past the viewport. fullPage:false only catches the viewport top-
  // left; locator.screenshot() crops to the canvas element exactly.
  await page.waitForTimeout(500);
  try {
    const canvas = page.locator("canvas").first();
    await canvas.screenshot({ path: SCREENSHOT_PATH });
    console.log(`saved canvas screenshot → ${SCREENSHOT_PATH}`);
  } catch (e) {
    console.warn(`canvas-locator screenshot failed (${e?.message ?? e}); falling back to full-page`);
    await page.screenshot({ path: SCREENSHOT_PATH, fullPage: true });
  }

  // Verdict.
  let failures = 0;
  function check(name, ok, detail) {
    const status = ok ? "OK" : "FAIL";
    console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
    if (!ok) failures += 1;
  }

  if (snapshot.error) {
    check("nameplate snapshot ran cleanly", false, snapshot.error);
  } else {
    const named = snapshot.namedAcademy;
    const withSprite = snapshot.namedAcademyWithSprite;
    const coverage = named > 0 ? (withSprite / named * 100).toFixed(1) : "0.0";
    check(
      "at least 1 named academy entity in EntityManager",
      named >= 1,
      `named=${named}`
    );
    check(
      "every named academy entity has a Sprite child of root",
      withSprite === named && named > 0,
      `sprite/named=${withSprite}/${named} (${coverage}%)`
    );
    check(
      "every Sprite carries correct nameplateText userData",
      snapshot.namedAcademyWithCorrectText === withSprite && withSprite > 0,
      `correct/sprite=${snapshot.namedAcademyWithCorrectText}/${withSprite}`
    );
    check(
      "every Sprite is positioned above the entity (z > 0)",
      snapshot.namedAcademyWithSpriteAbove === withSprite && withSprite > 0,
      `above/sprite=${snapshot.namedAcademyWithSpriteAbove}/${withSprite}`
    );
    check(
      "every Sprite has a SpriteMaterial",
      snapshot.namedAcademyWithSpriteMaterial === withSprite && withSprite > 0,
      `mat/sprite=${snapshot.namedAcademyWithSpriteMaterial}/${withSprite}`
    );
    check(
      "every SpriteMaterial map is a CanvasTexture",
      snapshot.namedAcademyWithCanvasTexture === withSprite && withSprite > 0,
      `tex/sprite=${snapshot.namedAcademyWithCanvasTexture}/${withSprite}`
    );
  }

  check(
    "zero browser console errors during capture",
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
    console.log("PASS: nameplate capture completed.");
    console.log(`snapshot:   ${SNAPSHOT_PATH}`);
    console.log(`screenshot: ${SCREENSHOT_PATH}`);
    console.log(`diag log:   ${DIAG_LOG_PATH}`);
    process.exit(0);
  }
})().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
