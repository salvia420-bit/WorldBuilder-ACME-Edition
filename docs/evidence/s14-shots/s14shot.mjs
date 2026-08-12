#!/usr/bin/env node
// s14shot.mjs — attach to the live S14 browser and capture the 3D layer.
//
// page.screenshot() photographs a BLACK world: the app renders ~20 passes into
// render targets and presents with ONE final pass to the default framebuffer, so
// any capture taken between frames reads the clear colour. Capture synchronously
// INSIDE that final present pass via readPixels. (Lifted from eyetest/arm.mjs.)
//
// usage: node s14shot.mjs <cdpPort> <outName> [hudAlso]
import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-core";

const PORT = Number(process.argv[2] || 9342);
const NAME = process.argv[3];
const HUD = process.argv[4] === "hud";
const OUT = "/home/wbterminal/fanout-s12/B/eyetest-B/out";
if (!NAME) { console.error("usage: node s14shot.mjs <port> <name> [hud]"); process.exit(1); }
fs.mkdirSync(OUT, { recursive: true });

const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
const page = (await browser.pages()).find((p) => !p.url().startsWith("about:")) || (await browser.pages())[0];

if (HUD) await page.screenshot({ path: path.join(OUT, `${NAME}-hud.png`), captureBeyondViewport: false });

const gl = await page.evaluate(() => new Promise((res) => {
  try {
    const ls = window.liveScene3d, r = ls && ls.renderer;
    if (!r) return res({ err: "no renderer" });
    const glc = r.getContext();
    const orig = r.render.bind(r);
    let calls = 0, done = false;
    const fin = (p) => { if (done) return; done = true; try { r.render = orig; } catch (_) {} res(p); };
    r.render = function (...a) {
      const out = orig(...a);
      calls++;
      if (done) return out;
      let tgt = "x";
      try { tgt = r.getRenderTarget(); } catch (_) {}
      if (tgt === null) {
        try {
          const W = glc.drawingBufferWidth, H = glc.drawingBufferHeight;
          const px = new Uint8Array(W * H * 4);
          glc.readPixels(0, 0, W, H, glc.RGBA, glc.UNSIGNED_BYTE, px);
          const cv = document.createElement("canvas");
          cv.width = W; cv.height = H;
          const cx = cv.getContext("2d");
          const img = cx.createImageData(W, H);
          for (let y = 0; y < H; y++) {            // GL is bottom-up
            const so = (H - 1 - y) * W * 4;
            img.data.set(px.subarray(so, so + W * 4), y * W * 4);
          }
          for (let i = 3; i < img.data.length; i += 4) img.data[i] = 255;
          cx.putImageData(img, 0, 0);
          let nb = 0, sum = 0; const d = img.data;
          for (let i = 0; i < d.length; i += 4) { const l = (d[i] + d[i + 1] + d[i + 2]) / 3; sum += l; if (l > 10) nb++; }
          fin({ dataUrl: cv.toDataURL("image/png"), w: W, h: H, presentCall: calls,
                nonBlackPct: +(100 * nb / (W * H)).toFixed(2), meanLuma: +(sum / (W * H)).toFixed(2) });
        } catch (e) { fin({ err: "capture threw: " + e.message }); }
      }
      return out;
    };
    setTimeout(() => fin({ err: "no present pass within 10s", calls }), 10000);
  } catch (e) { res({ err: String(e.message) }); }
}));

if (gl && gl.dataUrl) {
  const p = path.join(OUT, `${NAME}.png`);
  fs.writeFileSync(p, Buffer.from(gl.dataUrl.split(",")[1], "base64"));
  console.log(JSON.stringify({ path: p, w: gl.w, h: gl.h, nonBlackPct: gl.nonBlackPct, meanLuma: gl.meanLuma, presentCall: gl.presentCall }));
} else {
  console.log(JSON.stringify({ FAIL: gl }));
  process.exitCode = 4;
}
await browser.disconnect();
