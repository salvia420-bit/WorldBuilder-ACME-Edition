// npc-counter-probe — THE LAST MOVE: instrument three itself and COUNT which
// `needsProgramChange` branch fires, instead of guessing a seventh mechanism.
//
// THE CONTRADICTION THIS EXISTS TO BREAK (all measured, all in the handoff):
//   profile-split-render : the program-resolve path is 14.7% of samples and
//                          0.0% of it is bake — `getParameters` ~= 3.91ms of a
//                          ~28ms frame, INSIDE render(). So `getProgram` runs
//                          for something like ALL ~2,986 visible meshes, every
//                          frame, i.e. `needsProgramChange` is true per object.
//   …and yet every trigger that can set it measures STABLE:
//     version churn      1.0 obj/frame (the known §5.1 residual mesh)
//     class thrash       exists (440 objs) but B−P = 0.10ms when fixed
//     lights version     0 changes / 430 frames
//     env/fog/tone/clip  0 changes / 339 frames
//     new materials      2 / 378 frames
//     vertexAlphas       impossible (vertexColors only on particles + terrain)
//   Both cannot be true. Six hypotheses in this chain have now died from being
//   argued instead of counted, so this one gets counted.
//
// HOW, without touching the repo: three is CDN-loaded (index.html:951 pins
// `cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js`), and our local
// node_modules/three is the SAME 0.184.0 build. So patch the local copy IN
// MEMORY and serve it to the page with page.route() — no vendored file, no
// importmap edit, nothing to revert or forget. `three.module.js` imports
// `./three.core.js` RELATIVELY, and route.fulfill keeps the request URL, so the
// core half still loads from the CDN untouched.
//
// The patch adds, to three's own source:
//   - a counter on EVERY `needsProgramChange = true;` (26 of them), tagged with
//     the condition line that precedes it — so the output NAMES the branch;
//   - a call counter on getProgram / setProgram / prepareMaterial, so we learn
//     whether getProgram really runs per object per frame, and from where.
// Then: settle, zero the counters, sample N frames, and divide by frames. The
// answer is a printed number.
import fs from "node:fs";
import { settleAt, WEATHER_OFF } from "./settle.mjs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const THREE_LOCAL = new URL("../../apps/holtburger-web/node_modules/three/build/three.module.js", import.meta.url).pathname;

function instrument(src) {
  const lines = src.split("\n");
  let cond = "(unknown)";
  let tagged = 0;
  const tags = [];
  for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    // Track the condition that guards the next assignment. The version-mismatch
    // branch is a bare `} else {`, so name it explicitly rather than inheriting
    // the previous `else if`'s text (that would mislabel the biggest suspect).
    if (/^\}?\s*else\s*\{$/.test(t)) cond = "VERSION MISMATCH (material.version !== __version)";
    else if (/^(\}\s*)?else if \(|^if \(/.test(t)) cond = t.replace(/^\}?\s*/, "").slice(0, 72);
    if (lines[i].includes("needsProgramChange = true;")) {
      const tag = `${String(tagged).padStart(2, "0")}: ${cond}`;
      tags.push(tag);
      lines[i] = lines[i].replace(
        "needsProgramChange = true;",
        `needsProgramChange = true; globalThis.__npc && globalThis.__npc.hit(${JSON.stringify(tag)});`
      );
      tagged++;
    }
  }
  let out = lines.join("\n");
  const callCounter = (needle, tag) => {
    if (!out.includes(needle)) throw new Error(`instrument: anchor not found: ${needle}`);
    out = out.replace(needle, `${needle} globalThis.__npc && globalThis.__npc.hit(${JSON.stringify(tag)});`);
  };
  callCounter("function getProgram( material, scene, object ) {", "CALLS: getProgram");
  callCounter("function prepareMaterial( material, scene, object ) {", "CALLS: prepareMaterial (compile/bake)");
  callCounter("function setProgram( camera, scene, geometry, material, object ) {", "CALLS: setProgram");
  return { src: out, tagged, tags };
}

