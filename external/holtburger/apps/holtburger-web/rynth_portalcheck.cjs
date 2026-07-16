#!/usr/bin/env node
// rynth_portalcheck.cjs — batch re-validation of portals.tsv arrival coords
// against OUR ACE worldgen. The sidecar README's standing caveat: "Portal
// arrival coords are retail GoArrow data (~0.1 deg rounded) — re-validate
// per-portal against our ACE before trusting portal:true legs". This is that
// validator.
//
// Per portals.tsv row whose Src lands inside baked coverage (--coverage file
// of hex LBIDs; default = the Holtburg 5x5, A7-AB x B2-B6):
//   1. resolve ground z at the Src via a sidecar /route query — teleport z is
//      taken from the plan leg NEAREST the teleport point so we never
//      @teleloc mid-air. Only trusted when coverage=="detour" (README trap:
//      straight legs have lerped, meaningless z).
//   2. @teleloc to an approach point --standoff (12m) short of the Src,
//      toward the landblock centre (stay on the same, baked landblock).
//   3. walk INTO the portal via MoveToPosition — the navmesh-snapped Src
//      first, then a probe ring around the raw Src (GoArrow coords are
//      rounded to ~0.1 deg = up to ~12m off the actual trigger volume).
//   4. detect the teleport exactly like router.js does: landblock-word
//      change WITH a world-frame jump >= 30m (SEAM_JUMP_M); a small jump is
//      an on-foot seam crossing, not a portal.
//   5. wait 4s for the far side to stream in, read the arrival pose, compare
//      vs the row's Dst in world-frame metres (--tolerance, default 15m).
//
// Output: CSV verdict rows (append + fsync per row -> crash-resumable) and a
// stdout summary. --resume skips rows whose key is already in the CSV.
// Logins are paced >= 70s apart (ACE session reap window); portals are
// batched per login (--batch, default 5) with @teleloc between rows; --max
// (default 10) bounds the rows per run.
//
// NOTE: shares the ACE test account — run serially, NEVER alongside other
// smokes or the supervisor fleet (same rule as rynth_globalroute_smoke.cjs).
//
// --dry-run does ALL parsing / frame math / coverage filtering / batching /
// (if the sidecar answers) z-resolution WITHOUT a browser — safe anywhere,
// including boxes with no ACE and no playwright.
//
// Usage:
//   node rynth_portalcheck.cjs --dry-run
//   node rynth_portalcheck.cjs [--max 10] [--batch 5] [--tolerance 15]
//     [--coverage lbids.txt] [--resume] [--out /mnt/wbterminal2/rynth_portalcheck.csv]
//     [--account tailnet1] [--password tailnet1] [--sidecar http://127.0.0.1:8767]

const fs = require("fs");
const path = require("path");

