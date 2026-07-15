// singleton-dedupe-probe — are the 17,895 "singletons" actually UNIQUE geometry?
//
// THE QUESTION, AND WHY IT DECIDES THE FIX. The predecessor handoff
// (draw-count-is-real-but-uncounted, c2840cbb) established that `statics` emits
// ~5,791 REAL draws/frame (78% of a ~7,562-draw frame) because BatchedMesh
// issues one multiDraw range PER INSTANCE. It then proposed a per-(material,LB)
// geometry MERGE: ~5,791 -> ~512 draws.
//
// That proposal rests on an ASSUMPTION I made from a code read and never
// measured: that the batched nodes are true singletons — models placed exactly
// once — so instancing cannot help them and merging is the only option. If the
// assumption is WRONG and their geometry repeats, then InstancedMesh (ONE real
// draw for N instances, measured FREE: 14 InstancedMesh / 2,992 instances cost
// -0.28ms) beats a merge (512 draws) by a wide margin, and the handoff names
// the wrong fix.
//
// THERE IS A CONCRETE REASON TO DOUBT THE ASSUMPTION. statics.js has TWO
// bakers, and only one of them dedupes across landblocks:
//   :2617  "Stage 3: ring-wide group-by-modelId ... This is the divergent step
//           vs the per-LB baker: placements sharing a modelId across LBs are
//           batched into a single InstancedMesh. Singletons stay as plain Mesh."
//   :2141  consolidateStaticSingletons(addedNodes, batches)   <- the per-LB path
// The per-LB baker has no cross-LB view, so a model placed ONCE PER LB across
// 121 resident LBs is a "singleton" 121 separate times — 121 plain meshes, swept
// into BatchedMesh by material, emitting 121 real draws for ONE model. That is
// invisible to a code read and invisible to info.calls. It is not invisible to
// a hash of the vertex data.
//
// METHOD. For every BatchedMesh under `statics`, hash each geometry range's
// ACTUAL position data (the geometry stored in a BatchedMesh is the untransformed
// source model — the placement lives in the per-instance matrix, statics.js:1683
// `bm.setMatrixAt(iid, m.matrix)`), then count how many INSTANCES share each
// hash. No source change, no arms, no A/B — a census of a number.
//
// WHAT THE ANSWER MEANS:
//   distinct ~= instances  -> genuinely unique models. Merge is right; the
//                             handoff's ~512-draw projection stands.
//   distinct <<  instances -> the geometry repeats and we are drawing the same
//                             model N times. INSTANCE it: draws collapse to
//                             ~distinct (material,geometry) pairs, which beats
//                             the merge, and the handoff's lead must be re-aimed.
// Both outcomes are useful; the point is to stop guessing which one is true.
import fs from "node:fs";
import { settleAt, WEATHER_OFF } from "./settle.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const hits = fs.readdirSync(`${process.env.HOME}/.npm/_npx`)
    .map((d) => `${process.env.HOME}/.npm/_npx/${d}/node_modules/playwright-core`)
    .filter((p) => fs.existsSync(p));
  const pw = require(hits[0]);
  const browser = await pw.chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();

  const q = new URLSearchParams({
    renderer: "3d", autoLogin: "1", account: "tailnet1", password: "tailnet1",
    autoSpawn: "first", nosw: "1", particleInstancing: "off", ...WEATHER_OFF,
    ...(process.env.EXTRA_Q ? Object.fromEntries(new URLSearchParams(process.env.EXTRA_Q)) : {}),
  });
  const bail = async (msg, code) => {
    console.error(`[sd] ${msg}`);
    await page.close().catch(() => {});
    process.exit(code);
  };

  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") await bail("boot error (account still held? wait 45-60s)", 3);
    await sleep(1000);
  }
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.liveScene3d?.scene)).catch(() => false)) break;
    await sleep(1000);
  }
  const gpu = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      return gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL);
    } catch (e) { return `err:${e.message}`; }
  }).catch(() => null);
  console.error(`[sd] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[sd] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  const SAMPLES_ENV = +(process.env.SAMPLES ?? 96);
  await page.evaluate((n) => { window.__sdSamples = n; }, SAMPLES_ENV);
  console.error(`[sd] hash samples per geometry: ${SAMPLES_ENV === 0 ? "ALL floats (exact)" : SAMPLES_ENV}`);
  const r = await page.evaluate((groupName) => {
    const ls = window.liveScene3d;
    const root = ls.scene.getObjectByName(groupName);
    if (!root) return { error: `no group ${groupName}` };

    // FNV-1a over the range's position floats. Subsampled to a bounded number of
    // samples so a 17k-range census stays fast; vertexCount/indexCount are mixed
    // in so two different models cannot collide merely by sharing sample points.
    // SAMPLES caps how many position floats feed the hash. The default (96) is
    // a subsample, so it CAN in principle collide two different models into one
    // "distinct" geometry — which would fake a dedupe win. Re-run with
    // SAMPLES=0 (hash EVERY float, no subsampling) to check: if the distinct
    // count is unchanged, subsampling is not inventing the repeats.
    const SAMPLES = window.__sdSamples || 96;
    const hashRange = (arr, startFloat, floatLen, vc, ic) => {
      let h = 0x811c9dc5 ^ (vc * 2654435761) ^ (ic * 40503);
      const stride = SAMPLES > 0 ? Math.max(1, Math.floor(floatLen / SAMPLES)) : 1;
      const buf = new DataView(new ArrayBuffer(4));
      for (let i = 0; i < floatLen; i += stride) {
        buf.setFloat32(0, arr[startFloat + i]);
        const b = buf.getUint32(0);
        h ^= b; h = Math.imul(h, 0x01000193);
      }
      return (h >>> 0).toString(16) + ":" + vc + ":" + ic;
    };

    const byHash = new Map();          // geometry hash -> instance count (scene-wide)
    const byMatHash = new Set();       // (material.uuid|hash) -> the instanced-draw floor
    let batches = 0, instances = 0, hashed = 0, skipped = 0;
    const perBatchDistinct = [];

    root.traverse((o) => {
      if (!o.isBatchedMesh) return;
      batches++;
      const pos = o.geometry?.attributes?.position?.array;
      const gi = o._geometryInfo, ii = o._instanceInfo;
      if (!pos || !gi || !ii) { skipped++; return; }
      const matUuid = (Array.isArray(o.material) ? o.material[0] : o.material)?.uuid || "?";
      // hash each geometry ONCE, then attribute per instance
      const hashOfGeom = new Map();
      for (let g = 0; g < gi.length; g++) {
        const e = gi[g];
        if (!e || e.vertexStart < 0 || e.vertexCount <= 0) continue;
        hashOfGeom.set(g, hashRange(pos, e.vertexStart * 3, e.vertexCount * 3, e.vertexCount, e.indexCount | 0));
        hashed++;
      }
      const local = new Set();
      for (let i = 0; i < ii.length; i++) {
        const inf = ii[i];
        if (!inf || inf.active === false) continue;
        instances++;
        const h = hashOfGeom.get(inf.geometryIndex);
        if (h == null) continue;
        byHash.set(h, (byHash.get(h) || 0) + 1);
        byMatHash.add(matUuid + "|" + h);
        local.add(h);
      }
      perBatchDistinct.push({ name: o.name, geoms: gi.length, insts: ii.length, distinct: local.size });
    });

    const counts = [...byHash.values()].sort((a, b) => b - a);
    return {
      batches, instances, hashedGeometries: hashed, skipped,
      distinctGeometries: byHash.size,
      instancedDrawFloor: byMatHash.size,
      top: counts.slice(0, 12),
      repeatedInstances: counts.filter((c) => c > 1).reduce((a, b) => a + b, 0),
      singletonGeometries: counts.filter((c) => c === 1).length,
      worstBatches: perBatchDistinct.sort((a, b) => (b.insts - b.distinct) - (a.insts - a.distinct)).slice(0, 6),
    };
  }, process.env.GROUP || "statics");

  if (r.error) await bail(r.error, 6);
  console.error(`[sd] ==========================================================`);
  console.error(`[sd] ${r.batches} BatchedMesh · ${r.instances} active instances · ${r.hashedGeometries} geometry entries hashed (${r.skipped} batches skipped)`);
  console.error(`[sd] DISTINCT geometries          = ${r.distinctGeometries}`);
  console.error(`[sd]   of which appear ONCE       = ${r.singletonGeometries}   <- true singletons`);
  console.error(`[sd]   instances on REPEATED geom = ${r.repeatedInstances}   <- draws instancing could collapse`);
  console.error(`[sd] dedupe ratio                 = ${(r.instances / Math.max(1, r.distinctGeometries)).toFixed(1)}x  (instances per distinct model)`);
  console.error(`[sd] top repeat counts            = ${r.top.join(", ")}`);
  console.error(`[sd] ---- what each fix would cost, in REAL draws ----`);
  console.error(`[sd]   today (1 range per instance)          ~ ${r.instances}`);
  console.error(`[sd]   per-(material,LB) MERGE               ~ ${r.batches}`);
  console.error(`[sd]   INSTANCE by (material, geometry)      ~ ${r.instancedDrawFloor}`);
  console.error(`[sd] worst batches (insts vs distinct geoms):`);
  for (const b of r.worstBatches) console.error(`[sd]   ${String(b.insts).padStart(4)} insts / ${String(b.distinct).padStart(4)} distinct  ${b.name}`);

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/singleton-dedupe.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, settle: s, ...r }, null, 2));
  await page.close();
  process.exit(0);
})();
