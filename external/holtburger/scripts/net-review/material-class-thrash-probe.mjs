// material-class-thrash-probe — is a SHARED material being rendered by more than
// one OBJECT CLASS, and thereby forcing a program re-resolve every frame?
//
// THE HYPOTHESIS, read from three r184 source (not inferred from a delta):
//   three.module.js:18332  } else if ( object.isBatchedMesh && materialProperties.batching === false ) {
//   :18336                 } else if ( !object.isBatchedMesh && materialProperties.batching === true ) {
//   :18348                 } else if ( object.isInstancedMesh && materialProperties.instancing === false ) {
//   :18352                 } else if ( !object.isInstancedMesh && materialProperties.instancing === true ) {
//        ...each sets needsProgramChange = true, and then:
//   :18440  if ( needsProgramChange === true ) program = getProgram( material, scene, object );
//   :18098  getProgram -> getParameters(...) + getProgramCacheKey(...)  <-- BOTH run BEFORE
//   :18127  the "program and light state identical" early-out.
//
// `materialProperties` is keyed PER MATERIAL, not per object. So if ONE material
// object is rendered by a BatchedMesh AND by a plain Mesh in the same frame, the
// `batching` flag flips on every object, needsProgramChange is TRUE every time,
// and every such draw pays getParameters + a cache-key STRING BUILD — even though
// the program never actually changes. Same for `instancing`.
//
// WHY WE SUSPECT IT HERE: `materialCache.getCached(surfaceDid)` returns ONE
// SHARED material per surfaceDid, and statics render that same material as
// BatchedMesh chunk buckets (keyed BY MATERIAL OBJECT), as plain Mesh singletons
// ("lone" nodes the batcher passes through), and as InstancedMesh (ring bake).
// The CPU profile says getParameters is the #1 self-time item in the frame
// (10.2%), with the program-resolve path at ~19% — and ?walkInInstance, which
// changes the class MIX per material, moved it to 4.8%. That is what this
// hypothesis predicts.
//
// This probe does not argue. It walks the settled scene and asks: for each
// material, WHICH object classes render it? A material seen in >1 class is a
// per-frame program re-resolve for every object that uses it.
//
// If the census comes back ~0 mixed materials, the hypothesis is dead and the
// getParameters cost is coming from one of the OTHER needsProgramChange triggers
// (envMap / fog / vertexAlphas / clipping / toneMapping / lights version) or
// from a genuine per-frame `needsUpdate` writer — all still on the table.
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
    console.error(`[mt] ${msg}`);
    await page.close().catch(() => {});
    process.exit(code);
  };

  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") await bail("boot error (account still held? wait 150s)", 3);
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
  console.error(`[mt] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[mt] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  const r = await page.evaluate(() => {
    const ls = window.liveScene3d;
    const classOf = (o) => (o.isBatchedMesh ? "batched" : o.isInstancedMesh ? "instanced" : o.isSkinnedMesh ? "skinned" : "plain");
    const groupOf = (o) => {
      let p = o;
      while (p) {
        if (["statics", "terrain", "cells", "entities", "buildings"].includes(p.name)) return p.name;
        p = p.parent;
      }
      return "(other)";
    };
    // material uuid -> { classes:Set, objects:n, perClass:{}, name, groups:Set }
    const byMat = new Map();
    ls.scene.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) {
        if (!m) continue;
        let e = byMat.get(m.uuid);
        if (!e) { e = { classes: new Set(), objects: 0, perClass: {}, name: m.name || "(unnamed)", type: m.type, groups: new Set() }; byMat.set(m.uuid, e); }
        const c = classOf(o);
        e.classes.add(c);
        e.perClass[c] = (e.perClass[c] || 0) + 1;
        e.objects++;
        e.groups.add(groupOf(o));
      }
    });
    const mixed = [];
    let mixedObjects = 0, totalObjects = 0, totalMats = 0;
    for (const [uuid, e] of byMat) {
      totalMats++;
      totalObjects += e.objects;
      if (e.classes.size > 1) {
        mixedObjects += e.objects;
        mixed.push({ uuid: uuid.slice(0, 8), name: e.name, type: e.type, classes: [...e.classes], perClass: e.perClass, objects: e.objects, groups: [...e.groups] });
      }
    }
    mixed.sort((a, b) => b.objects - a.objects);
    return { totalMats, totalObjects, mixedMats: mixed.length, mixedObjects, top: mixed.slice(0, 15) };
  });

  console.error(`[mt] ==========================================================`);
  console.error(`[mt] visible meshes: ${r.totalObjects}   distinct materials: ${r.totalMats}`);
  console.error(`[mt] MATERIALS RENDERED BY >1 OBJECT CLASS: ${r.mixedMats} / ${r.totalMats}`);
  console.error(`[mt]   objects drawn with such a material: ${r.mixedObjects} / ${r.totalObjects} (${(100 * r.mixedObjects / Math.max(1, r.totalObjects)).toFixed(1)}%)`);
  console.error(`[mt]   ^ EACH of those pays getParameters + a cache-key STRING BUILD every frame,`);
  console.error(`[mt]     because materialProperties.batching/instancing flips per object (three:18332/18348).`);
  console.error(`[mt] top offenders (by objects affected):`);
  for (const m of r.top) {
    console.error(`[mt]   ${String(m.objects).padStart(4)} objs  classes=${m.classes.join("+")}  ${JSON.stringify(m.perClass)}  groups=${m.groups.join(",")}  ${m.type} "${m.name}"`);
  }
  if (r.mixedMats === 0) {
    console.error(`[mt] => HYPOTHESIS DEAD. No material spans classes; the getParameters cost is`);
    console.error(`[mt]    coming from another needsProgramChange trigger or a real per-frame needsUpdate writer.`);
  }

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/material-class-thrash.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, extraQ: process.env.EXTRA_Q || "", settle: s, ...r }, null, 2));
  await page.close();
  process.exit(0);
})();
