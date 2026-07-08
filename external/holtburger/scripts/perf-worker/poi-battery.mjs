// poi_battery.mjs — teleport through the full @telepoi list in ONE session and
// run the perf diagnostics at each stop to fish out bad performance.
// Per POI: longest main-thread freeze during teleport+settle (heartbeat max-gap
// = the synchronous-materialisation stall), residency (LBs/nodes), steady-state
// cullStaticsGroup perCallMs, surface-miss warns, console errors, indoor flag.
import { pathToFileURL } from "node:url";
const boot = await import(
  pathToFileURL(
    "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs"
  ).href
);

// Full ace_world.points_of_interest list (62). Dupe/alias names kept — the
// battery is meant to be faithful; already-there teleports settle fast.
const POIS = [
  "Ahurenga","Al-Arqas","Al-Jalima","Arwic","Ayan Baqur","Baishi","Bandit Castle",
  "Beach Fort","Bluespire","Cragstone","Dryreach","Eastham","Eastwatch","Fiun",
  "Fort Tethana","Freehold","Glenden Wood","Greenspire","Hebian-to","Holtburg",
  "Hotel","Hotel Swank","HotelSwank","Kara","Khayyaban","Kryst","Lin","Linvak Tukal",
  "Lytelthorpe","Marketplace","Mayoi","Nanto","Neydisa","Night Club","NightClub",
  "Outpost","Plateau","Qalabar","Redspire","Refuge","Rithwic","Samsur","Sanamar",
  "Sawato","Shoushi","Silyun","Stonehold","Storage","Swank","Timaru","TN","Tou-Tou",
  "Town Network","TownNetwork","Tufa","Underground","Uziz","Westwatch","Xarabydun",
  "Yanshi","Yaraq","Zaikhal",
];

const log = (...a) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

const { page, helpers } = await boot.launchAndEnter({ query: { nosw: "1" }, timeoutMs: 90_000 });

// running console counters
let totalWarns = 0, totalErrs = 0;
const warnRe = /unavailable|empty fallback/i;
page.on("console", (m) => {
  const ty = m.type();
  if (ty === "error") totalErrs++;
  else if ((ty === "warning" || ty === "warn") && warnRe.test(m.text())) totalWarns++;
});
page.on("pageerror", () => { totalErrs++; });

// wait for scene + materialCache
const s0 = Date.now();
while (Date.now() - s0 < 80_000) {
  if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.materialCache))) break;
  await page.waitForTimeout(1000);
}
// install a 4ms heartbeat freeze detector on the main thread
await helpers.evalInPage(() => {
  window.__hb = { last: performance.now(), maxGap: 0 };
  if (window.__hbTimer) clearInterval(window.__hbTimer);
  window.__hbTimer = setInterval(() => {
    const now = performance.now();
    const gap = now - window.__hb.last;
    if (gap > window.__hb.maxGap) window.__hb.maxGap = gap;
    window.__hb.last = now;
  }, 4);
});
log("heartbeat installed; touring", POIS.length, "POIs");

// NOTE: getLocalPlayerPose() x/y are LANDBLOCK-LOCAL (0..192) — cross-town
// teleports barely move x/y, so detect moves via landblockId, and settle on
// residency (staticsBakedLbs) stabilising rather than pose distance.
const getPose = () => helpers.evalInPage(() => {
  try { const p = window.__sessionHandle.getLocalPlayerPose(); return p ? { lb: p.landblockId ?? null } : null; } catch { return null; }
});

