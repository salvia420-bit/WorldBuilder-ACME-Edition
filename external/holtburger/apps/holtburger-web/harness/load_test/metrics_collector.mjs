// harness/load_test/metrics_collector.mjs
// Live system, GPU, process (/proc), and ACE server telemetry collector.
// Reads /proc directly (no `ps` dependency), queries `nvidia-smi`, and sends
// `allstats` / `netstats` / `serverperformance reset` to ACE's console FIFO.

import fs from "node:fs";
import { execFileSync } from "node:child_process";

const ACE_FIFO = process.env.ACE_FIFO || "/workspace/wb/ace_stdin.fifo";
const ACE_LOG = process.env.ACE_LOG || "/workspace/wb/ace_console.log";
const CLK_TCK = 100; // Linux USER_HZ (sysconf(_SC_CLK_TCK) is 100 on x86_64 Linux)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function parseIntComma(s) {
  if (!s) return null;
  const n = Number(String(s).replace(/,/g, "").trim());
  return Number.isFinite(n) ? n : null;
}

function readProcSnapshot() {
  const groups = {
    ace: { pids: [], pidTicks: new Map(), rssMB: 0, cpuTicks: 0, threads: 0, fds: 0 },
    wsbridge: { pids: [], pidTicks: new Map(), rssMB: 0, cpuTicks: 0, threads: 0, fds: 0 },
    mariadb: { pids: [], pidTicks: new Map(), rssMB: 0, cpuTicks: 0, threads: 0, fds: 0 },
    serve: { pids: [], pidTicks: new Map(), rssMB: 0, cpuTicks: 0, threads: 0, fds: 0 },
    chrome: { pids: [], pidTicks: new Map(), rssMB: 0, cpuTicks: 0, threads: 0, fds: 0 },
    loadtest: { pids: [], pidTicks: new Map(), rssMB: 0, cpuTicks: 0, threads: 0, fds: 0 },
  };

  let entries = [];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return groups;
  }

  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    let cmd = "";
    try {
      cmd = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").trim();
    } catch {
      continue;
    }
    if (!cmd) continue;
    const low = cmd.toLowerCase();
    let bucket = null;
    if (low.includes("ace.server.dll")) bucket = "ace";
    else if (low.includes("holtburger-wsbridge")) bucket = "wsbridge";
    else if (low.includes("mariadbd") || low.includes("mysqld ")) bucket = "mariadb";
    else if (low.includes("serve.py")) bucket = "serve";
    else if (low.includes("ace-loadtest")) bucket = "loadtest";
    else if (low.includes("chrome") || low.includes("chromium") || low.includes("headless_shell")) bucket = "chrome";
    if (!bucket) continue;

    let rssKB = 0;
    let threads = 0;
    try {
      const st = fs.readFileSync(`/proc/${pid}/status`, "utf8");
      const mRss = st.match(/^VmRSS:\s+(\d+)\s+kB/m);
      if (mRss) rssKB = Number(mRss[1]);
      const mThr = st.match(/^Threads:\s+(\d+)/m);
      if (mThr) threads = Number(mThr[1]);
    } catch {}

    let cpuTicks = 0;
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
      const rp = stat.lastIndexOf(")");
      if (rp > 0) {
        const fields = stat.slice(rp + 2).trim().split(/\s+/);
        // fields[11] = utime (14th field overall), fields[12] = stime (15th)
        cpuTicks = (Number(fields[11]) || 0) + (Number(fields[12]) || 0);
      }
    } catch {}

    let fds = 0;
    try {
      fds = fs.readdirSync(`/proc/${pid}/fd`).length;
    } catch {}

    const g = groups[bucket];
    g.pids.push(pid);
    g.pidTicks.set(pid, cpuTicks);
    g.rssMB += rssKB / 1024;
    g.cpuTicks += cpuTicks;
    g.threads += threads;
    g.fds += fds;
  }

  for (const k of Object.keys(groups)) {
    groups[k].rssMB = +groups[k].rssMB.toFixed(1);
  }
  return groups;
}

