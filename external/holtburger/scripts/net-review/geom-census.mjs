// geom-census.mjs — Task #2 measurement: per-model-DID GPU BufferGeometry
// duplication factor across the resident scene (sizes the #4 geometry-share
// lever). Runs the LOCAL headless SwiftShader boot (harness/lib/boot.mjs), which
// per HANDOFF §3d is authoritative for geometry/heap bounding (NOT fps). The
// duplication factor is a scene-graph property, independent of the GPU backend.
//
// Usage: node geom-census.mjs [outJson]
import fs from "node:fs";

const BOOT = "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs";
const OUT = process.argv[2] || "/mnt/wbterminal2/tmp/geom-census-result.json";
const QUERY = process.env.CENSUS_QUERY || "nosw=1&nullRender=0";

// Default: dense outdoor towns (same slices as the gov A/B). Override with
// CENSUS_POIS=indoor to exercise the envcell (cells.js) path in dungeons.
const OUTDOOR = [
  { name: "Rithwic",   cellHex: "0xC98C0028", x: 113.666, y: 190.259, z: 22.005, q: [-0.707107, 0, 0, -0.707107] },
  { name: "Cragstone", cellHex: "0xBB9F0040", x: 169.358, y: 168.251, z: 54.005, q: [0.578683, 0, 0, -0.815552] },
];
const INDOOR = [
  { name: "Marketplace", cellHex: "0x016C01BC", x: 49.206, y: -31.935, z: 0.005, q: [1, 0, 0, 0] },
  { name: "TownNetwork", cellHex: "0x00070143", x: 70.0, y: -60.0, z: 0.005, q: [1, 0, 0, 0] },
];
const POIS = process.env.CENSUS_POIS === "indoor" ? INDOOR : OUTDOOR;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function settle(evalInPage, capMs = 45000) {
  // Wait until terrainBakedLbs.size is stable for 3 consecutive 1.5s reads.
  const t0 = Date.now();
  let last = -1, stableCount = 0, size = 0;
  while (Date.now() - t0 < capMs) {
    await sleep(1500);
    size = await evalInPage(() => window.liveScene3d?.terrainBakedLbs?.size ?? 0).catch(() => 0);
    if (size > 0 && size === last) { stableCount++; if (stableCount >= 3) break; }
    else stableCount = 0;
    last = size;
  }
  return { residentLbs: size, settleMs: Date.now() - t0 };
}

