// P2 (2026-08-04) — XUBC7 transcode + record-source wiring, against a REAL
// corpus payload and the REAL vendored transcoder. Node-only shims: fetch is
// patched to read the transcoder glue/wasm from disk.
// Run: node test_xu7_transcode.mjs
import fs from "fs";
import { createRequire } from "module";
import {
  transcodeXu7,
  texXu7Enabled,
  _resetXu7ForTest,
  _setXu7ModuleForTest,
  xu7Stats,
} from "./scene3d/xu7_textures.js";
import {
  initBc7Source,
  _setBc7SupportForTest,
  _resetBc7ForTest,
  bc7Stats,
} from "./scene3d/bc7_textures.js";

const KTX2 = "/mnt/wbterminal2/xubc7-corpus/statics-lossless/0x06003789.ktx2";

// --- node shim: load the transcoder via require (the browser UMD loader
// path is exercised by the live boot test, not here) and inject it. ---
const require2 = createRequire(import.meta.url);
const BASIS = require2("./scene3d/transcoder/basis_transcoder.js");
const modulePromise = BASIS().then((m) => {
  m.initializeBasis();
  return m;
});
_setXu7ModuleForTest(modulePromise);

let failures = 0;
const check = (c, l) => {
  if (!c) {
    failures++;
    console.error("FAIL:", l);
  } else console.log("ok:", l);
};

async function run() {
  // --- flag: DEFAULT-ON with an `off` escape ---
  // Flipped 2026-08-05 (862640b9) after the 1070 redmi eye-pass. These
  // assertions still encoded the pre-flip exact-match opt-in and FAILED from
  // that commit onwards — nothing caught it because this suite was registered
  // in no runner (now TIER5).
  check(texXu7Enabled("?texXu7=on") === true, "flag: =on enables");
  check(texXu7Enabled("?texXu7=off") === false, "flag: =off is the escape");
  check(texXu7Enabled("") === true, "flag: absent is ON (default-ON since 08-05)");
  check(texXu7Enabled("?other=1") === true, "flag: an unrelated query is still ON");

  // --- transcode a real corpus payload ---
  // Real corpus payload, not a synthesised one — a hand-built KTX2 would not
  // exercise the scheme-6 supercompression this whole tier is about. Registered
  // in TIER5 as of 2026-08-05, so a missing fixture must FAIL with something
  // actionable rather than an ENOENT stack (and must not be skipped: a skip
  // asserts nothing, which is the runner's stated rule).
  if (!fs.existsSync(KTX2)) {
    console.error(
      `FAIL: corpus fixture missing: ${KTX2}\n` +
        "      /mnt/wbterminal2 is an external mount — check it is mounted " +
        "(the xu7 corpus lives there; see docs/HANDOFF-texture-pipeline-2026-08-04.md)."
    );
    process.exit(1);
  }
  const bytes = new Uint8Array(fs.readFileSync(KTX2));
  const parsed = await transcodeXu7(bytes);
  check(parsed !== null, "transcode: real corpus ktx2 decodes");
  if (parsed) {
    check(parsed.width === 2048 && parsed.height === 2048, "transcode: dims 2048x2048");
    check(parsed.levels.length === 12, "transcode: full 12-level chain");
    const last = parsed.levels[parsed.levels.length - 1];
    check(last.width === 1 && last.height === 1, "transcode: chain reaches 1x1");
    check(parsed.levels[0].data.length === 512 * 512 * 16, "transcode: level0 is exact BC7 bytes");
    check(parsed.blocksX === 512 && parsed.blocksY === 512, "transcode: block dims");
  }
  check(xu7Stats().decodes === 1 && xu7Stats().decodeErrors === 0, "transcode: stats tallied");

  // --- record source: xu7-first with hbc7 fallback ---
  // NOTE: tryXu7 requires the wasm route (skips when fetchImpl injected), so
  // wire a fake wasm exposing both exports.
  _resetBc7ForTest();
  _setBc7SupportForTest(true);
  // (default-ON; the explicit window.location below pins it for this scope)
  const fakeWasm = {
    xu7_blocks: async () => bytes,
    bc7_blocks: async () => {
      throw new Error("must not fall back when xu7 decodes");
    },
  };
  const src = initBc7Source({ wasmExports: fakeWasm });
  // The flag is default-ON now, so the memo needs no priming — reset it anyway
  // so this block does not inherit whatever an earlier case left behind.
  _resetXu7ForTest();
  _setXu7ModuleForTest(modulePromise);
  const origWindow = globalThis.window;
  globalThis.window = { location: { search: "?texXu7=on" } };
  const parsed2 = await src.getAsync(0x06003789);
  globalThis.window = origWindow;
  check(parsed2 && parsed2.width === 2048 && parsed2.levels.length === 12, "source: xu7-first path served the record");
  check(bc7Stats().hits === 1, "source: counted as hit");

  // --- fallback: empty xu7 → bc7_blocks path ---
  _resetBc7ForTest();
  _setBc7SupportForTest(true);
  _resetXu7ForTest();
  _setXu7ModuleForTest(modulePromise);
  globalThis.window = { location: { search: "?texXu7=on" } };
  let fellBack = false;
  const src2 = initBc7Source({
    wasmExports: {
      xu7_blocks: async () => new Uint8Array(0),
      bc7_blocks: async () => {
        fellBack = true;
        return null;
      },
    },
  });
  const r2 = await src2.getAsync(0x06001111);
  globalThis.window = origWindow;
  check(r2 === null && fellBack, "source: empty xu7 falls back to bc7_blocks");

  console.log(failures === 0 ? "ALL PASS" : `${failures} FAILURES`);
  process.exit(failures === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
