#!/usr/bin/env node
// tools/bake-windclips.mjs — P4.3 tree-wind clip PRODUCER (Phase-4, 2026-06-26).
//
// Bakes the per-DID `windclip` sidecars the runtime `?treeWind=on` peel path
// (statics.js → animated_scenery.js attachWindTrees) consumes. Each artifact is
// the RAW `WindClip::encode_payload()` byte stream (num_parts at offset 0) — NOT
// a SuiteBlob "HSB1" container: `fetch_suite_artifact` returns the file verbatim
// and the JS decoder in suite_assets.js reads num_parts at byte 0, so writing a
// container here would make it parse 'HSB1' as num_parts → overflow → null →
// silent frozen fallback. We therefore emit encode_payload()'s exact framing.
//
// ── BYTE-IDENTITY-BY-CONSTRUCTION (the whole point) ──────────────────────────
// The clip frames are produced by the UNCHANGED in-page wind_rig.js
// `buildBboxRig` → `buildTreeWindClip` running inside the page's V8 + the page's
// initialized wasm singleton, then byte-copied (DataView.setFloat32 LE) into the
// payload. Node never re-derives a single sin/cos — it only base64-shuttles the
// bytes V8 packed and writes them. The rig + every bucket frame is therefore the
// exact float the runtime's getOrCreateWindGroup would build, bit-for-bit.
//
// ── FIREWALL / DETERMINISM ───────────────────────────────────────────────────
//   * PER-DID keyed (one .bin per SetupModel DID on the tree_wind.js allowlist).
//   * No live input baked: clip = geometry + DEFAULT wind params only
//     (dirDeg 135 / strength 1 / fps 30 / loopSeconds 4 / ampDeg 7 /
//      cycles1 3 / cycles2 11 / flutter 0.3). Weather, creature-part frames and
//     camera stay 100% runtime. light-count delta == 0 (deformation.windBend).
//   * Reproducible: the bake runs TWICE in-page and asserts byte-identical
//     payloads per DID before writing (A.5 determinism gate, gate 3).
//   * In-page round-trip: the packed bytes are decoded back through the
//     REGISTERED windclip decoder (suite_assets.js) and asserted bit-equal
//     (Uint32 views, not float ===) to the golden frames + rig (A.5 gate 1).
//
// The pkg/ singleton TRAP (probe-confirmed): a bare
// `import("/apps/holtburger-web/pkg/holtburger_web.js")` returns a SECOND,
// uninitialized wasm-bindgen instance and every wasm call throws. The page
// initializes the module under a cache-bust query URL
// (`./pkg/holtburger_web.js?v=…`), and ES modules are keyed by FULL resolved URL
// incl. query, so ONLY that href holds the initialized singleton. We resolve it
// from the DOM modulepreload link and import THAT exact href.
//
// Artifacts → ${HOLTBURGER_DIST:-/mnt/wbterminal2/holtburger-dist}/suite/  (the
// external/holtburger/dist symlink target) — NEVER inside the git repo.
//
// USAGE
//   node tools/bake-windclips.mjs            # bake every allowlist DID
//   node tools/bake-windclips.mjs --list     # dry: print the DIDs it WILL bake (no chromium, no writes)
//   node tools/bake-windclips.mjs --help     # this help
//   node tools/bake-windclips.mjs --did 0x02001063,0x02000258   # subset (allowlist-only)
//
// GATE: `node --check tools/bake-windclips.mjs` + `--list` self-describe.

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";

import { loadChromium, probeServer, SERVER_BASE } from "../harness/lib/boot.mjs";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = "/home/wbterminal/WorldBuilder-ACME-Edition";

// ── constants (must mirror the runtime; see windBend.defaults + attachWindTrees) ──
const K_BUCKETS = 4; // live phase-bucket count (attachWindTrees opts.phaseBuckets || 4)
const WIND_PARAMS = Object.freeze({
  dirDeg: 135,
  strength: 1,
  // The rest fall back to buildTreeWindClip's internal defaults (single source
  // of truth, windBend.defaults). Recorded here only for the manifest line.
  fps: 30,
  loopSeconds: 4,
  ampDeg: 7,
  cycles1: 3,
  cycles2: 11,
  flutter: 0.3,
});

const APP_BASE = SERVER_BASE; // http://127.0.0.1:8765/apps/holtburger-web/
const LOGIN_URL = APP_BASE + "index.html?nosw=1&nohealth=1";
const SCENE = "/apps/holtburger-web/scene3d";