export function readHostAndGpu() {
  const out = {
    cgroupMemMB: null,
    cgroupMaxMB: null,
    hostMemAvailMB: null,
    hostMemTotalMB: null,
    swapUsedMB: null,
    load1: null,
    gpuUtilPct: null,
    gpuMemUtilPct: null,
    vramUsedMB: null,
    vramTotalMB: null,
    gpuTempC: null,
  };
  try {
    out.cgroupMemMB = +(Number(fs.readFileSync("/sys/fs/cgroup/memory.current", "utf8").trim()) / 1048576).toFixed(1);
    const mx = fs.readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim();
    if (/^\d+$/.test(mx)) out.cgroupMaxMB = +(Number(mx) / 1048576).toFixed(1);
  } catch {}
  try {
    const mi = fs.readFileSync("/proc/meminfo", "utf8");
    const getKB = (k) => {
      const m = mi.match(new RegExp(`^${k}:\\s+(\\d+)\\s+kB`, "m"));
      return m ? Number(m[1]) : null;
    };
    const tot = getKB("MemTotal");
    const avail = getKB("MemAvailable");
    const swTot = getKB("SwapTotal");
    const swFree = getKB("SwapFree");
    if (tot != null) out.hostMemTotalMB = +(tot / 1024).toFixed(1);
    if (avail != null) out.hostMemAvailMB = +(avail / 1024).toFixed(1);
    if (swTot != null && swFree != null) out.swapUsedMB = +((swTot - swFree) / 1024).toFixed(1);
  } catch {}
  try {
    const la = fs.readFileSync("/proc/loadavg", "utf8").trim().split(/\s+/);
    out.load1 = Number(la[0]);
  } catch {}
  try {
    const raw = execFileSync(
      "nvidia-smi",
      ["--query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu", "--format=csv,noheader,nounits"],
      { encoding: "utf8", timeout: 3000 }
    ).trim();
    const parts = raw.split(/\r?\n/)[0].split(",").map((s) => Number(s.trim()));
    if (parts.length >= 5 && parts.every((n) => Number.isFinite(n))) {
      [out.gpuUtilPct, out.gpuMemUtilPct, out.vramUsedMB, out.vramTotalMB, out.gpuTempC] = parts;
    }
  } catch {}
  return out;
}

/**
 * Compute delta CPU ticks across two per-PID maps so exiting/crashing PIDs do not
 * corrupt or zero-out the CPU% of surviving processes.
 */
export function computePerPidCpuTicksDelta(prevPidTicks, curPidTicks) {
  let dTicks = 0;
  for (const [pid, curTicks] of curPidTicks.entries()) {
    const prev = prevPidTicks?.get(pid);
    if (prev != null) {
      dTicks += Math.max(0, curTicks - prev);
    } else {
      dTicks += Math.max(0, curTicks);
    }
  }
  return dTicks;
}

export class ProcessSampler {
  constructor() {
    this.prev = null;
    this.prevTs = null;
  }
  sample() {
    const now = Date.now();
    const cur = readProcSnapshot();
    const result = {};
    const dtSec = this.prevTs ? Math.max(0.1, (now - this.prevTs) / 1000) : null;
    for (const [k, g] of Object.entries(cur)) {
      let cpuPct = null;
      if (this.prev && dtSec && this.prev[k] && g.pids.length > 0) {
        const dTicks = computePerPidCpuTicksDelta(this.prev[k].pidTicks, g.pidTicks);
        cpuPct = +((dTicks / CLK_TCK / dtSec) * 100).toFixed(1);
      }
      result[k] = {
        procs: g.pids.length,
        rssMB: g.rssMB,
        cpuPct,
        threads: g.threads,
        fds: g.fds,
      };
    }
    this.prev = cur;
    this.prevTs = now;
    return result;
  }
}

let lastPerfResetMs = null;

