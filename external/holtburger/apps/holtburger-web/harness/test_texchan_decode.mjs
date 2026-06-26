// test_texchan_decode.mjs — Phase-5 S6b-1 gate.
//
// Cross-validates the Rust producer (TexChan::encode) against the JS decoder
// (decodeTexchanBytes): reads real on-disk .texchan.bin containers from the
// dist/suite bake (resolved via texchan-manifest.json) and asserts the decoded
// dims + channel lengths are well-formed. Proves the JS container+payload parse
// matches what bake_texchan wrote, end to end, on real data.
//
// Run: node harness/test_texchan_decode.mjs   (needs the S5 bake on disk)

import { decodeTexchanBytes } from "../scene3d/suite_assets.js";
import { readFileSync } from "node:fs";

const DIST = process.env.HOLTBURGER_DIST || "/mnt/wbterminal2/holtburger-dist";
const SUITE = `${DIST}/suite`;
const SAMPLE = 60;

let manifest;
try {
  manifest = JSON.parse(readFileSync(`${SUITE}/texchan-manifest.json`, "utf8"));
} catch (e) {
  console.error(`SKIP: no texchan-manifest.json at ${SUITE} (run the S5 bake first): ${e.message}`);
  process.exit(2);
}

const entries = Object.entries(manifest).slice(0, SAMPLE);
let ok = 0;
let fail = 0;
const seenStems = new Set();

for (const [did, stem] of entries) {
  let buf;
  try {
    buf = readFileSync(`${SUITE}/${stem}.texchan.bin`);
  } catch (e) {
    console.error(`MISSING ${did} -> ${stem}.texchan.bin: ${e.message}`);
    fail++;
    continue;
  }
  const u8 = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const tc = decodeTexchanBytes(u8);
  if (!tc) {
    console.error(`DECODE-NULL ${did} (${stem})`);
    fail++;
    continue;
  }
  const px = tc.width * tc.height;
  const good =
    tc.width > 0 &&
    tc.height > 0 &&
    tc.normal && tc.normal.length === px * 3 &&
    tc.roughness && tc.roughness.length === px &&
    tc.ao && tc.ao.length === px;
  if (good) {
    ok++;
    seenStems.add(stem);
  } else {
    console.error(
      `BAD ${did} (${stem}): ${tc.width}x${tc.height} n=${tc.normal?.length} r=${tc.roughness?.length} a=${tc.ao?.length}`
    );
    fail++;
  }
}

// Negative case: a truncated / non-container buffer must fail-soft to null.
const garbage = new Uint8Array([0x48, 0x53, 0x42, 0x31, 1, 0, 7]); // "HSB1" + ver + tagLen, then nothing
const negOk = decodeTexchanBytes(garbage) === null && decodeTexchanBytes(new Uint8Array(0)) === null;

console.log(`texchan decode: ok=${ok} fail=${fail} uniqueStems=${seenStems.size} negative-fail-soft=${negOk}`);
if (fail === 0 && ok > 0 && negOk) {
  console.log("TEXCHAN-DECODE ✅");
  process.exit(0);
} else {
  console.error("TEXCHAN-DECODE ❌");
  process.exit(1);
}
