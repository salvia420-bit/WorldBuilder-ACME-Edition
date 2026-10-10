#!/usr/bin/env node
// tools/particle-fx/preview.cjs — offline before/after renders of particle
// effects through the client's post chain (see preview.html). HEAVY job under
// the laptop rules: one headless Chromium tab (SwiftShader), check `free -m`,
// run capped:
//   PFX_WORK=<work dir with thumbs/ + emitters_ctx.json> \
//   capped-build node tools/particle-fx/preview.cjs <outDir> [--max=N] [--only=family,family]
// Writes <outDir>/<cell>.jpg (800×600) + <outDir>/manifest.json.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const APP = path.resolve(__dirname, "..", "..");
const WORK = process.env.PFX_WORK || path.join(__dirname, "work");
const OUT = path.resolve(process.argv[2] || path.join(WORK, "preview"));
const arg = (k) => (process.argv.find((a) => a.startsWith(`--${k}=`)) || "").split("=")[1];
const MAX = +(arg("max") || 0) || Infinity;
const ONLY = (arg("only") || "").split(",").filter(Boolean);
const K = +(arg("k") || 0) || 0;
const SKIP = (arg("skip") || "").split(",").filter(Boolean);
const ADDKS = (arg("addks") || "").split(",").filter(Boolean).map(Number);
const RES = (arg("res") || "800x600").split("x").map(Number);
const DIDS = new Set((arg("dids") || "").split(",").filter(Boolean).map((d) => d.toUpperCase().replace(/^0X/, "0x")));
fs.mkdirSync(OUT, { recursive: true });

const cat = JSON.parse(fs.readFileSync(path.join(APP, "data", "particle-fx-catalog.json"), "utf8"));
const recs = new Map(JSON.parse(fs.readFileSync(path.join(WORK, "emitters_ctx.json"), "utf8")).map((e) => [e.id >>> 0, e]));

const sid8 = (s) => (typeof s === "string" ? parseInt(s, 16) : s).toString(16).toUpperCase().padStart(8, "0");

function pojo(e) {
  return {
    id: e.id >>> 0, emitterType: e.emitterType, particleType: e.particleType, gfxObjId: e.gfxObj, hwGfxObjId: e.hwGfxObj || e.gfxObj,
    birthrate: e.birthrate, maxParticles: Math.min(e.maxParticles, 400), initialParticles: Math.min(e.initialParticles, 400),
    totalParticles: e.totalParticles, totalSeconds: e.totalSeconds, lifespan: e.lifespan, lifespanRand: e.lifespanRand,
    offsetDirX: e.offsetDir[0], offsetDirY: e.offsetDir[1], offsetDirZ: e.offsetDir[2], minOffset: e.minOffset, maxOffset: e.maxOffset,
    aX: e.A[0], aY: e.A[1], aZ: e.A[2], minA: e.minA, maxA: e.maxA,
    bX: e.B[0], bY: e.B[1], bZ: e.B[2], minB: e.minB, maxB: e.maxB,
    cX: e.C[0], cY: e.C[1], cZ: e.C[2], minC: e.minC, maxC: e.maxC,
    scaleRand: e.scaleRand, startScale: e.startScale, finalScale: e.finalScale,
    transRand: e.transRand, startTrans: e.startTrans, finalTrans: e.finalTrans, isParentLocal: !!e.isParentLocal,
  };
}
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

