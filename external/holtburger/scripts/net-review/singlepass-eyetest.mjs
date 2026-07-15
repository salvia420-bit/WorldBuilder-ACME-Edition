// singlepass-eyetest — SEE what scene-wide forceSinglePass actually changes.
//
// forcesinglepass-parity.mjs says the scene-wide flip changes 3,688 px (0.72%,
// max delta 106) on the 451 non-particle transparent DoubleSide meshes. That is
// a COUNT. A count cannot tell you whether the change is a regression, an
// improvement, or invisible — and this project's rule is that parity is proven
// by looking, not by counting (the brazier-flame hero shot is owed for exactly
// this reason). So: render the two paths and LOOK at them.
//
// Same instant-A/B as forcesinglepass-parity (render twice inside ONE
// synchronous moment, no rAF/tick between, so scene state is identical BY
// CONSTRUCTION) — but it writes PNGs instead of statistics:
//   A  the current two-pass (BackSide then FrontSide)
//   B  forceSinglePass (what retail does: one draw, CULLMODE_NONE)
//   D  an amplified diff heatmap, so a 0.72% change is actually visible
//   plus CROPS centred on the largest diff clusters, since 3,688 px scattered
//   over a 960x535 frame are invisible at full size.
//
// WHY B IS THE PARITY CANDIDATE, NOT THE RISK. Retail's per-polygon draw path,
// D3DPolyRender::DrawPolyInternal (acclient.c:455306):
//     if ( override_cull_state_0 || p->sides_type == 1 )
//         SetCullMode(CULLMODE_NONE);       // two-sided -> cull nothing
//     else
//         SetCullMode(CULLMODE_CW);
// ...and then draws ONCE. One cull mode, one draw. The back-then-front two-pass
// three does for transparent DoubleSide has NO retail counterpart, so arm B is
// what the retail client put on screen and arm A is the deviation. That inverts
// the burden of proof: the question is not "is B safe" but "is A parity".
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
    console.error(`[eye] ${msg}`);
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
  console.error(`[eye] GPU: ${gpu}`);
  if (!/GTX 1070/.test(gpu || "")) await bail(`not the 1070 GPU (${gpu})`, 5);

  // Tour several POIs in ONE page load. The pose confound that dominates draw
  // counts does NOT apply here: both arms are rendered at the SAME instant from
  // the SAME camera, so any pose is a valid sample and the only thing more stops
  // buy is COVERAGE. One night-time Holtburg pose is not evidence that a visual
  // change is safe everywhere — this is the 62-town walk in miniature.
  const POIS = (process.env.POIS || process.env.POI || "Holtburg").split(",").map((x) => x.trim()).filter(Boolean);
  const measure = async (scope) => await page.evaluate(async (scope) => {
    const ls = window.liveScene3d, r = ls.renderer;
    const THREE = await import("https://cdn.jsdelivr.net/npm/three@0.184.0/build/three.module.js");
    const scene = ls.scene, camera = ls.cameraSwitcher?.activeCamera ?? ls.camera;
    const W = 960, H = 535;
    const rt = new THREE.WebGLRenderTarget(W, H, { depthBuffer: true });
    const isParticle = (o) => o?.isMesh && !o.isInstancedMesh && o.userData?.__particle === true;

    const mats = [];
    const names = new Map();
    scene.traverse((o) => {
      if (!o.isMesh || o.visible === false) return;
      if (scope === "nonparticles" && isParticle(o)) return;
      const ms = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of ms) if (m?.transparent === true && m.side === 2) { mats.push(m); names.set(m.name || m.type, (names.get(m.name || m.type) || 0) + 1); }
    });
    const flip = (v) => { for (const m of mats) if (m.forceSinglePass !== v) { m.forceSinglePass = v; m.needsUpdate = true; } };

    const grab = () => {
      const prev = r.getRenderTarget();
      r.setRenderTarget(rt); r.clear(); r.render(scene, camera);
      const b = new Uint8Array(W * H * 4);
      r.readRenderTargetPixels(rt, 0, 0, W, H, b);
      r.setRenderTarget(prev);
      return b;
    };
    // WebGL readback is bottom-up; flip rows so the PNG is right way up.
    const toPng = (buf) => {
      const c = document.createElement("canvas"); c.width = W; c.height = H;
      const cx = c.getContext("2d"); const id = cx.createImageData(W, H);
      for (let y = 0; y < H; y++) {
        const src = (H - 1 - y) * W * 4, dst = y * W * 4;
        for (let x = 0; x < W * 4; x++) id.data[dst + x] = buf[src + x];
      }
      cx.putImageData(id, 0, 0);
      return c.toDataURL("image/png").split(",")[1];
    };

    grab(); // discard the first render into a fresh target (converges)
    const c1 = grab(), c2 = grab();
    let control = 0;
    for (let i = 0; i < c1.length; i += 4) if (c1[i] !== c2[i] || c1[i + 1] !== c2[i + 1] || c1[i + 2] !== c2[i + 2]) control++;

    flip(true);
    const b = grab();
    flip(false);
    const a2 = grab();
    let restoreDiff = 0;
    for (let i = 0; i < c2.length; i += 4) if (c2[i] !== a2[i] || c2[i + 1] !== a2[i + 1] || c2[i + 2] !== a2[i + 2]) restoreDiff++;

    // Amplified diff heatmap + cluster finding (on a coarse grid, so we can
    // point the crops at where the change actually IS).
    const diff = new Uint8Array(W * H * 4);
    const GRID = 32, gw = Math.ceil(W / GRID), gh = Math.ceil(H / GRID);
    const cells = new Float64Array(gw * gh);
    let changed = 0, maxD = 0;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        const i = (y * W + x) * 4;
        const d = Math.max(Math.abs(c2[i] - b[i]), Math.abs(c2[i + 1] - b[i + 1]), Math.abs(c2[i + 2] - b[i + 2]));
        if (d > 0) { changed++; cells[Math.floor(y / GRID) * gw + Math.floor(x / GRID)] += d; }
        if (d > maxD) maxD = d;
        const v = Math.min(255, d * 8); // amplify: 0.72% at delta ~10 is invisible raw
        diff[i] = v; diff[i + 1] = v > 0 ? 255 - v : 0; diff[i + 2] = 0; diff[i + 3] = 255;
      }
    }
    const top = [...cells].map((v, i) => ({ v, gx: i % gw, gy: Math.floor(i / gw) }))
      .sort((p, q) => q.v - p.v).slice(0, 5)
      .map((c) => ({ weight: Math.round(c.v), cx: c.gx * GRID + GRID / 2, cyFromBottom: c.gy * GRID + GRID / 2 }));

    rt.dispose();
    return {
      W, H, control, restoreDiff, changed, maxD, matCount: mats.length,
      materialNames: [...names.entries()].sort((x, y) => y[1] - x[1]).slice(0, 12),
      topClusters: top,
      pngA: toPng(c2), pngB: toPng(b), pngD: toPng(diff),
    };
  }, scope);

  const dir = process.env.SHOT_DIR || "/mnt/wbterminal2/tmp/eyetest";
  fs.mkdirSync(dir, { recursive: true });
  const scope = process.env.SCOPE || "nonparticles";
  const all = [];
  for (const poi of POIS) {
    const st = await settleAt(page, poi, { log: (m) => console.error(`[eye] ${m}`), pinPose: POIS.length === 1 ? (process.env.PIN_POSE || null) : null });
    if (!st.settled) { console.error(`[eye] ${poi}: NOT settled — skipping (its numbers would not be a scene)`); continue; }
    const out = await measure(scope);
    fs.writeFileSync(`${dir}/${poi}-A-twopass.png`, Buffer.from(out.pngA, "base64"));
    fs.writeFileSync(`${dir}/${poi}-B-singlepass.png`, Buffer.from(out.pngB, "base64"));
    fs.writeFileSync(`${dir}/${poi}-D-diff-x8.png`, Buffer.from(out.pngD, "base64"));
    const pct = +(100 * out.changed / (out.W * out.H)).toFixed(3);
    // control/restoreDiff MUST both be 0 or this POI's diff is not attributable
    // to the render path and must not be counted.
    const valid = out.control === 0 && out.restoreDiff === 0;
    console.error(`[eye] ${poi.padEnd(12)} ${valid ? "valid" : "!! VOID (control " + out.control + "/" + out.restoreDiff + ")"}  mats=${out.matCount}  changed=${out.changed}px (${pct}%)  maxDelta=${out.maxD}`);
    console.error(`[eye]   top mats: ${out.materialNames.slice(0, 5).map(([n, c]) => `${n}x${c}`).join(", ")}`);
    all.push({ poi, valid, control: out.control, restoreDiff: out.restoreDiff, changed: out.changed, pct,
      maxD: out.maxD, matCount: out.matCount, materialNames: out.materialNames, topClusters: out.topClusters, settle: st.state });
  }

  console.error(`[eye] ==========================================================`);
  for (const r of all) console.error(`[eye] ${r.poi.padEnd(12)} ${String(r.pct).padStart(7)}% of pixels change (max delta ${r.maxD}) across ${r.matCount} materials`);
  console.error(`[eye] wrote ${dir}/<POI>-{A-twopass,B-singlepass,D-diff-x8}.png`);
  fs.writeFileSync(`${dir}/meta.json`, JSON.stringify({ gpu, scope, stops: all }, null, 2));
  await page.close();
  process.exit(0);
})();
