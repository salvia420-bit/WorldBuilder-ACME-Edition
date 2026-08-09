#!/usr/bin/env node
// derive-pvw-xu7.mjs — T10 preview coverage for xu7-only rsIds.
//
// XUBC7 KTX2 payloads are OPAQUE to the Rust bake (unregistered scheme-6
// supercompression; the vendored basis transcoder is the only decoder —
// docs/HANDOFF-texture-pipeline-2026-08-04.md). The bake derives previews
// by mip-slicing HBC7 sources; rsIds that exist ONLY as xu7 have no HBC7
// to slice. This script closes that gap OFFLINE: transcode each .ktx2 to
// BC7 with the SAME vendored transcoder the client uses, emit a full-chain
// `<rsId>.hbc7`, and feed the output dir to `dat-shard --tex-pvw-extra`.
// The bake then slices these to the ≤128 preview cap like any other HBC7
// source, so `texrefMissingPvw` can reach 0 (pass 5 D-05.5.4).
//
// Usage:
//   node derive-pvw-xu7.mjs --xu7 DIR --out DIR [--ids FILE]
//     --xu7  dir of <rsId>.ktx2 payloads
//     --out  dir to write <rsId>.hbc7 (created; existing files skipped)
//     --ids  optional file of 0xXXXXXXXX ids (one per line — e.g. the
//            pack-report.json `pvw_wanted_from_xu7` list); default = every
//            .ktx2 in --xu7.

import fs from "fs";
import path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

const argv = process.argv.slice(2);
function arg(name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : null;
}
const xu7Dir = arg("--xu7");
const outDir = arg("--out");
const idsFile = arg("--ids");
if (!xu7Dir || !outDir) {
  console.error("usage: derive-pvw-xu7.mjs --xu7 DIR --out DIR [--ids FILE]");
  process.exit(2);
}

const here = path.dirname(fileURLToPath(import.meta.url));
// apps/holtburger-tools/scripts -> apps/holtburger-web/scene3d/transcoder
const transcoderDir = path.resolve(
  here,
  "../../holtburger-web/scene3d/transcoder",
);
const require2 = createRequire(import.meta.url);
const BASIS = require2(path.join(transcoderDir, "basis_transcoder.js"));

function hbc7FromLevels(width, height, levels) {
  const header = Buffer.alloc(20);
  header.write("HBC7", 0, "ascii");
  header.writeUInt32LE(width, 4);
  header.writeUInt32LE(height, 8);
  header.writeUInt32LE(Math.ceil(width / 4), 12);
  header.writeUInt32LE(Math.ceil(height / 4), 16);
  return Buffer.concat([header, ...levels]);
}

async function main() {
  const module = await BASIS();
  module.initializeBasis();

  let ids;
  if (idsFile) {
    ids = fs
      .readFileSync(idsFile, "utf8")
      .split(/\s+/)
      .filter(Boolean)
      .map((s) => parseInt(s, 16) >>> 0);
  } else {
    ids = fs
      .readdirSync(xu7Dir)
      .filter((n) => n.toLowerCase().endsWith(".ktx2"))
      .map((n) => parseInt(n.replace(/\.ktx2$/i, ""), 16) >>> 0);
  }
  ids = [...new Set(ids)].sort((a, b) => a - b);

  fs.mkdirSync(outDir, { recursive: true });
  let ok = 0,
    skipped = 0,
    failed = 0;
  for (const rs of ids) {
    const hex = `0x${rs.toString(16).toUpperCase().padStart(8, "0")}`;
    const outPath = path.join(outDir, `${hex}.hbc7`);
    if (fs.existsSync(outPath)) {
      skipped++;
      continue;
    }
    let src = path.join(xu7Dir, `${hex}.ktx2`);
    if (!fs.existsSync(src)) {
      src = path.join(xu7Dir, `${hex.slice(2)}.ktx2`);
    }
    if (!fs.existsSync(src)) {
      console.error(`MISS ${hex}: no .ktx2 in ${xu7Dir}`);
      failed++;
      continue;
    }
    let file = null;
    try {
      const bytes = new Uint8Array(fs.readFileSync(src));
      file = new module.KTX2File(bytes);
      if (!file.isValid()) throw new Error("invalid KTX2");
      const width = file.getWidth();
      const height = file.getHeight();
      const levelCount = file.getLevels();
      if (!file.startTranscoding()) throw new Error("startTranscoding failed");
      const fmt = module.transcoder_texture_format.cTFBC7_RGBA.value;
      const levels = [];
      let lw = width,
        lh = height;
      for (let i = 0; i < levelCount; i++) {
        const size = file.getImageTranscodedSizeInBytes(i, 0, 0, fmt);
        const expect = Math.ceil(lw / 4) * Math.ceil(lh / 4) * 16;
        if (size !== expect) {
          throw new Error(
            `level ${i}: transcoded ${size} B != BC7 grid ${expect} B ` +
              `for ${lw}x${lh} (non-halving chain?)`,
          );
        }
        const dst = new Uint8Array(size);
        if (!file.transcodeImage(dst, i, 0, 0, fmt, 0, -1, -1)) {
          throw new Error(`transcodeImage failed at level ${i}`);
        }
        levels.push(Buffer.from(dst));
        lw = Math.max(1, lw >> 1);
        lh = Math.max(1, lh >> 1);
      }
      fs.writeFileSync(outPath, hbc7FromLevels(width, height, levels));
      ok++;
    } catch (e) {
      console.error(`FAIL ${hex}: ${e.message}`);
      failed++;
    } finally {
      if (file) file.delete();
    }
  }
  console.log(
    `derive-pvw-xu7: ${ok} derived, ${skipped} already present, ${failed} failed`,
  );
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
