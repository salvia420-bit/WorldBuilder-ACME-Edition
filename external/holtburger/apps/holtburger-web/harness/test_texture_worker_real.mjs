// harness/test_texture_worker_real.mjs — T14 (ST4): worker-path vs main-path
// byte-identity with the REAL vendored basisu transcoder and a REAL corpus
// payload.
//
// This is the "no eye item" evidence at full fidelity (SPEC §3 T14: "same
// transcoder, same output"): the mock-driven suite (test_texture_worker.mjs)
// pins the protocol; THIS suite pins that the worker job body and the
// main-thread `_transcodeNow` produce byte-identical BC7 for a real
// scheme-6-supercompressed KTX2, each on its OWN transcoder instance —
// exactly the two-instance topology the flag ships (the worker owns its own
// 1.04 MB copy).
//
// Follows test_xu7_transcode.mjs's precedent: the transcoder loads via
// createRequire (node UMD branch), and a MISSING corpus fixture FAILS loud
// (a skip asserts nothing — the runner's stated rule; /mnt/wbterminal2 is an
// external mount, check it is mounted).
//
// Run:  node harness/test_texture_worker_real.mjs        (exit 0/1)

import fs from "node:fs";
import { createRequire } from "node:module";
import {
  transcodeXu7,
  xu7Transcoder,
  _setXu7ModuleForTest,
  _resetXu7ForTest,
  _resetTexWorkerForTest,
} from "../scene3d/xu7_textures.js";
import {
  handleTextureWorkerMessage,
  _setWorkerTranscoderForTest,
  _resetTextureWorkerForTest,
} from "../scene3d/texture_worker.js";

const KTX2 = "/mnt/wbterminal2/xubc7-corpus/statics-lossless/0x06003789.ktx2";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

async function run() {
  if (!fs.existsSync(KTX2)) {
    console.error(
      `FAIL: corpus fixture missing: ${KTX2}\n` +
        "      /mnt/wbterminal2 is an external mount — check it is mounted " +
        "(the xu7 corpus lives there; see docs/HANDOFF-texture-pipeline-2026-08-04.md).",
    );
    process.exit(1);
  }
  const require2 = createRequire(import.meta.url);
  const BASIS = require2("../scene3d/transcoder/basis_transcoder.js");

  // TWO independent instances — the exact per-context topology the flag ships.
  const mainModule = await BASIS().then((m) => {
    m.initializeBasis();
    return m;
  });
  const workerModule = await BASIS().then((m) => {
    m.initializeBasis();
    return m;
  });

  const bytes = new Uint8Array(fs.readFileSync(KTX2));

  // Main path: flag off, budget off = the pre-ST4 straight-through decode.
  globalThis.window = { location: { search: "?texWorkers=off&xu7Budget=off" } };
  _resetXu7ForTest();
  _resetTexWorkerForTest();
  _setXu7ModuleForTest(mainModule);
  await xu7Transcoder();
  const t0 = performance.now();
  const mainOut = await transcodeXu7(bytes.slice());
  const mainMs = performance.now() - t0;
  check("main path decodes the real payload", mainOut !== null && mainOut.levels.length > 0);

  // Worker path: the REAL job body via the REAL message handler.
  _resetTextureWorkerForTest();
  _setWorkerTranscoderForTest(workerModule);
  const replies = [];
  await handleTextureWorkerMessage(
    { type: "job", seq: 1, kind: "xu7", bytes: bytes.slice().buffer, want: { nra: "half" } },
    (msg) => replies.push(msg),
  );
  const r = replies[0];
  check("worker job ok", r && r.ok === true, r && r.err);
  check(
    "dims agree",
    r.width === mainOut.width && r.height === mainOut.height,
    `${r.width}x${r.height} vs ${mainOut.width}x${mainOut.height}`,
  );
  check("level count agrees", r.levelBytes.length === mainOut.levels.length);

  // Reconstruct the worker's levels exactly as the client does and compare
  // byte-for-byte against the main path's.
  const buf = new Uint8Array(r.bc7);
  let off = 0;
  let identical = true;
  for (let i = 0; i < r.levelBytes.length; i += 1) {
    const view = buf.subarray(off, off + r.levelBytes[i]);
    if (!bytesEqual(view, mainOut.levels[i].data)) {
      identical = false;
      check(`level ${i} identical`, false, `first mismatch in level ${i}`);
      break;
    }
    off += r.levelBytes[i];
  }
  check("BYTE-IDENTICAL BC7 output, real transcoder, both instances", identical);
  check("buffer exactly consumed", off === buf.byteLength || !identical);

  // NRA rider on the real payload: half-res plane at level-1 dims.
  check(
    "want.nra:half derives a half-res RGBA8 plane",
    r.nra &&
      r.nra.width === Math.max(1, r.width >> 1) &&
      r.nra.height === Math.max(1, r.height >> 1) &&
      r.nra.plane.byteLength === r.nra.width * r.nra.height * 4,
  );
  check("worker transcodeMs recorded", typeof r.transcodeMs === "number" && r.transcodeMs > 0, `main=${mainMs.toFixed(1)}ms worker=${r.transcodeMs.toFixed(1)}ms [informational, same box]`);

  _resetXu7ForTest();
  _resetTexWorkerForTest();
  _resetTextureWorkerForTest();
  delete globalThis.window;

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
