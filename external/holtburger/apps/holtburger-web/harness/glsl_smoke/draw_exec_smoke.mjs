// harness/glsl_smoke/draw_exec_smoke.mjs — pixel check for `?drawExec` (scene3d/draw_exec.js,
// stage 3 S3.1) in a real WebGL2 stack: local headless Chromium (ANGLE / SwiftShader), three
// r184 from node_modules, the production renderer patches in index.js order, a 4x MSAA target,
// reversed-Z when SwiftShader exposes EXT_clip_control (the log buffer otherwise — reported).
// Arms `?drawExec=off` (the executor is not installed), `?drawExec=on&drawExecRigs=off`,
// `?drawExec=on&drawExecRuns=on&drawExecRigs=off` (S3.2 sentinel runs),
// `?drawExec=on&drawExecRuns=on&drawExecRigs=on` (S3.6 entity parts executed too) and the
// SHIPPED DEFAULT (no URL flags: ?drawExec and ?drawExecRigs are DEFAULT ON since 2026-10-26,
// runs off). Every non-default arm names every flag, so no arm rides a default by accident.
// After a warm-up that ends when a frame
// adds no async-link deferral, 8 read-back frames (camera moving) must be pixel-identical to
// the off arm (max channel diff 0), with gl.getError() === 0, no console / page errors, every
// program linked, and the executor must actually have executed draws (fast continuations AND
// state-only switches; the runs arm must have formed sentinel runs; the rigs arms must have
// executed the entity parts).
// NOT part of the node gate (it launches a browser — one heavy job at a time):
//
//   capped-build node harness/glsl_smoke/draw_exec_smoke.mjs
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require("/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules/playwright-core");
const HERE = dirname(fileURLToPath(import.meta.url));
const APP = join(HERE, "..", "..");

async function run(search) {
  const browser = await chromium.launch({ executablePath: "/usr/bin/chromium", headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 300)));
    await page.route("http://smoke.test/**", (route) => {
      const u = new URL(route.request().url());
      let file, type = "text/javascript";
      if (u.pathname === "/page.html") { file = join(HERE, "draw_exec_page.html"); type = "text/html"; }
      else if (u.pathname.startsWith("/three/")) file = join(APP, "node_modules/three/build", u.pathname.slice(7));
      else if (u.pathname.startsWith("/app/")) file = join(APP, u.pathname.slice(5));
      if (!file) return route.fulfill({ status: 404, body: "" });
      try { return route.fulfill({ status: 200, contentType: type, body: readFileSync(file) }); } catch (e) { return route.fulfill({ status: 404, body: String(e) }); }
    });
    await page.goto(`http://smoke.test/page.html${search}`);
    await page.waitForFunction(() => window.__smoke, null, { timeout: 180000 });
    const r = await page.evaluate(() => window.__smoke);
    r.pageErrors = pageErrors;
    return r;
  } finally { await browser.close(); }
}

const summary = (r) => ({
  flag: r.flag, installed: r.installed, depthMode: r.depthMode, reversedZ: r.reversedZ ?? null, glError: r.glError, warmFrames: r.warmFrames,
  frames: r.frames.map((f) => `${f.f}:${f.hash}:${f.lit}`).join(" "),
  dx: r.dx ? { draws: r.dx.draws, fast: r.dx.fast, stateOnly: r.dx.stateOnly, full: r.dx.full, passThrough: r.dx.passThrough, recorded: r.dx.recorded, vaoFixes: r.dx.vaoFixes, vaoFixLate: r.dx.vaoFixLate, vaoSuppressed: r.dx.vaoSuppressed, smSkips: r.dx.smSkips, runs: r.dx.runs, runItems: r.dx.runItems, errors: r.dx.errors, refused: r.dx.refused, invalid: r.dx.invalid } : null,
  deferredInReadback: r.deferredInReadback,
  runs: r.runs ? { draws: r.runs.draws, runs: r.runs.runs, sortedDraws: r.runs.sortedDraws } : null,
  programs: r.programs ? r.programs.length : 0, errors: r.errors, pageErrors: r.pageErrors, renderer: r.renderer,
});
const off = await run("?drawExec=off");
console.log("drawExec off:        ", JSON.stringify(summary(off)));
const on = await run("?drawExec=on&drawExecRigs=off&drawExecRuns=off");
console.log("drawExec on:         ", JSON.stringify(summary(on)));
const runs = await run("?drawExec=on&drawExecRuns=on&drawExecRigs=off");
console.log("drawExec on + runs:  ", JSON.stringify(summary(runs)), `sentinel runs ${runs.dx ? runs.dx.runs : 0} / items ${runs.dx ? runs.dx.runItems : 0}`);
const rigs = await run("?drawExec=on&drawExecRuns=on&drawExecRigs=on");
console.log("+ runs + rigs:       ", JSON.stringify(summary(rigs)));
const dflt = await run("");
console.log("default (no flags):  ", JSON.stringify(summary(dflt)));

const compare = (x, y, label) => {
  let maxDiff = 0, differing = 0, framesDiffer = 0;
  const n = Math.min(x.frames.length, y.frames.length);
  for (let i = 0; i < n; i++) if (x.frames[i].hash !== y.frames[i].hash) framesDiffer++;
  const a = x.frames.at(-1)?.data || [], b = y.frames.at(-1)?.data || [];
  for (let i = 0; i < Math.min(a.length, b.length); i++) { const d = Math.abs(a[i] - b[i]); if (d) differing++; if (d > maxDiff) maxDiff = d; }
  console.log(`${label}: frames compared ${n} (hash), ${framesDiffer} differ; last frame ${a.length / 4} px, max channel diff ${maxDiff}, channels differing ${differing}`);
  return n === 8 && x.frames.length === y.frames.length && framesDiffer === 0 && maxDiff === 0 && a.length > 0;
};
const linked = (r) => r.programs && r.programs.length >= 1 && r.programs.every((p) => p.linked);
const clean = (r) => r.errors.length === 0 && r.pageErrors.length === 0 && r.glError === 0 && linked(r);
// (vaoFixLate: a hand-over bind the setup hook missed, i.e. a program it never adopted — must stay 0)
const executed = (r) => r.dx && r.dx.fast > 0 && r.dx.stateOnly > 0 && r.dx.errors === 0 && r.dx.vaoFixLate === 0;
const okOn = compare(on, off, "on   vs off");
const okRuns = compare(runs, off, "runs vs off");
const okRigs = compare(rigs, off, "rigs vs off");
const okDflt = compare(dflt, off, "dflt vs off");
// the entity parts are executed under ?drawExecRigs (shares: the arms may warm up for different frame counts)
const passShare = (r) => r.dx.passThrough / Math.max(1, r.dx.draws);
const ok = off.flag === false && off.installed === false && on.flag === true && on.installed === true && runs.installed === true && rigs.installed === true
  && dflt.flag === true && dflt.installed === true
  && okOn && okRuns && okRigs && okDflt && on.frames.at(-1).lit > 1000
  && executed(on) && executed(runs) && executed(rigs) && executed(dflt) && runs.dx.runs > 0
  && passShare(rigs) < passShare(on) && passShare(dflt) < passShare(on)
  && dflt.dx.runs === 0 // ?drawExecRuns stays default off
  && clean(off) && clean(on) && clean(runs) && clean(rigs) && clean(dflt);
console.log(ok ? "PASS" : "FAIL");
process.exit(ok ? 0 : 1);
