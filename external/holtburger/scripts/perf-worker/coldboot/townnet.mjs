// townnet.mjs — "Holtburg fully loaded, then the Town Network for the first time" on the live 1070 page.
// Precondition: `node sess.mjs boot --spawn <Name>` (in world, fresh profile).
//   node townnet.mjs <label> [--from Holtburg] [--to TownNetwork] [--settle-s 15] [--max-s 150]
//                             [--relay-log run.tsv] [--shots 5,15,30,60]
// 1. @telepoi <from>, wait for it to settle (no interior build, no pending surfaces, relay quiet).
// 2. @telepoi <to>; every 1 s: cell / indoor / interior builds / cell meshes / pending surfaces /
//    outdoor terrain + statics / far terrain / entities (+ portals: meshes, emitters) / fps / bytes.
// 3. 3D screenshots (real GPU) at the --shots seconds → townnet-<label>-<s>s.png; console warnings.
// → townnet-<label>.json
// ?texUpgradeQueue (2026-10-09, null-safe on old builds and on =off): rows gain `tex` (visible-cell rsIds:
// [hex, metres, F|P|W|S]), `hd` (__bc7Stats bytesFetched), `q` (__texUpgradeQueue.stats digest), `tw`
// (texture worker / xu7 FIFO counters); the tracker is armed before the teleport and `report()` is taken at
// the end (walls = teleport + firstCells s); SUMMARY gains `tex`; NET rows gain uniq/xferMb/uniqXferMb;
// townnet-<label>-res.json = resource rows for `hbns.py <file> <sum.tex.wallsPageMs> <+10000>`.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const a = process.argv.slice(2);
const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const LABEL = a[0] && !a[0].startsWith("--") ? a[0] : "tn";
const FROM = opt("--from", "Holtburg"), TO = opt("--to", "TownNetwork");
const SETTLE = +opt("--settle-s", 15), MAXS = +opt("--max-s", 150), RLOG = opt("--relay-log", null);
const SHOTS = opt("--shots", "5,15,30,60").split(",").map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const relayBytes = (sinceMs) => { if (!RLOG) return null; let d = 0; for (const l of readFileSync(RLOG, "utf8").split("\n")) { const f = l.split("\t"); if (+f[0] >= sinceMs) d += +f[1] || 0; } return d; };

const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const pg = browser.contexts()[0].pages().find((p) => p.url().includes("holtburger-web"));
const consoleLines = [];
let tTele = null;
pg.on("console", (m) => { if (tTele == null) return; const ty = m.type(); const tx = m.text(); if (ty === "error" || ty === "warning" || /envcells|portal|sealed|white|fallback|failed|interiorStabBatch|interiorClosure|shardFetch|texUpgrade/i.test(tx)) consoleLines.push({ t: +((Date.now() - tTele) / 1000).toFixed(1), ty, tx: tx.slice(0, 300) }); });

