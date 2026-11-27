#!/usr/bin/env node
// harness/port-terminal-stage.js — Live ACE + real-GPU Chrome 8-shot visual stage driver
// for the Marine Container Terminal & Container Ship at Site A (NE Flatland North Coast,
// 0xE8F8..0xEBF9, PORT_ORIGIN = [44960, 47880, 0], Warehouse = [44960, 47625, 0]).
//
// Drives an already-running `harness/ingame-driver.mjs` instance (default http://127.0.0.1:8799)
// via POST /eval and GET /shot, capturing all 8 1920x1080 PNG screenshots at noon
// (`setSkyTimeOverride(0.5)`), hiding `[id^=hb-]` on shots 1-5 & 7-8 while showing
// `#hb-ship-osd` on shot 6, and verifying zero failing errors in driver-console.log.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { filterErrors } from "./lib/console_allowlist.mjs";

const PORT_ORIGIN = [44960.0, 47880.0, 0.0];
const WAREHOUSE_ORIGIN = [44960.0, 47625.0, 0.0];
const TELE_YARD_CMD = "@tele 96.80N 85.33E";

const SHOT_NAMES = Object.freeze({
  "1": "01_overview_port_and_warehouse",
  "2": "02_ship_autonomous_berthing",
  "3": "03_sts_crane_discharge_cycle",
  "4": "04_container_yard_rmg_rtg_reefer",
  "5": "05_warehouse_intermodal_handoff",
  "6": "06_ship_manual_helm_bridge_hud",
  "7": "07_dual_berth_full_ops",
  "8": "08_vessel_bow_and_waterline_closeup",
});

function printHelp() {
  console.log(`port-terminal-stage.js — Stage & capture 8 live Marine Terminal & Ship shots via ingame-driver.mjs

Usage:
  node harness/port-terminal-stage.js [options]

Options:
  --driver-url <url>   Control API of ingame-driver.mjs (default: http://127.0.0.1:8799)
  --out <dir>          Output directory containing driver-console.log & PNGs (default: /workspace/wb/port-shots/ingame)
  --shot <all|1..8>    Run all 8 shots or a single shot index (default: all)
  --help, -h           Print this help`);
}

function parseArgs(argv) {
  const opts = {
    driverUrl: process.env.DRIVER_URL || "http://127.0.0.1:8799",
    outDir: process.env.OUT || "/workspace/wb/port-shots/ingame",
    shot: "all",
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") opts.help = true;
    else if (a === "--driver-url") opts.driverUrl = argv[++i];
    else if (a.startsWith("--driver-url=")) opts.driverUrl = a.slice("--driver-url=".length);
    else if (a === "--out") opts.outDir = argv[++i];
    else if (a.startsWith("--out=")) opts.outDir = a.slice("--out=".length);
    else if (a === "--shot") opts.shot = String(argv[++i]).toLowerCase();
    else if (a.startsWith("--shot=")) opts.shot = a.slice("--shot=".length).toLowerCase();
    else throw new Error(`Unknown option: ${a}`);
  }
  if (opts.shot !== "all" && !(opts.shot in SHOT_NAMES)) {
    throw new Error(`Invalid --shot "${opts.shot}" (expected all or 1..8)`);
  }
  return opts;
}

function parsePngDimensions(buf) {
  if (!buf || buf.length < 24) return { valid: false, reason: "file too short" };
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) return { valid: false, reason: "invalid PNG signature" };
  }
  const type = buf.toString("ascii", 12, 16);
  if (type !== "IHDR") return { valid: false, reason: `unexpected first chunk ${type}` };
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { valid: width === 1920 && height === 1080, width, height };
}

class StageClient {
  constructor(driverUrl, outDir) {
    this.driverUrl = driverUrl.replace(/\/+$/, "");
    this.outDir = outDir;
    mkdirSync(this.outDir, { recursive: true });
  }

