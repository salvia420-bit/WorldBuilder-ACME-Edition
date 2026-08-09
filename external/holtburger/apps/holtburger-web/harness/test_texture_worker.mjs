// harness/test_texture_worker.mjs — T14 (ST4, `?texWorkers`): the dedicated
// texture worker's message protocol, the client's routing/fallback machinery,
// and byte-identity of the worker path against the main-thread path.
//
// WHAT IS UNDER TEST (SPEC §3 T14; pass-05 D-05.4 + S3; pass-08 D-08.4):
//   PART 1 — flag grammar: `?texWorkers` is an EXACT-MATCH DEV opt-in
//            (DEFAULT OFF); garbage/absent must read OFF.
//   PART 2 — helper parity: the worker's self-contained HBC7/BC7 helpers
//            (duplicated because module workers can't import "three"-importing
//            modules) cannot drift from bc7_textures.js.
//   PART 3 — protocol framing: init→ready; job/result/cancel shapes; unknown
//            kinds and malformed payloads answer ok:false (never hang).
//   PART 4 — byte-identity: flag-ON worker route vs flag-OFF main route
//            resolve IDENTICAL parsed output (same transcoder, same bytes) —
//            T14's "no eye item" claim rests on this.
//   PART 5 — terrain assembly: worker-assembled array vs the synchronous
//            `buildTerrainBc7Array`, byte-identical mipmaps + identical
//            texture flags.
//   PART 6 — FALLBACK ENGAGEMENT (the kill criterion): construction failure,
//            crash mid-job, and not-ready-yet must each (a) still resolve the
//            caller via the retained `?xu7Budget` FIFO / hbc7-route contract
//            and (b) be COUNTED on `__texWorkerStats` — never silent.
//   PART 7 — cancel semantics (client queue + worker side).
//
// No browser, no wasm, no real Worker: a mock Worker drives the REAL
// handleTextureWorkerMessage in-process, so the protocol bytes on the "wire"
// are the production ones. The real transcoder against a real corpus payload
// stays test_xu7_transcode.mjs's job.
//
// Run:  node harness/test_texture_worker.mjs        (exit 0/1)

import {
  transcodeXu7,
  texWorkersEnabled,
  texWorkerStats,
  workerTerrainAssemble,
  workerDeriveNra,
  cancelTextureWorkerJob,
  xu7Transcoder,
  _setXu7ModuleForTest,
  _resetXu7ForTest,
  _drainXu7QueueForTest,
  _setTexWorkerFactoryForTest,
  _resetTexWorkerForTest,
  _texWorkerStateForTest,
} from "../scene3d/xu7_textures.js";
import {
  handleTextureWorkerMessage,
  parseHbc7Worker,
  bc7BlocksFor as workerBlocksFor,
  bc7LevelBytes as workerLevelBytes,
  assembleTerrainChannel,
  _setWorkerTranscoderForTest,
  _resetTextureWorkerForTest,
  HBC7_HEADER_BYTES,
  HBC7_MAGIC,
} from "../scene3d/texture_worker.js";
import { parseHbc7, bc7BlocksFor, bc7LevelBytes } from "../scene3d/bc7_textures.js";
import {
  buildTerrainBc7Array,
  buildTerrainBc7ArrayFromAssembled,
  TERRAIN_BC7_DEPTH,
} from "../scene3d/terrain_bc7.js";

let passed = 0;
let failed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? passed++ : failed++;
}

function withSearch(search) {
  globalThis.window = { location: { search } };
}
function noWindow() {
  delete globalThis.window;
}

async function flushMicrotasks(n = 16) {
  for (let i = 0; i < n; i += 1) await Promise.resolve();
}
const tick = () => new Promise((r) => setTimeout(r, 0));

function bytesEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

// ── fake transcoder module (KTX2File-shaped, multi-level, BC7 + RGBA32) ────
const BC7_FMT = 7;
const RGBA32_FMT = 13;