function framing(info, size, behavior) {
  const L = Math.max(0.05, info.lifespan);
  const q = Math.max(size[0], size[1], size[2]) || 0.3;
  const S = q * 0.5 * (clamp(info.startScale, 0.1, 10) + clamp(info.finalScale, 0.1, 10));
  const avgA = 0.5 * (info.minA + info.maxA), avgB = 0.5 * (info.minB + info.maxB);
  const vA = len([info.aX, info.aY, info.aZ]) * avgA;
  const vB = len([info.bX, info.bY, info.bZ]) * avgB;
  const pt = info.particleType;
  let E = Math.max(info.maxOffset, vA * L * 0.55, (pt === 5 ? len([info.cX, info.cY, info.cZ]) * 0.5 * (info.minC + info.maxC) : 0), S * 0.6);
  if ([3, 4, 8, 9, 10, 11].includes(pt)) E = Math.max(E, Math.min(vB * L * L * 0.25, 30));
  E = clamp(E, 0.25, 25);
  const vz = [2, 3, 4, 8, 9, 10, 11, 12].includes(pt) ? info.aZ * avgA : 0;
  const bz = [3, 4, 8, 9, 10, 11].includes(pt) ? info.bZ * avgB : 0;
  const tm = L * 0.45;
  const anchorZ = 1.0;
  const zc = anchorZ + clamp(vz * tm + 0.5 * bz * tm * tm, -E, 2 * E);
  const dist = clamp(E * 2.7 + 1.3, 2.2, 70);
  const persistent = info.totalParticles === 0 && info.totalSeconds === 0;
  let simSec = persistent ? clamp(L * 1.4, 1.2, 8) : (info.totalSeconds > 0 ? clamp(Math.min(info.totalSeconds, L) * 0.9, 0.2, 6) : clamp(L * 0.45, 0.15, 4));
  if (behavior === "burst" || behavior === "implode" || behavior === "flash") simSec = clamp(L * 0.35, 0.1, 3);
  let moveSpeed = 0, moveStart = 0, lookX = 0;
  if (info.emitterType === 2) { // per-metre trail: drag the parent past the camera
    simSec = clamp(L * 1.2, 0.8, 5);
    moveSpeed = 4;
    moveStart = -moveSpeed * simSec * 0.75;
    lookX = moveStart + moveSpeed * simSec * 0.6;
  }
  return { extent: E, anchorZ, cam: [lookX, -dist, Math.max(0.6, zc + dist * 0.22)], look: [lookX, 0, Math.max(0.3, zc)], simSec, moveSpeed, moveStart };
}

// ---- selection ---------------------------------------------------------------
const PRIORITY_TAGS = ["portal", "lifestone", "hearth", "chimney", "water", "celebration", "spell_projectile", "buff", "debuff", "splatter", "breath", "hit_spark", "appear"];
const fams = new Map();
for (const [did, e] of Object.entries(cat.emitters)) {
  if (["none", "misc", "sky"].includes(e.family)) continue;
  const r = recs.get(parseInt(did, 16) >>> 0);
  if (!r || !r.surface || !r.gfx || !r.gfx.size) continue;
  if (ONLY.length && !ONLY.includes(e.family)) continue;
  if (!fams.has(e.family)) fams.set(e.family, []);
  fams.get(e.family).push({ did, e, r });
}
const picks = [];
if (DIDS.size) {
  for (const items of fams.values()) for (const it of items) if (DIDS.has(it.did)) picks.push(it);
}
for (const [fam, items] of (DIDS.size ? [] : fams)) {
  const k = K || (items.length > 100 ? 5 : items.length > 30 ? 4 : items.length > 8 ? 3 : 2);
  items.sort((a, b) => (b.r.nCtx || 0) - (a.r.nCtx || 0));
  const chosen = [];
  const usedSurf = new Set(), usedBeh = new Set(), usedTag = new Set();
  const score = (it) => {
    let s = Math.log2(1 + (it.r.nCtx || 0));
    const tags = it.e.tags || [];
    for (const t of tags) if (PRIORITY_TAGS.includes(t) && !usedTag.has(t)) s += 3;
    if (!usedSurf.has(it.e.surface)) s += 4;
    if (!usedBeh.has(it.e.behavior)) s += 2;
    if (it.e.behavior === "standing" || it.e.behavior === "plume") s += 1;
    return s;
  };
  while (chosen.length < k && chosen.length < items.length) {
    let best = null, bs = -1;
    for (const it of items) { if (chosen.includes(it)) continue; const s = score(it); if (s > bs) { bs = s; best = it; } }
    chosen.push(best);
    usedSurf.add(best.e.surface); usedBeh.add(best.e.behavior);
    for (const t of best.e.tags || []) usedTag.add(t);
  }
  picks.push(...chosen);
}