const OUT_ROOT = process.env.HOLTBURGER_DIST || "/mnt/wbterminal2/holtburger-dist";
const OUT_DIR = path.join(OUT_ROOT, "suite");

// ── helpers (Node) ───────────────────────────────────────────────────────────
function didHex(did) {
  return "0x" + ((did >>> 0).toString(16).toUpperCase().padStart(8, "0"));
}
function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

// FNV-1a/64 over header ints + every f32 folded as `Lossless` bits (raw to_bits,
// -0.0 → +0.0). Byte-for-byte mirror of holtburger-suite-bake windclip::fingerprint
// (the `windclip-hash` sidecar value) so a Rust cross-check matches.
const FNV1A_OFFSET = 0xcbf29ce484222325n;
const FNV1A_PRIME = 0x00000100000001b3n;
const MASK64 = (1n << 64n) - 1n;
const _fbuf = new ArrayBuffer(4);
const _f32 = new Float32Array(_fbuf);
const _u32 = new Uint32Array(_fbuf);
function f32CanonBits(v) {
  // Collapse both zero encodings so -0.0 hashes identically to +0.0 (Lossless).
  if (v === 0) v = 0;
  _f32[0] = v;
  return _u32[0] >>> 0;
}
function fnv1aFold(h, word) {
  let w = word >>> 0;
  for (let i = 0; i < 4; i++) {
    const byte = BigInt((w >>> (i * 8)) & 0xff); // to_le_bytes: low byte first
    h = ((h ^ byte) * FNV1A_PRIME) & MASK64;
  }
  return h;
}
/** Recompute the windclip-hash from the on-disk payload bytes (no float re-derive). */
function fingerprintWindclip(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const numParts = dv.getUint32(0, true);
  const numFrames = dv.getUint32(4, true);
  const k = dv.getUint32(8, true);
  const fps = dv.getFloat32(12, true);
  let h = FNV1A_OFFSET;
  h = fnv1aFold(h, numParts);
  h = fnv1aFold(h, numFrames);
  h = fnv1aFold(h, k);
  h = fnv1aFold(h, f32CanonBits(fps));
  const ff = numFrames * numParts * 7;
  let o = 16;
  for (let b = 0; b < k; b++) {
    for (let i = 0; i < ff; i++, o += 4) h = fnv1aFold(h, f32CanonBits(dv.getFloat32(o, true)));
  }
  for (let p = 0; p < numParts; p++) {
    for (let i = 0; i < 11; i++, o += 4) h = fnv1aFold(h, f32CanonBits(dv.getFloat32(o, true)));
  }
  return h.toString(16).padStart(16, "0");
}