const sample = () => pg.evaluate(() => {
  const s = window.liveScene3d, h = window.__sessionHandle;
  const asArr = (v) => v instanceof Set ? Array.from(v).map((x) => (x >>> 0).toString(16)) : null;
  let cell = null, indoor = null;
  try { const p = h?.getLocalPlayerPose?.(); cell = p ? (p.landblockId >>> 0).toString(16) : null; p?.free?.(); } catch (_) {}
  try { indoor = !!h?.isCurrentCellIndoor?.(); } catch (_) {}
  const em = s?.entityManager; let ents = 0, entsWithMesh = 0; const portals = [];
  if (em?.entityMap) for (const [g, e] of em.entityMap) {
    ents++;
    let meshes = 0; try { e.root?.traverse?.((o) => { if (o.isMesh) meshes++; }); } catch (_) {}
    if (meshes > 0) entsWithMesh++;
    const nm = String(e.meta?.name ?? e.name ?? "");
    if (/portal/i.test(nm)) portals.push({ g: (g >>> 0).toString(16), nm: nm.slice(0, 32), meshes, vis: e.root ? e.root.visible !== false : null, inScene: !!e.root?.parent });
  }
  let far = null; try { const f = window.__farTerrainState?.(); far = f ? { visible: f.ring?.visible ?? f.visible ?? null, patches: f.ring?.patchesLive ?? f.ring?.patches ?? null, lbBakes: f.ring?.stats?.lbBakes ?? null } : null; } catch (_) {}
  let parts = null; try { const p = window.__diag?.particles?.(); parts = p ? { live: p.liveEmitters, st: p.staticEmitters, wd: p.worldEmitters } : null; } catch (_) {}
  const r = s?.renderer; const frame = r?.info?.render?.frame ?? null;
  let bw = null; try { const st = window.__diag?.bakeWorkerStats?.(); if (st) bw = { q: st.queue?.queuedNow, inf: st.queue?.inFlightPosted, posted: st.queue?.posted, by: Object.fromEntries(Object.entries(st.byType || {}).map(([k, v]) => [k, v.count])) }; } catch (_) {}
  let split = null; try { const d = globalThis.__indoorDepthSplit; split = d ? (d.armed ? "armed" : "off") : null; } catch (_) {}
  // ?texUpgradeQueue sampler (works on both arms and on older builds): every rsId on a mesh of a visible cell
  // container, its distance (m, camera to the cell's mesh group) and state — F full landed, P on pre waiting,
  // W on retail albedo waiting, S settled without a full tier. hd = full-tier bytes so far; q = queue stats.
  let tex = null; try { const mc = s?.materialCache, vis = s?._lastCellVisibleSet, reg = s?.cellContainers3d, cam = s?.cameraSwitcher?.activeCamera ?? s?.camera; if (mc && vis && reg && cam) { const rsOf = (m) => { const u = m && m.userData; return ((u && (u.__bc7RsId ?? u.__pvwRsId ?? u.__texRsId)) || 0) >>> 0; }; const st = new Map(); for (const m of mc.materials.values()) { const r = rsOf(m); if (!r) continue; const u = m.userData; const v = u.__bc7 ? "F" : u.__bc7Pending ? (u.__bc7Pre ? "P" : "W") : "S"; if (st.get(r) !== "F") st.set(r, v); } const ce = cam.matrixWorld.elements, d = {}; for (const cid of vis) { const c = reg.get(cid); if (!c) continue; const mg = c.children.find((k) => k.name?.startsWith("mesh-")) || c, w = mg.matrixWorld.elements, x = Math.hypot(w[12] - ce[12], w[13] - ce[13], w[14] - ce[14]); c.traverse((o) => { if (!o.isMesh) return; for (const m of [].concat(o.material)) { const r = rsOf(m); if (r && !(d[r] <= x)) d[r] = x; } }); } tex = Object.entries(d).map(([r, x]) => [(+r).toString(16), Math.round(x), st.get(+r) || "?"]); } } catch (_) {}
  let hd = null; try { hd = window.__bc7Stats?.()?.bytesFetched ?? null; } catch (_) {}
  let q = null; try { q = window.__texUpgradeQueue?.stats?.() ?? null; if (q) q = { en: q.enabled, paused: q.paused, queued: q.queued?.total, fg: q.queued?.fg, byBand: q.queued?.byBand, inflight: q.inflight, disp: q.dispatched, byKind: q.dispatchedByKind, bytes: q.bytes, dropped: q.dropped, cancelledPre: q.cancelledPre, aged: q.aged, bp: q.backpressureBlocks, tok: q.tokenBlocks, bucket: q.bucket, cap: q.cap, link: q.link, resumes: q.resumes?.length, idx: q.index && { ms: q.index.lastMs, maxMs: q.index.maxMs, cls0: q.index.cls0, ok: q.index.available, complete: q.index.complete } }; } catch (_) {}
  let tw = null; try { const w = window.__texWorkerStats?.(); const x = window.__xu7Stats?.(); tw = { ff: w?.fifoFallbacks ?? null, mq: w?.maxQueueDepth ?? null, qd: w?.queueDepth ?? null, st: w?.state ?? null, ew: w?.eagerWaits ?? null, dec: x?.decodes ?? null, nrs: x?.notReadySkips ?? null, xmq: x?.maxQueueDepth ?? null }; } catch (_) {}
  return { cell, indoor, envIn: asArr(s?.envCellBuildInFlight), envLoaded: asArr(s?.envCellLoadedLbs), tex, hd, q, tw,
    kids: s?.cellsGroup?.children?.length ?? null, pf: s?.materialCache?.pendingFetches?.size ?? null, mats: s?.materialCache?.materials?.size ?? null,
    terr: s?.terrainBakedLbs?.size ?? null, statics: s?.staticsBakedLbs?.size ?? null, bld: s?.buildingsBakedLbs?.size ?? null,
    sealed: s?._sealedEvictLbKey ? (s._sealedEvictLbKey >>> 0).toString(16) : 0, pending: window.__interiorBuildPending ?? null,
    tier: window.__terrainBc7Stats?.()?.ladder?.tier ?? null, far, parts, ents, entsWithMesh, portals, frame, bw, split,
    heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1e6) : null };
}).catch((e) => ({ err: String(e).slice(0, 120) }));
const chat = (msg) => pg.evaluate((m) => window.__sessionHandle.sendChat(m), msg);
const shot3d = async (file) => {
  const url = await pg.evaluate(async () => {
    const r = window.liveScene3d.renderer, orig = r.render, cv = r.domElement; let last = null;
    r.render = function (...x) { const ret = orig.apply(this, x); if (r.getRenderTarget() === null) { try { last = cv.toDataURL("image/jpeg", 0.85); } catch (e) { last = String(e); } } return ret; };
    await new Promise((res) => { let n = 0; const f = () => (++n >= 3 || last) ? res() : requestAnimationFrame(f); requestAnimationFrame(f); setTimeout(res, 4000); });
    r.render = orig; return last;
  }).catch(() => null);
  if (url && url.startsWith("data:")) writeFileSync(file, Buffer.from(url.split(",")[1], "base64"));
};
const log = (o) => console.log(JSON.stringify(o));
// The ?texUpgradeQueue sampler fields stay in the JSON rows; stdout lines carry only compact counters.
const lean = (r) => (r ? { ...r, tex: undefined, hd: undefined, q: undefined, tw: undefined } : r);
const texNear = (r, m = 32) => (Array.isArray(r?.tex) ? r.tex.filter((x) => x[1] <= m) : null);
const compact = (r) => { const n = texNear(r); return { texIn: n ? n.length : null, texWait: n ? n.filter((x) => x[2] === "W" || x[2] === "P").length : null, hdMB: r?.hd != null ? +(r.hd / 1e6).toFixed(1) : null, qd: r?.q ? r.q.queued : null }; };