function fakeModule({ dim = 64, levels = 3, valid = true, fillBase = 0xab } = {}) {
  const dims = [];
  let w = dim;
  let h = dim;
  for (let i = 0; i < levels; i += 1) {
    dims.push([w, h]);
    if (w === 1 && h === 1) break;
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  return {
    transcoder_texture_format: { cTFBC7_RGBA: { value: BC7_FMT }, cTFRGBA32: { value: RGBA32_FMT } },
    initializeBasis() {},
    KTX2File: class {
      constructor(bytes) {
        this.bytes = bytes;
      }
      isValid() {
        return valid;
      }
      getWidth() {
        return dim;
      }
      getHeight() {
        return dim;
      }
      getLevels() {
        return dims.length;
      }
      startTranscoding() {
        return true;
      }
      getImageTranscodedSizeInBytes(level, _l, _f, fmt) {
        const [lw, lh] = dims[level];
        return fmt === RGBA32_FMT ? lw * lh * 4 : workerLevelBytes(lw, lh);
      }
      transcodeImage(dst, level, _l, _f, fmt) {
        // Deterministic per-level, per-format pattern so byte-compares bite.
        const seed = fmt === RGBA32_FMT ? 0x40 + level : fillBase + level;
        for (let i = 0; i < dst.length; i += 1) dst[i] = (seed + i * 7) & 0xff;
        return true;
      }
      close() {}
      delete() {}
    },
  };
}

// ── mock Worker driving the REAL worker message handler in-process ─────────
class MockWorker {
  constructor({ silent = false, delayReady = false } = {}) {
    this.onmessage = null;
    this.onerror = null;
    this.onmessageerror = null;
    this.terminated = false;
    this._silent = silent; // swallow everything (never ready, never replies)
    this._delayReady = delayReady;
  }
  postMessage(msg) {
    if (this.terminated || this._silent) return;
    setTimeout(() => {
      if (this.terminated) return;
      handleTextureWorkerMessage(msg, (reply) => {
        if (this.terminated) return;
        if (this.onmessage) this.onmessage({ data: reply });
      });
    }, 0);
  }
  terminate() {
    this.terminated = true;
  }
  crash(message = "boom") {
    if (this.onerror) this.onerror({ message });
  }
}

// synthetic HBC7 v2 payload (header + full halving chain, deterministic)
function makeHbc7(dim, levels, seed) {
  const dims = [];
  let w = dim;
  let h = dim;
  for (let i = 0; i < levels; i += 1) {
    dims.push([w, h]);
    w = Math.max(1, w >> 1);
    h = Math.max(1, h >> 1);
  }
  let total = HBC7_HEADER_BYTES;
  for (const [lw, lh] of dims) total += bc7LevelBytes(lw, lh);
  const u8 = new Uint8Array(total);
  const dv = new DataView(u8.buffer);
  dv.setUint32(0, HBC7_MAGIC, true);
  dv.setUint32(4, dim, true);
  dv.setUint32(8, dim, true);
  dv.setUint32(12, bc7BlocksFor(dim), true);
  dv.setUint32(16, bc7BlocksFor(dim), true);
  let off = HBC7_HEADER_BYTES;
  let li = 0;
  for (const [lw, lh] of dims) {
    const n = bc7LevelBytes(lw, lh);
    for (let i = 0; i < n; i += 1) u8[off + i] = (seed + li * 31 + i * 3) & 0xff;
    off += n;
    li += 1;
  }
  return u8;
}

const PAYLOAD = new Uint8Array(64).fill(1);

async function run() {
  // ---------------------------------------------------------------- PART 1 --
  console.log("PART 1 — ?texWorkers flag grammar (DEV opt-in, DEFAULT OFF)");
  check("absent ⇒ OFF (default-off, DEV stage)", texWorkersEnabled("") === false);
  check("unrelated query ⇒ OFF", texWorkersEnabled("?other=1") === false);
  check("=on opts in", texWorkersEnabled("?texWorkers=on") === true);
  check("=1 opts in", texWorkersEnabled("?texWorkers=1") === true);
  check("=true opts in", texWorkersEnabled("?texWorkers=true") === true);
  check("=yes opts in", texWorkersEnabled("?texWorkers=yes") === true);
  check("=2 (measurement escape) reads ON", texWorkersEnabled("?texWorkers=2") === true);
  check("=off reads OFF", texWorkersEnabled("?texWorkers=off") === false);
  check("=0 reads OFF", texWorkersEnabled("?texWorkers=0") === false);
  check("empty value reads OFF", texWorkersEnabled("?texWorkers=") === false);
  check("garbage (=onn) reads OFF — exact-match opt-in", texWorkersEnabled("?texWorkers=onn") === false);

  // ---------------------------------------------------------------- PART 2 --
  console.log("PART 2 — worker helper parity vs bc7_textures.js (no drift)");
  {
    let ok = true;
    for (const n of [0, 1, 3, 4, 5, 63, 64, 65, 511, 1024, 2048]) {
      if (workerBlocksFor(n) !== bc7BlocksFor(n)) ok = false;
    }
    check("bc7BlocksFor agrees", ok);
    ok = true;
    for (const [w, h] of [[1, 1], [4, 4], [64, 64], [65, 33], [512, 128], [1024, 1024]]) {
      if (workerLevelBytes(w, h) !== bc7LevelBytes(w, h)) ok = false;
    }
    check("bc7LevelBytes agrees", ok);
    const payload = makeHbc7(16, 5, 9);
    const a = parseHbc7(payload);
    const b = parseHbc7Worker(payload);
    let same =
      a.width === b.width && a.height === b.height && a.blocksX === b.blocksX &&
      a.blocksY === b.blocksY && a.levels.length === b.levels.length;
    if (same) {
      for (let i = 0; i < a.levels.length; i += 1) {
        if (!bytesEqual(a.levels[i].data, b.levels[i].data)) same = false;
        if (a.levels[i].width !== b.levels[i].width) same = false;
      }
    }
    check("parseHbc7 walk byte-identical on a 5-level chain", same);
    for (const bad of [
      new Uint8Array(4),
      new Uint8Array(64), // zero magic
      makeHbc7(16, 5, 9).subarray(0, 40), // truncated
    ]) {
      let t1 = null;
      let t2 = null;
      try { parseHbc7(bad); } catch (e) { t1 = String(e.message); }
      try { parseHbc7Worker(bad); } catch (e) { t2 = String(e.message); }
      check(`both parsers throw on the same malformed input`, t1 !== null && t2 !== null, `${t1} / ${t2}`);
    }
  }

  // ---------------------------------------------------------------- PART 3 --
  console.log("PART 3 — protocol framing (real handler, injected post)");
  {
    _resetTextureWorkerForTest();
    _setWorkerTranscoderForTest(fakeModule({ dim: 16, levels: 3 }));
    const replies = [];
    const post = (msg) => replies.push(msg);

    await handleTextureWorkerMessage({ type: "init", transcoderBaseUrl: null }, post);
    check("init answers ready", replies.length === 1 && replies[0].type === "ready");

    await handleTextureWorkerMessage(
      { type: "job", seq: 1, kind: "xu7", bytes: PAYLOAD.slice().buffer, want: { nra: null } },
      post,
    );
    const r1 = replies[1];
    check("xu7 result frame", r1 && r1.type === "result" && r1.seq === 1 && r1.ok === true && r1.kind === "xu7");
    check("dims + levelBytes shape", r1.width === 16 && r1.height === 16 && Array.isArray(r1.levelBytes) && r1.levelBytes.length === 3);
    const totalBytes = r1.levelBytes.reduce((a, b) => a + b, 0);
    check("ONE concatenated buffer, exact size", r1.bc7 instanceof ArrayBuffer && r1.bc7.byteLength === totalBytes);
    check("transcodeMs is a number", typeof r1.transcodeMs === "number" && r1.transcodeMs >= 0);
    check("no nra when want.nra is null", r1.nra === undefined);

    await handleTextureWorkerMessage(
      { type: "job", seq: 2, kind: "xu7", bytes: PAYLOAD.slice().buffer, want: { nra: "half" } },
      post,
    );
    const r2 = replies[2];
    check("want.nra:half attaches a plane", r2.ok === true && r2.nra && r2.nra.plane instanceof ArrayBuffer);
    check("half-res nra reads level 1 dims", r2.nra.width === 8 && r2.nra.height === 8 && r2.nra.plane.byteLength === 8 * 8 * 4);

    await handleTextureWorkerMessage(
      { type: "job", seq: 3, kind: "xu7", bytes: PAYLOAD.slice().buffer, want: { nra: "full" } },
      post,
    );
    check("want.nra:full reads level 0 dims", replies[3].nra.width === 16 && replies[3].nra.height === 16);

    _setWorkerTranscoderForTest(fakeModule({ valid: false }));
    await handleTextureWorkerMessage(
      { type: "job", seq: 4, kind: "xu7", bytes: PAYLOAD.slice().buffer, want: { nra: null } },
      post,
    );
    check("malformed KTX2 answers ok:false (never a hang)", replies[4].ok === false && /invalid/i.test(replies[4].err));

    await handleTextureWorkerMessage({ type: "job", seq: 5, kind: "nonsense" }, post);
    check("unknown kind answers ok:false", replies[5].ok === false && /unknown job kind/.test(replies[5].err));

    await handleTextureWorkerMessage({ type: "cancel", seq: 6 }, post);
    await handleTextureWorkerMessage({ type: "job", seq: 6, kind: "xu7", bytes: PAYLOAD.slice().buffer }, post);
    check("cancel-before-job answers ok:false cancelled", replies[6].ok === false && replies[6].err === "cancelled");

    const rgba = new Uint8Array(8 * 8 * 4).fill(200);
    await handleTextureWorkerMessage({ type: "job", seq: 7, kind: "nra-derive", width: 8, height: 8, rgba: rgba.buffer }, post);
    const r7 = replies[7];
    check("nra-derive answers a plane", r7.ok === true && r7.plane instanceof ArrayBuffer && r7.plane.byteLength === 8 * 8 * 4);
    const plane = new Uint8Array(r7.plane);
    check("uniform input derives flat/neutral texels", plane[0] === 128 && plane[1] === 128 && plane[2] === 0 && plane[3] === 255);
  }

  // ---------------------------------------------------------------- PART 4 --
  console.log("PART 4 — byte-identity: worker route vs main route (no eye item)");
  {
    // Arm BOTH sides with the same deterministic fake transcoder.
    // Main route: flag off, budget off = the pre-ST4 straight-through call.
    noWindow();
    withSearch("?texWorkers=off&xu7Budget=off");
    _resetXu7ForTest();
    _resetTexWorkerForTest();
    _resetTextureWorkerForTest();
    _setXu7ModuleForTest(fakeModule({ dim: 32, levels: 4 }));
    await xu7Transcoder();
    const mainOut = await transcodeXu7(PAYLOAD.slice());
    check("main route resolved", mainOut && mainOut.width === 32 && mainOut.levels.length === 4);

    // Worker route: flag on, mock worker running the real handler.
    withSearch("?texWorkers=on");
    _resetXu7ForTest();
    _resetTexWorkerForTest();
    _resetTextureWorkerForTest();
    _setWorkerTranscoderForTest(fakeModule({ dim: 32, levels: 4 }));
    let mock = null;
    _setTexWorkerFactoryForTest(() => {
      mock = new MockWorker();
      return mock;
    });
    // First call races the (instant, mocked) init — allow the ready to land.
    const p = transcodeXu7(PAYLOAD.slice());
    await tick();
    await tick();
    let workerOut = await p;
    if (workerOut === null) {
      // The first ask legitimately rode the FIFO while the worker was
      // loading (ask-don't-await). With no xu7 module armed on the main arm
      // that resolves null — retry now that the worker is ready.
      check("not-ready ask fell back and was counted", texWorkerStats().fifoFallbacks >= 1);
      workerOut = await transcodeXu7(PAYLOAD.slice());
    } else {
      check("worker served the first ask", true);
    }
    check("worker route resolved", !!workerOut && workerOut.width === 32 && workerOut.levels.length === 4, JSON.stringify(texWorkerStats()));
    let identical =
      workerOut && mainOut.width === workerOut.width && mainOut.height === workerOut.height &&
      mainOut.blocksX === workerOut.blocksX && mainOut.blocksY === workerOut.blocksY &&
      mainOut.levels.length === workerOut.levels.length;
    if (identical) {
      for (let i = 0; i < mainOut.levels.length; i += 1) {
        if (!bytesEqual(mainOut.levels[i].data, workerOut.levels[i].data)) identical = false;
        if (mainOut.levels[i].width !== workerOut.levels[i].width) identical = false;
        if (mainOut.levels[i].height !== workerOut.levels[i].height) identical = false;
      }
    }
    check("BYTE-IDENTICAL parsed output across arms", !!identical);
    const st = texWorkerStats();
    check("worker jobs counted", st.jobs >= 1, `jobs=${st.jobs}`);
    check("msTranscode accumulated", st.msTranscode >= 0 && typeof st.msTranscode === "number");
    check("queue drained", st.queueDepth === 0 && st.inflight === 0);
  }

  // ---------------------------------------------------------------- PART 5 --
  console.log("PART 5 — terrain assembly: worker vs synchronous, byte-identical");
  {
    // 33 layers over 4 shared payloads (retail shares rsIds — the dedup path).
    const tileSize = 8;
    const levels = 4; // 8→4→2→1
    const rsIds = ["0x06AA0001", "0x06AA0002", "0x06AA0003", "0x06AA0004"];
    const payloadsByRs = new Map(rsIds.map((rs, i) => [rs, makeHbc7(tileSize, levels, 17 + i * 5)]));
    const layerRs = [];
    for (let i = 0; i < TERRAIN_BC7_DEPTH; i += 1) layerRs.push(rsIds[i % rsIds.length]);
    const byLayer = layerRs.map((rs) => parseHbc7(payloadsByRs.get(rs)));
    const ch = { byLayer, tileSize, levels, layerRs };

    const syncTex = buildTerrainBc7Array(ch, { anisotropy: 16, name: "t" });
    check("sync build produced a texture", !!syncTex && syncTex.mipmaps.length === levels);

    // Worker-side pure assembly.
    const assembled = assembleTerrainChannel({
      tileSize,
      levels,
      depth: TERRAIN_BC7_DEPTH,
      layerRs,
      payloads: rsIds.map((rs) => ({ rs, bytes: payloadsByRs.get(rs).slice().buffer })),
    });
    check("assembled levelBytes match sync mipmap sizes",
      assembled.levelBytes.every((n, i) => n === syncTex.mipmaps[i].data.byteLength));
    let same = true;
    {
      let off = 0;
      for (let i = 0; i < levels; i += 1) {
        const view = assembled.bc7.subarray(off, off + assembled.levelBytes[i]);
        if (!bytesEqual(view, syncTex.mipmaps[i].data)) same = false;
        off += assembled.levelBytes[i];
      }
    }
    check("assembled bytes BYTE-IDENTICAL to sync mipmaps", same);

    const fromAssembled = buildTerrainBc7ArrayFromAssembled(
      { tileSize, levels, depth: TERRAIN_BC7_DEPTH, levelBytes: assembled.levelBytes, bc7: assembled.bc7.buffer },
      { anisotropy: 16, name: "t" },
    );
    check("FromAssembled texture flags match sync twin",
      fromAssembled.format === syncTex.format &&
      fromAssembled.minFilter === syncTex.minFilter &&
      fromAssembled.magFilter === syncTex.magFilter &&
      fromAssembled.wrapS === syncTex.wrapS &&
      fromAssembled.colorSpace === syncTex.colorSpace &&
      fromAssembled.anisotropy === syncTex.anisotropy &&
      fromAssembled.image.depth === syncTex.image.depth);
    let sameTex = fromAssembled.mipmaps.length === syncTex.mipmaps.length;
    for (let i = 0; sameTex && i < levels; i += 1) {
      if (!bytesEqual(fromAssembled.mipmaps[i].data, syncTex.mipmaps[i].data)) sameTex = false;
    }
    check("FromAssembled mipmaps byte-identical", sameTex);

    // Validation: a missing layer / wrong dims / wrong level count all throw.
    for (const [label, bad] of [
      ["missing layer", { tileSize, levels, depth: TERRAIN_BC7_DEPTH, layerRs: layerRs.map((r, i) => (i === 5 ? "0xDEAD" : r)), payloads: rsIds.map((rs) => ({ rs, bytes: payloadsByRs.get(rs).slice().buffer })) }],
      ["wrong tileSize", { tileSize: 16, levels, depth: TERRAIN_BC7_DEPTH, layerRs, payloads: rsIds.map((rs) => ({ rs, bytes: payloadsByRs.get(rs).slice().buffer })) }],
      ["wrong level count", { tileSize, levels: 3, depth: TERRAIN_BC7_DEPTH, layerRs, payloads: rsIds.map((rs) => ({ rs, bytes: payloadsByRs.get(rs).slice().buffer })) }],
    ]) {
      let threw = false;
      try { assembleTerrainChannel(bad); } catch (_) { threw = true; }
      check(`all-or-nothing: ${label} throws`, threw);
    }

    // End-to-end through the client + mock worker.
    withSearch("?texWorkers=on");
    _resetTexWorkerForTest();
    _resetTextureWorkerForTest();
    _setTexWorkerFactoryForTest(() => new MockWorker());
    const res = await workerTerrainAssemble({
      tileSize,
      levels,
      depth: TERRAIN_BC7_DEPTH,
      layerRs,
      payloads: rsIds.map((rs) => ({ rs, bytes: payloadsByRs.get(rs).slice().buffer })),
    });
    check("client round-trip ok", res.ok === true && res.levelBytes.length === levels);
    const viaClient = buildTerrainBc7ArrayFromAssembled(res, { anisotropy: 16, name: "t" });
    let sameE2e = viaClient.mipmaps.length === levels;
    for (let i = 0; sameE2e && i < levels; i += 1) {
      if (!bytesEqual(viaClient.mipmaps[i].data, syncTex.mipmaps[i].data)) sameE2e = false;
    }
    check("end-to-end mipmaps byte-identical to sync twin", sameE2e);
    check("terrainAssembles counted + msAssemble accumulated",
      texWorkerStats().terrainAssembles === 1 && typeof texWorkerStats().msAssemble === "number");
  }

  // ---------------------------------------------------------------- PART 6 --
  console.log("PART 6 — fallback engagement: automatic, resolved, COUNTED");
  {
    // (a) Construction failure ⇒ dead, counted; the FIFO still serves.
    withSearch("?texWorkers=on");
    _resetXu7ForTest();
    _resetTexWorkerForTest();
    _setTexWorkerFactoryForTest(() => {
      throw new Error("no Worker in this environment");
    });
    _setXu7ModuleForTest(fakeModule({ dim: 16, levels: 2 }));
    await xu7Transcoder();
    const p1 = transcodeXu7(PAYLOAD.slice());
    await flushMicrotasks();
    _drainXu7QueueForTest();
    const out1 = await p1;
    check("construction failure: caller still resolves via the FIFO", !!out1 && out1.width === 16);
    let st = texWorkerStats();
    check("state is dead", st.state === "dead", st.state);
    check("fallbackEngagements counted", st.fallbackEngagements === 1, `n=${st.fallbackEngagements}`);
    check("fifoFallbacks counted", st.fifoFallbacks >= 1, `n=${st.fifoFallbacks}`);
    check("lastError names the cause", /no Worker/.test(String(st.lastError)));

    // Dead worker stays dead: subsequent asks route FIFO, counted each time.
    const before = texWorkerStats().fifoFallbacks;
    const p1b = transcodeXu7(PAYLOAD.slice());
    await flushMicrotasks();
    _drainXu7QueueForTest();
    await p1b;
    check("dead worker: every later ask counted too", texWorkerStats().fifoFallbacks === before + 1);

    // (b) Crash mid-job ⇒ pending nulled (hbc7 route), counted; later asks FIFO.
    _resetXu7ForTest();
    _resetTexWorkerForTest();
    _resetTextureWorkerForTest();
    let mock = null;
    _setTexWorkerFactoryForTest(() => {
      // Ready arrives, but jobs are swallowed — then we crash it.
      mock = new MockWorker({ silent: true });
      setTimeout(() => {
        if (mock.onmessage) mock.onmessage({ data: { type: "ready" } });
      }, 0);
      return mock;
    });
    _setXu7ModuleForTest(fakeModule({ dim: 16, levels: 2 }));
    await xu7Transcoder();
    // Prime construction, wait for ready.
    const warm = transcodeXu7(PAYLOAD.slice());
    await tick();
    await flushMicrotasks();
    _drainXu7QueueForTest(); // the not-ready first ask rides the FIFO
    await warm;
    check("mock reached ready", _texWorkerStateForTest() === "ready");
    const hung = transcodeXu7(PAYLOAD.slice()); // posted to the silent worker
    await tick();
    mock.crash("simulated worker crash");
    const outHung = await Promise.race([hung, new Promise((r) => setTimeout(() => r("HUNG"), 500))]);
    check("crash mid-job: pending job resolves null (hbc7 route), never hangs", outHung === null);
    st = texWorkerStats();
    check("pendingNulled counted", st.pendingNulled === 1, `n=${st.pendingNulled}`);
    check("crash counted as fallback engagement", st.fallbackEngagements === 1);
    check("state dead after crash", st.state === "dead");

    // (c) Terrain: dead worker ⇒ workerTerrainAssemble throws + counted
    // (terrain_bc7.js catches, re-fetches, falls back to the sync build).
    let threw = false;
    try {
      await workerTerrainAssemble({ tileSize: 8, levels: 4, depth: TERRAIN_BC7_DEPTH, layerRs: [], payloads: [] });
    } catch (_) {
      threw = true;
    }
    check("terrain assembly on a dead worker throws (caller falls back)", threw);
    check("terrainFallbacks counted", texWorkerStats().terrainFallbacks === 1);

    // (d) nra-derive is ask-only: not-ready ⇒ null, no waiting.
    _resetTexWorkerForTest();
    _setTexWorkerFactoryForTest(() => new MockWorker({ silent: true }));
    const nraOut = await workerDeriveNra({ width: 4, height: 4, rgba: new Uint8Array(64).buffer });
    check("nra-derive while worker not ready returns null (ask-only)", nraOut === null);
  }

  // ---------------------------------------------------------------- PART 7 --
  console.log("PART 7 — cancel semantics");
  {
    withSearch("?texWorkers=on");
    _resetXu7ForTest();
    _resetTexWorkerForTest();
    _resetTextureWorkerForTest();
    let mock = null;
    _setTexWorkerFactoryForTest(() => {
      mock = new MockWorker({ silent: true });
      setTimeout(() => {
        if (mock.onmessage) mock.onmessage({ data: { type: "ready" } });
      }, 0);
      return mock;
    });
    // Bring the client up.
    _setXu7ModuleForTest(fakeModule({ dim: 16, levels: 2 }));
    await xu7Transcoder();
    const first = transcodeXu7(PAYLOAD.slice());
    await tick();
    await flushMicrotasks();
    _drainXu7QueueForTest();
    await first;
    check("client ready", _texWorkerStateForTest() === "ready");
    // seq numbering is internal; jobs 2 and 3 are the in-flight + queued pair.
    const inflightP = transcodeXu7(PAYLOAD.slice());
    const queuedP = transcodeXu7(PAYLOAD.slice());
    await flushMicrotasks();
    const stBefore = texWorkerStats();
    check("one in flight, one queued", stBefore.inflight === 1 && stBefore.queueDepth === 2, JSON.stringify({ i: stBefore.inflight, q: stBefore.queueDepth }));
    // The queued job's seq is inflight seq + 1; cancel it.
    let cancelledQueued = false;
    for (let seq = 1; seq < 10 && !cancelledQueued; seq += 1) {
      // find the queued one: cancelling the in-flight seq posts to the worker
      // (silent here), cancelling the queued seq resolves it null NOW.
      if (texWorkerStats().queueDepth < 2) break;
      cancelledQueued = cancelTextureWorkerJob(seq) && texWorkerStats().queueDepth === 1;
    }
    check("queued job cancellable (resolves null immediately)", cancelledQueued);
    const q = await Promise.race([queuedP, new Promise((r) => setTimeout(() => r("HUNG"), 300))]);
    check("cancelled queued job resolved null", q === null);
    check("cancels counted", texWorkerStats().cancels >= 1);
    // Clean up the in-flight promise (kill the worker; it null-resolves).
    mock.crash("teardown");
    const inflightOut = await Promise.race([inflightP, new Promise((r) => setTimeout(() => r("HUNG"), 300))]);
    check("in-flight settled on teardown", inflightOut === null);
  }

  // teardown
  _resetXu7ForTest();
  _resetTexWorkerForTest();
  _resetTextureWorkerForTest();
  _setTexWorkerFactoryForTest(null);
  noWindow();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

run().catch((e) => {
  console.error(e);
  process.exit(1);
});
