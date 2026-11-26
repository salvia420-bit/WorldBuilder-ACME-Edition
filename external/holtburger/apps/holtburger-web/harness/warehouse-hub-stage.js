#!/usr/bin/env node
// harness/warehouse-hub-stage.js — Live ACE + real-GPU Chrome visual stage driver
// for the Intermodal Automated Warehouse Hub at NE Flatland (0xE9F4, @tele 93.60N 84.80E).
//
// Drives an already-running `harness/ingame-driver.mjs` instance (default http://127.0.0.1:8799)
// via POST /eval and GET /shot, capturing 6 PNG screenshots + scale-stress telemetry and
// verifying zero console/page errors in driver-console.log.

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { filterErrors } from "./lib/console_allowlist.mjs";

const HUB_ORIGIN = [44832.0, 46944.0, 0.0];
const TELE_CMD = "@tele 93.60N 84.80E";
const L1_TELELOC_CMD = "@teleloc 0xE9F40014 50.00 86.00 0.00 0 0 0 1";

function printHelp() {
  console.log(`warehouse-hub-stage.js — Stage & capture 6 live warehouse hub shots via ingame-driver.mjs

Usage:
  node harness/warehouse-hub-stage.js [options]

Options:
  --driver-url <url>   Control API of ingame-driver.mjs (default: http://127.0.0.1:8799)
  --out <dir>          Output directory containing driver-console.log & PNGs (default: /workspace/wb/warehouse-shots/ingame)
  --shot <all|1..6>    Run all 6 shots or a single shot index (default: all)
  --help, -h           Print this help`);
}