function gitCommit() {
  try {
    return execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch (_) {
    return "unknown";
  }
}

function parseArgs(argv) {
  const out = { help: false, list: false, dids: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") out.help = true;
    else if (a === "--list") out.list = true;
    else if (a === "--did" || a === "--dids") {
      const v = argv[++i] || "";
      out.dids = v
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((s) => (s.startsWith("0x") || s.startsWith("0X") ? parseInt(s, 16) : parseInt(s, 10)) >>> 0);
    } else if (a.startsWith("--did=")) {
      out.dids = a
        .slice(6)
        .split(/[\s,]+/)
        .filter(Boolean)
        .map((s) => (s.startsWith("0x") || s.startsWith("0X") ? parseInt(s, 16) : parseInt(s, 10)) >>> 0);
    }
  }
  return out;
}

const HELP = `bake-windclips.mjs — P4.3 per-DID tree-wind clip producer

  node tools/bake-windclips.mjs            bake every tree_wind.js allowlist DID
  node tools/bake-windclips.mjs --list     print the DIDs that WOULD be baked (no chromium, no writes)
  node tools/bake-windclips.mjs --did A,B  bake a subset (allowlist-only)
  node tools/bake-windclips.mjs --help     this help

  K (phase buckets) = ${K_BUCKETS}
  wind params       = dirDeg ${WIND_PARAMS.dirDeg}, strength ${WIND_PARAMS.strength}, fps ${WIND_PARAMS.fps}, loopSeconds ${WIND_PARAMS.loopSeconds}, ampDeg ${WIND_PARAMS.ampDeg}, cycles1 ${WIND_PARAMS.cycles1}, cycles2 ${WIND_PARAMS.cycles2}, flutter ${WIND_PARAMS.flutter}
  app base          = ${APP_BASE}
  out dir           = ${OUT_DIR}

  Pack layout (RAW WindClip::encode_payload, all little-endian):
    off 0   u32  num_parts
    off 4   u32  num_frames
    off 8   u32  k                        (= ${K_BUCKETS})
    off 12  f32  fps                      (= ${WIND_PARAMS.fps})
    off 16  k bucket-major blocks, each num_frames*num_parts*7 f32, FRAME-MAJOR
              frames[(f*num_parts + p)*7 + 0..6] = [ox,oy,oz, qw,qx,qy,qz]  (AC wxyz)
    off 16+k*BS  num_parts rig records, 11 f32 each   (BS = num_frames*num_parts*7*4)
              pivot.x,y,z, weight, rest_o.x,y,z, rest_q.w,x,y,z
    total = 16 + k*num_frames*num_parts*7*4 + num_parts*44
`;

// ── the in-page bake (serialized to V8; must be self-contained) ──────────────
// Returns { ok, skipped, reason, partCount, numFrames, fps, k, b64, verify }.
// Runs the UNCHANGED buildBboxRig→buildTreeWindClip and byte-packs LE in-page.
async function bakeOneInPage({ href, did, K, scene, dirDeg, strength }) {
  const FPP = 7; // floats per part per frame [ox,oy,oz, qw,qx,qy,qz]
  const RIGF = 11; // floats per rig record
  try {
    const mod = await import(href); // initialized singleton (DO NOT bare-import)
    if (typeof mod.fetchBuildingPlacement !== "function") {
      return { ok: false, skipped: true, reason: "pkg-missing-fetchBuildingPlacement" };
    }

    // (b) placement → part meshes + hinge frames (ORDER: meshes, then hinge, then free)
    let bundle;
    try {
      bundle = await mod.fetchBuildingPlacement(did >>> 0);
    } catch (e) {
      return { ok: false, skipped: true, reason: "fetchBuildingPlacement-threw:" + (e && e.message) };
    }
    const partCount = bundle.partCount | 0;
    if (partCount === 0) {
      bundle.free?.();
      return { ok: false, skipped: true, reason: "partCount==0" };
    }
    const partMeshes = bundle.takePartMeshes();
    const hinge = typeof bundle.takePartHingeFrames === "function" ? bundle.takePartHingeFrames() : [];
    bundle.free?.(); // hinge structs survive free

    // (d) gate inputs from canonical scene3d modules
    const ad = await import(scene + "/adapter.js");
    const bw = await import(scene + "/bake_worker_client.js");
    const st = await import(scene + "/statics.js");
    const wr = await import(scene + "/wind_rig.js");
    const materialCache = st.getOrCreateMaterialCache({ wasmExports: mod });
    const spFetch = bw.surfacePixelsFetcher(mod);

    // (e) R4 material-gated part-box build — VERBATIM to buildOneWind:447-483.
    const unionBox = (a, b) => ({
      minX: Math.min(a.minX, b.minX), minY: Math.min(a.minY, b.minY), minZ: Math.min(a.minZ, b.minZ),
      maxX: Math.max(a.maxX, b.maxX), maxY: Math.max(a.maxY, b.maxY), maxZ: Math.max(a.maxZ, b.maxZ),
      cx: 0, cy: 0, cz: 0,
    });
    const partBoxes = [];
    let groupsSeen = 0;
    let matMisses = 0;
    for (let i = 0; i < partCount; i++) {
      let localBox = null;
      const wasmMesh = partMeshes[i];
      if (wasmMesh) {
        try {
          const { groups, surfaceDids } = ad.meshToGeometryGroups(wasmMesh);
          for (let g = 0; g < (groups?.length || 0); g++) {
            const grp = groups[g];
            const sid = grp.surfaceDid || surfaceDids?.[g] || 0;
            groupsSeen += 1;
            // eslint-disable-next-line no-await-in-loop
            const mat = await materialCache.get(sid, spFetch);
            if (!mat) matMisses += 1;
            if (grp.geometry && mat) {
              const pos = grp.geometry.getAttribute?.("position")?.array;
              if (pos && pos.length) {
                const bb = wr.partBBox(pos);
                localBox = localBox ? unionBox(localBox, bb) : bb;
              }
            }
          }
        } catch (e) {
          return { ok: false, skipped: true, reason: "mesh-build-threw:" + (e && e.message) };
        }
        wasmMesh.free?.();
      }
      if (localBox) {
        localBox.cx = (localBox.minX + localBox.maxX) / 2;
        localBox.cy = (localBox.minY + localBox.maxY) / 2;
        localBox.cz = (localBox.minZ + localBox.maxZ) / 2;
      }
      partBoxes.push(localBox || wr.partBBox(null));
    }
    // PER-DID material gate: every group must resolve a material, else SKIP (ship
    // nothing → peel keeps the tree frozen). matMisses>0 ⇒ a surface failed to load.
    if (matMisses > 0) {
      return { ok: false, skipped: true, reason: `surface-load-failed:${matMisses}/${groupsSeen} groups` };
    }

    // (f) rig — EXACTLY buildOneWind's call.
    const rig = wr.buildBboxRig(partBoxes, hinge).rigs;

    // (g) K phase buckets via the UNCHANGED buildTreeWindClip; keep goldens for verify.
    const goldens = [];
    let numFrames = 0;
    let fps = 0;
    for (let b = 0; b < K; b++) {
      const clip = wr.buildTreeWindClip(partCount, rig, {
        dirDeg,
        strength,
        phaseOffset: (b / K) * 2 * Math.PI,
      });
      if (b === 0) {
        numFrames = clip.numFrames;
        fps = clip.fps;
      }
      goldens.push(clip.frames); // Float32Array, frame-major [(f*numParts+p)*7+c]
    }

    // pack RAW encode_payload() LE in-page (memcpy — NO Node re-derive).
    const ff = numFrames * partCount * FPP; // floats / bucket
    const bs = ff * 4;
    const total = 16 + K * bs + partCount * RIGF * 4;
    const out = new Uint8Array(total);
    const dv = new DataView(out.buffer);
    dv.setUint32(0, partCount >>> 0, true);
    dv.setUint32(4, numFrames >>> 0, true);
    dv.setUint32(8, K >>> 0, true);
    dv.setFloat32(12, fps, true);
    let off = 16;
    for (let b = 0; b < K; b++) {
      const fr = goldens[b];
      for (let i = 0; i < ff; i++, off += 4) dv.setFloat32(off, fr[i], true);
    }
    for (let p = 0; p < partCount; p++) {
      const r = rig[p];
      const piv = r.pivot, ro = r.rest.o, rq = r.rest.q;
      dv.setFloat32(off, piv.x, true); off += 4;
      dv.setFloat32(off, piv.y, true); off += 4;
      dv.setFloat32(off, piv.z, true); off += 4;
      dv.setFloat32(off, r.weight, true); off += 4;
      dv.setFloat32(off, ro.x, true); off += 4;
      dv.setFloat32(off, ro.y, true); off += 4;
      dv.setFloat32(off, ro.z, true); off += 4;
      dv.setFloat32(off, rq[0], true); off += 4;
      dv.setFloat32(off, rq[1], true); off += 4;
      dv.setFloat32(off, rq[2], true); off += 4;
      dv.setFloat32(off, rq[3], true); off += 4;
    }

    // (h) IN-PAGE ROUND-TRIP VERIFY (A.5 gate 1) — through the REGISTERED windclip
    // decoder (suite_assets.js), bit-compare (Uint32 views) not float ===.
    let bucketsOk = true;
    let rigOk = true;
    try {
      const sa = await import(scene + "/suite_assets.js");
      const src = new sa.SuiteAssetSource({ fetchImpl: () => out });
      let dec = src.get(did >>> 0, "windclip");
      for (let tries = 0; dec === null && tries < 2000; tries++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 0));
        dec = src.get(did >>> 0, "windclip");
      }
      if (!dec) {
        bucketsOk = false;
        rigOk = false;
      } else {
        for (let b = 0; b < K && bucketsOk; b++) {
          const gFa = goldens[b];
          const dFa = dec.bucketFrames(b);
          if (dFa.length !== gFa.length) { bucketsOk = false; break; }
          const gu = new Uint32Array(gFa.buffer, gFa.byteOffset, gFa.length);
          const du = new Uint32Array(dFa.buffer, dFa.byteOffset, dFa.length);
          for (let i = 0; i < gu.length; i++) {
            if (gu[i] !== du[i]) { bucketsOk = false; break; }
          }
        }
        // rig f32-bit equality
        const eqBits = (a, b) => {
          _f.setFloat32(0, a, true);
          const ab = _f.getUint32(0, true);
          _f.setFloat32(0, b, true);
          return ab === _f.getUint32(0, true);
        };
        const _f = new DataView(new ArrayBuffer(4));
        for (let p = 0; p < partCount && rigOk; p++) {
          const a = rig[p], d = dec.rig[p];
          if (
            !eqBits(a.pivot.x, d.pivot.x) || !eqBits(a.pivot.y, d.pivot.y) || !eqBits(a.pivot.z, d.pivot.z) ||
            !eqBits(a.weight, d.weight) ||
            !eqBits(a.rest.o.x, d.rest.o.x) || !eqBits(a.rest.o.y, d.rest.o.y) || !eqBits(a.rest.o.z, d.rest.o.z) ||
            !eqBits(a.rest.q[0], d.rest.q[0]) || !eqBits(a.rest.q[1], d.rest.q[1]) ||
            !eqBits(a.rest.q[2], d.rest.q[2]) || !eqBits(a.rest.q[3], d.rest.q[3])
          ) {
            rigOk = false;
          }
        }
      }
    } catch (e) {
      bucketsOk = false;
      rigOk = false;
    }

    // base64 (chunked to dodge fromCharCode arg limits).
    let s = "";
    const CH = 0x8000;
    for (let i = 0; i < out.length; i += CH) {
      s += String.fromCharCode.apply(null, out.subarray(i, Math.min(i + CH, out.length)));
    }
    const b64 = btoa(s);

    return {
      ok: true,
      skipped: false,
      partCount,
      numFrames,
      fps,
      k: K,
      bytes: total,
      b64,
      verify: { bucketsOk, rigOk, groupsSeen },
    };
  } catch (e) {
    return { ok: false, skipped: true, reason: "in-page-threw:" + (e && e.message ? e.message : String(e)) };
  }
}