const cells = [];
let seed = 1;
for (const p of picks.slice(0, MAX)) {
  const info = pojo(p.r);
  const fr = framing(info, p.r.gfx.size, p.e.behavior);
  const st = p.r.surface || {};
  for (const bg of ["day", "night"]) {
    const variants = [[false, null], ...(ADDKS.length ? ADDKS.map((k) => [true, k]) : [[true, null]])];
    for (const [fxOn, addK] of variants) {
      cells.push({
        kind: "emitter", key: `${p.did}_${bg}_${fxOn ? "fx" : "stock"}${addK != null ? "_K" + addK : ""}`, did: p.did, family: p.e.family, behavior: p.e.behavior,
        note: p.e.note, tags: p.e.tags, params: p.e.params, ctx: (p.r.ctx || []).slice(0, 2),
        surface: sid8(p.e.surface), surfaceType: st.type >>> 0, additive: !!((st.type >>> 0) & 0x10000),
        gfxSize: p.r.gfx.size, uvBounds: p.r.gfx.uvBounds, info, bg, fx: fxOn, addK, seed, ...fr,
      });
    }
  }
  seed++;
}

// synthesized emitters (POJOs mirror the component defaults; gfx sizes from the DAT)
const SYN = [
  { name: "particle.gemSparkle", surface: "080002F0", type: 0x10102, size: [0.294, 0, 0.294], info: { id: 0, fxProfile: "particle.gemSparkle", emitterType: 1, particleType: 1, birthrate: 0.45, maxParticles: 4, initialParticles: 2, lifespan: 1.3, lifespanRand: 0.4, maxOffset: 0.05, startScale: 0.45, finalScale: 0.15, startTrans: 0, finalTrans: 1 }, sim: 2.5 },
  { name: "particle.brazierEmbers.ember", surface: "08000041", type: 0x10102, size: [1.1, 0, 1.1], info: { id: 0, fxProfile: "particle.brazierEmbers.ember", emitterType: 1, particleType: 2, birthrate: 0.06, maxParticles: 24, initialParticles: 6, lifespan: 1.1, lifespanRand: 0.4, maxOffset: 0.1, aZ: 1, minA: 0.9, maxA: 0.9, startScale: 0.07, finalScale: 0.015, scaleRand: 0.02, startTrans: 0, finalTrans: 1 }, sim: 2.5 },
  { name: "particle.brazierEmbers.smoke", surface: "080000E6", type: 0x102, size: [1.45, 0, 1.4], info: { id: 0, fxProfile: "particle.brazierEmbers.smoke", emitterType: 1, particleType: 2, birthrate: 0.5, maxParticles: 12, initialParticles: 2, lifespan: 3, lifespanRand: 0.8, maxOffset: 0.1, aZ: 1, minA: 0.4, maxA: 0.4, startScale: 0.08, finalScale: 0.34, startTrans: 0, finalTrans: 1 }, sim: 4 },
  { name: "terrain.volcanoEmbers.ember", surface: "08000041", type: 0x10102, size: [1.1, 0, 1.1], info: { id: 0, fxProfile: "terrain.volcanoEmbers.ember", emitterType: 1, particleType: 2, birthrate: 0.09, maxParticles: 36, initialParticles: 10, lifespan: 2.4, lifespanRand: 0.9, maxOffset: 1, aZ: 1, minA: 1.6, maxA: 1.6, startScale: 0.22, finalScale: 0.04, scaleRand: 0.06, startTrans: 0, finalTrans: 1 }, sim: 3 },
  { name: "terrain.volcanoEmbers.smoke", surface: "080000E6", type: 0x102, size: [1.45, 0, 1.4], info: { id: 0, fxProfile: "terrain.volcanoEmbers.smoke", emitterType: 1, particleType: 2, birthrate: 0.7, maxParticles: 14, initialParticles: 3, lifespan: 5, lifespanRand: 1.6, maxOffset: 1, aZ: 1, minA: 0.7, maxA: 0.7, startScale: 0.4, finalScale: 2.2, startTrans: 0, finalTrans: 1 }, sim: 6 },
  { name: "particle.foliagePollen", surface: "080002E9", type: 0x10102, size: [0.294, 0, 0.294], info: { id: 0xF0E00001, emitterType: 1, particleType: 2, birthrate: 0.7, maxParticles: 12, initialParticles: 4, lifespan: 8, lifespanRand: 2, maxOffset: 1.2, aY: 0.05, minA: 0.4, maxA: 1.2, scaleRand: 0.15, startScale: 0.5, finalScale: 0.32, transRand: 0.1, startTrans: 0.25, finalTrans: 1 }, sim: 6 },
  { name: "particle.foliageFireflies", surface: "08000163", type: 0x10102, size: [1.74, 0, 2.38], info: { id: 0xF0E00002, emitterType: 1, particleType: 5, birthrate: 1.1, maxParticles: 8, initialParticles: 3, lifespan: 4.5, lifespanRand: 1.5, maxOffset: 1.5, aY: 0.02, minA: 0.3, maxA: 0.9, bX: 0.9, bY: 1.3, bZ: 0.7, minB: 0.6, maxB: 1.4, cX: 0.25, cY: 0.18, cZ: 0.25, minC: 0.5, maxC: 1, scaleRand: 0.1, startScale: 0.22, finalScale: 0.22, transRand: 0.2, startTrans: 0.15, finalTrans: 1 }, sim: 5, bg: ["night"] },
  { name: "particle.foliageLeaves", surface: "08000C66", type: 0x104, size: [0.316, 0, 0.196], uvb: [0.694, 0.898, 2.306, 1.898], info: { id: 0xF0E00003, emitterType: 1, particleType: 4, birthrate: 0.9, maxParticles: 16, initialParticles: 0, lifespan: 6, lifespanRand: 1.5, maxOffset: 1.5, aX: 0.15, aZ: 0.15, minA: 0.4, maxA: 1, bZ: -0.45, minB: 0.7, maxB: 1.2, cX: 0.2, cY: 0.2, minC: 0.5, maxC: 1, scaleRand: 0.2, startScale: 0.9, finalScale: 0.9, startTrans: 0, finalTrans: 1 }, sim: 7, anchorZ: 3.5 },
  { name: "particle.breathFog", surface: "080002E9", type: 0x10102, size: [0.294, 0, 0.294], info: { id: 0xF0E00004, emitterType: 1, particleType: 2, birthrate: 0.45, maxParticles: 5, initialParticles: 1, lifespan: 1.6, lifespanRand: 0.5, maxOffset: 0.05, aY: -1, aZ: 0.2, minA: 0.3, maxA: 0.6, scaleRand: 0.15, startScale: 0.35, finalScale: 1.3, transRand: 0.1, startTrans: 0.35, finalTrans: 1 }, sim: 2.5 },
  { name: "terrain.sandDevils", surface: "080002E9", type: 0x10102, size: [0.294, 0, 0.294], info: { id: 0xF0E00010, emitterType: 1, particleType: 5, birthrate: 0.12, maxParticles: 40, initialParticles: 10, lifespan: 5, lifespanRand: 1.5, maxOffset: 0.6, aZ: 1, minA: 0.6, maxA: 1.2, bX: 2.0, bY: 2.0, bZ: 0, minB: 0.8, maxB: 1.2, cX: 0.6, cY: 0.6, cZ: 0, minC: 0.6, maxC: 1.0, scaleRand: 0.25, startScale: 0.6, finalScale: 1.9, transRand: 0.15, startTrans: 0.45, finalTrans: 1 }, sim: 5 },
  { name: "terrain.swampMidges", surface: "080000E6", type: 0x102, size: [1.45, 0, 1.4], info: { id: 0xF0E00021, emitterType: 1, particleType: 2, birthrate: 0.7, maxParticles: 12, initialParticles: 4, lifespan: 8, lifespanRand: 2, maxOffset: 1.0, aY: 0.01, minA: 0.1, maxA: 0.35, scaleRand: 0.15, startScale: 0.5, finalScale: 0.32, startTrans: 0.25, finalTrans: 1 }, sim: 6 },
  { name: "terrain.marshGas.bubble", surface: "080002E9", type: 0x10102, size: [0.294, 0, 0.294], info: { id: 0xF0E00022, emitterType: 1, particleType: 2, birthrate: 1.7, maxParticles: 6, initialParticles: 2, lifespan: 3.6, lifespanRand: 1.2, maxOffset: 0.4, aZ: 1, minA: 0.5, maxA: 1.3, startScale: 0.16, finalScale: 0.5, scaleRand: 0.2, startTrans: 0.55, finalTrans: 1, transRand: 0.15 }, sim: 5, anchorZ: 0.2 },
  { name: "terrain.marshGas.wisp", surface: "08000072", type: 0x10102, size: [1.45, 0, 0.9], info: { id: 0xF0E00023, emitterType: 1, particleType: 2, birthrate: 0.22, maxParticles: 8, initialParticles: 3, lifespan: 1.5, lifespanRand: 0.4, maxOffset: 0.3, aZ: 1, minA: 0.6, maxA: 1.2, startScale: 0.35, finalScale: 1.5, scaleRand: 0.15, startTrans: 0.1, finalTrans: 1, transRand: 0.1 }, sim: 2.5, anchorZ: 0.3 },
];
const ZERO = { gfxObjId: 0, totalParticles: 0, totalSeconds: 0, offsetDirX: 0, offsetDirY: 0, offsetDirZ: 0, minOffset: 0, aX: 0, aY: 0, aZ: 0, minA: 1, maxA: 1, bX: 0, bY: 0, bZ: 0, minB: 1, maxB: 1, cX: 0, cY: 0, cZ: 0, minC: 1, maxC: 1, scaleRand: 0, transRand: 0, lifespanRand: 0, isParentLocal: false };
if ((!ONLY.length || ONLY.includes("synth")) && !SKIP.includes("synth")) {
  for (const s of SYN) {
    const info = { ...ZERO, hwGfxObjId: 1, ...s.info };
    const fr = framing(info, s.size, "standing");
    fr.simSec = s.sim;
    if (s.anchorZ != null) { fr.anchorZ = s.anchorZ; fr.look[2] = Math.max(0.3, s.anchorZ + (fr.look[2] - 1)); fr.cam[2] = fr.look[2] + 0.22 * Math.abs(fr.cam[1]); }
    const syn = cat.synthesized[s.name] || {};
    for (const bg of s.bg || ["day", "night"]) {
      for (const fxOn of [false, true]) {
        cells.push({
          kind: "emitter", key: `${s.name}_${bg}_${fxOn ? "fx" : "stock"}`, did: s.name, family: syn.family, behavior: "synthesized",
          note: syn.note, params: syn.params, ctx: [syn.sprite || ""], surface: s.surface, surfaceType: s.type,
          additive: !!(s.type & 0x10000), gfxSize: s.size, uvBounds: s.uvb || [0, 0, 1, 1], info, bg, fx: fxOn, seed: seed, ...fr,
        });
      }
      seed++;
    }
  }
}