// ── canonical frame math (RynthNavPlugin.cs:128-130,295-296,585-586,707) ────
const degToWorld = (deg) => (deg * 10 + 1019.5) * 24;
const worldToDeg = (w) => (w / 24 - 1019.5) / 10;
const worldXY = (lb, x, y) => [((lb >>> 24) & 0xff) * 192 + x, ((lb >>> 16) & 0xff) * 192 + y];
// World metres -> full objCellId (correct outdoor cell low-word) + lb-local.
function worldToLeg(wx, wy, z) {
  const lbX = Math.min(255, Math.max(0, Math.floor(wx / 192)));
  const lbY = Math.min(255, Math.max(0, Math.floor(wy / 192)));
  const lx = wx - lbX * 192;
  const ly = wy - lbY * 192;
  const cell = 1 + Math.min(7, Math.floor(lx / 24)) * 8 + Math.min(7, Math.floor(ly / 24));
  return { lb: ((lbX << 24) | (lbY << 16) | cell) >>> 0, x: lx, y: ly, z };
}
const lbHex = (lb) => ((lb >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, "0");

// ── tunables (walk/detect constants mirror rynth/router.js) ─────────────────
const SEAM_JUMP_M = 30; // lb change + jump >= this = portal (router.js:26)
const PORTAL_SETTLE_MS = 4000; // streaming settle after the hop (router.js:25)
const ARRIVE_M = 2.0; // reached a walk target without teleporting -> next probe
const REISSUE_MS = 3000; // re-issue moveTo when not closing (router.js:24)
const TARGET_TIMEOUT_MS = 20_000; // per walk-target watchdog
const ROW_BUDGET_MS = 100_000; // whole-row watchdog (teleloc + all probes)
const LOGIN_SPACING_MS = 70_000; // ACE reap window between OUR logins
const POLL_MS = 400;
// Probe ring around the RAW Src point — 0.1-deg rounding puts the real
// trigger up to ~12m away; walking through/around the point rams it.
const PROBES = [[0, 0], [0, 6], [6, 0], [0, -6], [-6, 0], [0, 12], [12, 0], [0, -12], [-12, 0]];

// ── args ─────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = {
    dryRun: false, resume: false, max: 10, batch: 5, tolerance: 15, standoff: 12,
    portals: path.join(__dirname, "..", "rynthnav-sidecar", "data", "portals.tsv"),
    out: "/mnt/wbterminal2/rynth_portalcheck.csv",
    coverage: null,
    sidecar: "http://127.0.0.1:8767",
    account: "tailnet1", password: "tailnet1",
    base: "http://127.0.0.1:8765/apps/holtburger-web/index.html",
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    const next = () => argv[++i];
    if (k === "--dry-run") a.dryRun = true;
    else if (k === "--resume") a.resume = true;
    else if (k === "--max") a.max = Number(next());
    else if (k === "--batch") a.batch = Number(next());
    else if (k === "--tolerance") a.tolerance = Number(next());
    else if (k === "--standoff") a.standoff = Number(next());
    else if (k === "--portals") a.portals = next();
    else if (k === "--out") a.out = next();
    else if (k === "--coverage") a.coverage = next();
    else if (k === "--sidecar") a.sidecar = String(next()).replace(/\/+$/, "");
    else if (k === "--account") a.account = next();
    else if (k === "--password") a.password = next();
    else if (k === "--base") a.base = next();
    else { console.error(`unknown arg: ${k} (see header comment)`); process.exit(2); }
  }
  if (!Number.isFinite(a.max) || !Number.isFinite(a.batch) || !Number.isFinite(a.tolerance)) {
    console.error("--max/--batch/--tolerance must be numbers");
    process.exit(2);
  }
  return a;
}

// ── portals.tsv (parse EXACTLY like DetourRouter.LoadPortals: \t split,
//    4 leading float cols srcNS srcEW dstNS dstEW, optional label col 5) ─────
function parsePortals(file) {
  const rows = [];
  const lines = fs.readFileSync(file, "utf8").split(/\r?\n/);
  for (const line of lines) {
    if (!line.trim()) continue;
    const f = line.split("\t");
    if (f.length < 4) continue;
    const [srcNs, srcEw, dstNs, dstEw] = f.slice(0, 4).map(Number);
    if (![srcNs, srcEw, dstNs, dstEw].every(Number.isFinite)) continue;
    rows.push({
      srcNs, srcEw, dstNs, dstEw,
      label: f[4] || "",
      // Resume key: the raw coord strings — stable across coverage filters
      // and label edits, unique per physical row.
      key: `${f[0]}|${f[1]}|${f[2]}|${f[3]}`,
    });
  }
  return rows;
}

// ── coverage set of 4-hex LBIDs ("A9B4"); default = Holtburg 5x5 ────────────
function defaultCoverage() {
  const s = new Set();
  for (let x = 0xa7; x <= 0xab; x++)
    for (let y = 0xb2; y <= 0xb6; y++)
      s.add(((x << 8) | y).toString(16).toUpperCase().padStart(4, "0"));
  return s;
}
function loadCoverage(file) {
  const s = new Set();
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.split("#")[0]; // '#' comments
    for (const tok of line.split(/[\s,]+/)) {
      const t = tok.trim().replace(/^0x/i, "").toUpperCase();
      if (/^[0-9A-F]{4}$/.test(t)) s.add(t);
    }
  }
  return s;
}

// ── per-row geometry: src/dst world points, approach (teleport) point ────────
function rowGeometry(row, standoff) {
  const srcWx = degToWorld(row.srcEw), srcWy = degToWorld(row.srcNs);
  const expWx = degToWorld(row.dstEw), expWy = degToWorld(row.dstNs);
  const srcLb = lbHex(worldToLeg(srcWx, srcWy, 0).lb);
  // Approach from the landblock-centre side: stays on the (baked) src
  // landblock, so both /route endpoints sit on loaded tiles.
  const cX = Math.floor(srcWx / 192) * 192 + 96, cY = Math.floor(srcWy / 192) * 192 + 96;
  let dx = cX - srcWx, dy = cY - srcWy;
  const n = Math.hypot(dx, dy);
  if (n < 1) { dx = -1; dy = 0; } else { dx /= n; dy /= n; }
  return {
    srcWx, srcWy, srcLb, expWx, expWy,
    appWx: srcWx + dx * standoff, appWy: srcWy + dy * standoff,
  };
}

