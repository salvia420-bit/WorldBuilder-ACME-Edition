#!/usr/bin/env node
// scripts/derive-terrain-t128.mjs — derive the static t128 terrain tier.
//
// WHY: the terrain tier ladder (scene3d/terrain_bc7.js, `?terrainT1024`) boots
// terrain at t128 and promotes to the full tier afterwards, so the ground is
// textured within seconds instead of waiting for the whole 1024² array (65 MB
// on the wire; at 666 kbps that is ~13 min of nothing but terrain bytes). Its
// t128 source used to be the pack controller's lane-B slice ONLY (`?packSource`,
// default OFF), so the default boot could never use the ladder. This script
// writes the same bytes as a plain static tier next to t512/t1024:
//
//   apps/holtburger-web/scene3d/assets/terrain_bc7/t128/
//     manifest.json                 tier "t128", tileSize 128, levels 8
//     0x0600XXXX_color.hbc7         29 payloads per channel, 21,892 B each
//     0x0600XXXX_nra.hbc7
//
// The payloads are MIP-SLICED from the source tier's chain (level 3 of a 1024²
// chain IS a 128² image), never re-encoded — byte-identical to the pack bake's
// t128 slices (D-12.6: 29 × 21,892 B per channel). terrain_bc7.js reads them
// through the unchanged `loadTerrainBc7Manifest` / `loadTerrainBc7Channel`.
//
// Like every terrain_bc7 tier this output is a gitignored build artifact
// (external/holtburger/.gitignore: apps/holtburger-web/scene3d/assets/terrain_bc7/).
// Re-run after re-baking t1024. Idempotent; refuses (exit 1) on any malformed
// or off-dimension source payload rather than writing a partial tier.
//
// USAGE
//   node scripts/derive-terrain-t128.mjs [--src <tier dir>] [--out <tier dir>]
//     defaults: --src apps/holtburger-web/scene3d/assets/terrain_bc7/t1024
//               --out apps/holtburger-web/scene3d/assets/terrain_bc7/t128
//
// Test: apps/holtburger-web/harness/test_terrain_tier_ladder.mjs (PART 11).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const DEFAULT_SRC = path.join(ROOT, "apps/holtburger-web/scene3d/assets/terrain_bc7/t1024");
const DEFAULT_OUT = path.join(ROOT, "apps/holtburger-web/scene3d/assets/terrain_bc7/t128");

export const T128_TILE = 128;
const HBC7_MAGIC = 0x37434248; // "HBC7" LE
const HBC7_HEADER = 20;
const blocks = (n) => Math.ceil(Math.max(0, n | 0) / 4);
const levelBytes = (w, h) => blocks(w) * blocks(h) * 16;

/**
 * Slice one HBC7 v2 payload (full halving chain) down to the `tile`² level
 * and everything below it. Returns a NEW payload with a rewritten header.
 * Throws on any malformed input.
 */
export function sliceHbc7(buf, tile = T128_TILE) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (u8.byteLength < HBC7_HEADER) throw new Error("HBC7 shorter than header");
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== HBC7_MAGIC) throw new Error("bad HBC7 magic");
  const w0 = dv.getUint32(4, true);
  const h0 = dv.getUint32(8, true);
  if (w0 !== h0) throw new Error(`non-square ${w0}x${h0}`);
  if (dv.getUint32(12, true) !== blocks(w0) || dv.getUint32(16, true) !== blocks(h0)) {
    throw new Error("block dims disagree with pixel dims");
  }
  if (w0 < tile) throw new Error(`source is ${w0}² — smaller than the ${tile}² target`);
  // Walk the chain to the target level.
  let off = HBC7_HEADER;
  let w = w0;
  while (w > tile) {
    off += levelBytes(w, w);
    w = Math.max(1, w >> 1);
  }
  if (w !== tile) throw new Error(`chain from ${w0}² never lands on ${tile}²`);
  // Remaining chain: tile², …, 1×1 — and it must end exactly at the buffer end.
  let need = 0;
  let lw = tile;
  let levels = 0;
  for (;;) {
    need += levelBytes(lw, lw);
    levels += 1;
    if (lw === 1) break;
    lw >>= 1;
  }
  if (off + need !== u8.byteLength) {
    throw new Error(`chain length mismatch: ${u8.byteLength - off} bytes from ${tile}² down, expected ${need}`);
  }
  const out = new Uint8Array(HBC7_HEADER + need);
  const odv = new DataView(out.buffer);
  odv.setUint32(0, HBC7_MAGIC, true);
  odv.setUint32(4, tile, true);
  odv.setUint32(8, tile, true);
  odv.setUint32(12, blocks(tile), true);
  odv.setUint32(16, blocks(tile), true);
  out.set(u8.subarray(off, off + need), HBC7_HEADER);
  return { bytes: out, levels };
}

export function deriveT128({ src = DEFAULT_SRC, out = DEFAULT_OUT, quiet = false } = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(src, "manifest.json"), "utf8"));
  const layers = manifest.layers || {};
  const rsIds = [...new Set(Object.values(layers).map((m) => String(m.rsId)))];
  if (Object.keys(layers).length !== 33 || rsIds.length === 0) {
    throw new Error(`${src}/manifest.json: expected 33 layers, got ${Object.keys(layers).length}`);
  }
  const written = [];
  let levels = 0;
  let diskBytes = 0;
  const staged = new Map();
  for (const rs of rsIds) {
    for (const chan of ["color", "nra"]) {
      const name = `${rs}_${chan}.hbc7`;
      const r = sliceHbc7(fs.readFileSync(path.join(src, name)));
      if (levels && r.levels !== levels) throw new Error(`${name}: ${r.levels} levels, others have ${levels}`);
      levels = r.levels;
      staged.set(name, r.bytes);
      diskBytes += r.bytes.byteLength;
    }
  }
  // All payloads validated — only now touch the output dir (never a partial tier).
  fs.mkdirSync(out, { recursive: true });
  for (const [name, bytes] of staged) {
    fs.writeFileSync(path.join(out, name), bytes);
    written.push(name);
  }
  const m = {
    pack: manifest.pack,
    tier: "t128",
    tileSize: T128_TILE,
    levels,
    source: manifest.source,
    nra: manifest.nra,
    nraPack: manifest.nraPack,
    colorPack: manifest.colorPack,
    waterLayersFlat: manifest.waterLayersFlat,
    derivedFrom: { tier: manifest.tier, tileSize: manifest.tileSize, method: "mip-slice (no re-encode)" },
    uniqueRsIds: rsIds.length,
    diskBytes,
    layers,
  };
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify(m, null, 1) + "\n");
  if (!quiet) {
    console.log(
      `[derive-terrain-t128] ${rsIds.length} rsIds × 2 channels from ${manifest.tier} → ${out} ` +
        `(${levels} levels, ${(diskBytes / 1024).toFixed(0)} KiB total)`
    );
  }
  return { written: written.length, levels, diskBytes, manifest: m };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = (k) => {
    const i = process.argv.indexOf(k);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
  try {
    deriveT128({ src: arg("--src") ? path.resolve(arg("--src")) : DEFAULT_SRC, out: arg("--out") ? path.resolve(arg("--out")) : DEFAULT_OUT });
  } catch (e) {
    console.error(`[derive-terrain-t128] FAILED: ${e.message}`);
    process.exit(1);
  }
}
