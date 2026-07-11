// Tour 13 landblocks around Holtburg in wire mode. At each LB:
// 1. @teleloc to LB center, 200m altitude (server clamps to terrain)
// 2. Wait for envcell/PVS to settle
// 3. Align camera behind player in heading direction (so screenshot
//    shows what's IN FRONT — not the side of the character)
// 4. Screenshot to docs/wiretree/lb_0x<LB>_initial.png

import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "fs";

const HOLT_DOCS = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/docs/wiretree";
mkdirSync(HOLT_DOCS, { recursive: true });

// 13 LBs: 3×3 inner around Holtburg (0xA9, 0xB4) + 4 cardinal outer.
// Format: { lbX, lbY, label }
// LB coord convention: lbX = east-west byte, lbY = north-south byte.
// Holtburg LB ID = 0xA9B4 (X=A9, Y=B4).
const LBS = [
  // Cardinal outer
  { x: 0xA7, y: 0xB4, label: "W2"   }, // far west
  { x: 0xAB, y: 0xB4, label: "E2"   }, // far east
  { x: 0xA9, y: 0xB2, label: "N2"   }, // far north
  { x: 0xA9, y: 0xB6, label: "S2"   }, // far south
  // Inner 3×3
  { x: 0xA8, y: 0xB3, label: "NW"   },
  { x: 0xA9, y: 0xB3, label: "N"    },
  { x: 0xAA, y: 0xB3, label: "NE"   },
  { x: 0xA8, y: 0xB4, label: "W"    },
  { x: 0xA9, y: 0xB4, label: "C-Holtburg" },
  { x: 0xAA, y: 0xB4, label: "E"    },
  { x: 0xA8, y: 0xB5, label: "SW"   },
  { x: 0xA9, y: 0xB5, label: "S"    },
  { x: 0xAA, y: 0xB5, label: "SE"   },
];

const log = (...args) => {
  const ts = new Date().toISOString().slice(11, 19);
  console.log(`[${ts}]`, ...args);
};

const URL =
  "http://127.0.0.1:8765/apps/holtburger-web/index.html?" +
  "autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first&" +
  "renderer=3d&quality=low&agentic=low&wireframe=1";

const t0 = Date.now();
log("OUT_DIR =", HOLT_DOCS);
log("URL     =", URL);
log(`tour: ${LBS.length} LBs`);

const browser = await chromium.launch({
  headless: true,
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader",
         "--disable-gpu-sandbox", "--ignore-gpu-blocklist"],
});
const ctx = await browser.newContext({ viewport: { width: 1280, height: 720 } });
const page = await ctx.newPage();

const consoleLog = [];
page.on("console", (m) => consoleLog.push({ t: Date.now() - t0, type: m.type(), text: m.text() }));
page.on("pageerror", (e) => consoleLog.push({ t: Date.now() - t0, type: "pageerror", text: String(e?.message ?? e) }));

await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
log("page navigated");

// Wait for ready
const readyDeadline = Date.now() + 90_000;
while (Date.now() < readyDeadline) {
  const state = await page.evaluate(() => window.__bootState || "").catch(() => "");
  if (state === "ready") { log(`ready in ${((Date.now() - t0) / 1000).toFixed(1)}s`); break; }
  if (state === "error") { log("FAIL: boot error"); process.exit(2); }
  await new Promise(r => setTimeout(r, 500));
}

await page.waitForTimeout(2000);

const tourResults = [];
for (const lb of LBS) {
  const lbHex = (lb.x << 8 | lb.y).toString(16).toUpperCase().padStart(4, "0");
  const lbName = `0x${lbHex}-${lb.label}`;
  // @teleloc <ObjCellId> <PosX> <PosY> <PosZ>
  // ObjCellId = (LB_X << 24) | (LB_Y << 16) | 0x0001 (outdoor cell 1)
  // Local pos (96, 96, 200) = LB-local center at 200m altitude (server
  // drops to terrain).
  const cellId = `0x${lbHex}0001`;
  const cmd = `@teleloc ${cellId} 96.0 96.0 200.0`;
  log(`tour → ${lbName} (cmd=${cmd})`);

  await page.evaluate((c) => {
    try { window.__sessionHandle?.sendChat?.(c); } catch (_) {}
  }, cmd);
  // Wait for teleport + envcells + PVS streams to settle
  await page.waitForTimeout(5500);

  // Align camera behind player in heading direction
  const align = await page.evaluate(() => {
    return window.__wireCameraAlignBehindPlayer?.() ?? { ok: false, reason: "helper-missing" };
  });
  // Let camera tick to new position
  await page.waitForTimeout(400);

  const pose = await page.evaluate(() => {
    const p = window.__sessionHandle?.getLocalPlayerPose?.();
    return p ? { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), heading: typeof p.heading === "number" ? +p.heading.toFixed(3) : null } : null;
  });

  // Count meshes
  const sceneStats = await page.evaluate(() => {
    const s = window.liveScene3d;
    let meshes = 0;
    s?.scene?.traverse?.((o) => { if (o.isMesh) meshes++; });
    return {
      meshes,
      textures: s?.renderer?.info?.memory?.textures ?? 0,
      geometries: s?.renderer?.info?.memory?.geometries ?? 0,
    };
  });

  const file = `${HOLT_DOCS}/lb_0x${lbHex}_${lb.label}_initial.png`;
  await page.screenshot({ path: file });
  log(`  saved ${file.split("/").pop()}  pose=${JSON.stringify(pose)}  meshes=${sceneStats.meshes}  align=${align.ok}`);

  tourResults.push({ lbHex, label: lb.label, file, pose, sceneStats, align });
}

writeFileSync(`${HOLT_DOCS}/tour-summary.json`, JSON.stringify({
  tourStartedAt: new Date(t0).toISOString(),
  totalMs: Date.now() - t0,
  results: tourResults,
}, null, 2));
writeFileSync(`${HOLT_DOCS}/tour-console.json`, JSON.stringify(consoleLog, null, 2));
log(`tour done. ${tourResults.length} screenshots in ${HOLT_DOCS}`);

await browser.close();
