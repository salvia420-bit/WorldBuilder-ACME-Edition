#!/usr/bin/env node
// white-texture-detector.mjs — catch S1 (intermittent flat-WHITE armor/body
// textures) in the act and attribute it.
//
// Classes (see A16-F1: the shared fallback is GREY 0x888888, NOT white):
//   shared-fallback   mesh wears materialCache.fallbackMaterial ("scene3d-fallback")
//                     = surface decode never landed for this DID (grey, not white)
//   no-map-white      real material, map===null, color ~white  → LIT FLAT WHITE (S1)
//   map-white-texels  DataTexture present but sampled texels ~all-white (S1: bad
//                     decode / palette produced white pixels)
//   map-not-uploadable map set but image missing/zero-dim (GL samples black)
//   emissive-white    emissive ~white with intensity ≥1 (VFX variant gone wrong)
//   textured-ok       everything else
//
// Texture sampling is CPU-side only: DataTexture.image.data (typed array) or a
// 2D-canvas draw for bitmap-backed maps. NO WebGL readback anywhere.
// Runs fine under ?nullRender=1 (materials exist without GPU renders).
//
// Usage (laptop):
//   node white-texture-detector.mjs [--duration 120] [--interval 5000]
//        [--telepoi "Holtburg"] [--query "extra=flags"] [--out out.json]
// Output: JSON to stdout/--out + trailing "WHITE-TEX SUMMARY: ..." line.

import { pathToFileURL } from "node:url";
import fs from "node:fs";

const BOOT_MJS = process.env.BOOT_MJS ||
  "/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/harness/lib/boot.mjs";

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] != null ? process.argv[i + 1] : dflt;
};
const DURATION_MS = Number(arg("duration", "120")) * 1000;
const INTERVAL_MS = Number(arg("interval", "5000"));
const TELEPOI = arg("telepoi", "");
const EXTRA_QUERY = arg("query", "");
const OUT = arg("out", "");