(async () => {
  const raw = fs.readFileSync(THREE_LOCAL, "utf8");
  const { src: patched, tagged, tags } = instrument(raw);
  console.error(`[npc] instrumented ${tagged} needsProgramChange sites + 3 call counters (${(patched.length / 1e6).toFixed(2)} MB)`);
  if (tagged !== 26) console.error(`[npc] ⚠ expected 26 sites, got ${tagged} — three's source may have shifted; check the tags below`);

  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const hits = fs.readdirSync(`${process.env.HOME}/.npm/_npx`)
    .map((d) => `${process.env.HOME}/.npm/_npx/${d}/node_modules/playwright-core`)
    .filter((p) => fs.existsSync(p));
  const pw = require(hits[0]);
  const browser = await pw.chromium.connectOverCDP("http://127.0.0.1:9333");
  const ctx = browser.contexts()[0];
  const page = await ctx.newPage();
  const bail = async (msg, code) => {
    console.error(`[npc] ${msg}`);
    await page.close().catch(() => {});
    process.exit(code);
  };

  // The counter must exist BEFORE three's module body runs.
  await page.addInitScript(() => {
    globalThis.__npc = {
      counts: {},
      hit(k) { this.counts[k] = (this.counts[k] || 0) + 1; },
      reset() { this.counts = {}; },
    };
  });
  // Serve OUR patched three for the pinned CDN URL. Everything else (three.core.js,
  // addons) still comes from the CDN, so only setProgram/getProgram change.
  let served = 0;
  await page.route("**/three@0.184.0/build/three.module.js", async (route) => {
    served++;
    await route.fulfill({ status: 200, contentType: "application/javascript; charset=utf-8", body: patched });
  });

  const q = new URLSearchParams({
    renderer: "3d", autoLogin: "1", account: "tailnet1", password: "tailnet1",
    autoSpawn: "first", nosw: "1", particleInstancing: "off", ...WEATHER_OFF,
    ...(process.env.EXTRA_Q ? Object.fromEntries(new URLSearchParams(process.env.EXTRA_Q)) : {}),
  });
  await page.goto(`http://127.0.0.1:8765/apps/holtburger-web/index.html?${q}`, { timeout: 60000 });
  for (let i = 0; i < 240; i++) {
    const bs = await page.evaluate(() => window.__bootState).catch(() => null);
    if (bs === "in-world" || bs === "ready") break;
    if (bs === "error") await bail("boot error (account still held? wait 150s)", 3);
    await sleep(1000);
  }
  console.error(`[npc] patched three served ${served}x`);
  if (!served) await bail("route never fired — the importmap URL did not match; the page ran STOCK three", 7);
  for (let i = 0; i < 90; i++) {
    if (await page.evaluate(() => !!(window.liveScene3d?.scene)).catch(() => false)) break;
    await sleep(1000);
  }
  const live = await page.evaluate(() => !!globalThis.__npc && Object.keys(globalThis.__npc.counts).length > 0);
  console.error(`[npc] counters live and firing: ${live}`);
  const gpu = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      const gl = c.getContext("webgl2") || c.getContext("webgl");
      return gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL);
    } catch (e) { return `err:${e.message}`; }
  }).catch(() => null);
  console.error(`[npc] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  const s = await settleAt(page, process.env.POI || "Holtburg",
    { log: (m) => console.error(`[npc] ${m}`), pinPose: process.env.PIN_POSE || null });
  if (!s.settled) await bail("not settled; abort", 4);

  // ---- A/B/A: does `bm.colorTexture = null` kill branch 05? ----
  // three r184 BUG: BatchedMesh has NO `colorTexture` property (its field is
  // `_colorsTexture`), so `object.colorTexture` is UNDEFINED and
  //   :18340  } else if ( object.isBatchedMesh && materialProperties.batchingColor === false
  //                       && object.colorTexture !== null )    // undefined !== null -> ALWAYS TRUE
  // fires for EVERY BatchedMesh EVERY frame -> getProgram -> getParameters +
  // cache-key string, for a program that never changes. Defining the property as
  // null makes the comparison false and the branch stops firing. (Branch 04 is
  // then also inert: it needs batchingColor === true, and it is false here.)
  await page.evaluate(() => {
    window.__npcFrames = 0;
    const t = () => { window.__npcFrames++; requestAnimationFrame(t); };
    requestAnimationFrame(t);
    const ls = window.liveScene3d, r = ls.renderer;
    if (r?.info) r.info.autoReset = false;
    const D = window.__ab = { renderMs: 0, batches: [] };
    const orig = r.render.bind(r);
    r.render = function (sc, cam) {
      const t0 = performance.now();
      try { return orig(sc, cam); } finally { D.renderMs += performance.now() - t0; }
    };
    ls.scene.traverse((o) => { if (o.isBatchedMesh) D.batches.push(o); });
    D.fix = () => { for (const b of D.batches) b.colorTexture = null; return D.batches.length; };
    D.unfix = () => { for (const b of D.batches) delete b.colorTexture; return D.batches.length; };
    D.mark = () => ({ raf: window.__npcFrames, renderMs: D.renderMs, calls: r.info.render.calls });
  });

  const ARM_S = +(process.env.ARM_S || 14);
  const arm = async (label, action) => {
    const n = await page.evaluate((a) => (a === "fix" ? window.__ab.fix() : window.__ab.unfix()), action);
    await sleep(2000);
    await page.evaluate(() => { globalThis.__npc.reset(); });
    const a = await page.evaluate(() => window.__ab.mark());
    await sleep(ARM_S * 1000);
    const b = await page.evaluate(() => ({ ...window.__ab.mark(), counts: globalThis.__npc.counts }));
    const dRaf = b.raf - a.raf;
    const gp = (b.counts["CALLS: getProgram"] || 0) / dRaf;
    const b05 = Object.entries(b.counts).filter(([k]) => k.startsWith("05:")).reduce((x, [, v]) => x + v, 0) / dRaf;
    const ms = +((b.renderMs - a.renderMs) / dRaf).toFixed(2);
    console.error(`[npc] ${label.padEnd(24)} batches=${n}  getProgram=${gp.toFixed(0)}/f  branch05=${b05.toFixed(0)}/f  renderCPU=${ms}ms`);
    return { label, n, getProgram: +gp.toFixed(1), branch05: +b05.toFixed(1), renderMs: ms };
  };

  const rows = [];
  rows.push(await arm("A-baseline#1", "unfix"));
  rows.push(await arm("B-colorTexture=null#1", "fix"));
  rows.push(await arm("A-baseline#2", "unfix"));
  rows.push(await arm("B-colorTexture=null#2", "fix"));
  rows.push(await arm("A-baseline#3", "unfix"));

  const A = rows.filter((r) => r.label.startsWith("A")).map((r) => r.renderMs);
  const B = rows.filter((r) => r.label.startsWith("B")).map((r) => r.renderMs);
  const mean = (x) => x.reduce((a, b) => a + b, 0) / x.length;
  const spread = Math.max(...A) - Math.min(...A);
  console.error(`[npc] ==========================================================`);
  console.error(`[npc] A (stock three r184) mean ${mean(A).toFixed(2)}ms  spread ${spread.toFixed(2)} = NOISE FLOOR`);
  console.error(`[npc] B (colorTexture=null) mean ${mean(B).toFixed(2)}ms`);
  console.error(`[npc] delta ${(mean(B) - mean(A)).toFixed(2)}ms (${(100 * (mean(B) - mean(A)) / mean(A)).toFixed(1)}%)  -> ${Math.abs(mean(B) - mean(A)) > spread ? "WIN" : "NOT PROVEN (inside noise)"}`);
  console.error(`[npc] branch05 ${rows[0].branch05}/f -> ${rows[1].branch05}/f ; getProgram ${rows[0].getProgram}/f -> ${rows[1].getProgram}/f`);
  const r = { counts: {}, frames: 0, ab: rows };

  fs.writeFileSync(process.env.OUT || "/mnt/wbterminal2/tmp/npc-counters.json",
    JSON.stringify({ poi: process.env.POI || "Holtburg", gpu, extraQ: process.env.EXTRA_Q || "", settle: s, frames: r.frames, counts: r.counts, tags }, null, 2));
  await page.close();
  process.exit(0);
})();