// ---- 1. stand in <from> until it has settled
const t1 = Date.now();
await chat(`@telepoi ${FROM}`);
let quietSince = null, settled = null, prevB = relayBytes(t1) ?? 0;
for (let i = 0; i < 240; i++) {
  await sleep(1000);
  const s = sample(); const r = await s; const b = relayBytes(t1); const rate = b == null ? 0 : b - prevB; prevB = b ?? 0;
  const quiet = r.envIn && r.envIn.length === 0 && r.pf === 0 && rate < 150000;
  quietSince = quiet ? (quietSince ?? Date.now()) : null;
  if (i % 10 === 0) log({ phase: "from", t: (Date.now() - t1) / 1000, ...lean(r), portals: r.portals?.length, rateKBs: Math.round(rate / 1000) });
  if (quietSince && Date.now() - quietSince >= SETTLE * 1000) { settled = r; break; }
}
log({ phase: "from-settled", t: (Date.now() - t1) / 1000, ...lean(settled), portals: settled?.portals?.length });
await shot3d(`townnet-${LABEL}-from.jpg`);

// ---- 2. go to <to>
const lt = await pg.evaluate(() => { const L = []; window.__tnLongTasks = L; try { const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) L.push([Math.round(e.startTime), Math.round(e.duration)]); }); o.observe({ type: "longtask" }); window.__tnLtObs = o; } catch (_) {} return performance.now(); });
// ?texUpgradeQueue in-view tracker (4 Hz, both arms; null-safe on builds without the queue). Re-armed so a
// second run on the same sess.mjs page starts with an empty tracker.
// `ep`/`pn` = the PAGE's clocks (the 1070's Date.now and performance.now): the queue's report() and the
// bc7/suite HD logs stamp page epoch ms, and this script runs on another host, so walls are mapped into the
// page's clocks (midpoint of this round trip) instead of mixing the two machines' wall clocks.
const tb0 = Date.now();
const texBase = await pg.evaluate(() => { try { const q = window.__texUpgradeQueue; q?.trackInView?.(false); const on = q?.trackInView?.(true) ?? null; const w = window.__texWorkerStats?.(); const x = window.__xu7Stats?.(); return { ep: Date.now(), pn: performance.now(), tracking: on, ff: w?.fifoFallbacks ?? null, mq: w?.maxQueueDepth ?? null, dec: x?.decodes ?? null, nrs: x?.notReadySkips ?? null, hd: window.__bc7Stats?.()?.bytesFetched ?? null }; } catch (e) { return { err: String(e).slice(0, 120) }; } }).catch(() => null);
const tbMid = (tb0 + Date.now()) / 2;
tTele = Date.now();
await chat(`@telepoi ${TO}`);
const rows = []; const shotsLeft = SHOTS.slice(); let prevFrame = null;
for (let i = 0; Date.now() - tTele < MAXS * 1000; i++) {
  await sleep(1000);
  const r = await sample(); r.t = +((Date.now() - tTele) / 1000).toFixed(1);
  r.fps = prevFrame != null && r.frame != null ? r.frame - prevFrame : null; prevFrame = r.frame;
  r.MB = RLOG ? +(relayBytes(tTele) / 1e6).toFixed(1) : null;
  rows.push(r);
  const k = JSON.stringify({ ...lean(r), t: 0, frame: 0, fps: 0, MB: 0, heap: 0 });
  if (rows.length === 1 || k !== rows[rows.length - 2]._k) log({ ...lean(r), ...compact(r), portals: r.portals.map((p) => `${p.nm}:${p.meshes}${p.inScene ? "" : "!scene"}`).join("|") });
  r._k = k;
  if (shotsLeft.length && r.t >= shotsLeft[0]) { await shot3d(`townnet-${LABEL}-${shotsLeft.shift()}s.jpg`); }
}
const longtasks = await pg.evaluate(() => window.__tnLongTasks || []).catch(() => null);
// Downloads since the teleport, by class (needs sess.mjs's raised resource-timing buffer).
const netByClass = await pg.evaluate((ms0) => {
  const g = {}; for (const e of performance.getEntriesByType("resource")) { if (e.startTime < ms0) continue;
    const n = e.name.replace(/^https?:\/\/[^/]+/, ""); const k = n.includes("/shards/") ? "shard" : n.includes("texchan") ? "texchan" : n.split("?")[0].replace(/[0-9a-f]{6,}/gi, "#").replace(/\d+/g, "N").split("/").slice(-3).join("/");
    (g[k] ||= { n: 0, mb: 0, first: 1e9, last: 0, urls: new Set(), xfer: 0, uxfer: 0 }); g[k].n++; g[k].mb += e.encodedBodySize / 1e6; g[k].first = Math.min(g[k].first, (e.startTime - ms0) / 1000); g[k].last = Math.max(g[k].last, (e.responseEnd - ms0) / 1000);
    // ?texUpgradeQueue A/B: a second request for the same URL (texchan double fetch) may be a cache hit —
    // count it by UNIQUE URL and by transferSize (wire bytes), next to the encodedBodySize sum (`mb`).
    g[k].xfer += (e.transferSize || 0) / 1e6; if (!g[k].urls.has(e.name)) { g[k].urls.add(e.name); g[k].uxfer += (e.transferSize || 0) / 1e6; } }
  return Object.entries(g).sort((a, b) => b[1].mb - a[1].mb).slice(0, 20).map(([k, v]) => ({ k, n: v.n, mb: +v.mb.toFixed(1), first: +v.first.toFixed(1), last: +v.last.toFixed(1), uniq: v.urls.size, xferMb: +v.xfer.toFixed(1), uniqXferMb: +v.uxfer.toFixed(1) }));
}, lt).catch(() => null);
const first = (f) => rows.find(f)?.t ?? null;
const sum = {
  label: LABEL, from: FROM, to: TO, fromSettled: settled && { terr: settled.terr, statics: settled.statics, bld: settled.bld, ents: settled.ents },
  inLb: first((r) => r.cell && (parseInt(r.cell, 16) >>> 16) === 0x0007),
  firstCells: first((r) => r.kids > 0 && r.envLoaded?.some((x) => (parseInt(x, 16) >>> 16) === 0x0007)),
  noPending: first((r) => r.envLoaded?.some((x) => (parseInt(x, 16) >>> 16) === 0x0007) && r.pf === 0 && r.envIn?.length === 0),
  // 2026-10-09: with ?interiorWallsFirst the walls attach before the landblock is marked built (firstCells,
  // above, now = "statics in"); the walls time is the build's own console line (null on older builds / =off).
  wallsAttached: consoleLines.find((c) => /interiorWallsFirst\] envcells 0x00070000: \d+ cells attached/.test(c.tx))?.t ?? null,
  final: rows[rows.length - 1],
};
// ---- ?texUpgradeQueue acceptance (new fields only; null-safe on old builds and on =off)
// Page clocks when available (see texBase); otherwise the old node-clock / `lt` approximations.
const pageClk = Number.isFinite(texBase?.ep) && Number.isFinite(texBase?.pn);
const wallsEpochMs = sum.firstCells == null ? null : pageClk ? Math.round(texBase.ep + (tTele - tbMid) + sum.firstCells * 1000) : tTele + sum.firstCells * 1000;
const wallsPageMs = sum.firstCells == null ? null : Math.round((pageClk ? texBase.pn + (tTele - tbMid) : lt) + sum.firstCells * 1000);
const texReport = await pg.evaluate((w) => { try { const q = window.__texUpgradeQueue; const r = q?.report?.(w != null ? { wallsEpochMs: w } : {}) ?? null; q?.trackInView?.(false); return r; } catch (e) { return { err: String(e).slice(0, 160) }; } }, wallsEpochMs).catch(() => null);
// HD-window downloads by class from resource timing: texchan by unique URL + transferSize; shards (DAT + tex-*
// mixed — split them with hbns.py on the -res.json dump below).
const netWin = wallsPageMs == null ? null : await pg.evaluate(([a, b]) => {
  const g = {}; for (const e of performance.getEntriesByType("resource")) { if (e.responseEnd < a || e.responseEnd > b) continue;
    const n = e.name; const k = n.includes("/shards/") ? "shard" : n.includes("texchan") ? "texchan" : null; if (!k) continue;
    (g[k] ||= { n: 0, urls: new Set(), encMb: 0, xferMb: 0, uniqXferMb: 0 }); g[k].n++; g[k].encMb += e.encodedBodySize / 1e6; g[k].xferMb += (e.transferSize || 0) / 1e6;
    if (!g[k].urls.has(n)) { g[k].urls.add(n); g[k].uniqXferMb += (e.transferSize || 0) / 1e6; } }
  return Object.fromEntries(Object.entries(g).map(([k, v]) => [k, { n: v.n, uniq: v.urls.size, encMb: +v.encMb.toFixed(1), xferMb: +v.xferMb.toFixed(1), uniqXferMb: +v.uniqXferMb.toFixed(1) }]));
}, [wallsPageMs, wallsPageMs + 10000]).catch(() => null);
// Resource rows since the teleport for `hbns.py townnet-<label>-res.json <wallsPageMs> <wallsPageMs+10000>`.
const resRows = await pg.evaluate((ms0) => performance.getEntriesByType("resource").filter((e) => e.startTime >= ms0).map((e) => [e.name, Math.round(e.startTime), Math.round(e.responseEnd), e.encodedBodySize, e.transferSize, e.nextHopProtocol]), lt).catch(() => null);
if (resRows) writeFileSync(`townnet-${LABEL}-res.json`, JSON.stringify(resRows));
// Independent in-view wait from the sampler (wall clock from first seen W/P within 32 m to F/S; old builds too).
const smp = (() => { const open = new Map(), done = new Map(); let lastT = null;
  for (const r of rows) { if (!Array.isArray(r.tex)) continue; lastT = r.t; for (const [rs, dist, stt] of r.tex) {
    if (dist <= 32 && (stt === "W" || stt === "P")) { if (!open.has(rs) && !done.has(rs)) open.set(rs, r.t); }
    else if (open.has(rs) && (stt === "F" || stt === "S")) { done.set(rs, r.t - open.get(rs)); open.delete(rs); } } }
  const waits = [...done.values(), ...[...open.values()].map((t0) => (lastT ?? t0) - t0)];
  return { n: waits.length, maxWaitS: waits.length ? +Math.max(...waits).toFixed(1) : null, over10: waits.filter((w) => w > 10).length, stillOpen: open.size }; })();