  async evalInPage(body) {
    const res = await fetch(`${this.driverUrl}/eval`, {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch (_) {
      throw new Error(`Driver /eval returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok || !json.ok) {
      throw new Error(`Driver /eval error: ${json.err || text}`);
    }
    return json.r;
  }

  async settleFrames(n = 4) {
    return this.evalInPage(`
      const t0 = performance.now();
      while (window.__portalSpace && window.__portalSpace.state !== 0 && performance.now() - t0 < 2000) {
        await new Promise((r) => setTimeout(r, 30));
      }
      for (let i = 0; i < ${Math.max(1, n)}; i++) {
        await new Promise((r) => requestAnimationFrame(r));
      }
      return true;
    `);
  }

  async hideAllHud() {
    return this.evalInPage(`
      let st = document.getElementById("__e2e_hide_hud");
      if (!st) {
        st = document.createElement("style");
        st.id = "__e2e_hide_hud";
        document.head.appendChild(st);
      }
      st.textContent = "[id^=hb-], .hb-pill, .hb-bar, .hb-panel, #hb-weather-pill, button[aria-label=\\"Restore bar\\"], #chat-panel, #hud-root, body > button, body > div > button { visibility: hidden !important; display: none !important; }";
      document.documentElement.classList.add("no-hud");
      return true;
    `);
  }

  async showShipOsdOnly() {
    return this.evalInPage(`
      let st = document.getElementById("__e2e_hide_hud");
      if (!st) {
        st = document.createElement("style");
        st.id = "__e2e_hide_hud";
        document.head.appendChild(st);
      }
      st.textContent = "[id^=hb-]:not(#hb-ship-osd), .hb-pill, .hb-bar, .hb-panel, #hb-weather-pill, button[aria-label=\\"Restore bar\\"], #chat-panel, #hud-root, body > button, body > div > button { visibility: hidden !important; display: none !important; } #hb-ship-osd { visibility: visible !important; display: block !important; }";
      document.documentElement.classList.remove("no-hud");
      return true;
    `);
  }

  async waitUntil(predFn, timeoutMs = 20000, pollMs = 150, label = "condition") {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      const val = await predFn();
      if (val) return val;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    throw new Error(`Timed out waiting for ${label} after ${timeoutMs} ms`);
  }

  async captureShot(name) {
    const res = await fetch(`${this.driverUrl}/shot?name=${encodeURIComponent(name)}`);
    const json = await res.json();
    if (!res.ok || !json.ok) {
      throw new Error(`Driver /shot?name=${name} failed: ${json.err || res.status}`);
    }
    const filePath = json.f || path.join(this.outDir, `${name}.png`);
    if (!existsSync(filePath)) {
      throw new Error(`Captured screenshot missing on disk: ${filePath}`);
    }
    const st = statSync(filePath);
    if (st.size <= 12 * 1024) {
      throw new Error(`Screenshot ${filePath} suspiciously small (${st.size} bytes)`);
    }
    const png = parsePngDimensions(readFileSync(filePath));
    if (!png.valid) {
      throw new Error(`Screenshot ${filePath} invalid PNG: ${JSON.stringify(png)}`);
    }
    console.log(`[shot] ${name}.png (${png.width}x${png.height}, ${(st.size / 1024).toFixed(1)} KiB) -> ${filePath}`);
    return { path: filePath, bytes: st.size, ...png };
  }

  getConsoleLogOffset() {
    const logPath = path.join(this.outDir, "driver-console.log");
    if (!existsSync(logPath)) return 0;
    return statSync(logPath).size;
  }

  assertZeroConsoleErrors(startOffset) {
    const logPath = path.join(this.outDir, "driver-console.log");
    if (!existsSync(logPath)) {
      throw new Error(`driver-console.log not found at ${logPath}`);
    }
    const raw = readFileSync(logPath, "utf8");
    const delta = raw.slice(Math.min(startOffset, raw.length));
    const lines = delta.split(/\r?\n/).filter(Boolean);
    const errorLines = lines.filter((l) => l.startsWith("[error]") || l.startsWith("[pageerror]"));
    const { failing, allowed } = filterErrors(errorLines);
    if (allowed.length > 0) {
      console.log(`[console] ${allowed.length} allowlisted message(s) ignored`);
    }
    if (failing.length > 0) {
      throw new Error(`Console/page errors detected (${failing.length}):\n${failing.join("\n")}`);
    }
  }
}

async function setupPortSiteBase(client) {
  await client.evalInPage(`
    const sh = window.__sessionHandle;
    if (!sh) throw new Error("window.__sessionHandle missing");
    if (!window.__port?.terminal || !window.__port?.ship || !window.__port?.warehouse) {
      throw new Error("window.__port facade missing (is ?vehicles=on enabled?)");
    }
    if (!window.__cam?.orbit) throw new Error("window.__cam.orbit missing (is ?camDebug=on enabled?)");
    sh.sendChat("@vehicle despawn all");
    sh.sendChat("@trailer despawn all");
    sh.sendChat("@container despawn all");
    sh.sendChat("@palletjack despawn all");
    return true;
  `);
  await new Promise((r) => setTimeout(r, 400));

  await client.evalInPage(`
    window.__sessionHandle.sendChat(${JSON.stringify(TELE_YARD_CMD)});
    return true;
  `);

  await client.waitUntil(
    () =>
      client.evalInPage(`
        const sh = window.__sessionHandle;
        const p = sh?.getLocalPlayerPose?.();
        if (!p) return false;
        const lb = (p.landblockId >>> 16) & 0xffff;
        const tz = sh.terrainHeightAt?.(${PORT_ORIGIN[0]}, ${PORT_ORIGIN[1]});
        return (lb === 0xeaf8 || lb === 0xeaf9 || lb === 0xe9f8 || lb === 0xe9f9) && Number.isFinite(tz);
      `),
    25000,
    250,
    "Site A (0xEAF8) teleport & terrain readiness"
  );

  await client.evalInPage(`
    window.__sessionHandle.setSkyTimeOverride(0.5);
    return true;
  `);
  await client.hideAllHud();
  await client.settleFrames(4);
}

async function resetSceneClean(client, { populateYard = true, buildWarehouse = true } = {}) {
  await client.hideAllHud();
  await client.evalInPage(`
    const v = window.__vehicles;
    const p = window.__port;
    try { p.ship.exit?.(); } catch (_) {}
    for (const s of (p.ship.list?.() || [])) {
      try { p.ship.removeShip(s.id); } catch (_) {}
    }
    try { p.terminal.stopScenarios?.(); } catch (_) {}
    try { p.terminal.clearTerminal?.(); } catch (_) {}
    try { p.warehouse.stopScenarios?.(); } catch (_) {}
    try { p.warehouse.clearHub?.(); } catch (_) {}
    for (const c of (v.containers?.list?.() || [])) {
      try { v.containers.removeLocal?.(c.guid); } catch (_) {}
    }
    for (const t of (v.trailers?.list?.() || [])) {
      try { v.trailers.removeLocal?.(t.guid); } catch (_) {}
    }
    for (const s of (v.semi?.list?.() || [])) {
      try { v.semi.removeLocal?.(s.guid); } catch (_) {}
    }

    p.terminal.buildTerminal({ origin: ${JSON.stringify(PORT_ORIGIN)}, populateYard: ${Boolean(populateYard)} });
    if (${Boolean(buildWarehouse)}) {
      p.warehouse.buildHub({ origin: ${JSON.stringify(WAREHOUSE_ORIGIN)}, populateDemoCargo: true });
    }
    window.__sessionHandle.setSkyTimeOverride(0.5);
    return { terminal: p.terminal.stats, warehouse: p.warehouse.stats };
  `);
  await client.settleFrames(3);
}

async function runShot1(client) {
  await resetSceneClean(client, { populateYard: true, buildWarehouse: true });
  await client.evalInPage(`
    const p = window.__port;
    const [ox, oy] = ${JSON.stringify(PORT_ORIGIN)};
    p.ship.spawnShip("MV-DERETH-1", {
      name: "M/V Dereth Feeder",
      spawnAtBerth: "B1",
      moored: true,
      populateCargo: true,
    });
    // Populate warehouse drop pad C1 so seam shows live intermodal handoff
    p.terminal.deliverToWarehousePad("C1", {
      wcid: 4000021,
      liveryId: 0,
      slots: [
        { slotIndex: 18, palletSize: "full", cargoWcid: 4000014 },
        { slotIndex: 19, palletSize: "full", cargoWcid: 4000011 },
      ],
    });
    // High aerial overview showing Deep Sea -> Ship -> Quay + STS -> Container Yard + RMG/RTG/Reefer -> Warehouse South
    window.__cam.orbit(ox - 10, oy - 95, 4.0, 295, 205, 34);
    return true;
  `);
  await client.settleFrames(6);
  return client.captureShot(SHOT_NAMES["1"]);
}

async function runShot2(client) {
  await resetSceneClean(client, { populateYard: true, buildWarehouse: true });
  await client.evalInPage(`
    const p = window.__port;
    const [ox, oy] = ${JSON.stringify(PORT_ORIGIN)};
    const ship = p.ship.spawnShip("MV-BERTH-1", {
      name: "M/V Dereth Feeder",
      x: ox - 80.0,
      y: oy + 26.0,
      heading: Math.PI * 0.5,
      moored: false,
      mode: "autonomous",
      populateCargo: true,
    });
    p.ship.commandGoToBerth("MV-BERTH-1", "B1");
    // Step ~1.8s so bow & stern thrusters are actively crabbing with visible whitewater plumes
    for (let i = 0; i < 54; i++) {
      p.ship.tick(1 / 30, [ox - 80, oy + 12, 16]);
    }
    window.__cam.orbit(ox - 80, oy + 12, 5.0, 76, 228, 22);
    return p.ship.get("MV-BERTH-1")?.state?.captainState ?? null;
  `);
  await client.settleFrames(5);
  return client.captureShot(SHOT_NAMES["2"]);
}

async function runShot3(client) {
  await resetSceneClean(client, { populateYard: true, buildWarehouse: true });
  await client.evalInPage(`
    const p = window.__port;
    const [ox, oy] = ${JSON.stringify(PORT_ORIGIN)};
    p.ship.spawnShip("MV-STS-1", {
      name: "M/V Dereth Feeder",
      spawnAtBerth: "B1",
      moored: true,
      populateCargo: true,
    });
    // Position TT-1 under STS-1 portal lane awaiting the hoisted 40ft container
    const tt1 = p.terminal.shuttles.get("TT-1");
    tt1?.setPoseImmediate?.({ x: ox - 77.0, y: oy - 13.0, heading: Math.PI * 0.5, cargo: null });

    // Pose STS-1 mid-hoist lifting a 40ft container cleanly out of Bay 04 above ship deck toward portal shuttle
    const sts1 = p.terminal.sts.get("STS-1");
    sts1?.setPoseImmediate?.({
      x: ox - 77.0,
      trolleyY: 16.5,
      spreaderZ: 15.2,
      spreaderLen: 12.192,
      boomAngle: 0.0,
      twistlockAngle: Math.PI * 0.5,
      carriedContainer: { wcid: 4000021, kind: 11, sizeFt: 40, liveryId: 1, bic: "HLTB U 404210-7" },
    });

    window.__cam.orbit(ox - 77.0, oy - 1.0, 12.0, 52, 232, 18);
    return true;
  `);
  await client.settleFrames(5);
  return client.captureShot(SHOT_NAMES["3"]);
}

async function runShot4(client) {
  await resetSceneClean(client, { populateYard: true, buildWarehouse: true });
  await client.evalInPage(`
    const p = window.__port;
    const [ox, oy] = ${JSON.stringify(PORT_ORIGIN)};
    const rmg1 = p.terminal.yardCranes.get("RMG-1");
    rmg1?.setPoseImmediate?.({
      x: ox - 68.0,
      trolleyY: -3.5,
      spreaderZ: 10.6,
      spreaderLen: 12.192,
      twistlockAngle: Math.PI * 0.5,
      carriedContainer: { wcid: 4000022, kind: 12, sizeFt: 40, liveryId: 2 },
    });
    const rtg1 = p.terminal.yardCranes.get("RTG-1");
    rtg1?.setPoseImmediate?.({
      x: ox + 108.0,
      trolleyY: 2.0,
      spreaderZ: 9.8,
      spreaderLen: 12.192,
      wheelSteerRad: 0.0,
    });
    const tt2 = p.terminal.shuttles.get("TT-2");
    tt2?.setPoseImmediate?.({
      x: ox + 22.0,
      y: oy - 127.0,
      heading: Math.PI * 0.5,
      cargo: { wcid: 4000021, kind: 11, sizeFt: 40, liveryId: 0 },
    });
    window.__cam.orbit(ox + 26.0, oy - 138.0, 5.0, 128, 212, 26);
    return true;
  `);
  await client.settleFrames(5);
  return client.captureShot(SHOT_NAMES["4"]);
}

async function runShot5(client) {
  await resetSceneClean(client, { populateYard: true, buildWarehouse: true });
  await client.evalInPage(`
    const p = window.__port;
    const [ox, oy] = ${JSON.stringify(PORT_ORIGIN)};
    const [wox, woy] = ${JSON.stringify(WAREHOUSE_ORIGIN)};

    // Promote container onto untouched Warehouse Zone A Drop Pads C1 & C2 (doors open)
    p.terminal.deliverToWarehousePad("C1", {
      wcid: 4000021,
      liveryId: 0,
      slots: [
        { slotIndex: 18, palletSize: "full", cargoWcid: 4000014 },
        { slotIndex: 19, palletSize: "full", cargoWcid: 4000011 },
      ],
    });
    p.terminal.deliverToWarehousePad("C2", {
      wcid: 4000022,
      liveryId: 1,
      slots: [
        { slotIndex: 19, palletSize: "full", cargoWcid: 4000012 },
      ],
    });

    // Terminal shuttle TT-3 in the Y=47684 intermodal corridor right north of the Y=47670 seam
    const tt3 = p.terminal.shuttles.get("TT-3");
    tt3?.setPoseImmediate?.({
      x: wox - 24.0,
      y: woy + 59.0,
      heading: Math.PI * 0.5,
      cargo: { wcid: 4000021, kind: 11, sizeFt: 40, liveryId: 2 },
    });

    // Untouched Warehouse AGF actively extracting pallet from C1 open doors
    const agf = p.warehouse.spawnAgf("agf-handoff", {
      pos: [wox - 40.575, woy + 25.85, 0],
      heading: 0.0,
      forkHeightM: 0.227,
      supportSurfaceZ: 0.162,
      carriedWcid: 4000014,
    });
    agf.model?.update?.({
      forkHeightM: 0.227,
      supportSurfaceZ: 0.162,
      carriedWcid: 4000014,
      statusMode: "lifting",
      dt: 0,
    });

    window.__cam.orbit(wox - 32.0, woy + 38.0, 2.5, 42, 148, 22);
    return { containersOnPads: window.__vehicles.containers.list().length };
  `);
  await client.settleFrames(5);
  return client.captureShot(SHOT_NAMES["5"]);
}

async function runShot6(client) {
  await resetSceneClean(client, { populateYard: true, buildWarehouse: true });
  await client.evalInPage(`
    const p = window.__port;
    const [ox, oy] = ${JSON.stringify(PORT_ORIGIN)};
    p.ship.spawnShip("MV-HELM-1", {
      name: "M/V Dereth Feeder",
      x: ox - 30.0,
      y: oy + 145.0,
      heading: Math.PI * 0.62,
      moored: false,
      mode: "manual",
      populateCargo: true,
    });
    p.ship.board("MV-HELM-1", { viewMode: "bridge" });
    p.ship.setHelmInput("MV-HELM-1", { eot: 2, rudder: 0.35, bowThruster: 0.25, sternThruster: 0.0 });
    for (let i = 0; i < 60; i++) {
      p.ship.tick(1 / 30, [ox - 30, oy + 145, 16]);
    }
    const st = p.ship.get("MV-HELM-1").state;
    // Frame from bridge wing looking forward over cargo stacks & open sea with terminal on starboard bow
    window.__cam.orbit(st.x, st.y, 13.5, 36, ((st.heading * 180) / Math.PI + 195) % 360, 12);
    return { boarded: p.ship.getBoardedShipId(), osdVisible: Boolean(document.getElementById("hb-ship-osd")) };
  `);
  // Shot 6 explicitly keeps #hb-ship-osd visible!
  await client.showShipOsdOnly();
  await client.settleFrames(6);
  const res = await client.captureShot(SHOT_NAMES["6"]);
  await client.evalInPage(`window.__port.ship.exit(); return true;`);
  await client.hideAllHud();
  return res;
}

async function runShot7(client) {
  await resetSceneClean(client, { populateYard: true, buildWarehouse: true });
  await client.evalInPage(`
    const p = window.__port;
    const [ox, oy] = ${JSON.stringify(PORT_ORIGIN)};
    // Ship 1 moored & discharging at Berth 1
    p.ship.spawnShip("MV-DUAL-1", {
      name: "M/V Dereth Feeder",
      spawnAtBerth: "B1",
      moored: true,
      hullHex: 0x162b44,
      funnelHex: 0xc83e2b,
      populateCargo: true,
    });
    // Ship 2 crabbing into Berth 2 simultaneously
    p.ship.spawnShip("MV-DUAL-2", {
      name: "M/V Dericost Express",
      x: ox + 120.0,
      y: oy + 28.0,
      heading: Math.PI * 0.5,
      moored: false,
      mode: "autonomous",
      hullHex: 0x1c3a32,
      funnelHex: 0xd98a1e,
      populateCargo: true,
    });
    p.ship.commandGoToBerth("MV-DUAL-2", "B2");
    for (let i = 0; i < 45; i++) {
      p.ship.tick(1 / 30, [ox + 20, oy + 20, 20]);
    }
    const sts1 = p.terminal.sts.get("STS-1");
    sts1?.setPoseImmediate?.({
      x: ox - 77.0,
      trolleyY: 18.0,
      spreaderZ: 15.8,
      spreaderLen: 12.192,
      twistlockAngle: Math.PI * 0.5,
      carriedContainer: { wcid: 4000021, kind: 11, sizeFt: 40, liveryId: 0 },
    });
    const sts2 = p.terminal.sts.get("STS-2");
    sts2?.setPoseImmediate?.({
      x: ox + 120.0,
      trolleyY: 4.0,
      spreaderZ: 21.0,
      spreaderLen: 12.192,
      boomAngle: 0.0,
    });
    window.__cam.orbit(ox + 20.0, oy - 6.0, 10.0, 235, 208, 28);
    return { shipCount: p.ship.list().length };
  `);
  await client.settleFrames(6);
  return client.captureShot(SHOT_NAMES["7"]);
}

async function runShot8(client) {
  await resetSceneClean(client, { populateYard: true, buildWarehouse: false });
  await client.evalInPage(`
    const p = window.__port;
    const [ox, oy] = ${JSON.stringify(PORT_ORIGIN)};
    p.ship.spawnShip("MV-HERO-1", {
      name: "M/V Dereth Feeder",
      x: ox - 20.0,
      y: oy + 115.0,
      heading: Math.PI * 0.45,
      moored: false,
      mode: "manual",
      populateCargo: true,
    });
    // Unload Bay 02 deck tiers (86 -> 84 -> 82) & open forward hold hatch Bay 02 so the
    // open cell-guided cargo hold (tank-top z=+0.45 m, 0 water clipping) is clearly visible
    for (const tier of [86, 84, 82]) {
      for (const row of [4, 2, 1, 3]) {
        p.ship.unloadContainer("MV-HERO-1", 2, row, tier);
      }
    }
    const hatchRes = p.ship.setHatchCover("MV-HERO-1", 2, true, true);
    p.ship.setHelmInput("MV-HERO-1", { eot: 3, rudder: 0.0, bowThruster: 0.0, sternThruster: 0.0 });
    for (let i = 0; i < 75; i++) {
      p.ship.tick(1 / 30, [ox, oy + 115, 6]);
    }
    const st = p.ship.get("MV-HERO-1").state;
    // Sea-level heroic three-quarter bow shot: bulbous bow, open Bay 02 hold (z=+0.45m), boot-top swell line, deck stacks, bridge & Kelvin wake
    const bowX = st.x + Math.sin(st.heading) * 24.0;
    const bowY = st.y + Math.cos(st.heading) * 24.0;
    window.__cam.orbit(bowX, bowY, 4.2, 56, ((st.heading * 180) / Math.PI + 38) % 360, 15);
    return { speed: st.speed, z: st.z, bay02HatchOpen: hatchRes?.open ?? 0 };
  `);
  await client.settleFrames(6);
  return client.captureShot(SHOT_NAMES["8"]);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const client = new StageClient(opts.driverUrl, opts.outDir);
  await setupPortSiteBase(client);
  await new Promise((r) => setTimeout(r, 1200));
  const logStart = client.getConsoleLogOffset();

  const runners = {
    "1": runShot1,
    "2": runShot2,
    "3": runShot3,
    "4": runShot4,
    "5": runShot5,
    "6": runShot6,
    "7": runShot7,
    "8": runShot8,
  };

  const order = opts.shot === "all" ? ["1", "2", "3", "4", "5", "6", "7", "8"] : [opts.shot];
  const results = {};
  for (const id of order) {
    results[`shot${id}`] = await runners[id](client);
  }

  client.assertZeroConsoleErrors(logStart);
  console.log("[port-terminal-stage] ALL REQUESTED SHOTS COMPLETE & 0 CONSOLE ERRORS");
}

main().catch((err) => {
  console.error("[port-terminal-stage] FAIL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