// ── in-page installer: window.__whiteTex = { scan, watch, stop, transitions } ──
// Self-contained (Playwright-serialized). Also paste-able into any devtools.
const installWhiteTex = () => {
  if (window.__whiteTex) return { ok: true, already: true };
  const WHITE8 = 245;            // texel channel threshold (0..255)
  const WHITEF = 0.9;            // material color channel threshold (0..1)
  const SAMPLES = 64;            // texels sampled per map
  let sampleCanvas = null;       // lazy 2D canvas for bitmap-backed maps

  const sampleTexture = (map) => {
    try {
      if (!map) return { kind: "none" };
      const img = map.image;
      if (!img || !(img.width > 0) || !(img.height > 0))
        return { kind: "not-uploadable" };
      let data = null, w = img.width, h = img.height;
      if (img.data && img.data.length >= w * h * 4) {
        data = img.data;                       // DataTexture — direct
      } else if (typeof document !== "undefined") {
        // ImageBitmap/canvas-backed — CPU 2D-canvas draw (no GL readback)
        if (!sampleCanvas) sampleCanvas = document.createElement("canvas");
        const sw = Math.min(w, 16), sh = Math.min(h, 16);
        sampleCanvas.width = sw; sampleCanvas.height = sh;
        const ctx = sampleCanvas.getContext("2d", { willReadFrequently: true });
        ctx.drawImage(img, 0, 0, sw, sh);
        data = ctx.getImageData(0, 0, sw, sh).data;
        w = sw; h = sh;
      }
      if (!data) return { kind: "unsampleable", w, h };
      const texels = (data.length / 4) | 0;
      const step = Math.max(1, Math.floor(texels / SAMPLES));
      let n = 0, white = 0, sum = 0, opaque = 0;
      for (let i = 0; i < texels; i += step) {
        const o = i * 4;
        const r = data[o], g = data[o + 1], b = data[o + 2], a = data[o + 3];
        n++;
        sum += (r + g + b) / 3;
        if (a >= 8) opaque++;
        if (r >= WHITE8 && g >= WHITE8 && b >= WHITE8) white++;
      }
      return {
        kind: "sampled", w, h, n,
        whiteFrac: n ? +(white / n).toFixed(3) : 0,
        avgLuma: n ? +(sum / n).toFixed(1) : 0,
        opaqueFrac: n ? +(opaque / n).toFixed(3) : 0,
      };
    } catch (e) {
      return { kind: "error", error: String((e && e.message) || e) };
    }
  };

  const classify = (mat) => {
    if (!mat) return { state: "no-material" };
    if (mat.name === "scene3d-fallback") return { state: "shared-fallback" };
    const c = mat.color;
    const colorWhite = !!(c && c.r >= WHITEF && c.g >= WHITEF && c.b >= WHITEF);
    const em = mat.emissive;
    const emissiveWhite = !!(em && em.r >= WHITEF && em.g >= WHITEF && em.b >= WHITEF
      && (mat.emissiveIntensity == null || mat.emissiveIntensity >= 1));
    const tex = sampleTexture(mat.map || null);
    let state;
    if (!mat.map) state = colorWhite ? "no-map-white" : "no-map-tinted";
    else if (tex.kind === "not-uploadable") state = "map-not-uploadable";
    else if (tex.kind === "sampled" && tex.whiteFrac >= 0.98 && tex.opaqueFrac > 0.5)
      state = "map-white-texels";
    else state = "textured-ok";
    if (emissiveWhite && state === "textured-ok") state = "emissive-white";
    return {
      state, colorWhite, emissiveWhite, tex,
      matName: mat.name || null, matUuid: mat.uuid,
      paletteKey: mat.userData && mat.userData.__paletteKey || null,
      vfxSetKey: mat.userData && mat.userData.__vfxSetKey || null,
      transparent: !!mat.transparent, opacity: mat.opacity,
    };
  };

  const scan = () => {
    const t = performance.now();
    const s3 = window.liveScene3d;
    const out = {
      t: +t.toFixed(0), ok: true, entityMeshes: 0,
      byState: {}, flagged: [],
      cache: null, sceneAvailable: !!(s3 && s3.scene),
    };
    try {
      const mc = s3 && s3.materialCache;
      if (mc) out.cache = {
        materials: mc.materials ? mc.materials.size : null,
        fallbackHits: mc.fallbackHits ?? null,
        realHits: mc.realHits ?? null,
        missingSurfaces: mc.missingSurfaces ? mc.missingSurfaces.size : null,
        pendingFetches: mc.pendingFetches ? mc.pendingFetches.size : null,
      };
    } catch (_) {}
    if (!out.sceneAvailable) { out.ok = false; return out; }
    s3.scene.traverse((o) => {
      const ud = o.userData;
      // entities.js:3654 convention — part meshes carry {guid, partIndex, surfaceDid}
      if (!o.isMesh || !ud || ud.guid == null || ud.surfaceDid == null) return;
      out.entityMeshes++;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const mat of mats) {
        const c = classify(mat);
        out.byState[c.state] = (out.byState[c.state] || 0) + 1;
        if (c.state !== "textured-ok" && c.state !== "no-map-tinted") {
          out.flagged.push({
            entityId: "0x" + (ud.guid >>> 0).toString(16).padStart(8, "0"),
            partName: o.name, partIndex: ud.partIndex,
            surfaceDid: "0x" + (ud.surfaceDid >>> 0).toString(16).padStart(8, "0"),
            visible: o.visible !== false,
            materialState: c.state,
            materialDetail: {
              matName: c.matName, paletteKey: c.paletteKey, vfxSetKey: c.vfxSetKey,
              colorWhite: c.colorWhite, emissiveWhite: c.emissiveWhite,
            },
            textureState: c.tex,
          });
        }
      }
    });
    return out;
  };

  // watch(): periodic scans + per-(entity,part) state-transition journal so an
  // intermittent white→ok (or ok→white) flip is captured WITH its timestamp.
  const wt = {
    snapshots: [], transitions: [], _last: new Map(), _timer: null,
    scan,
    watch(intervalMs) {
      wt.stop();
      wt._timer = setInterval(() => {
        try {
          const s = scan();
          wt.snapshots.push(s);
          if (wt.snapshots.length > 60) wt.snapshots.shift();
          const now = new Map();
          for (const f of s.flagged) now.set(f.entityId + "|" + f.partName, f.materialState);
          // ok→flagged and flagged-state changes
          for (const [k, st] of now) {
            const prev = wt._last.get(k) || "textured-ok";
            if (prev !== st) wt.transitions.push({ t: s.t, key: k, from: prev, to: st });
          }
          // flagged→ok recoveries
          for (const [k, prev] of wt._last) {
            if (!now.has(k)) wt.transitions.push({ t: s.t, key: k, from: prev, to: "textured-ok" });
          }
          if (wt.transitions.length > 500) wt.transitions.splice(0, wt.transitions.length - 500);
          wt._last = now;
        } catch (_) { /* a diagnostic must never break the frame */ }
      }, Math.max(1000, intervalMs || 5000));
      return { ok: true };
    },
    stop() { if (wt._timer) { clearInterval(wt._timer); wt._timer = null; } },
  };
  window.__whiteTex = wt;
  return { ok: true };
};