export async function sendAceCommand(cmd) {
  // Open FIFO non-blocking so a dead ACE process never hangs the harness forever.
  const flags = fs.constants.O_WRONLY | fs.constants.O_NONBLOCK;
  let fd;
  try {
    fd = fs.openSync(ACE_FIFO, flags);
  } catch (e) {
    throw new Error(`sendAceCommand(${cmd}): ACE FIFO unavailable (${e.code || e.message})`);
  }
  try {
    fs.writeSync(fd, `${cmd}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

export async function resetAcePerf() {
  await sendAceCommand("serverperformance start");
  await sleep(150);
  await sendAceCommand("serverperformance reset");
  lastPerfResetMs = Date.now();
  await sleep(200);
}

export function readAceLogSize() {
  try {
    return fs.statSync(ACE_LOG).size;
  } catch {
    return 0;
  }
}

export function scanAceLogWarnings(startOffset) {
  const counts = {
    movementSpeed: 0,
    failedTransition: 0,
    lockWait: 0,
    lockWaitMaxMs: 0,
    perfSlow: 0,
    serverFull: 0,
    errors: 0,
  };
  let endOffset = startOffset;
  try {
    const sz = fs.statSync(ACE_LOG).size;
    if (sz <= startOffset) return { counts, endOffset: sz };
    const fd = fs.openSync(ACE_LOG, "r");
    const buf = Buffer.alloc(sz - startOffset);
    fs.readSync(fd, buf, 0, buf.length, startOffset);
    fs.closeSync(fd);
    endOffset = sz;
    const lines = buf.toString("utf8").split(/\r?\n/);
    for (const line of lines) {
      if (!line) continue;
      if (line.includes("MOVEMENT SPEED")) counts.movementSpeed++;
      if (line.includes("failed transition")) counts.failedTransition++;
      if (line.includes("[LOCKWAIT]")) {
        counts.lockWait++;
        const m = line.match(/([\d.]+)\s*ms/i);
        if (m) {
          const ms = Number(m[1]);
          if (Number.isFinite(ms) && ms > counts.lockWaitMaxMs) counts.lockWaitMaxMs = +ms.toFixed(1);
        }
      }
      if (line.includes("[PERFORMANCE]")) counts.perfSlow++;
      if (line.includes("Server full") || line.includes("LogonServerFull")) counts.serverFull++;
      if (/\bERROR\b/.test(line)) counts.errors++;
    }
  } catch {}
  return { counts, endOffset };
}

export async function queryAceStats() {
  let startOffset = 0;
  try {
    startOffset = fs.statSync(ACE_LOG).size;
  } catch {
    return null;
  }
  const wallElapsedSec = lastPerfResetMs ? Math.max(0.2, (Date.now() - lastPerfResetMs) / 1000) : null;
  try {
    await sendAceCommand("allstats");
    await sleep(250);
    await sendAceCommand("netstats");
  } catch {
    return null;
  }
  // Wait up to 15s for netstats tail ("CRC errors") to flush into ace_console.log
  // (needed when ACE is experiencing a multi-second world stall).
  let chunk = "";
  for (let i = 0; i < 75; i++) {
    await sleep(200);
    let sz = 0;
    try {
      sz = fs.statSync(ACE_LOG).size;
    } catch {
      continue;
    }
    if (sz > startOffset) {
      const fd = fs.openSync(ACE_LOG, "r");
      const buf = Buffer.alloc(sz - startOffset);
      fs.readSync(fd, buf, 0, buf.length, startOffset);
      fs.closeSync(fd);
      chunk = buf.toString("utf8");
      if (chunk.includes("CRC errors") && chunk.includes("Server Status:")) break;
    }
  }
  return parseAceStats(chunk, wallElapsedSec);
}

export function parseAceStats(text, wallElapsedSec = null) {
  const out = {
    connections: null,
    authenticatedConnections: null,
    playersOnline: null,
    activeLandblocks: null,
    activeDungeons: null,
    dormantLandblocks: null,
    landblockGroups: null,
    worldPlayers: null,
    worldCreatures: null,
    worldMissiles: null,
    worldOther: null,
    worldTotalObjects: null,
    acePrivateMB: null,
    aceThreads: null,
    worldThreadsCfg: null,
    dbThreadsCfg: null,
    portalDatCached: null,
    cellDatCached: null,
    updateWorld5mHits: null,
    updateWorldAvgMs: null,
    updateWorldLongMs: null,
    updateWorldHz: null,
    updateWorldHzWall: null,
    tickPhysicsAvgMs: null,
    tickPhysicsLongMs: null,
    tickMtAvgMs: null,
    tickMtLongMs: null,
    tickStAvgMs: null,
    tickStLongMs: null,
    playerTickAvgMs: null,
    playerTickLongMs: null,
    worldObjHeartbeatAvgMs: null,
    worldObjHeartbeatLongMs: null,
    generatorUpdateAvgMs: null,
    vehicleTickAvgMs: null,
    vehicleTickLongMs: null,
    inboundNetAvgMs: null,
    inboundNetLongMs: null,
    sessionWorkAvgMs: null,
    sessionWorkLongMs: null,
    monsterTickAvgMs: null,
    playerPhysicsAvgMs: null,
    physicsEffPct: null,
    mtEffPct: null,
    gcTotalMemMB: null,
    gcHeapSizeMB: null,
    gcPausePct: null,
    gcAllocatedMB: null,
    dbQueueCount: null,
    dbQueueWaitMs: null,
    netPktsC2S: null,
    netPktsS2C: null,
    netRetransC2S: null,
    netRetransS2C: null,
    netCrcErrors: null,
  };

  let m;
  if ((m = text.match(/([\d,]+)\s+connections,\s+([\d,]+)\s+authenticated connections,.*?([\d,]+)\s+players online/))) {
    out.connections = parseIntComma(m[1]);
    out.authenticatedConnections = parseIntComma(m[2]);
    out.playersOnline = parseIntComma(m[3]);
  }
  if ((m = text.match(/Landblocks:\s+([\d,]+)\s+active\s+\(([\d,]+)\s+dungeons\),\s+([\d,]+)\s+dormant.*?Landblock Groups:\s+([\d,]+)\s+-\s+Players:\s+([\d,]+),\s+Creatures:\s+([\d,]+),\s+Missiles:\s+([\d,]+),\s+Other:\s+([\d,]+),\s+Total:\s+([\d,]+)/))) {
    out.activeLandblocks = parseIntComma(m[1]);
    out.activeDungeons = parseIntComma(m[2]);
    out.dormantLandblocks = parseIntComma(m[3]);
    out.landblockGroups = parseIntComma(m[4]);
    out.worldPlayers = parseIntComma(m[5]);
    out.worldCreatures = parseIntComma(m[6]);
    out.worldMissiles = parseIntComma(m[7]);
    out.worldOther = parseIntComma(m[8]);
    out.worldTotalObjects = parseIntComma(m[9]);
  }
  if ((m = text.match(/^([\d,]+)\s+MB used$/m))) out.acePrivateMB = parseIntComma(m[1]);
  if ((m = text.match(/Threads:\s+([\d,]+)/))) out.aceThreads = parseIntComma(m[1]);
  if ((m = text.match(/WorldThreadCount:\s+(\d+).*?DatabaseThreadCount:\s+(\d+)/))) {
    out.worldThreadsCfg = Number(m[1]);
    out.dbThreadsCfg = Number(m[2]);
  }
  if ((m = text.match(/Portal\.dat has ([\d,]+) files cached/))) out.portalDatCached = parseIntComma(m[1]);
  if ((m = text.match(/Cell\.dat has ([\d,]+) files cached/))) out.cellDatCached = parseIntComma(m[1]);

  let monDurMin = null;
  if ((m = text.match(/Monitoring Durations:\s+~5m\s+([\d.]+)\s+min/))) {
    monDurMin = Number(m[1]);
  }

  const parsePerfRow = (name) => {
    const re = new RegExp(`^\\s*([\\d,]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)\\s+[\\d,]+\\s+-.*? - ${name}\\s*$`, "m");
    const r = text.match(re);
    if (!r) return null;
    return {
      hits: parseIntComma(r[1]),
      avgMs: +(Number(r[2]) * 1000).toFixed(2),
      longMs: +(Number(r[3]) * 1000).toFixed(2),
      lastMs: +(Number(r[4]) * 1000).toFixed(2),
    };
  };

  const ugw = parsePerfRow("UpdateGameWorld_Entire");
  if (ugw) {
    out.updateWorld5mHits = ugw.hits;
    out.updateWorldAvgMs = ugw.avgMs;
    out.updateWorldLongMs = ugw.longMs;
    if (monDurMin && monDurMin > 0.01) {
      out.updateWorldHz = +(ugw.hits / (monDurMin * 60)).toFixed(1);
    }
    if (wallElapsedSec && wallElapsedSec > 0.5) {
      out.updateWorldHzWall = +(ugw.hits / wallElapsedSec).toFixed(1);
    }
  }
  const tp = parsePerfRow("LandblockManager_TickPhysics");
  if (tp) { out.tickPhysicsAvgMs = tp.avgMs; out.tickPhysicsLongMs = tp.longMs; }
  const tm = parsePerfRow("LandblockManager_TickMultiThreadedWork");
  if (tm) { out.tickMtAvgMs = tm.avgMs; out.tickMtLongMs = tm.longMs; }
  const ts = parsePerfRow("LandblockManager_TickSingleThreadedWork");
  if (ts) { out.tickStAvgMs = ts.avgMs; out.tickStLongMs = ts.longMs; }
  const pt = parsePerfRow("Landblock_Tick_Player_Tick");
  if (pt) { out.playerTickAvgMs = pt.avgMs; out.playerTickLongMs = pt.longMs; }
  const hb = parsePerfRow("Landblock_Tick_WorldObject_Heartbeat");
  if (hb) { out.worldObjHeartbeatAvgMs = hb.avgMs; out.worldObjHeartbeatLongMs = hb.longMs; }
  const gu = parsePerfRow("Landblock_Tick_GeneratorUpdate");
  if (gu) out.generatorUpdateAvgMs = gu.avgMs;
  const vt = parsePerfRow("VehicleManager_Tick");
  if (vt) { out.vehicleTickAvgMs = vt.avgMs; out.vehicleTickLongMs = vt.longMs; }
  const ni = parsePerfRow("NetworkManager_InboundClientMessageQueueRun");
  if (ni) { out.inboundNetAvgMs = ni.avgMs; out.inboundNetLongMs = ni.longMs; }
  const sw = parsePerfRow("NetworkManager_DoSessionWork");
  if (sw) { out.sessionWorkAvgMs = sw.avgMs; out.sessionWorkLongMs = sw.longMs; }
  const mt = parsePerfRow("Landblock_Tick_Monster_Tick");
  if (mt) out.monsterTickAvgMs = mt.avgMs;
  const pp = parsePerfRow("Player_Tick_UpdateObjectPhysics");
  if (pp) out.playerPhysicsAvgMs = pp.avgMs;

  if ((m = text.match(/TickPhysicsEfficiencyTracker:\s+(\d+)\s*%,\s+TickMultiThreadedWorkEfficiencyTracker:\s+(\d+)\s*%/))) {
    out.physicsEffPct = Number(m[1]);
    out.mtEffPct = Number(m[2]);
  }
  if ((m = text.match(/GC\.GetTotalMemory:\s+([\d,]+)\s+MB,\s+GC\.GetTotalAllocatedBytes:\s+([\d,]+)\s+MB/))) {
    out.gcTotalMemMB = parseIntComma(m[1]);
    out.gcAllocatedMB = parseIntComma(m[2]);
  }
  if ((m = text.match(/PauseTimePercentage:\s+([\d.]+)/))) out.gcPausePct = Number(m[1]);
  if ((m = text.match(/HeapSizeBytes:\s+([\d,]+)\s+MB/))) out.gcHeapSizeMB = parseIntComma(m[1]);
  if ((m = text.match(/Current database queue count:\s+([\d,]+)/))) out.dbQueueCount = parseIntComma(m[1]);
  if ((m = text.match(/Current database queue wait time:\s+([\d,]+)\s+ms/))) out.dbQueueWaitMs = parseIntComma(m[1]);

  if ((m = text.match(/packets\s+client=>server:\s+([\d,]+)\s+server=>client:\s+([\d,]+)/))) {
    out.netPktsC2S = parseIntComma(m[1]);
    out.netPktsS2C = parseIntComma(m[2]);
  }
  if ((m = text.match(/requests for retransmit\s+client=>server:\s+([\d,]+)\s+Server=>client:\s+([\d,]+)/i))) {
    out.netRetransC2S = parseIntComma(m[1]);
    out.netRetransS2C = parseIntComma(m[2]);
  }
  if ((m = text.match(/CRC errors\s+client=>server:\s+([\d,]+)/))) {
    out.netCrcErrors = parseIntComma(m[1]);
  }

  return out;
}