const lastTw = [...rows].reverse().find((r) => r.tw)?.tw ?? null;
const lastHd = [...rows].reverse().find((r) => r.hd != null)?.hd ?? null;
const mb = (b) => (b == null ? null : +(b / 1e6).toFixed(1));
sum.tex = {
  wallsEpochMs, wallsPageMs, pageMinusNodeMs: pageClk ? Math.round(texBase.ep - tbMid) : null, tracking: texBase?.tracking ?? null, qEnabled: texReport?.stats?.enabled ?? null,
  hdWinMB: mb(texReport?.hdBytesWindow?.total), hdWin: texReport?.hdBytesWindow ? Object.fromEntries(Object.entries(texReport.hdBytesWindow).map(([k, v]) => [k, mb(v)])) : null,
  budget10sMB: mb(texReport?.budget10s), inViewMaxMs: texReport?.inView?.maxWaitMs ?? null, over10s: texReport?.inView?.over10s ?? null,
  inViewMaxAllMs: texReport?.inView?.maxWaitMsAll ?? null, open: texReport?.inView?.open?.length ?? null,
  K: texReport?.order?.K ?? null, orderFrac: texReport?.order?.firstKInViewFraction ?? null,
  smp, netWin, hdRunMB: lastHd != null && texBase?.hd != null ? mb(lastHd - texBase.hd) : null,
  ffDelta: lastTw?.ff != null && texBase?.ff != null ? lastTw.ff - texBase.ff : null, twMaxQ: lastTw?.mq ?? null, xu7MaxQ: lastTw?.xmq ?? null,
  nrsDelta: lastTw?.nrs != null && texBase?.nrs != null ? lastTw.nrs - texBase.nrs : null,
};
writeFileSync(`townnet-${LABEL}.json`, JSON.stringify({ sum, rows, consoleLines, longtasks, ltPageMs0: lt, netByClass, texBase, texReport }, null, 0));
for (const x of netByClass || []) console.log("NET", JSON.stringify(x));
console.log("SUMMARY", JSON.stringify({ ...sum, final: undefined }));
process.exit(0);