// ── driver ──
const boot = await import(pathToFileURL(BOOT_MJS).href);
const query = { nosw: "1" };
if (EXTRA_QUERY) for (const [k, v] of new URLSearchParams(EXTRA_QUERY)) query[k] = v;
const { page, helpers, inWorld } = await boot.launchAndEnter({ query, timeoutMs: 120_000 });
if (!inWorld) {
  console.log(JSON.stringify({ ok: false, reason: "boot-stalled" }));
  console.log("WHITE-TEX SUMMARY: SKIP boot-stalled");
  await helpers.close(); process.exit(2);
}
// liveScene3d appears ~35s after in-world on some routes — poll, don't assume.
for (let i = 0; i < 90; i++) {
  if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
  await page.waitForTimeout(1000);
}
if (TELEPOI) {
  await helpers.evalInPage((p) => { try { window.__sessionHandle.sendChat("@telepoi " + p); } catch (_) {} }, TELEPOI);
  await page.waitForTimeout(15_000);
  for (let i = 0; i < 30; i++) { // liveScene3d transiently nulled during teleport
    if (await helpers.evalInPage(() => !!(window.liveScene3d && window.liveScene3d.scene))) break;
    await page.waitForTimeout(1000);
  }
}
await helpers.evalInPage(installWhiteTex);
await helpers.evalInPage((ms) => window.__whiteTex.watch(ms), INTERVAL_MS);
await page.waitForTimeout(DURATION_MS);
const result = await helpers.evalInPage(() => {
  window.__whiteTex.stop();
  const finalScan = window.__whiteTex.scan();
  return { finalScan, transitions: window.__whiteTex.transitions,
           snapshotCount: window.__whiteTex.snapshots.length };
});
const errors = helpers.consoleErrors();
const payload = { ok: true, telepoi: TELEPOI || null, durationMs: DURATION_MS,
                  intervalMs: INTERVAL_MS, result, consoleErrorCount: errors.length,
                  consoleErrors: errors.slice(0, 20) };
const json = JSON.stringify(payload, null, 2);
if (OUT) fs.writeFileSync(OUT, json);
console.log(json);
const f = result.finalScan;
const whiteNow = (f.byState["no-map-white"] || 0) + (f.byState["map-white-texels"] || 0)
               + (f.byState["emissive-white"] || 0);
console.log(`WHITE-TEX SUMMARY: entityMeshes=${f.entityMeshes} whiteNow=${whiteNow} ` +
  `greyFallback=${f.byState["shared-fallback"] || 0} transitions=${result.transitions.length} ` +
  `fallbackHits=${f.cache && f.cache.fallbackHits} pending=${f.cache && f.cache.pendingFetches}`);
await helpers.close();
process.exit(whiteNow > 0 ? 1 : 0);
