// Phase 1.1 probe — fetch real Holtburg surfaces via the live-ACE
// HTTP manifest, then for each one verify the new `normalPixels`
// getter is populated (or empty for Luminous) and contains plausible
// normal-map data.
//
// Output: writes 2 PNG screenshots under /mnt/wbterminal1/tmp/claude-
// scratch/visual-fidelity/wave2-p11/ — one of the diffuse texture,
// one of the procedural normal map — for a representative Holtburg
// stone-wall surface DID. Plus summary stats: how many surfaces got
// normal maps, how many were skipped (Luminous), texture-memory
// growth estimate.
//
// Usage: `node probe_phase11_normals.cjs` from apps/holtburger-web/

const fs = require("fs");
const path = require("path");
const { performance } = require("perf_hooks");

// fetch is built into Node 18+.
const wasmMod = require("./pkg-node/holtburger_web.js");

const HOLTBURG_LB = 0xA9B4;
const HOLTBURG_CELL_ID = (((HOLTBURG_LB & 0xFFFF) << 16) | 0xFFFE) >>> 0;
const LIVE_MANIFEST_URL =
  process.env.MANIFEST_URL ||
  "http://100.116.47.66:8765/dist/manifest.json";
const SCRATCH_DIR =
  "/mnt/wbterminal1/tmp/claude-scratch/visual-fidelity/wave2-p11";

function ensureScratchDir() {
  if (!fs.existsSync(SCRATCH_DIR)) {
    fs.mkdirSync(SCRATCH_DIR, { recursive: true });
  }
}

