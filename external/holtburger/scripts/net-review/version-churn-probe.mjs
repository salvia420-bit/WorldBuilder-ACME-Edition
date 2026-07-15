// version-churn-probe — is something bumping `material.version` EVERY FRAME?
//
// WHERE THIS SITS. `getParameters` is the #1 self-time item in the frame (10.2%,
// cpu-profile-probe) and it has exactly ONE caller: `getProgram` (three.module.js
// :18098). `getProgram` runs only when `needsProgramChange` (:18440). So SOMETHING
// sets that flag per object per frame. Two candidates:
//
//   (a) CLASS THRASH — one material rendered by both a BatchedMesh and a plain
//       Mesh flips `materialProperties.batching` (:18332/:18336).
//       ** REFUTED (material-declone-ab.mjs): giving the 280 shared-material
//       batches their own clones saved 0.92ms while the PLACEBO (cloning the 229
//       NON-shared batches) saved 0.81ms — B−P = 0.10ms, i.e. nothing. The
//       mechanism is real (37 materials / 440 meshes span classes) and costs ~0.
//
//   (b) VERSION BUMP — `material.needsUpdate = true` runs `this.version++`
//       (three.core.js:16821), and :18420 `else { needsProgramChange = true; }`
//       fires on ANY version mismatch. This is the predecessor's ORIGINAL §3.2
//       suspicion, which I wrongly dissolved (§4c) and which (a)'s death now puts
//       back in front.
//
// This probe tests (b) directly and cheaply: snapshot every material's `.version`
// once per rAF and count how many CHANGED since the previous frame. A material
// whose version moves every frame is a per-frame program re-resolve for every
// object drawn with it.
//
// It also captures the WRITER: `Material.prototype.needsUpdate`'s setter is
// wrapped to record a stack trace, so the output NAMES the call site rather than
// leaving the next session to read 65 grep hits and guess (predecessor §6.1 —
// "grepping creation sites tells you what you PATCHED, not what RUNS").
//
// If ~0 versions churn, (b) is dead too and the trigger is one of the remaining
// needsProgramChange conditions (envMap / fog / vertexAlphas / vertexTangents /
// clipping / toneMapping / morph* / lightProbeGrid / lights state version) —
// which the probe also samples so the answer is not another guess.
import fs from "node:fs";
import { settleAt, WEATHER_OFF } from "./settle.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let __page = null;
process.on("unhandledRejection", async (e) => {
  console.error(`[vc] CRASH: ${e && e.message}`);
  try { await __page?.close(); } catch (_) {}
  process.exit(1);
});
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
  __page = page;

  const q = new URLSearchParams({
    renderer: "3d", autoLogin: "1", account: "tailnet1", password: "tailnet1",
    autoSpawn: "first", nosw: "1", particleInstancing: "off", ...WEATHER_OFF,
    ...(process.env.EXTRA_Q ? Object.fromEntries(new URLSearchParams(process.env.EXTRA_Q)) : {}),
  });
  const bail = async (msg, code) => {
    console.error(`[vc] ${msg}`);
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
  console.error(`[vc] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[vc] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  const setup = await page.evaluate(() => {
    const ls = window.liveScene3d;
    const D = window.__vc = { raf: 0, changed: 0, frames: 0, byMat: new Map(), writers: new Map(), objectsAffected: 0 };

    // 1) Wrap the needsUpdate SETTER on Material.prototype so we NAME the writer.
    //    Walk up from a real material to the prototype that actually owns it.
    let proto = null, probe = null;
    ls.scene.traverse((o) => { if (!probe && o.isMesh && o.material) probe = Array.isArray(o.material) ? o.material[0] : o.material; });
    for (let p = probe && Object.getPrototypeOf(probe); p; p = Object.getPrototypeOf(p)) {
      if (Object.getOwnPropertyDescriptor(p, "needsUpdate")) { proto = p; break; }
    }
    if (proto) {
      const d = Object.getOwnPropertyDescriptor(proto, "needsUpdate");
      Object.defineProperty(proto, "needsUpdate", {
        configurable: true,
        get: d.get,
        set(v) {
          if (v === true) {
            const st = (new Error().stack || "").split("\n").slice(2, 5).join(" <- ").replace(/https?:\/\/[^/]+/g, "");
            D.writers.set(st, (D.writers.get(st) || 0) + 1);
          }
          return d.set.call(this, v);
        },
      });
    }
    D.wrapped = !!proto;

    // 2) Per-rAF: how many materials' .version moved since last frame, and how
    //    many OBJECTS are drawn with such a material (that is the cost multiplier).
    const last = new Map();
    const seenUuids = new Set();
    const matObjects = new Map();
    const rescan = () => {
      matObjects.clear();
      ls.scene.traverse((o) => {
        if (!o.isMesh || o.visible === false) return;
        const mats = Array.isArray(o.material) ? o.material : [o.material];
        for (const m of mats) { if (m) matObjects.set(m, (matObjects.get(m) || 0) + 1); }
      });
    };
    rescan();
    D.rescan = rescan;
    const tick = () => {
      D.raf++;
      // ⭐ THE GAP IN v1: it rescanned ONCE, so it could only see version bumps on
      // materials that already existed. A BRAND-NEW material has
      // materialProperties.__version === undefined, so `material.version ===
      // __version` is false -> the else branch at :18420 -> needsProgramChange ->
      // getProgram -> getParameters. Material CREATION is a per-frame program
      // resolve too, and v1 was structurally blind to it. Rescan every frame.
      rescan();
      let fresh = 0;
      for (const m of matObjects.keys()) {
        if (!seenUuids.has(m.uuid)) { seenUuids.add(m.uuid); fresh++; }
      }
      D.newMats = (D.newMats || 0) + fresh;
      let ch = 0, objs = 0;
      for (const [m, n] of matObjects) {
        const v = m.version;
        const prev = last.get(m);
        if (prev !== undefined && v !== prev) {
          ch++; objs += n;
          const key = `${m.type} "${m.name || "(unnamed)"}"`;
          D.byMat.set(key, (D.byMat.get(key) || 0) + 1);
        }
        last.set(m, v);
      }
      D.changed += ch; D.objectsAffected += objs; D.frames++; D.liveMats = matObjects.size;
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    return { materials: matObjects.size, wrapped: D.wrapped };
  });
  console.error(`[vc] tracking ${setup.materials} live materials; needsUpdate setter wrapped: ${setup.wrapped}`);

  await sleep(2000);
  await page.evaluate(() => { const D = window.__vc; D.changed = 0; D.frames = 0; D.objectsAffected = 0; D.newMats = 0; D.byMat.clear(); D.writers.clear(); });
  await sleep(+(process.env.ARM_S || 14) * 1000);

  const r = await page.evaluate(() => {
    const D = window.__vc;
    return {
      frames: D.frames, changed: D.changed, objectsAffected: D.objectsAffected,
      byMat: [...D.byMat.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
      writers: [...D.writers.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
    };
  });

  console.error(`[vc] ==========================================================`);
  console.error(`[vc] over ${r.frames} frames:`);
  console.error(`[vc]   material .version CHANGES : ${r.changed}  (${(r.changed / Math.max(1, r.frames)).toFixed(1)} per frame)`);
  console.error(`[vc]   NEW materials created      : ${r.newMats}  (${(r.newMats / Math.max(1, r.frames)).toFixed(1)} per frame)  <- each is a FIRST program resolve`);
  console.error(`[vc]   live materials now         : ${r.liveMats}`);
  console.error(`[vc]   objects drawn with a churning material: ${(r.objectsAffected / Math.max(1, r.frames)).toFixed(1)} per frame`);
  console.error(`[vc]   ^ each of those is a getProgram -> getParameters + cache-key STRING BUILD`);
  console.error(`[vc] top churning materials:`);
  for (const [k, n] of r.byMat) console.error(`[vc]   ${String(n).padStart(5)}x  ${k}`);
  console.error(`[vc] top needsUpdate=true WRITERS (call site):`);
  for (const [k, n] of r.writers) console.error(`[vc]   ${String(n).padStart(5)}x  ${k}`);
  if (r.changed === 0) {
    console.error(`[vc] => VERSION CHURN IS DEAD TOO. Nothing bumps material.version per frame, so`);
    console.error(`[vc]    getProgram is being forced by one of the OTHER needsProgramChange triggers`);
    console.error(`[vc]    (envMap/fog/vertexAlphas/vertexTangents/clipping/toneMapping/morph/lights).`);
    console.error(`[vc]    Do NOT guess which — instrument that branch next.`);
  }

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/version-churn.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, settle: s, setup, ...r }, null, 2));
  await page.close();
  process.exit(0);
})();