// Per-DID geometry census — run in-page.
function censusFn() {
  const ls = window.liveScene3d;
  if (!ls || !ls.scene) return { err: "no liveScene3d" };
  const rr = ls.renderer;
  let ri = null;
  if (rr && rr.info && rr.info.memory) {
    rr.info.autoReset = false;
    ri = {
      geometries: rr.info.memory.geometries,
      textures: rr.info.memory.textures,
      programs: rr.info.programs ? rr.info.programs.length : null,
    };
  }
  // A "root" may be a THREE.Object3D OR a Map<id,Group> (cellContainers3d).
  function rootsOf(x) {
    if (!x) return [];
    if (typeof x.traverse === "function") return [x];
    if (typeof x.values === "function") return Array.from(x.values()); // Map
    return [];
  }
  function censusGroup(rootOrMap) {
    const roots = rootsOf(rootOrMap);
    const geoms = new Set();             // all distinct geometry.uuid
    const byDid = new Set();             // distinct model DIDs
    // Cross-LB duplication is keyed by (DID, partIndex): the SAME logical part
    // rebuilt per LB → multiple distinct geometry.uuid. Multi-surface models
    // (many parts) inflate a per-DID-only count but are NOT duplication.
    const byPart = new Map();            // "did#part" -> { geoms:Set, meshes, did, part }
    let meshes = 0, instanced = 0, batched = 0, withDid = 0, noDid = 0, noGeom = 0;
    const stack = roots.slice();
    while (stack.length) {
      const o = stack.pop();
      if (!o) continue;
      // LOD: count only the primary (highest-detail) child, mirroring
      // diag/placements.js visitStatic — avoids counting LOD levels as dup.
      if (o.isLOD && o.children && o.children.length) { stack.push(o.children[0]); continue; }
      if (o.isMesh || o.isInstancedMesh || o.isBatchedMesh) {
        meshes++;
        if (o.isInstancedMesh) instanced++;
        if (o.isBatchedMesh) batched++;
        const g = o.geometry;
        if (g) geoms.add(g.uuid); else noGeom++;
        let did = o.userData ? o.userData.modelId : null;
        if (did == null) { noDid++; }
        else {
          did = (typeof did === "string") ? (parseInt(did, 16) >>> 0) : (did >>> 0);
          withDid++;
          byDid.add(did);
          const ud = o.userData || {};
          // Full logical mesh identity: (modelId, partIndex, surfaceDid). If the
          // SAME identity maps to >1 distinct BufferGeometry, those are per-LB
          // rebuilds of one logical sub-mesh = the #4 cross-LB duplication.
          // landblockId (statics carries it directly) proves the LB-spread.
          const part = (ud.partIndex != null) ? (ud.partIndex | 0) : 0;
          const surf = (ud.surfaceDid != null) ? (ud.surfaceDid >>> 0) : 0;
          const key = did + "#" + part + "#" + surf;
          let e = byPart.get(key);
          if (!e) { e = { geoms: new Set(), meshes: 0, lbs: new Set(), did, part, surf }; byPart.set(key, e); }
          e.meshes++;
          if (g) e.geoms.add(g.uuid);
          if (ud.landblockId != null) e.lbs.add(ud.landblockId >>> 0);
        }
      }
      if (o.children) for (let i = 0; i < o.children.length; i++) stack.push(o.children[i]);
    }
    // Per-(DID,part) duplication: distinctGeoms-1 per key is reclaimable by #4.
    let reclaimable = 0, dupKeys = 0, maxDupPart = 0, trackedGeoms = 0;
    const histPart = {};
    const off = [];
    for (const e of byPart.values()) {
      const n = e.geoms.size;
      trackedGeoms += n;
      histPart[n] = (histPart[n] || 0) + 1;
      if (n > maxDupPart) maxDupPart = n;
      if (n > 1) { reclaimable += (n - 1); dupKeys++; off.push(["0x" + e.did.toString(16).padStart(8, "0"), e.part, "0x" + e.surf.toString(16), n, e.meshes, e.lbs.size]); }
    }
    off.sort((a, b) => b[3] - a[3]);
    return {
      meshes, instanced, batched, withDid, noDid, noGeom,
      distinctGeoms: geoms.size,
      uniqueDids: byDid.size,
      didPartKeys: byPart.size,
      trackedGeoms,
      // TRUE cross-LB reclaimable: geometries eliminable by sharing one per (DID,part).
      reclaimableGeoms: reclaimable,
      dupPartKeys: dupKeys,
      maxDupPerPart: maxDupPart,
      histPerPart: histPart, // {distinctGeomsForAPart: numSuchParts}
      topOffenders: off.slice(0, 15), // [didHex, partIndex, distinctGeoms, meshes]
    };
  }
  // Entity census — identity (wcid) is on the entity ROOT group; part meshes
  // carry {guid, partIndex, surfaceDid}. animation.js claims geometry is SHARED
  // across spawns of the same setupId. Key by (wcid, part, surface): if shared,
  // distinctGeoms per key == 1; if not, it grows with instance count.
  function entityCensus() {
    const rootGrp = ls.entitiesGroup;
    if (!rootGrp || !rootGrp.children) return null;
    const byKey = new Map();
    const wcids = new Set();
    const guids = new Set();
    const distinct = new Set();
    let entityRoots = 0, meshes = 0;
    for (const er of rootGrp.children) {
      entityRoots++;
      const ud = er.userData || {};
      const wcid = ud.modelId != null ? (ud.modelId >>> 0) : 0;
      const lb = ud.landblockId != null ? (ud.landblockId >>> 0) : 0;
      wcids.add(wcid);
      er.traverse((o) => {
        if (!(o.isMesh || o.isInstancedMesh)) return;
        meshes++;
        const g = o.geometry;
        if (g) distinct.add(g.uuid);
        const mu = o.userData || {};
        const part = mu.partIndex != null ? (mu.partIndex | 0) : 0;
        const surf = mu.surfaceDid != null ? (mu.surfaceDid >>> 0) : 0;
        if (mu.guid != null) guids.add(mu.guid);
        const key = wcid + "#" + part + "#" + surf;
        let e = byKey.get(key);
        if (!e) { e = { geoms: new Set(), instances: 0, lbs: new Set(), wcid }; byKey.set(key, e); }
        e.instances++;
        if (g) e.geoms.add(g.uuid);
        if (lb) e.lbs.add(lb);
      });
    }
    let reclaimable = 0, dupKeys = 0, maxDup = 0;
    const off = [];
    for (const e of byKey.values()) {
      const n = e.geoms.size;
      if (n > maxDup) maxDup = n;
      if (n > 1) { reclaimable += (n - 1); dupKeys++; off.push(["0x" + e.wcid.toString(16), n, e.instances, e.lbs.size]); }
    }
    off.sort((a, b) => b[1] - a[1]);
    return {
      entityRoots, meshes,
      uniqueWcids: wcids.size, uniqueGuids: guids.size,
      distinctGeoms: distinct.size, idKeys: byKey.size,
      // geometries eliminable if one geom per (wcid,part,surface) were shared:
      reclaimableIfSharedBySetup: reclaimable, dupKeys, maxDup,
      topOffenders: off.slice(0, 15), // [wcidHex, distinctGeoms, instances, distinctLBs]
    };
  }
  let dd = null;
  try {
    if (window.__hbWasm && typeof window.__hbWasm.dat_decode_diag === "function") {
      dd = JSON.parse(window.__hbWasm.dat_decode_diag());
    }
  } catch (_) {}
  let pose = null;
  try {
    const p = window.__sessionHandle.getLocalPlayerPose();
    if (p) { pose = { lb: p.landblockId >>> 0, x: p.x, y: p.y, z: p.z }; if (p.free) p.free(); }
  } catch (_) {}
  return {
    pose,
    residentLbs: ls.terrainBakedLbs ? ls.terrainBakedLbs.size : null,
    lru: ls.landblockLru && ls.landblockLru.getStats ? ls.landblockLru.getStats() : null,
    ri,
    heapMB: performance.memory ? +(performance.memory.usedJSHeapSize / 1048576).toFixed(1) : null,
    groups: {
      scene: censusGroup(ls.scene),
      statics: censusGroup(ls.staticsGroup),
      cells: censusGroup(ls.cellsGroup),
      cellContainers: censusGroup(ls.cellContainers3d),
      buildings: censusGroup(ls.buildingsGroup),
      terrain: censusGroup(ls.terrainGroup),
      entities: censusGroup(ls.entitiesGroup),
    },
    entityCensus: entityCensus(),
    // Note: dat_decode_diag reads the MAIN-thread wasm instance. Model
    // triangulation runs in the bake WORKER's own instance by default, so this
    // reflects surface-cache activity, not the MODEL_TRI_CACHE memo (which has
    // no hit/miss counter yet — see RESULTS follow-on).
    decodeDiag: dd,
  };
}