// ── sidecar I/O ──────────────────────────────────────────────────────────────
async function fetchJson(url, init, timeoutMs) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { ...(init || {}), signal: ctl.signal });
    return await r.json();
  } finally {
    clearTimeout(t);
  }
}

// Resolve ground z near the Src: /route from the approach point (z-guess
// ladder — FindNearestPoly start half-extent is only 64 in Y) to the Src
// {ns,ew}. Teleport z = leg nearest the approach point; walk target = final
// leg (the navmesh-snapped Src). coverage=="detour" REQUIRED (README trap:
// an unbaked lb still answers with plausible-looking straight legs).
async function resolveZ(sidecar, row, geo) {
  for (const zGuess of [0, 100, 200, 300, 400]) {
    const from = worldToLeg(geo.appWx, geo.appWy, zGuess);
    let res;
    try {
      res = await fetchJson(`${sidecar}/route`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          from: { lb: from.lb >>> 0, x: from.x, y: from.y, z: zGuess },
          to: { ns: row.srcNs, ew: row.srcEw },
        }),
      }, 8000);
    } catch (e) {
      return { ok: false, error: `sidecar unreachable (${e.message})` };
    }
    if (!res || res.ok !== true || !Array.isArray(res.legs) || !res.legs.length) continue;
    if (res.coverage !== "detour") continue;
    let nearest = res.legs[0], best = Infinity;
    for (const l of res.legs) {
      const [wx, wy] = worldXY(l.lb >>> 0, l.x, l.y);
      const d = Math.hypot(wx - geo.appWx, wy - geo.appWy);
      if (d < best) { best = d; nearest = l; }
    }
    const walk = res.legs[res.legs.length - 1];
    return { ok: true, teleZ: nearest.z, walkTarget: { lb: walk.lb >>> 0, x: walk.x, y: walk.y, z: walk.z } };
  }
  return { ok: false, error: "no detour-coverage route at any z guess (lb baked? sidecar tiles loaded?)" };
}