// placeholder bursts
const BURST = {
  launch: [0x4abcff, 0, 0.6], explode: [0xffa733, 0, 1.0], projectileCollision: [0xffbb44, 0, 0.6], fizzle: [0x808080, 0, 0.45],
  splatter: [0xff3030, 0, 0.4], splatterCrit: [0xff4a3a, 0, 0.55], spark: [0xffffff, 0, 0.25], healthUp: [0x40ff80, 0, 0.6],
  healthDown: [0xa03030, 0, 0.6], regenUp: [0x66ee99, 0, 0.35], regenDown: [0x884444, 0, 0.35], swapHealth: [0xff44dd, 1, 1.2],
  shield: [0x4080ff, 1, 1.3], attribUp: [0xc8ff44, 0, 0.6], attribDown: [0xff6633, 0, 0.6], skillUp: [0xc8ff44, 2, 0.5],
  skillDown: [0xff6633, 2, 0.5], enchantUp: [0xffd966, 0, 0.55], enchantDown: [0x9966dd, 0, 0.55], dispel: [0xaa99cc, 1, 0.9],
  vitaeUp: [0xffffff, 0, 0.9], vitaeDown: [0x111133, 0, 0.9], death: [0x6b1a8a, 0, 1.2], create: [0xeeffff, 0, 1.0],
  hide: [0x666666, 0, 0.6], portal: [0xcc44ff, 0, 1.4], portalStorm: [0xffffff, 0, 1.2], camping: [0x88ddff, 0, 0.8],
  layingOfHands: [0x88ddff, 0, 0.9], breatheFlame: [0xff7733, 0, 0.9], breatheFrost: [0x66ddff, 0, 0.9], breatheAcid: [0x77ff44, 0, 0.9],
  breatheLightning: [0xddeeff, 0, 0.9], specialState: [0x66dddd, 0, 0.35], specialStateBlack: [0x222222, 0, 0.35],
  levelUp: [0xffcc33, 0, 1.5], augmentation: [0xffcc33, 0, 1.1], aetheria: [0x4488ff, 0, 0.7], restriction: [0x4488ff, 0, 0.7],
  wedding: [0xff66cc, 0, 1.0], bunnySmite: [0xff99cc, 0, 0.7], baelZharonSmite: [0x661133, 0, 1.4], blackMadness: [0x331144, 0, 0.8],
  dirtyFighting: [0x884444, 2, 0.5], default: [0xffffff, 0, 0.6],
};
if ((!ONLY.length || ONLY.includes("bursts")) && !SKIP.includes("bursts")) {
  for (const [look, [color, shape, scale]] of Object.entries(BURST)) {
    for (const fxOn of [false, true]) {
      cells.push({ kind: "burst", key: `burst_${look}_${fxOn ? "fx" : "stock"}`, look, color, shape, scale, age: 0.35, bg: "night", fx: fxOn });
    }
  }
}