(async () => {
  const boot = await import(BOOT);
  console.error("[census] launching local SwiftShader boot…");
  const r = await boot.launchAndEnter({ query: QUERY, timeoutMs: 120000 });
  const { browser, helpers, inWorld, inWorldMs } = r;
  const evalInPage = helpers.evalInPage;
  console.error(`[census] inWorld=${inWorld} inWorldMs=${inWorldMs}`);
  if (!inWorld) {
    let bs = null; try { bs = await evalInPage(() => window.__bootState); } catch (_) {}
    console.error(`[census] NOT in-world (bootState=${bs}); aborting`);
    try { await browser.close(); } catch (_) {}
    process.exit(3);
  }
  // wait for liveScene3d (late — ~35s after in-world)
  for (let i = 0; i < 90; i++) {
    if (await evalInPage(() => !!(window.liveScene3d && window.liveScene3d.scene)).catch(() => false)) break;
    await sleep(1000);
  }

  const slices = [];
  const chat = (c) => evalInPage((cmd) => { try { window.__sessionHandle.sendChat(cmd); } catch (_) {} }, c).catch(() => {});

  // spawn slice
  let s = await settle(evalInPage);
  console.error(`[census] spawn settled: residentLbs=${s.residentLbs}`);
  slices.push({ label: "spawn", ...(await evalInPage(censusFn)) });

  for (const poi of POIS) {
    const cmd = `@teleloc ${poi.cellHex} ${poi.x} ${poi.y} ${poi.z} ${poi.q.join(" ")}`;
    console.error(`[census] teleport → ${poi.name}: ${cmd}`);
    await chat(cmd);
    await sleep(3000);
    s = await settle(evalInPage);
    console.error(`[census] ${poi.name} settled: residentLbs=${s.residentLbs}`);
    slices.push({ label: poi.name, ...(await evalInPage(censusFn)) });
  }

  const consoleErrors = (await evalInPage(() => (window.__perf && window.__perf.longtasks) ? window.__perf.longtasks.length : null).catch(() => null));
  const result = { generatedAtMs: Date.now(), inWorldMs, slices, longtasks: consoleErrors };
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.error(`[census] wrote ${OUT}`);
  try { await browser.close(); } catch (_) {}
  process.exit(0);
})().catch((e) => { console.error("[census] FATAL", e); process.exit(1); });
