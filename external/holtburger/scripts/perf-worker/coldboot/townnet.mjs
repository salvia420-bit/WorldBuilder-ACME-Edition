// townnet.mjs — "Holtburg fully loaded, then the Town Network for the first time" on the live 1070 page.
// Precondition: `node sess.mjs boot --spawn <Name>` (in world, fresh profile).
//   node townnet.mjs <label> [--from Holtburg] [--to TownNetwork] [--settle-s 15] [--max-s 150]
//                             [--relay-log run.tsv] [--shots 5,15,30,60]
// 1. @telepoi <from>, wait for it to settle (no interior build, no pending surfaces, relay quiet).
// 2. @telepoi <to>; every 1 s: cell / indoor / interior builds / cell meshes / pending surfaces /
//    outdoor terrain + statics / far terrain / entities (+ portals: meshes, emitters) / fps / bytes.
// 3. 3D screenshots (real GPU) at the --shots seconds → townnet-<label>-<s>s.png; console warnings.
// → townnet-<label>.json
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
pg.on("console", (m) => { if (tTele == null) return; const ty = m.type(); const tx = m.text(); if (ty === "error" || ty === "warning" || /envcells|portal|sealed|white|fallback|failed/i.test(tx)) consoleLines.push({ t: +((Date.now() - tTele) / 1000).toFixed(1), ty, tx: tx.slice(0, 300) }); });

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
  return { cell, indoor, envIn: asArr(s?.envCellBuildInFlight), envLoaded: asArr(s?.envCellLoadedLbs),
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

// ---- 1. stand in <from> until it has settled
const t1 = Date.now();
await chat(`@telepoi ${FROM}`);
let quietSince = null, settled = null, prevB = relayBytes(t1) ?? 0;
for (let i = 0; i < 240; i++) {
  await sleep(1000);
  const s = sample(); const r = await s; const b = relayBytes(t1); const rate = b == null ? 0 : b - prevB; prevB = b ?? 0;
  const quiet = r.envIn && r.envIn.length === 0 && r.pf === 0 && rate < 150000;
  quietSince = quiet ? (quietSince ?? Date.now()) : null;
  if (i % 10 === 0) log({ phase: "from", t: (Date.now() - t1) / 1000, ...r, portals: r.portals?.length, rateKBs: Math.round(rate / 1000) });
  if (quietSince && Date.now() - quietSince >= SETTLE * 1000) { settled = r; break; }
}
log({ phase: "from-settled", t: (Date.now() - t1) / 1000, ...settled, portals: settled?.portals?.length });
await shot3d(`townnet-${LABEL}-from.jpg`);

// ---- 2. go to <to>
const lt = await pg.evaluate(() => { const L = []; window.__tnLongTasks = L; try { const o = new PerformanceObserver((l) => { for (const e of l.getEntries()) L.push([Math.round(e.startTime), Math.round(e.duration)]); }); o.observe({ type: "longtask" }); window.__tnLtObs = o; } catch (_) {} return performance.now(); });
tTele = Date.now();
await chat(`@telepoi ${TO}`);
const rows = []; const shotsLeft = SHOTS.slice(); let prevFrame = null;
for (let i = 0; Date.now() - tTele < MAXS * 1000; i++) {
  await sleep(1000);
  const r = await sample(); r.t = +((Date.now() - tTele) / 1000).toFixed(1);
  r.fps = prevFrame != null && r.frame != null ? r.frame - prevFrame : null; prevFrame = r.frame;
  r.MB = RLOG ? +(relayBytes(tTele) / 1e6).toFixed(1) : null;
  rows.push(r);
  const k = JSON.stringify({ ...r, t: 0, frame: 0, fps: 0, MB: 0, heap: 0 });
  if (rows.length === 1 || k !== rows[rows.length - 2]._k) log({ ...r, portals: r.portals.map((p) => `${p.nm}:${p.meshes}${p.inScene ? "" : "!scene"}`).join("|") });
  r._k = k;
  if (shotsLeft.length && r.t >= shotsLeft[0]) { await shot3d(`townnet-${LABEL}-${shotsLeft.shift()}s.jpg`); }
}
const longtasks = await pg.evaluate(() => window.__tnLongTasks || []).catch(() => null);
// Downloads since the teleport, by class (needs sess.mjs's raised resource-timing buffer).
const netByClass = await pg.evaluate((ms0) => {
  const g = {}; for (const e of performance.getEntriesByType("resource")) { if (e.startTime < ms0) continue;
    const n = e.name.replace(/^https?:\/\/[^/]+/, ""); const k = n.includes("/shards/") ? "shard" : n.includes("texchan") ? "texchan" : n.split("?")[0].replace(/[0-9a-f]{6,}/gi, "#").replace(/\d+/g, "N").split("/").slice(-3).join("/");
    (g[k] ||= { n: 0, mb: 0, first: 1e9, last: 0 }); g[k].n++; g[k].mb += e.encodedBodySize / 1e6; g[k].first = Math.min(g[k].first, (e.startTime - ms0) / 1000); g[k].last = Math.max(g[k].last, (e.responseEnd - ms0) / 1000); }
  return Object.entries(g).sort((a, b) => b[1].mb - a[1].mb).slice(0, 20).map(([k, v]) => ({ k, n: v.n, mb: +v.mb.toFixed(1), first: +v.first.toFixed(1), last: +v.last.toFixed(1) }));
}, lt).catch(() => null);
const first = (f) => rows.find(f)?.t ?? null;
const sum = {
  label: LABEL, from: FROM, to: TO, fromSettled: settled && { terr: settled.terr, statics: settled.statics, bld: settled.bld, ents: settled.ents },
  inLb: first((r) => r.cell && (parseInt(r.cell, 16) >>> 16) === 0x0007),
  firstCells: first((r) => r.kids > 0 && r.envLoaded?.some((x) => (parseInt(x, 16) >>> 16) === 0x0007)),
  noPending: first((r) => r.envLoaded?.some((x) => (parseInt(x, 16) >>> 16) === 0x0007) && r.pf === 0 && r.envIn?.length === 0),
  final: rows[rows.length - 1],
};
writeFileSync(`townnet-${LABEL}.json`, JSON.stringify({ sum, rows, consoleLines, longtasks, ltPageMs0: lt, netByClass }, null, 0));
for (const x of netByClass || []) console.log("NET", JSON.stringify(x));
console.log("SUMMARY", JSON.stringify({ ...sum, final: undefined }));
process.exit(0);