// ── allowlist DIDs (Node side, for --list / fallback) ────────────────────────
// tree_wind.js imports NOTHING and reads `window` only inside guarded flag
// helpers, so it loads cleanly in Node — keeping --list drift-free from the
// in-page allowlist used by the real bake.
async function loadAllowlistDidsNode() {
  try {
    const tw = await import("../scene3d/tree_wind.js");
    return Array.from(tw.treeWindDids()).map((d) => d >>> 0);
  } catch (e) {
    // Last-resort literal mirror of TREE_WIND_DIDS (kept in sync by review).
    return [0x02001063, 0x02001064, 0x020007a2, 0x02000246, 0x02000258, 0x0200035f];
  }
}

async function resolveDidsInPage(page) {
  return page.evaluate(async () => {
    const tw = await import("/apps/holtburger-web/scene3d/tree_wind.js");
    return Array.from(tw.treeWindDids()).map((d) => d >>> 0);
  });
}

async function waitPkgReady(page, href, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    // eslint-disable-next-line no-await-in-loop
    const ready = await page.evaluate(async (h) => {
      try {
        const m = await import(h);
        return typeof m.has_resource_source === "function" && m.has_resource_source() === true;
      } catch (_) {
        return false;
      }
    }, href);
    if (ready) return true;
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(250);
  }
  return false;
}