function parseArgs(argv) {
  const opts = {
    driverUrl: process.env.DRIVER_URL || "http://127.0.0.1:8799",
    outDir: process.env.OUT || "/workspace/wb/warehouse-shots/ingame",
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
  if (opts.shot !== "all" && !["1", "2", "3", "4", "5", "6"].includes(opts.shot)) {
    throw new Error(`Invalid --shot "${opts.shot}" (expected all or 1..6)`);
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
    } catch (err) {
      throw new Error(`Driver /eval returned non-JSON (${res.status}): ${text.slice(0, 300)}`);
    }
    if (!res.ok || !json.ok) {
      throw new Error(`Driver /eval error: ${json.err || text}`);
    }
    return json.r;
  }

  async settleFrames(n = 3) {
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

  async hideHud() {
    return this.evalInPage(`
      let st = document.getElementById("__e2e_hide_hud");
      if (!st) {
        st = document.createElement("style");
        st.id = "__e2e_hide_hud";
        st.textContent = "[id^=hb-], .hb-pill, .hb-bar, .hb-panel, #hb-weather-pill, button[aria-label=\\"Restore bar\\"], #chat-panel, #hud-root, body > button, body > div > button { visibility: hidden !important; display: none !important; }";
        document.head.appendChild(st);
      }
      document.documentElement.classList.add("no-hud");
      return true;
    `);
  }

  async showHud() {
    return this.evalInPage(`
      const st = document.getElementById("__e2e_hide_hud");
      if (st) st.remove();
      document.documentElement.classList.remove("no-hud");
      return true;
    `);
  }

  async waitUntil(predFn, timeoutMs = 15000, pollMs = 150, label = "condition") {
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
    if (st.size <= 10 * 1024) {
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

async function setupHubBase(client) {
  await client.evalInPage(`
    const sh = window.__sessionHandle;
    if (!sh) throw new Error("window.__sessionHandle missing");
    if (!window.__vehicles?.warehouse) throw new Error("window.__vehicles.warehouse missing");
    if (!window.__cam?.orbit) throw new Error("window.__cam.orbit missing (is ?camDebug=on enabled?)");
    sh.sendChat("@vehicle despawn all");
    sh.sendChat("@trailer despawn all");
    sh.sendChat("@container despawn all");
    sh.sendChat("@palletjack despawn all");
    return true;
  `);
  await new Promise((r) => setTimeout(r, 400));

  await client.evalInPage(`
    window.__sessionHandle.sendChat(${JSON.stringify(TELE_CMD)});
    return true;
  `);

  await client.waitUntil(
    () =>
      client.evalInPage(`
        const sh = window.__sessionHandle;
        const p = sh?.getLocalPlayerPose?.();
        if (!p) return false;
        const lb = (p.landblockId >>> 16) & 0xffff;
        const tz = sh.terrainHeightAt?.(${HUB_ORIGIN[0]}, ${HUB_ORIGIN[1]});
        return lb === 0xe9f4 && Number.isFinite(tz);
      `),
    25000,
    250,
    "NE Flatland 0xE9F4 teleport & terrain readiness"
  );

  await client.evalInPage(`
    const sh = window.__sessionHandle;
    sh.setSkyTimeOverride(0.5);
    return {
      tz: sh.terrainHeightAt(${HUB_ORIGIN[0]}, ${HUB_ORIGIN[1]}),
      sky: sh.getSkyTimeOverride?.() ?? 0.5,
    };
  `);
  await client.hideHud();
  await client.evalInPage(`
    const wh = window.__vehicles.warehouse;
    wh.stopScenarios();
    wh.clearHub();
    wh.buildHub({ origin: ${JSON.stringify(HUB_ORIGIN)}, populateDemoCargo: true });
    return wh.stats;
  `);
  await client.settleFrames(4);
}

async function clearLocalProps(client) {
  await client.evalInPage(`
    const v = window.__vehicles;
    for (const c of (v.containers?.list?.() || [])) {
      try { v.containers.removeLocal?.(c.guid); } catch (_) {}
    }
    for (const t of (v.trailers?.list?.() || [])) {
      try { v.trailers.removeLocal?.(t.guid); } catch (_) {}
    }
    for (const s of (v.semi?.list?.() || [])) {
      try { v.semi.removeLocal?.(s.guid); } catch (_) {}
    }
    for (let g = 0x78000001; g <= 0x78000008; g++) {
      try { v.semi.removeLocal?.(g); } catch (_) {}
    }
    const wh = v.warehouse;
    wh.stopScenarios();
    wh.clearHub();
    wh.buildHub({ origin: ${JSON.stringify(HUB_ORIGIN)}, populateDemoCargo: false });
    window.__sessionHandle.setSkyTimeOverride(0.5);
    return true;
  `);
}

async function runShot1(client) {
  await clearLocalProps(client);
  await client.evalInPage(`
    const [ox, oy] = ${JSON.stringify(HUB_ORIGIN)};
    const v = window.__vehicles;
    const wh = v.warehouse;
    wh.clearHub();
    wh.buildHub({ origin: [ox, oy, 0], populateDemoCargo: true });

    // Populate extra rack slots across R1..R6 for rich visual density
    const wcids = [4000002, 4000010, 4000011, 4000012, 4000013, 4000014, 4000015, 4000016, 4000017];
    let idx = 0;
    for (const r of wh.racks.values()) {
      const sides = r.doubleSided ? 2 : 1;
      for (let b = 0; b < r.bayCount; b++) {
        for (let t = 0; t < 4; t++) {
          for (let s = 0; s < sides; s++) {
            if ((b + t + s) % 2 === 0) {
              r.loadSlot(b, t, s, 0, wcids[idx++ % wcids.length]);
            }
          }
        }
      }
    }

    // Zone A Drop Pads C1 (40ft open), C2 (40HC closed), C3 (20ft open)
    const c1 = v.containers.spawnLocal(0x76000001, 11, [ox - 40.0, oy + 32.5, 0], 0, {
      doorProgress: 1.0,
      slots: [
        { slotIndex: 18, palletSize: "full", cargoWcid: 4000014 },
        { slotIndex: 19, palletSize: "full", cargoWcid: 4000011 },
      ],
    });
    c1?.model?.syncSlots?.(c1.slots);

    const c2 = v.containers.spawnLocal(0x76000002, 12, [ox - 24.0, oy + 32.5, 0], 0, {
      doorProgress: 0.0,
      slots: [],
    });
    c2?.model?.syncSlots?.(c2.slots);

    const c3 = v.containers.spawnLocal(0x76000003, 10, [ox - 8.0, oy + 29.43, 0], 0, {
      doorProgress: 1.0,
      slots: [
        { slotIndex: 9, palletSize: "full", cargoWcid: 4000012 },
      ],
    });
    c3?.model?.syncSlots?.(c3.slots);

    // Zone A East Apron: Semi-379 + 40ft Sidelifter side-by-side along the turning apron
    v.semi.spawnLocal(0x78000001, [ox + 28.0, oy + 35.0, 0], Math.PI * 0.5, { liveryId: 0 });
    v.trailers.spawnLocal(0x77000001, "sidelifter40", [ox + 18.5, oy + 35.0, 0], Math.PI * 0.5, {
      twistlockState: 1,
      landingGearRetracted: true,
    });

    // Active AGFs + AMRs via full-intermodal-loop
    wh.runScenario("full-intermodal-loop");
    return wh.stats;
  `);
  await new Promise((r) => setTimeout(r, 2000));
  await client.evalInPage(`
    const [ox, oy] = ${JSON.stringify(HUB_ORIGIN)};
    window.__cam.orbit(ox, oy, 2.0, 92, 215, 36);
    return true;
  `);
  await client.settleFrames(4);
  return client.captureShot("shot1_aerial_overview");
}

async function runShot2(client) {
  await clearLocalProps(client);
  await client.evalInPage(`
    const [ox, oy] = ${JSON.stringify(HUB_ORIGIN)};
    const v = window.__vehicles;
    const wh = v.warehouse;

    const c1 = v.containers.spawnLocal(0x76000001, 11, [ox - 40.0, oy + 32.5, 0], 0, {
      doorProgress: 1.0,
      slots: [
        { slotIndex: 18, palletSize: "full", cargoWcid: 4000014 },
        { slotIndex: 19, palletSize: "full", cargoWcid: 4000011 },
      ],
    });
    c1?.model?.syncSlots?.(c1.slots);

    const agf = wh.spawnAgf("agf-shot2", {
      pos: [ox - 40.575, oy + 25.85, 0],
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

    window.__cam.orbit(ox - 40.3, oy + 26.3, 1.35, 7.2, 145, 16);
    return true;
  `);
  await client.settleFrames(3);
  return client.captureShot("shot2_container_entry");
}

async function runShot3(client) {
  await clearLocalProps(client);
  await client.evalInPage(`
    const [ox, oy] = ${JSON.stringify(HUB_ORIGIN)};
    const wh = window.__vehicles.warehouse;
    const r1 = wh.racks.get("R1");
    const r23 = wh.racks.get("R2_3");
    const wcids = [4000010, 4000011, 4000012, 4000013, 4000014, 4000015, 4000016, 4000002];
    let k = 0;
    for (let b = 0; b < 8; b++) {
      for (let t = 0; t < 4; t++) {
        if (!(b === 3 && t === 3)) {
          r1?.loadSlot?.(b, t, 0, 0, wcids[k++ % wcids.length]);
        }
        r23?.loadSlot?.(b, t, 0, 0, wcids[k++ % wcids.length]);
        r23?.loadSlot?.(b, t, 1, 0, wcids[k++ % wcids.length]);
      }
    }
    r1?.setHighlightedSlot?.(3, 3, 0, 0, "target");

    const agf = wh.spawnAgf("agf-shot3", {
      pos: [ox - 6.80, oy + 4.00, 0],
      heading: 0.0,
      forkHeightM: 7.15,
      supportSurfaceZ: 7.085,
      carriedWcid: 4000017,
    });
    agf.model?.update?.({
      forkHeightM: 7.15,
      supportSurfaceZ: 7.05,
      carriedWcid: 4000017,
      statusMode: "lifting",
      dt: 0,
    });

    window.__cam.orbit(ox - 6.80, oy + 4.40, 4.65, 11.8, 95, 11);
    return true;
  `);
  await client.settleFrames(3);
  await client.evalInPage(`
    const agf = window.__vehicles.warehouse.agfs.get("agf-shot3");
    agf?.model?.update?.({
      forkHeightM: 7.15,
      supportSurfaceZ: 7.05,
      carriedWcid: 4000017,
      statusMode: "lifting",
      dt: 0,
    });
    return true;
  `);
  return client.captureShot("shot3_high_reach_racking");
}

async function runShot4(client) {
  await clearLocalProps(client);
  await client.evalInPage(`
    const [ox, oy] = ${JSON.stringify(HUB_ORIGIN)};
    const wh = window.__vehicles.warehouse;
    const s4 = wh.stands.get("S4");
    s4?.setCargoWcid?.(4000013);

    const amrA = wh.spawnAmr("amr-shot4", {
      pos: [ox + 14.15, oy - 1.8, 0],
      heading: Math.PI * 0.5,
      liftHeightM: 0.450,
      carriedWcid: 4000010,
    });
    amrA.model?.update?.({
      liftHeightM: 0.450,
      turntableYawRad: Math.PI * 0.25,
      carriedWcid: 4000010,
      statusMode: "lifting",
    });

    const amrB = wh.spawnAmr("amr-shot4b", {
      pos: [ox + 15.35, oy - 4.2, 0],
      heading: -Math.PI * 0.5,
      liftHeightM: 0.260,
      carriedWcid: 0,
    });
    amrB.model?.update?.({
      liftHeightM: 0.260,
      turntableYawRad: 0,
      carriedWcid: 0,
      statusMode: "transit",
    });

    window.__cam.orbit(ox + 14.1, oy - 2.6, 0.55, 4.6, 125, 22);
    return true;
  `);
  await client.settleFrames(3);
  await client.evalInPage(`
    const wh = window.__vehicles.warehouse;
    wh.amrs.get("amr-shot4")?.model?.update?.({
      liftHeightM: 0.450,
      turntableYawRad: Math.PI * 0.25,
      carriedWcid: 4000010,
      statusMode: "lifting",
    });
    return true;
  `);
  return client.captureShot("shot4_underride_amr");
}

async function runShot5(client) {
  await clearLocalProps(client);
  await client.evalInPage(`
    const [ox, oy] = ${JSON.stringify(HUB_ORIGIN)};
    const wh = window.__vehicles.warehouse;
    const l1 = wh.liftTables.get("L1");
    const l2 = wh.liftTables.get("L2");
    l1?.setAutoMode?.(false);
    l2?.setAutoMode?.(false);
    l1?.setHeightImmediate?.(0.0);
    l1?.setCargoWcid?.(4000012);
    l1?.setHighlighted?.("target");

    l2?.setHeightImmediate?.(0.380);
    l2?.setCargoWcid?.(4000014);
    wh.spawnAmr("amr-shot5", {
      pos: [ox - 38.0, oy - 14.0, 0],
      heading: 0.0,
      liftHeightM: 0.260,
      carriedWcid: 0,
    });

    // Clean any old live pallet jack & teleport player just north of L1
    window.__sessionHandle.sendChat("@palletjack despawn all");
    window.__sessionHandle.sendChat(${JSON.stringify(L1_TELELOC_CMD)});
    return true;
  `);

  await client.waitUntil(
    () =>
      client.evalInPage(`
        const [ox, oy] = ${JSON.stringify(HUB_ORIGIN)};
        const p = window.__sessionHandle?.getLocalPlayerPose?.();
        if (!p) return false;
        const c = p.landblockId >>> 0;
        const gx = ((c >>> 24) & 0xff) * 192 + p.x;
        const gy = ((((c >>> 15) & 1) === 1) ? 68928 : 0) + ((c >>> 16) & 0xff) * 192 + p.y;
        return Math.hypot(gx - (ox - 46.0), gy - (oy - 10.0)) < 2.5;
      `),
    10000,
    150,
    "player @teleloc near L1 north approach"
  );

  await client.evalInPage(`
    window.__sessionHandle.sendChat("@palletjack spawn");
    return true;
  `);

  const pjGuid = await client.waitUntil(
    () =>
      client.evalInPage(`
        const [ox, oy] = ${JSON.stringify(HUB_ORIGIN)};
        const list = window.__vehicles?.palletJacks?.list?.() || [];
        const near = list.find((p) => p.pos && Math.hypot(p.pos[0] - (ox - 46.0), p.pos[1] - (oy - 12.5)) < 8.0);
        return near ? near.guid : null;
      `),
    10000,
    150,
    "live @palletjack spawn near L1"
  );

  await client.evalInPage(`
    window.__vehicles.palletJacks.grab(${pjGuid});
    return true;
  `);

  await client.waitUntil(
    () => client.evalInPage(`return window.__vehicles?.palletJacks?.active === ${pjGuid};`),
    8000,
    100,
    "pallet jack grab active"
  );

  // Drive pallet jack onto L1 centered facing South (heading = Math.PI, refY = targetY - 0.25 = oy - 14.0) via KeyW/KeyS/KeyA/KeyD, then pick 4000012
  const shot5Result = await client.evalInPage(`
    const [ox, oy] = ${JSON.stringify(HUB_ORIGIN)};
    const targetX = ox - 46.0;
    const targetY = oy - 13.75;
    const held = new Set();
    const setKey = (want, code) => {
      if (want && !held.has(code)) {
        held.add(code);
        window.dispatchEvent(new KeyboardEvent("keydown", { code, key: code.replace("Key", "").toLowerCase(), bubbles: true, cancelable: true }));
      } else if (!want && held.has(code)) {
        held.delete(code);
        window.dispatchEvent(new KeyboardEvent("keyup", { code, key: code.replace("Key", "").toLowerCase(), bubbles: true, cancelable: true }));
      }
    };
    const wrapPi = (a) => {
      let v = (a + Math.PI) % (2 * Math.PI);
      if (v < 0) v += 2 * Math.PI;
      return v - Math.PI;
    };

    const t0 = performance.now();
    while (performance.now() - t0 < 6000) {
      const pj = window.__vehicles.palletJacks.get(${pjGuid});
      if (!pj || !pj.pos) break;
      const dx = targetX - pj.pos[0];
      const dy = targetY - pj.pos[1];
      const dist = Math.hypot(dx, dy);
      const southErr = Math.abs(wrapPi(Math.PI - (pj.heading || 0)));
      if (dist <= 0.15 && southErr <= 0.18) {
        break;
      }
      const fwd = Math.sin(pj.heading || 0) * dx + Math.cos(pj.heading || 0) * dy;
      const toTargetAngle = Math.atan2(dx, dy);
      const toTargetErr = Math.abs(wrapPi(toTargetAngle - (pj.heading || 0)));
      const useReverse = !(dist > 0.35 && toTargetErr > 1.1) && fwd < -0.05 && southErr <= 0.45;
      const desiredH = dist > 0.25 ? toTargetAngle : Math.PI;
      const steerSign = useReverse ? -1 : 1;
      const errH = wrapPi(desiredH - (pj.heading || 0)) * steerSign;
      setKey(errH < -0.08, "KeyA");
      setKey(errH > 0.08, "KeyD");
      setKey(!useReverse, "KeyW");
      setKey(useReverse, "KeyS");
      await new Promise((r) => setTimeout(r, 40));
    }
    setKey(false, "KeyW");
    setKey(false, "KeyS");
    setKey(false, "KeyA");
    setKey(false, "KeyD");
    await new Promise((r) => setTimeout(r, 150));

    // Pick stowed 4000012 off L1 onto the jack (KeyF) so avatar IK holds tiller with loaded pallet
    window.dispatchEvent(new KeyboardEvent("keydown", { code: "KeyF", key: "f", bubbles: true, cancelable: true }));
    await new Promise((r) => setTimeout(r, 60));
    window.dispatchEvent(new KeyboardEvent("keyup", { code: "KeyF", key: "f", bubbles: true, cancelable: true }));

    const wh = window.__vehicles.warehouse;
    const tPick = performance.now();
    while (performance.now() - tPick < 2000) {
      const pj = window.__vehicles.palletJacks.get(${pjGuid});
      const l1 = wh.liftTables.get("L1");
      if (pj?.carriedWcid === 4000012 && l1?.carriedWcid === 0) break;
      await new Promise((r) => setTimeout(r, 40));
    }

    window.__vehicles.palletJacks.raise(${pjGuid});
    const tRaise = performance.now();
    while (performance.now() - tRaise < 1500) {
      const pj = window.__vehicles.palletJacks.get(${pjGuid});
      if ((pj?.forkHeightM ?? 0) >= 0.19) break;
      await new Promise((r) => setTimeout(r, 40));
    }

    window.__cam.orbit(ox - 42.0, oy - 13.6, 0.85, 9.2, 42, 22);
    const pjNow = window.__vehicles.palletJacks.get(${pjGuid});
    const l1Wcid = wh.liftTables.get("L1")?.carriedWcid ?? -1;
    return {
      pjPos: pjNow?.pos,
      pjHeading: pjNow?.heading,
      forkHeightM: pjNow?.forkHeightM,
      carriedWcid: pjNow?.carriedWcid,
      carriedPalletSize: pjNow?.carriedPalletSize,
      l1Wcid,
    };
  `);
  console.log("[shot5] jack state:", JSON.stringify(shot5Result));
  if (shot5Result?.carriedWcid !== 4000012 || shot5Result?.l1Wcid !== 0) {
    throw new Error(`Shot 5 pickup failed: ${JSON.stringify(shot5Result)}`);
  }

  await client.settleFrames(4);
  const res = await client.captureShot("shot5_pallet_jack_lift_table");

  await client.evalInPage(`
    try { window.__vehicles.palletJacks.release(${pjGuid}); } catch (_) {}
    window.__sessionHandle.sendChat("@palletjack despawn all");
    return true;
  `);
  return res;
}

async function runShot6(client) {
  await clearLocalProps(client);
  await client.evalInPage(`
    const [ox, oy] = ${JSON.stringify(HUB_ORIGIN)};
    const wh = window.__vehicles.warehouse;
    wh.stopScenarios();
    wh.clearHub();
    wh.buildHub({ origin: [ox, oy, 0] });
    wh.runScenario("scale-stress");
    window.__cam.orbit(ox - 2.0, oy - 10.0, 2.5, 48.0, 148, 30);
    return true;
  `);

  await new Promise((r) => setTimeout(r, 3500));
  await client.waitUntil(
    () => client.evalInPage(`return !window.__asyncLink || window.__asyncLink.pending === 0;`),
    10000,
    100,
    "asyncLink shader drain in scale-stress"
  );
  await client.settleFrames(4);

  const info = await client.evalInPage(`
    const r = window.liveScene3d?.renderer;
    let renderInfo = null;
    if (r) {
      const prevAuto = r.info.autoReset;
      r.info.autoReset = false;
      r.info.reset();
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      renderInfo = { calls: r.info.render.calls, triangles: r.info.render.triangles, geometries: r.info.memory.geometries, textures: r.info.memory.textures };
      r.info.autoReset = prevAuto;
    }
    const wh = window.__vehicles.warehouse;
    const st = wh.getState();
    return {
      stats: wh.stats,
      renderInfo,
      agfCount: Object.keys(st.agfs || {}).length,
      amrCount: Object.keys(st.amrs || {}).length,
    };
  `);
  console.log("[shot6] scale-stress telemetry:", JSON.stringify(info));
  const res = await client.captureShot("shot6_scale_stress");
  await client.evalInPage(`window.__vehicles.warehouse.stopScenarios(); return true;`);
  return { ...res, telemetry: info };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    printHelp();
    process.exit(0);
  }

  const client = new StageClient(opts.driverUrl, opts.outDir);

  await setupHubBase(client);
  await new Promise((r) => setTimeout(r, 1500));
  const logStart = client.getConsoleLogOffset();

  const runners = {
    "1": runShot1,
    "2": runShot2,
    "3": runShot3,
    "4": runShot4,
    "5": runShot5,
    "6": runShot6,
  };

  const order = opts.shot === "all" ? ["1", "2", "3", "4", "5", "6"] : [opts.shot];
  const results = {};
  for (const id of order) {
    results[`shot${id}`] = await runners[id](client);
  }

  client.assertZeroConsoleErrors(logStart);
  console.log("[warehouse-hub-stage] ALL REQUESTED SHOTS COMPLETE & 0 CONSOLE ERRORS");
}

main().catch((err) => {
  console.error("[warehouse-hub-stage] FAIL:", err && err.stack ? err.stack : err);
  process.exit(1);
});