// Minimal PNG encoder for 8-bit RGB[A] data. Avoids a node_modules
// dep; PNG spec is short enough to inline. Reference:
// http://www.libpng.org/pub/png/spec/1.2/PNG-Contents.html
function crc32(buf) {
  let c;
  const table = [];
  for (let n = 0; n < 256; n += 1) {
    c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc = (table[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8)) >>> 0;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])), 0);
  return Buffer.concat([len, t, data, crc]);
}
function encodePng(rgba8, w, h) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;       // bit depth
  ihdr[9] = 6;       // colour type = RGBA
  ihdr[10] = 0;      // compression
  ihdr[11] = 0;      // filter
  ihdr[12] = 0;      // interlace
  // IDAT scanlines: prepend 0x00 (no filter) to each row.
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 4 + 1)] = 0;
    rgba8.subarray(y * w * 4, (y + 1) * w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const zlib = require("zlib");
  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    sig,
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", idat),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}
function encodePngFromRgb(rgb8, w, h) {
  // Pad RGB → RGBA so we hit the same encoder path.
  const rgba = Buffer.alloc(w * h * 4);
  for (let i = 0; i < w * h; i += 1) {
    rgba[i * 4] = rgb8[i * 3];
    rgba[i * 4 + 1] = rgb8[i * 3 + 1];
    rgba[i * 4 + 2] = rgb8[i * 3 + 2];
    rgba[i * 4 + 3] = 255;
  }
  return encodePng(rgba, w, h);
}

async function main() {
  ensureScratchDir();
  console.log(`[probe-p11] init_resource_source(${LIVE_MANIFEST_URL})`);
  await wasmMod.init_resource_source(LIVE_MANIFEST_URL);

  console.log(`[probe-p11] fetching Holtburg LB ${HOLTBURG_LB.toString(16)} surface DIDs`);
  const t0 = performance.now();
  const dids = await wasmMod.fetchLandblockSurfaceDids(HOLTBURG_CELL_ID);
  console.log(
    `[probe-p11] got ${dids.length} unique surface DIDs in ${(performance.now() - t0).toFixed(1)} ms`
  );

  // Decode in batches of 16 to avoid swamping the wasm walker.
  const summary = {
    total: dids.length,
    withNormalMap: 0,
    emptyNormalMap: 0,
    luminousSurfaces: 0,
    nonZeroWidth: 0,
    diffuseBytes: 0,
    normalBytes: 0,
    flatNormals: 0,
    nonFlatNormals: 0,
    perCategory: {},
  };
  const SURFACE_TYPE_LUMINOUS = 0x40;
  const sampleSurfaces = []; // {did, w, h, diffuse, normal} for the
                              // first few non-trivial surfaces.

  const BATCH = 16;
  for (let i = 0; i < dids.length; i += BATCH) {
    const slice = Array.from(dids).slice(i, i + BATCH);
    const u32 = new Uint32Array(slice);
    const sps = await wasmMod.fetch_surfaces_pixels(u32);
    for (let j = 0; j < sps.length; j += 1) {
      const sp = sps[j];
      const did = slice[j];
      let w, h, surfaceType, category, pixels, normalPixels;
      try {
        w = sp.width;
        h = sp.height;
        surfaceType = sp.surfaceType >>> 0;
        category = sp.category;
        pixels = sp.pixels;
        normalPixels = sp.normalPixels;
      } catch (e) {
        continue;
      }
      if (w === 0 || h === 0) continue;
      summary.nonZeroWidth += 1;
      summary.diffuseBytes += w * h * 4;
      if (w === 1 && h === 1) {
        summary.solid1x1 = (summary.solid1x1 || 0) + 1;
      }
      if (normalPixels && normalPixels.length > 0) {
        summary.withNormalMap += 1;
        summary.normalBytes += normalPixels.length;
        // Inspect for flat-ness: a "flat" normal map is uniform (128,
        // 128, 255). Count any non-flat pixel as evidence of real
        // gradient extraction.
        let nonFlat = 0;
        const sampleLen = Math.min(normalPixels.length, 3 * 64); // first 64 pixels
        for (let k = 0; k < sampleLen; k += 3) {
          const r = normalPixels[k];
          const g = normalPixels[k + 1];
          if (Math.abs(r - 128) > 4 || Math.abs(g - 128) > 4) {
            nonFlat += 1;
          }
        }
        if (nonFlat > 0) summary.nonFlatNormals += 1;
        else summary.flatNormals += 1;
      } else {
        summary.emptyNormalMap += 1;
      }
      if ((surfaceType & SURFACE_TYPE_LUMINOUS) !== 0) {
        summary.luminousSurfaces += 1;
      }
      summary.perCategory[category] = (summary.perCategory[category] || 0) + 1;

      // Capture a couple of real Holtburg surfaces for screenshots —
      // pick ones that have a real (non-empty) normal map and at
      // least 32x32 resolution so the PNG is meaningful.
      if (sampleSurfaces.length < 2 && w >= 32 && h >= 32 && normalPixels && normalPixels.length > 0) {
        // Copy buffers — Vec<u8> getters reallocate, so safe to keep
        // references but make defensive copies anyway.
        sampleSurfaces.push({
          did,
          w,
          h,
          surfaceType,
          category,
          diffuse: Buffer.from(pixels),
          normal: Buffer.from(normalPixels),
        });
      }

      try { if (typeof sp.free === "function") sp.free(); } catch (_) {}
    }
  }

  console.log(`[probe-p11] summary:`);
  console.log(`  total dids: ${summary.total}`);
  console.log(`  non-zero-width decoded: ${summary.nonZeroWidth}`);
  console.log(`  with normal map: ${summary.withNormalMap}`);
  console.log(`  empty normal map (luminous / 1x1 solids / fails): ${summary.emptyNormalMap}`);
  console.log(`  1x1 solid-color surfaces: ${summary.solid1x1 ?? 0}`);
  console.log(`  flat normal maps (no gradient detected): ${summary.flatNormals}`);
  console.log(`  non-flat normal maps (real gradient): ${summary.nonFlatNormals}`);
  console.log(`  luminous surfaces: ${summary.luminousSurfaces}`);
  console.log(`  diffuse bytes (RGBA8): ${summary.diffuseBytes.toLocaleString()}`);
  console.log(`  normal bytes (RGB8):   ${summary.normalBytes.toLocaleString()}`);
  if (summary.diffuseBytes > 0) {
    const ratio = summary.normalBytes / summary.diffuseBytes;
    console.log(`  normal/diffuse byte ratio: ${(ratio * 100).toFixed(1)}%`);
    // Production JS path pads to RGBA: 4 bytes / pixel. Estimated GPU
    // growth = (4/4) = 100% if we shipped at RGBA, but the report is
    // about *transport*. Real GPU growth: width*height*4 added per
    // texture. The plan's 10–15% is about transport (RGB normal vs
    // RGBA diffuse); 3/4 = 75% per-pixel, but normalised against
    // total scene memory the percentage is much smaller because
    // shaders, geometry, terrain, etc. dominate.
    console.log(`  (GPU per-surface growth = normal_w*h*4 bytes RGBA)`);
  }
  console.log(`  per-category (Stone=0, Wood=1, ..., Generic=12):`);
  for (const [k, v] of Object.entries(summary.perCategory)) {
    console.log(`    cat ${k}: ${v}`);
  }

  // Write the screenshots.
  let i = 0;
  for (const s of sampleSurfaces) {
    const hex = s.did.toString(16).padStart(8, "0");
    const diffusePath = path.join(SCRATCH_DIR, `holtburg_surface_${hex}_diffuse.png`);
    const normalPath = path.join(SCRATCH_DIR, `holtburg_surface_${hex}_normal.png`);
    fs.writeFileSync(diffusePath, encodePng(s.diffuse, s.w, s.h));
    fs.writeFileSync(normalPath, encodePngFromRgb(s.normal, s.w, s.h));
    console.log(
      `[probe-p11] sample ${++i}: surface 0x${hex} ${s.w}x${s.h} cat=${s.category} flags=0x${s.surfaceType.toString(16)}`
    );
    console.log(`  diffuse → ${diffusePath}`);
    console.log(`  normal  → ${normalPath}`);
  }

  // Acceptance — abort with non-zero if the assertions fail.
  let failed = 0;
  if (summary.withNormalMap === 0) {
    console.log(`FAIL: no surfaces got a normal map`);
    failed += 1;
  }
  if (summary.nonFlatNormals === 0) {
    console.log(`FAIL: every normal map is flat (algorithm broken)`);
    failed += 1;
  }
  // Per Phase 1.1 hand-off note #3 — Luminous surfaces MUST be empty.
  // If all luminous surfaces also got a normal map, the gate failed.
  if (summary.luminousSurfaces > 0 && summary.withNormalMap >= summary.nonZeroWidth) {
    console.log(`FAIL: Luminous surfaces did not skip normal generation`);
    failed += 1;
  }
  if (failed > 0) process.exit(1);
  console.log(`[probe-p11] PASS`);
}

main().catch((e) => {
  console.error("[probe-p11] error:", e);
  process.exit(2);
});