async function resolvePkgHref(page) {
  return page.evaluate(() => {
    const link = document.querySelector('link[rel="modulepreload"][href*="holtburger_web.js"]');
    return link ? link.href : null;
  });
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(HELP);
    return 0;
  }

  if (args.list) {
    let dids = await loadAllowlistDidsNode();
    if (args.dids) {
      const allow = new Set(dids);
      dids = args.dids.filter((d) => allow.has(d));
    }
    dids = dids.slice().sort((a, b) => a - b);
    process.stdout.write(`# bake-windclips --list (no chromium, no writes)\n`);
    process.stdout.write(`# K=${K_BUCKETS} dirDeg=${WIND_PARAMS.dirDeg} strength=${WIND_PARAMS.strength} fps=${WIND_PARAMS.fps} out=${OUT_DIR}\n`);
    process.stdout.write(`# ${dids.length} DID(s) to bake:\n`);
    for (const d of dids) process.stdout.write(didHex(d) + "\n");
    return 0;
  }

  // PRE-FLIGHT
  const up = await probeServer(APP_BASE);
  if (!up) {
    process.stderr.write(`SERVER_DOWN: ${APP_BASE} unreachable. Start serve.py :8765.\n`);
    return 2;
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });

  const chromium = loadChromium();
  const browser = await chromium.launch({
    args: [
      "--use-gl=swiftshader",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
      "--disable-features=CalculateNativeWinOcclusion",
    ],
  });

  let exitCode = 0;
  const issues = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
    const page = await context.newPage();
    page.on("console", (m) => {
      const t = m.text();
      if (m.type() === "error" || /\[suite\]|\[tree-wind\]/.test(t)) {
        process.stderr.write(`[page:${m.type()}] ${t}\n`);
      }
    });
    page.on("pageerror", (e) => process.stderr.write(`[pageerror] ${e.message}\n`));

    await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", timeout: 60000 });

    const href = await resolvePkgHref(page);
    if (!href) throw new Error("MODULEPRELOAD_HREF_NOT_FOUND: no link[rel=modulepreload][href*=holtburger_web.js]");
    const pkgVer = (() => {
      try {
        return new URL(href).searchParams.get("v") || "";
      } catch (_) {
        return "";
      }
    })();

    const ready = await waitPkgReady(page, href);
    if (!ready) throw new Error("PKG_NOT_INITIALIZED: has_resource_source() never went true (manifest source uninitialized)");

    // RESOLVE DIDS (from the in-page allowlist; never drift).
    let dids = await resolveDidsInPage(page);
    if (K_BUCKETS !== 4) throw new Error("K_BUCKETS must be 4 (live phase-bucket count)");
    if (args.dids) {
      const allow = new Set(dids);
      const bad = args.dids.filter((d) => !allow.has(d));
      if (bad.length) throw new Error("--did contains non-allowlist DIDs: " + bad.map(didHex).join(","));
      dids = args.dids;
    }
    dids = dids.slice().sort((a, b) => a - b);

    const evalArgs = (did) => ({ href, did, K: K_BUCKETS, scene: SCENE, dirDeg: WIND_PARAMS.dirDeg, strength: WIND_PARAMS.strength });

    // PASS 1 + PASS 2 (A.5 determinism gate 3): bake twice, assert byte-identical
    // payloads per DID BEFORE writing.
    const pass1 = new Map();
    const pass2 = new Map();
    for (const did of dids) {
      // eslint-disable-next-line no-await-in-loop
      const r = await page.evaluate(bakeOneInPage, evalArgs(did));
      pass1.set(did, r);
    }
    for (const did of dids) {
      // eslint-disable-next-line no-await-in-loop
      const r = await page.evaluate(bakeOneInPage, evalArgs(did));
      pass2.set(did, r);
    }

    const baked = [];
    const skipped = [];
    for (const did of dids) {
      const r1 = pass1.get(did);
      const r2 = pass2.get(did);
      const hx = didHex(did);
      if (!r1.ok) {
        process.stderr.write(`[skip] ${hx}: ${r1.reason}\n`);
        skipped.push({ did, didHex: hx, reason: r1.reason });
        continue;
      }
      // determinism: both passes must agree.
      if (!r2.ok) {
        const msg = `non-deterministic: pass1 ok but pass2 skipped (${r2.reason})`;
        process.stderr.write(`[FAIL] ${hx}: ${msg}\n`);
        issues.push(`${hx}: ${msg}`);
        skipped.push({ did, didHex: hx, reason: msg });
        continue;
      }
      if (r1.b64 !== r2.b64) {
        const msg = "non-deterministic: pass1 != pass2 payload bytes";
        process.stderr.write(`[FAIL] ${hx}: ${msg}\n`);
        issues.push(`${hx}: ${msg}`);
        skipped.push({ did, didHex: hx, reason: msg });
        continue;
      }
      // round-trip verify (A.5 gate 1)
      if (!r1.verify.bucketsOk || !r1.verify.rigOk) {
        const msg = `round-trip mismatch (bucketsOk=${r1.verify.bucketsOk} rigOk=${r1.verify.rigOk})`;
        process.stderr.write(`[FAIL] ${hx}: ${msg}\n`);
        issues.push(`${hx}: ${msg}`);
        skipped.push({ did, didHex: hx, reason: msg });
        continue;
      }
      const buf = Buffer.from(r1.b64, "base64");
      // size assert
      const expect = 16 + K_BUCKETS * r1.numFrames * r1.partCount * 7 * 4 + r1.partCount * 44;
      if (buf.length !== expect || buf.length !== r1.bytes) {
        const msg = `size mismatch: got ${buf.length}, expected ${expect}`;
        process.stderr.write(`[FAIL] ${hx}: ${msg}\n`);
        issues.push(`${hx}: ${msg}`);
        skipped.push({ did, didHex: hx, reason: msg });
        continue;
      }
      const sha = sha256Hex(buf);
      const fp = fingerprintWindclip(buf);
      baked.push({
        did,
        didHex: hx,
        parts: r1.partCount,
        frames: r1.numFrames,
        fps: r1.fps,
        k: r1.k,
        bytes: buf.length,
        sha256: sha,
        fingerprint: fp,
        _buf: buf,
      });
    }

    // WRITE artifacts (sorted, deterministic; no timestamps anywhere).
    baked.sort((a, b) => a.did - b.did);
    skipped.sort((a, b) => a.did - b.did);
    for (const e of baked) {
      const binName = `${e.didHex}.windclip.bin`;
      const binPath = path.join(OUT_DIR, binName);
      fs.writeFileSync(binPath, e._buf);
      fs.writeFileSync(path.join(OUT_DIR, binName + ".sha256"), `${e.sha256}  ${binName}\n`);
      fs.writeFileSync(path.join(OUT_DIR, binName + ".windclip-hash"), `${e.fingerprint}  ${binName}\n`);
      process.stdout.write(`[bake] ${binName}  parts=${e.parts} frames=${e.frames} k=${e.k} bytes=${e.bytes} sha=${e.sha256.slice(0, 12)} fp=${e.fingerprint}\n`);
    }

    // coverage.json — deterministic (no timestamp).
    const coverage = {
      schema: "windclip-coverage/1",
      producer: "tools/bake-windclips.mjs",
      pkgVersion: pkgVer,
      k: K_BUCKETS,
      params: {
        dirDeg: WIND_PARAMS.dirDeg,
        strength: WIND_PARAMS.strength,
        fps: WIND_PARAMS.fps,
        loopSeconds: WIND_PARAMS.loopSeconds,
        ampDeg: WIND_PARAMS.ampDeg,
        cycles1: WIND_PARAMS.cycles1,
        cycles2: WIND_PARAMS.cycles2,
        flutter: WIND_PARAMS.flutter,
      },
      baked: baked.map((e) => ({
        did: e.didHex,
        parts: e.parts,
        frames: e.frames,
        fps: e.fps,
        bytes: e.bytes,
        sha256: e.sha256,
        fingerprint: e.fingerprint,
      })),
      skipped: skipped.map((e) => ({ did: e.didHex, reason: e.reason })),
    };
    fs.writeFileSync(path.join(OUT_DIR, "windclip-coverage.json"), JSON.stringify(coverage, null, 2) + "\n");

    // bake-source.sha256 — one manifest line (producer commit, pkg ?v=, DID set, K, params).
    const commit = gitCommit();
    const didSet = baked.map((e) => e.didHex).join(",");
    const manifest =
      `producer=tools/bake-windclips.mjs commit=${commit} pkg=${pkgVer} K=${K_BUCKETS} ` +
      `params=dirDeg${WIND_PARAMS.dirDeg},strength${WIND_PARAMS.strength},fps${WIND_PARAMS.fps},` +
      `loopSeconds${WIND_PARAMS.loopSeconds},ampDeg${WIND_PARAMS.ampDeg},cycles1=${WIND_PARAMS.cycles1},` +
      `cycles2=${WIND_PARAMS.cycles2},flutter${WIND_PARAMS.flutter} baked=[${didSet}]\n`;
    fs.writeFileSync(path.join(OUT_DIR, "bake-source.sha256"), manifest);

    process.stdout.write(`\nDONE: ${baked.length} baked, ${skipped.length} skipped → ${OUT_DIR}\n`);
    if (skipped.length) {
      for (const s of skipped) process.stdout.write(`  skipped ${s.did}: ${s.reason}\n`);
    }
    if (issues.length) exitCode = 1;
  } finally {
    await browser.close().catch(() => {});
  }
  return exitCode;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    process.stderr.write(`FATAL: ${e && e.stack ? e.stack : e}\n`);
    process.exit(3);
  });