// ---- serve + drive ---------------------------------------------------------------
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".png": "image/png", ".cjs": "text/javascript" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let file;
  if (url.startsWith("/work/")) file = path.normalize(path.join(WORK, url.slice(6)));
  else file = path.normalize(path.join(APP, url));
  if (!file.startsWith(APP) && !file.startsWith(WORK)) { res.writeHead(403); res.end(); return; }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream" });
    res.end(data);
  });
});

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  const { chromium } = require(path.join(APP, "node_modules", "playwright-core"));
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM || "/usr/bin/chromium", headless: true,
    args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--mute-audio", "--no-first-run", "--disable-extensions"],
  });
  const manifest = [];
  let code = 0;
  try {
    const page = await browser.newPage({ viewport: { width: RES[0] + 20, height: RES[1] + 20 } });
    const logs = [];
    page.on("console", (m) => { if (m.type() === "error") logs.push(m.text()); });
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.goto(`http://127.0.0.1:${port}/tools/particle-fx/preview.html?w=${RES[0]}&h=${RES[1]}`);
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
    console.log(`[preview] ${cells.length} cells (${picks.length} retail emitters)`);
    let i = 0;
    for (const c of cells) {
      i++;
      const fn = c.kind === "burst" ? "__renderBurst" : "__renderEmitter";
      let r;
      try {
        r = await page.evaluate(([f, cell]) => window[f](cell), [fn, c]);
      } catch (e) {
        console.log(`  cell ${c.key} failed: ${e.message}`);
        continue;
      }
      const b64 = r.img.split(",")[1];
      const file = `${c.key.replace(/[^A-Za-z0-9_.-]/g, "_")}.jpg`;
      fs.writeFileSync(path.join(OUT, file), Buffer.from(b64, "base64"));
      const { info, ...meta } = c;
      manifest.push({ ...meta, file });
      if (i % 40 === 0) console.log(`  ${i}/${cells.length}`);
    }
    const errs = await page.evaluate(() => window.__errors());
    if (errs.length) { console.log("SHADER ERRORS:", errs.slice(0, 3)); code = 1; }
    if (logs.length) console.log("console errors:", logs.slice(0, 10));
  } catch (e) {
    console.error(e); code = 1;
  } finally {
    fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 0));
    await browser.close();
    server.close();
  }
  console.log(`[preview] wrote ${manifest.length} images to ${OUT}`);
  process.exit(code);
})();