// ── CSV ──────────────────────────────────────────────────────────────────────
const CSV_HEADER = "key,label,src_ns,src_ew,dst_ns,dst_ew,exp_wx,exp_wy,act_lb,act_x,act_y,act_z,act_ns,act_ew,delta_m,verdict,note";
const csvEsc = (v) => {
  const s = String(v == null ? "" : v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function csvRow(row, geo, r) {
  const cells = [
    row.key, row.label, row.srcNs, row.srcEw, row.dstNs, row.dstEw,
    geo.expWx.toFixed(1), geo.expWy.toFixed(1),
    r.actual ? "0x" + (r.actual.lb >>> 0).toString(16).toUpperCase().padStart(8, "0") : "",
    r.actual ? r.actual.x.toFixed(2) : "", r.actual ? r.actual.y.toFixed(2) : "",
    r.actual ? r.actual.z.toFixed(2) : "",
    r.actual ? r.actNs.toFixed(3) : "", r.actual ? r.actEw.toFixed(3) : "",
    Number.isFinite(r.delta) ? r.delta.toFixed(1) : "",
    r.verdict, r.note || "",
  ];
  return cells.map(csvEsc).join(",");
}
function readResumeKeys(file) {
  const keys = new Set();
  if (!fs.existsSync(file)) return keys;
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    if (!line || line.startsWith("key,")) continue;
    // key is col 1 and never contains a comma/quote (numeric fields + '|').
    keys.add(line.split(",")[0]);
  }
  return keys;
}

// ── row selection + batching ─────────────────────────────────────────────────
function planRun(opts) {
  const all = parsePortals(opts.portals);
  const cov = opts.coverage ? loadCoverage(opts.coverage) : defaultCoverage();
  const resumeKeys = opts.resume ? readResumeKeys(opts.out) : new Set();
  const inCov = [];
  let skippedResume = 0;
  for (const row of all) {
    const geo = rowGeometry(row, opts.standoff);
    if (!cov.has(geo.srcLb)) continue;
    if (resumeKeys.has(row.key)) { skippedResume++; continue; }
    inCov.push({ row, geo });
  }
  const selected = inCov.slice(0, opts.max);
  const batches = [];
  for (let i = 0; i < selected.length; i += opts.batch) batches.push(selected.slice(i, i + opts.batch));
  return { total: all.length, covSize: cov.size, inCov: inCov.length + skippedResume, skippedResume, selected, batches };
}

// ── live-run page helpers (node-driven; short evaluates, never long ones) ────
async function readPose(page) {
  return page.evaluate(() => {
    const p = window.__rh ? window.__rh.TryGetPlayerPose() : null;
    return p ? { lb: p.objCellId >>> 0, x: p.x, y: p.y, z: p.z } : null;
  }).catch(() => null);
}
async function moveTo(page, t) {
  return page.evaluate(([lb, x, y, z]) => {
    window.__rh.MoveToPosition(lb >>> 0, x, y, z, true);
  }, [t.lb, t.x, t.y, t.z]).catch(() => null);
}
async function stopCompletely(page) {
  return page.evaluate(() => { try { window.__rh.StopCompletely(); } catch (_) {} }).catch(() => null);
}
async function installHost(page) {
  await page.evaluate(async () => {
    if (window.__rh) return;
    const wh = await import("/apps/holtburger-web/rynth/webhost.js");
    const host = new wh.RynthWebHost(window.__sessionHandle);
    window.__rh = host;
    host.start(10);
  });
}
async function teleloc(page, cell, x, y, z) {
  const cmd = `@teleloc 0x${(cell >>> 0).toString(16).toUpperCase().padStart(8, "0")} ${x.toFixed(2)} ${y.toFixed(2)} ${z.toFixed(2)}`;
  const r = await page.evaluate((c) => {
    const h = window.__sessionHandle;
    if (h && typeof h.sendChat === "function") {
      try { h.sendChat(c); return "sent"; } catch (e) { return `err: ${e.message || e}`; }
    }
    return "no handle";
  }, cmd).catch((e) => `evaluate threw: ${e.message}`);
  return { cmd, result: r };
}
const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// One row: teleloc -> walk probes -> detect jump -> settle -> compare.
async function checkPortal(page, row, geo, z, opts, log) {
  const rowStart = Date.now();
  // 1. teleloc to the approach point (+0.6m so we drop onto, not into, ground).
  const app = worldToLeg(geo.appWx, geo.appWy, z.teleZ + 0.6);
  const tl = await teleloc(page, app.lb, app.x, app.y, app.z);
  if (tl.result !== "sent") return { verdict: "ERROR", delta: NaN, note: `teleloc dispatch failed: ${tl.result}` };
  log(`  ${tl.cmd}`);
  let pose = null;
  for (let i = 0; i < 30; i++) { // 12s settle budget
    await sleepMs(POLL_MS);
    pose = await readPose(page);
    if (pose) {
      const [wx, wy] = worldXY(pose.lb, pose.x, pose.y);
      if (Math.hypot(wx - geo.appWx, wy - geo.appWy) <= 25) break;
    }
    pose = null;
  }
  if (!pose) return { verdict: "ERROR", delta: NaN, note: "teleloc did not settle near approach point (z wrong? command rejected?)" };

  // 2. walk targets: navmesh-snapped Src first, then the probe ring.
  const targets = [z.walkTarget];
  for (const [dx, dy] of PROBES.slice(1)) {
    targets.push(worldToLeg(geo.srcWx + dx, geo.srcWy + dy, z.walkTarget.z));
  }
  let lastLbWord = pose.lb >>> 16;
  let [lastWx, lastWy] = worldXY(pose.lb, pose.x, pose.y);
  for (const [ti, t] of targets.entries()) {
    if (Date.now() - rowStart > ROW_BUDGET_MS) break;
    await moveTo(page, t);
    const [twx, twy] = worldXY(t.lb, t.x, t.y);
    const tStart = Date.now();
    let lastD = Infinity, lastReissue = Date.now();
    while (Date.now() - tStart < TARGET_TIMEOUT_MS && Date.now() - rowStart < ROW_BUDGET_MS) {
      await sleepMs(POLL_MS);
      const p = await readPose(page);
      if (!p) continue;
      const lbWord = p.lb >>> 16;
      const [wx, wy] = worldXY(p.lb, p.x, p.y);
      // router.js portal-vs-seam rule: lb change + discontinuous jump.
      if (lbWord !== lastLbWord) {
        const jump = Math.hypot(wx - lastWx, wy - lastWy);
        lastLbWord = lbWord;
        if (jump >= SEAM_JUMP_M) {
          log(`  teleport! lb -> ${lbWord.toString(16)} jump=${jump.toFixed(0)}m (probe ${ti})`);
          await stopCompletely(page);
          await sleepMs(PORTAL_SETTLE_MS);
          const actual = (await readPose(page)) || p;
          const [awx, awy] = worldXY(actual.lb, actual.x, actual.y);
          const delta = Math.hypot(awx - geo.expWx, awy - geo.expWy);
          return {
            verdict: delta <= opts.tolerance ? "PASS" : "MISMATCH",
            actual, actNs: worldToDeg(awy), actEw: worldToDeg(awx), delta,
            note: `probe=${ti} jump=${jump.toFixed(0)}m`,
          };
        }
      }
      lastWx = wx; lastWy = wy;
      const d = Math.hypot(wx - twx, wy - twy);
      if (d <= ARRIVE_M) break; // reached this probe without a portal -> next
      if (d >= lastD - 0.2 && Date.now() - lastReissue > REISSUE_MS) {
        await moveTo(page, t);
        lastReissue = Date.now();
      }
      lastD = Math.min(lastD, d);
    }
  }
  await stopCompletely(page);
  return { verdict: "NO_TELEPORT", delta: NaN, note: `no lb-jump >= ${SEAM_JUMP_M}m across ${targets.length} probes (portal moved? not spawned? coords >12m off?)` };
}

// ── dry-run ──────────────────────────────────────────────────────────────────
async function dryRun(opts) {
  const plan = planRun(opts);
  console.log(`portals.tsv: ${plan.total} rows (${opts.portals})`);
  console.log(`coverage: ${plan.covSize} landblocks (${opts.coverage || "default Holtburg A7-AB x B2-B6"})`);
  console.log(`in-coverage rows: ${plan.inCov}${opts.resume ? ` (resume skipped ${plan.skippedResume})` : ""}; selected ${plan.selected.length} (max ${opts.max}); ${plan.batches.length} login batch(es) of <= ${opts.batch}`);
  let sidecarUp = false;
  try {
    const h = await fetchJson(`${opts.sidecar}/health`, null, 2000);
    sidecarUp = h && h.ok === true;
    console.log(`sidecar ${opts.sidecar}: ${sidecarUp ? `up (tiles=${h.tiles}, portals=${h.portals})` : "answered but not ok"}`);
  } catch (e) {
    console.log(`sidecar ${opts.sidecar}: unreachable (${e.message}) — z resolution deferred to the live run`);
  }
  for (const [bi, batch] of plan.batches.entries()) {
    console.log(`batch ${bi + 1} (one login):`);
    for (const { row, geo } of batch) {
      const app = worldToLeg(geo.appWx, geo.appWy, 0);
      let zNote = "z: unresolved (no sidecar)";
      if (sidecarUp) {
        const z = await resolveZ(opts.sidecar, row, geo);
        zNote = z.ok
          ? `z=${z.teleZ.toFixed(2)} walkTarget=0x${z.walkTarget.lb.toString(16)} (${z.walkTarget.x.toFixed(1)},${z.walkTarget.y.toFixed(1)},${z.walkTarget.z.toFixed(1)})`
          : `z FAILED: ${z.error}`;
      }
      console.log(
        `  ${row.label || "(unlabeled)"}\n` +
        `    src ${row.srcNs},${row.srcEw} -> lb=${geo.srcLb} world=(${geo.srcWx.toFixed(1)},${geo.srcWy.toFixed(1)})\n` +
        `    teleloc @ 0x${app.lb.toString(16).toUpperCase().padStart(8, "0")} local=(${app.x.toFixed(1)},${app.y.toFixed(1)}) standoff=${opts.standoff}m; ${zNote}\n` +
        `    expect dst ${row.dstNs},${row.dstEw} -> lb=${lbHex(worldToLeg(geo.expWx, geo.expWy, 0).lb)} world=(${geo.expWx.toFixed(1)},${geo.expWy.toFixed(1)}); tolerance=${opts.tolerance}m`
      );
    }
  }
  console.log(`DRY-RUN OK: ${plan.selected.length} rows planned, 0 executed (browser + ACE required for the live run)`);
}

// ── live run ─────────────────────────────────────────────────────────────────
async function liveRun(opts) {
  const { chromium } = require("playwright"); // lazy: dry-run must not need it
  const { bootInWorld } = require("./rynth_boot_helper.cjs");
  const log = (m) => console.log(`[portalcheck] ${m}`);
  const plan = planRun(opts);
  log(`${plan.selected.length} rows in ${plan.batches.length} batch(es); csv=${opts.out}`);
  if (!plan.selected.length) { log("nothing to do (coverage/resume filtered everything)"); return 0; }
  if (!fs.existsSync(opts.out)) fs.writeFileSync(opts.out, CSV_HEADER + "\n");

  // Resolve z for every selected row UP FRONT (fail fast if sidecar is down —
  // no point burning a login).
  for (const item of plan.selected) {
    item.z = await resolveZ(opts.sidecar, item.row, item.geo);
    if (!item.z.ok) log(`z-resolve FAILED for '${item.row.label}': ${item.z.error}`);
  }

  const browser = await chromium.launch({ headless: true, args: ["--no-sandbox", "--disable-gpu"] });
  const URL = `${opts.base}?nosw=1&nullRender=1&netDrainHz=30&autoLogin=1&account=${encodeURIComponent(opts.account)}&password=${encodeURIComponent(opts.password)}&autoSpawn=first`;
  const counts = {};
  let lastLoginAt = 0;
  try {
    for (const [bi, batch] of plan.batches.entries()) {
      // ACE reap-window pacing between OUR logins.
      const wait = lastLoginAt + LOGIN_SPACING_MS - Date.now();
      if (wait > 0) { log(`pacing: ${Math.ceil(wait / 1000)}s until next login (ACE reap window)`); await sleepMs(wait); }
      lastLoginAt = Date.now();
      log(`batch ${bi + 1}/${plan.batches.length}: booting (${batch.length} rows)`);
      const page = await bootInWorld(browser, URL);
      if (!page) {
        log(`batch ${bi + 1}: BOOT FAILED — recording ERROR rows`);
        for (const { row, geo } of batch) {
          const r = { verdict: "ERROR", delta: NaN, note: "boot failed" };
          fs.appendFileSync(opts.out, csvRow(row, geo, r) + "\n");
          counts[r.verdict] = (counts[r.verdict] || 0) + 1;
        }
        continue;
      }
      page.on("console", (m) => { const t = m.text(); if (/^\[(router|gnav)\]/.test(t)) log(`page: ${t}`); });
      await installHost(page);
      await sleepMs(2000);
      for (const { row, geo, z } of batch) {
        let r;
        if (!z.ok) {
          r = { verdict: "SKIP_NO_Z", delta: NaN, note: z.error };
        } else {
          log(`row: ${row.label || row.key} (src lb=${geo.srcLb})`);
          try {
            r = await checkPortal(page, row, geo, z, opts, log);
          } catch (e) {
            r = { verdict: "ERROR", delta: NaN, note: `threw: ${e.message}` };
          }
        }
        fs.appendFileSync(opts.out, csvRow(row, geo, r) + "\n");
        counts[r.verdict] = (counts[r.verdict] || 0) + 1;
        log(`  -> ${r.verdict}${Number.isFinite(r.delta) ? ` delta=${r.delta.toFixed(1)}m` : ""} ${r.note || ""}`);
        await sleepMs(1500);
      }
      await page.close().catch(() => null);
    }
  } finally {
    await browser.close().catch(() => null);
  }
  const summary = Object.entries(counts).map(([k, v]) => `${k}=${v}`).join(" ") || "none";
  log(`SUMMARY: ${summary} (csv: ${opts.out})`);
  // PASS-only exit 0; anything else non-zero so the orchestrator notices.
  return Object.keys(counts).every((k) => k === "PASS") ? 0 : 1;
}

// ── main ─────────────────────────────────────────────────────────────────────
if (require.main === module) {
  (async () => {
    const opts = parseArgs(process.argv);
    if (opts.dryRun) {
      await dryRun(opts);
      process.exit(0);
    }
    process.exit(await liveRun(opts));
  })().catch((e) => {
    console.error(`ERR ${e.stack || e.message}`);
    process.exit(1);
  });
} else {
  // Requireable for unit tests — pure helpers only (no browser/ACE needed).
  module.exports = {
    degToWorld, worldToDeg, worldXY, worldToLeg, lbHex,
    parsePortals, rowGeometry, planRun, resolveZ,
    CSV_HEADER, csvRow, readResumeKeys,
  };
}
