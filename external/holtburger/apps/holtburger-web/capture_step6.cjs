// Phase 4 step 6 capture: synthetic-entity demonstration of the
// realistic-NPC / portal / sign / container visuals (6a + 6b + 6e).
//
// This script does NOT need a running ACE / wsbridge. It loads the
// page over the http.server on :8765, waits for the static
// renderNeighbourhood pass to complete (terrain + placements paint),
// then injects EntityUpdate-shaped objects through the
// window.handleEntitySpawn surface (exposed alongside window.liveScene
// for capture-only use). The sub-steps under demonstration:
//
//   - 6a: weenie metadata reaching JS via the EntityUpdate fields.
//   - 6b: ItemType-keyed glyph fallback (cyan ring for portals,
//         red diamond for creatures, orange triangle for signs,
//         brown square for containers, etc.) — replaces the
//         step-2b magenta dot.
//   - 6e: per-entity nameplates (PIXI.Text in nameplateContainer,
//         constant 12px screen-space, colour-coded by category).
//
// Live-ACE wire-effect validation belongs in capture_phase4_step3.cjs;
// this capture is for visual sign-off on the JS-side rendering work.
const { chromium } = require("playwright");
const path = require("node:path");

(async () => {
  const PAGE_URL = "http://127.0.0.1:8765/apps/holtburger-web/index.html";
  const OUT_PATH = path.resolve(
    __dirname,
    "../../../../docs/images/phase-4-step-6-entities.png"
  );

  console.log("[step6-capture] launching headless chromium");
  const browser = await chromium.launch({ args: ["--use-gl=swiftshader"] });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
  const page = await context.newPage();
  page.setDefaultTimeout(180_000);
  page.on("pageerror", (e) => console.error("[pageerror]", e.message));
  page.on("requestfailed", (r) => console.warn(`[reqfail] ${r.method()} ${r.url()} :: ${r.failure()?.errorText}`));
  page.on("console", (m) => {
    const t = m.text();
    console.log(`[browser ${m.type()}] ${t}`);
  });

  console.log(`[step6-capture] navigating to ${PAGE_URL}`);
  await page.goto(PAGE_URL, { waitUntil: "load", timeout: 60_000 });

  // Wait for window.renderHoltburg to be defined (page module body
  // ran). Production code only invokes renderHoltburg inside the login
  // success path; we drive it directly so the capture works without
  // ACE. The page's manifest init at page-init time keeps the
  // fetch_* exports happy.
  console.log("[step6-capture] waiting for window.renderHoltburg");
  await page.waitForFunction(() => Boolean(window.renderHoltburg), { timeout: 60_000 });

  console.log("[step6-capture] running renderHoltburg() directly");
  // Don't await this here — renderHoltburg awaits internally before
  // it sets liveScene; we wait for the side-effect instead.
  page.evaluate(() => window.renderHoltburg()).catch((e) => console.warn("[render-evaluate]", e?.message));

  await page.waitForFunction(
    () => Boolean(window.liveScene && window.liveScene.entityContainer && window.handleEntitySpawn),
    { timeout: 180_000 }
  );

  // Inject five synthetic spawns at Holtburg town centre. ACE-streamed
  // entities arrive on csetup_ids that aren't in the static atlas; we
  // pass modelId=0 here to deliberately exercise the placeholder-glyph
  // path (since the on-demand fetch path needs a running ACE/manifest
  // session to resolve real models).
  console.log("[step6-capture] injecting synthetic Spawn events");
  await page.evaluate(() => {
    const HOLTBURG_LB = 0xA9B4FFFF;
    const Q = { qw: 1, qx: 0, qy: 0, qz: 0 };
    // Ground-truth ItemType bits from
    // external/ACE/Source/ACE.Entity/Enum/ItemType.cs:6
    const PORTAL = 0x00010000;
    const CREATURE = 0x00000010;
    const WRITABLE = 0x00002000;  // signs
    const CONTAINER = 0x00000200;
    const ARMOR = 0x00000002;
    const WEAPON_MELEE = 0x00000001;
    const KEY = 0x00004000;
    const LIFE_STONE = 0x10000000;

    // Cluster around landblock-local centre (96, 96).
    const spawn = (guid, dx, dy, name, itemType, scale = 1.0) =>
      window.handleEntitySpawn({
        kind: 1, guid, modelId: 0,
        landblockId: HOLTBURG_LB,
        x: 96 + dx, y: 96 + dy, z: 0,
        ...Q,
        wcid: guid & 0xFFFF,
        itemType,
        name,
        objScale: scale,
        iconId: 0, paletteId: 0, mtableId: 0,
      });

    spawn(0xA0000001, -22,  16, "Holtburg Portal",     PORTAL);
    spawn(0xA0000002, -10,  -2, "Drudge Slave",        CREATURE, 1.3);
    spawn(0xA0000003,  10,  -2, "Town Crier Ulgrim",   CREATURE);
    spawn(0xA0000004,  22,  16, "Welcome to Holtburg", WRITABLE);
    spawn(0xA0000005, -22, -16, "Storage Chest",       CONTAINER);
    spawn(0xA0000006,  18,  -2, "Lifestone",           LIFE_STONE);
    spawn(0xA0000007,   0,  22, "Iron Sword",          WEAPON_MELEE);
    spawn(0xA0000008,   0, -18, "Studded Leather",     ARMOR);
    spawn(0xA0000009,  22, -16, "Brass Key",           KEY);
  });

  // Settle: one rAF tick to project nameplate positions.
  await page.waitForTimeout(400);

  // Resize the canvas + camera + zoom + re-centre, all in one
  // pass so PIXI sees a single resize event and we don't wait
  // through multiple intermediate frames.
  console.log("[step6-capture] resizing canvas + zooming camera");
  await page.evaluate(() => {
    const c = document.getElementById("canvas");
    c.width = 1024;
    c.height = 1024;
    if (window.liveScene?.app?.renderer) {
      window.liveScene.app.renderer.resize(1024, 1024);
    }
    const cam = window.liveScene.cameraContainer;
    // ~6 px/m gives good nameplate readability at the synthetic cluster.
    const target = 6.0;
    const centre = { wx: 169 * 192 + 96, wy: 180 * 192 + 96 };
    const cw = 1024, ch = 1024;
    // ~10 px/m gives glyphs at 6-8 px on the canvas — distinguishable
    // as cyan ring, red diamond, brown square, orange triangle, etc.
    // Less than the 14px previous attempt so context (terrain, roads,
    // buildings) is also legible behind the entity cluster.
    const targetClose = 10.0;
    cam.scale.set(targetClose, targetClose);
    cam.position.set(cw / 2 - centre.wx * targetClose, ch / 2 + centre.wy * targetClose);
  });
  await page.waitForTimeout(500);

  // Tick the nameplate projector once now that camera is settled.
  // In production drainEvents calls this every rAF; the capture
  // bypasses drainEvents (no login → no rAF loop), so we drive it
  // explicitly. One tick is enough since positions are static here.
  await page.evaluate(() => window.updateNameplatePositions());
  await page.waitForTimeout(150);

  console.log(`[step6-capture] writing canvas screenshot → ${OUT_PATH}`);
  await page.locator("#canvas").screenshot({ path: OUT_PATH });

  // Smoke probe: confirm the entityMap actually grew + nameplates
  // exist + the synthetic-portal entry holds the expected meta.
  const probe = await page.evaluate(() => {
    const out = {
      entityCount: window.entityMap.size,
      nameplateContainerVisible: window.liveScene.nameplateContainer.visible,
      nameplateChildCount: window.liveScene.nameplateContainer.children.length,
      cameraScale: window.liveScene.cameraContainer.scale.x,
      samples: [],
    };
    for (const [guid, entry] of window.entityMap) {
      const np = entry.nameplate;
      out.samples.push({
        guid: `0x${guid.toString(16).toUpperCase()}`,
        kind: entry.kind,
        category: entry.meta?.category,
        name: entry.meta?.name,
        hasNameplate: !!np,
        nameplatePos: np ? { x: Math.round(np.position.x), y: Math.round(np.position.y) } : null,
        nameplateText: np?.text,
      });
    }
    return out;
  });
  console.log("[step6-capture] entityMap probe:", JSON.stringify(probe, null, 2));

  await browser.close();
  console.log("[step6-capture] done");
})();