const results = [];
for (const poi of POIS) {
  const warnsBefore = totalWarns, errsBefore = totalErrs;
  const before = await getPose();
  const beforeLb = before ? before.lb : null;
  const chStart = await helpers.evalInPage(() => window.liveScene3d?.staticsGroup?.children.length ?? -1);
  // reset freeze counter, then teleport
  await helpers.evalInPage(() => { window.__hb.maxGap = 0; window.__hb.last = performance.now(); });
  await helpers.evalInPage((p) => { try { window.__sessionHandle.sendChat("@telepoi " + p); } catch (_) {} }, poi);

  // Settle on staticsGroup.children stability (the reliable signal that drives
  // cull cost): wait for the teleport to LAND (landblock change or node count
  // moves >50) then for children to go FLAT (<2% growth for ~6s). Cap 26s.
  const t = Date.now();
  let landed = false, stable = 0, lastCh = chStart, curLb = beforeLb;
  const chSeries = [];
  while (Date.now() - t < 26_000) {
    await page.waitForTimeout(1200);
    const p = await getPose();
    const ch = await helpers.evalInPage(() => window.liveScene3d?.staticsGroup?.children.length ?? -1);
    chSeries.push(ch);
    if (p && p.lb != null) curLb = p.lb;
    if (!landed) {
      if (beforeLb != null && p && p.lb != null && p.lb !== beforeLb) landed = true;
      else if (ch >= 0 && chStart >= 0 && Math.abs(ch - chStart) > 50) landed = true;
      else if (Date.now() - t > 7000) landed = true; // already-there / tiny scene
    }
    const grow = lastCh > 0 ? Math.abs(ch - lastCh) / lastCh : (ch !== lastCh ? 1 : 0);
    if (ch >= 0 && grow < 0.02) stable++; else stable = 0;
    lastCh = ch;
    if (landed && stable >= 5 && Date.now() - t > 7000) break; // ~6s flat post-landing
  }
  const moved = beforeLb != null && curLb != null && curLb !== beforeLb;
  const resSeries = chSeries;

  // liveScene3d is transiently nulled during a teleport — re-wait before census.
  for (let i = 0; i < 24; i++) {
    if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.staticsGroup))) break;
    await page.waitForTimeout(500);
  }
  const c = await helpers.evalInPage(async () => {
    const s3 = window.liveScene3d;
    if (!s3 || !s3.staticsGroup) return { children: -1, visible: 0, bakedLbs: -1, maxResident: null, lruSize: null, indoor: null, ents: -1, perCallMs: null };
    const kids = s3.staticsGroup ? s3.staticsGroup.children : [];
    let visible = 0; for (const k of kids) if (k.visible !== false) visible++;
    const sm = await import("/apps/holtburger-web/scene3d/statics.js").catch(() => ({}));
    let culler = s3._frustumCuller || null;
    if (!culler) { try { const cu = await import("/apps/holtburger-web/scene3d/culling.js"); culler = cu.getFrustumCuller?.(s3); } catch (_) {} }
    let perCallMs = null;
    if (culler && sm.cullStaticsGroup) {
      try { sm.cullStaticsGroup(s3, culler); const t = performance.now(); for (let i = 0; i < 200; i++) sm.cullStaticsGroup(s3, culler); perCallMs = (performance.now() - t) / 200; } catch (_) {}
    }
    let indoor = null; try { indoor = window.__sessionHandle.isCurrentCellIndoor(); } catch (_) {}
    let ents = -1; try { ents = window.entityMap?.size ?? s3.entityManager?.entityMap?.size ?? -1; } catch (_) {}
    return {
      bakedLbs: s3.staticsBakedLbs?.size ?? -1, children: kids.length, visible,
      perCallMs, indoor, ents, lruSize: s3.landblockLru?.entries?.size ?? null,
      jsMissing: s3.materialCache?.missingSurfaces?.size ?? -1,
    };
  });
  const maxFreezeMs = await helpers.evalInPage(() => window.__hb.maxGap);

  const row = {
    poi, moved,
    maxFreezeMs: Math.round(maxFreezeMs),
    residentLbs: c.lruSize, bakedLbs: c.bakedLbs,
    children: c.children, visible: c.visible,
    cullMs: c.perCallMs != null ? +c.perCallMs.toFixed(3) : null,
    indoor: c.indoor, ents: c.ents,
    warns: totalWarns - warnsBefore, errors: totalErrs - errsBefore,
    nodePeak: Math.max(...resSeries),
  };
  results.push(row);
  log(`${poi.padEnd(16)} moved=${moved?1:0} freeze=${String(row.maxFreezeMs).padStart(5)}ms LBs=${row.residentLbs} nodes=${row.children} cull=${row.cullMs}ms warns=${row.warns} err=${row.errors} indoor=${row.indoor}`);
}

// Rankings
const byFreeze = [...results].filter(r => r.moved).sort((a, b) => b.maxFreezeMs - a.maxFreezeMs).slice(0, 12);
const byCull = [...results].filter(r => r.moved && r.cullMs != null).sort((a, b) => b.cullMs - a.cullMs).slice(0, 12);
const withErrors = results.filter(r => r.errors > 0);
const withWarns = results.filter(r => r.warns > 0);
const notMoved = results.filter(r => !r.moved).map(r => r.poi);

console.log("\n===== POI BATTERY SUMMARY =====");
console.log(JSON.stringify({
  totalPois: POIS.length,
  reached: results.filter(r => r.moved).length,
  notMoved,
  worstFreezes: byFreeze.map(r => ({ poi: r.poi, freezeMs: r.maxFreezeMs, LBs: r.residentLbs, nodes: r.children, indoor: r.indoor })),
  worstCull: byCull.map(r => ({ poi: r.poi, cullMs: r.cullMs, nodes: r.children, LBs: r.residentLbs })),
  poisWithErrors: withErrors.map(r => ({ poi: r.poi, errors: r.errors })),
  poisWithSurfaceWarns: withWarns.map(r => ({ poi: r.poi, warns: r.warns })),
  totalErrors: totalErrs,
}, null, 2));
console.log("\n===== FULL TABLE (json) =====");
console.log(JSON.stringify(results));
await helpers.close();
process.exit(0);
