// tests/film_runtime_capture.test.mjs
//
// WHY: AC Film Mode's page runtime part 2 turns a prepared shot into footage:
// the take player runs every frame in the SPEC §3 order (trajectory → drone →
// pilot residual → safety → camera write → stepped render → grab inside
// postRender), the WebCodecs recorder encodes HUD-free frames with film-time
// timestamps and hands Annex-B H.264 to the CLI through drain(), and the page
// JEV bridge carries pilot decisions to the Node broker without ever throwing
// into the pilot. A bug here ruins takes silently: wrong µs timestamps (a
// stretched or juddering edit), a VideoFrame never closed (GPU memory leak →
// the 1070 tab dies mid-shoot), a keyframe interval nobody can seek in,
// base64 that corrupts the Annex-B start codes, no backpressure (the page
// runs out of memory on a long take), a pre-roll frame in the footage, a
// slowed pilot that cuts the shot short, a locked replay that does not
// reproduce its rehearsal, a rack focus that never pulls. This suite EXECUTES
// the real modules (recorder.js, take_player.js, jev_bridge_page.js, plus the
// real trajectory / registry / flight model / pilot / camera-owner hooks) with
// fake VideoEncoder / VideoFrame / canvas / clock / sensors / safety:
//   R1 codec helpers + base64 (Buffer vs portable chunked path, > 32 KiB);
//   R2 config fallback chain (avc1.640033 → avc1.4d0033 → vp09 → frames, hw prefs);
//   R3 grab: µs timestamps = round(k/fps·1e6), duration, keyframe interval, close();
//   R4 Annex-B bytes preserved through base64 (CLI drain.mjs sniff + chunkBytes);
//   R5 drain chunking by maxBytes, done only after stop + empty queue;
//   R6 backpressure on encodeQueueSize / undrained bytes, timeout path;
//   R7 frames fallback (toDataURL JPEG), stop/abort/encoder error;
//   B1 page bridge: available re-evaluated, success / error envelopes, timeout,
//      too-large, never rejects; B2 the real pilot over the bridge (jev + fallback);
//   P1 pure residual math (path frame, subject re-aim, nadir framing nudge);
//   T1 take player stepped e2e: frames = duration·fps, pre-roll rendered not
//      recorded, timestamps, speedScale < 1 extends progress, cap, safety
//      adjustments recorded, locked replay reproduces the realised checksum,
//      DoF driven from the focus channel (fake window.__dof, classic.rack-focus),
//      realtime rAF mode, drone family, fades, actor cues, abort, errors;
//   T2 review fixes: static placement fades (node marker + visible, InstancedMesh
//      instance, BatchedMesh setVisibleAt) applied and restored exactly, a reveal
//      shot's own occluder kept, the sensors told what is faded (round 2: a real
//      BatchedMesh instance another owner parked or re-placed mid-take is left as they
//      left it, the setVisibleAt watch removed after); a fade that hides
//      nothing reroutes (r4: with the REAL world query a procedural scenery key
//      hides nothing and reroutes, a placed tree's key fades); the safety lens is released BEFORE the fades are restored
//      (a faded smoke cloud never stays hidden — real safety.js); indoor takes sense
//      the EnvCell walls through the real sensors (pre-roll + take);
//   T3 realtime takes on the film grid (review gate-0 / seams-4 / contracts-4 /
//      tooling-1): 22 / 30 / 60 Hz, jittery, throttled (undrawn) and backpressured
//      displays all give exactly round(D·fps) frames stamped n/fps (encoder, CLI
//      drain sink, realised table), each grid point = the first drawn frame at
//      wall t ≥ n/fps, held frames = one canvas wrap re-stamped (recorder
//      grab([t…])); a slowed take grows to ⌈wall·fps⌉ frames and replays locked
//      bit-identically; the injected particle cull runs at recheckInterval 1;
//   L1 live subjects (review math-0 / contracts-0): every realtime moving-subject
//      rig re-anchored to a t-ignoring live subject (walk, turn, snap, re-aim);
//   L2 round 2: a subject already walking at prepare (reference EXTRAPOLATED from
//      its velocity) that keeps walking through the pre-roll — no surge at the take
//      start (per-frame camera speed ≤ 1.25× the walk, distance ±15 %), realtime
//      and stepped, flown rigs reset at the walk's speed; one that stopped stays put;
//   F1 flight feasibility (review math-2): 'overspeed' + a VERIFIED minDurationSec
//      from the larger of the profile peak and the measured nominal peak (heavy-lift
//      gap pass, an ease that a longer duration cannot fix, unprofiled helix);
//   F2 the rehearse result / shoot report carry prepare's validation + flight check
//      and the run's craft tracking (maxGapM / endGapM);
//   L3 round 3 (check:r2-subject): flown carry rigs get the FULL time derivative of the
//      re-anchored pose as feed-forward — a subject walking 45° off the reference heading
//      (first step at the walk, ±2 %, craft on its nominal) and one turning 90°/s, beyond
//      the craft's amax (±15 %, no per-frame speed spike, the budgeted swing completes),
//      at 24 / 30 / 60 fps;
//   F3 round 3: the flight check DRY-FLIES the nominal (FLIGHT_CHECK) — acceleration-limited
//      moves within vmax are flagged, the searched minDurationSec really flies (realised
//      rehearsal), round 2's false 'verified' is gone, no technique is flagged at its default
//      duration, and the bounded search reports 'unverified' when its work budget runs out;
//   T4 Egg Orchard FPV run (DESIGN §3): traj.meta.lockWindows pin speedScale to 1 and hold
//      the pilot residual (eased to 0 over 0.4 s, blended back after), stepped and realtime,
//      byte-identical without windows; fade() refuses creature / npc / player guids (reported,
//      reroute fallback); pilot.fade 'never' (real code pilot) fades nothing and reroutes;
//   E1 the pre-roll AdminEnvirons wait (review contracts-5 / seams-3 / gate-1):
//      a look.fog change → rehearse / shoot (stepped and realtime) wait on the
//      LIVE loop until the REAL environ_override.js roll-in (+ one forced retail
//      light tick) has settled, reported in the take report; the same fog
//      re-applied never waits; bounded (30 s), a stalled override, no accessor,
//      a dry rehearsal and abort() all stop the wait.
//
// Flag: filmMode (DEFAULT OFF, `?filmMode=on`) — these modules load only under it.
// Run from apps/holtburger-web/: node tests/film_runtime_capture.test.mjs

import assert from "node:assert/strict";

const REC = await import("../scene3d/film/runtime/recorder.js");
const TP = await import("../scene3d/film/runtime/take_player.js");
const BR = await import("../scene3d/film/runtime/jev_bridge_page.js");
const { ensureFilmHooks } = await import("../scene3d/film/runtime/camera_owner.js");
const TR = await import("../scene3d/film/shots/trajectory.js");
const SHOTS = await import("../scene3d/film/shots/index.js");
const GB = await import("../scene3d/film/core/gimbal.js");
const { qRotate } = await import("../scene3d/film/core/quat.js");
const FR = await import("../scene3d/film/shots/framing.js");
const { createPilot } = await import("../scene3d/film/pilot/pilot.js");
const { neutralAnswers } = await import("../scene3d/film/pilot/policy_code.js");
const { emptySensorFrame, createSensors } = await import("../scene3d/film/scene/sensors.js");
const { createSafety } = await import("../scene3d/film/runtime/safety.js");
const LOS = await import("../scene3d/film/scene/los.js");
const WQ = await import("../scene3d/film/scene/world_query.js");
const { FilmError } = await import("../scene3d/film/core/errors.js");
const DRAIN = await import("../tools/film/lib/drain.mjs");
const ENVO = await import("../scene3d/environ_override.js");
const LT = await import("../scene3d/retail_light_tick.js");
const LK = await import("../scene3d/film/runtime/look.js");

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}

const near = (a, b, eps = 1e-6, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// fakes: WebCodecs + canvas
// ---------------------------------------------------------------------------

/** Annex-B access unit: 4-byte start code + NAL header (IDR 0x65 / slice 0x41) + payload. */
function annexB(seq, key, size = 64) {
  const b = new Uint8Array(size);
  b.set([0, 0, 0, 1, key ? 0x65 : 0x41]);
  for (let i = 5; i < size; i += 1) b[i] = (seq * 31 + i * 7) & 0xff;
  if (key) b.set([0, 0, 0, 1, 0x67], size - 10); // an in-band SPS start code mid-chunk
  return b;
}

/**
 * A fake VideoEncoder class family. `supported(cfg)` decides isConfigSupported;
 * `manual` keeps encodes pending (encodeQueueSize) until process(); `size(seq)`
 * chooses the chunk byte size.
 */
function makeEncoderClass(o = {}) {
  const supported = o.supported ?? (() => true);
  const queries = [];
  const instances = [];
  class FakeVideoEncoder {
    static async isConfigSupported(cfg) {
      queries.push({ ...cfg });
      return { supported: !!supported(cfg), config: cfg };
    }

    constructor({ output, error }) {
      this.output = output;
      this.error = error;
      this.state = "unconfigured";
      this.encodeQueueSize = 0;
      this.encoded = [];
      this.pendingFrames = [];
      this.seq = 0;
      this.flushed = 0;
      instances.push(this);
    }

    configure(cfg) {
      if (o.configureThrows && o.configureThrows(cfg)) throw new Error(`cannot configure ${cfg.codec}`);
      this.config = cfg;
      this.state = "configured";
    }

    encode(frame, opts) {
      if (this.state !== "configured") throw new Error(`encode in state ${this.state}`);
      if (frame.closed) throw new Error("frame already closed");
      const rec = { timestamp: frame.timestamp, duration: frame.duration, keyFrame: !!(opts && opts.keyFrame), init: frame.init };
      this.encoded.push(rec);
      if (o.manual) {
        this.pendingFrames.push(rec);
        this.encodeQueueSize = this.pendingFrames.length;
      } else this.emit(rec);
    }

    emit(rec) {
      const seq = this.seq++;
      const bytes = annexB(seq, rec.keyFrame, o.size ? o.size(seq) : 64);
      this.output({
        type: rec.keyFrame ? "key" : "delta",
        timestamp: rec.timestamp,
        duration: rec.duration,
        byteLength: bytes.length,
        copyTo(dst) {
          dst.set(bytes);
        },
        _bytes: bytes,
      });
    }

    process(n = Infinity) {
      let k = 0;
      while (this.pendingFrames.length && k < n) {
        this.emit(this.pendingFrames.shift());
        k += 1;
      }
      this.encodeQueueSize = this.pendingFrames.length;
      return k;
    }

    async flush() {
      this.flushed += 1;
      this.process();
    }

    close() {
      this.state = "closed";
    }
  }
  FakeVideoEncoder.queries = queries;
  FakeVideoEncoder.instances = instances;
  return FakeVideoEncoder;
}

/** A fake VideoFrame class that remembers every frame and whether it was closed. */
function makeFrameClass() {
  const frames = [];
  class FakeVideoFrame {
    constructor(source, init) {
      this.source = source;
      this.init = { ...init };
      this.timestamp = init.timestamp;
      this.duration = init.duration;
      this.closed = false;
      frames.push(this);
    }

    close() {
      this.closed = true;
    }
  }
  FakeVideoFrame.frames = frames;
  return FakeVideoFrame;
}

function fakeCanvas(w = 1280, h = 720, jpeg = true) {
  const c = { width: w, height: h, dataUrls: 0 };
  if (jpeg) {
    c.toDataURL = (type, q) => {
      c.dataUrls += 1;
      c.lastType = type;
      c.lastQ = q;
      const bytes = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, c.dataUrls & 0xff, 1, 2, 3, 0xff, 0xd9]);
      return `data:image/jpeg;base64,${Buffer.from(bytes).toString("base64")}`;
    };
  }
  return c;
}

// ---------------------------------------------------------------------------
// R1 helpers
// ---------------------------------------------------------------------------

check("R1 codec helpers: codecKind / evenDim / base64Length / encoderConfig", () => {
  assert.equal(REC.codecKind("avc1.640033"), "avc");
  assert.equal(REC.codecKind("AVC"), "avc");
  assert.equal(REC.codecKind("vp09.00.40.08"), "vp9");
  assert.equal(REC.codecKind("frames"), "frames");
  assert.equal(REC.codecKind("hevc"), null);
  assert.equal(REC.evenDim(1921), 1920);
  assert.equal(REC.evenDim(1080), 1080);
  assert.equal(REC.evenDim(NaN), null);
  assert.equal(REC.evenDim(-4), null);
  assert.equal(REC.base64Length(0), 0);
  assert.equal(REC.base64Length(1), 4);
  assert.equal(REC.base64Length(3000), 4000);
  const a = REC.encoderConfig("avc1.640033", { width: 1920, height: 1080, bitrate: 40e6, fps: 30 });
  assert.deepEqual(a, { codec: "avc1.640033", width: 1920, height: 1080, bitrate: 40e6, framerate: 30, latencyMode: "quality", hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } });
  const v = REC.encoderConfig("vp09.00.40.08", { width: 1920, height: 1080, bitrate: 40e6, fps: 30, hardwareAcceleration: "no-preference" });
  assert.equal(v.avc, undefined, "VP9 has no avc key");
  assert.equal(v.hardwareAcceleration, "no-preference");
  assert.deepEqual(REC.RECORDER_CODEC_CHAINS.avc, ["avc1.640033", "avc1.4d0033", "vp09.00.40.08", "frames"]);
});

check("R1 bytesToBase64: Buffer path == portable chunked path (> 32 KiB, all byte values)", () => {
  const big = new Uint8Array(100003);
  for (let i = 0; i < big.length; i += 1) big[i] = (i * 131 + (i >> 8)) & 0xff;
  const a = REC.bytesToBase64(big);
  const b = REC.bytesToBase64Portable(big);
  assert.equal(a, b);
  assert.equal(a, Buffer.from(big).toString("base64"));
  assert.equal(a.length, REC.base64Length(big.length));
  // a subarray view (offset) encodes only its own bytes
  const view = big.subarray(10, 20);
  assert.equal(REC.bytesToBase64Portable(view), Buffer.from(view).toString("base64"));
  assert.equal(REC.bytesToBase64(new Uint8Array(0)), "");
  assert.throws(() => REC.bytesToBase64("nope"), TypeError);
});

// ---------------------------------------------------------------------------
// R2 fallback chain
// ---------------------------------------------------------------------------

check("R2 avc1.640033 with prefer-hardware is the first choice; config is exact", async () => {
  const E = makeEncoderClass();
  const F = makeFrameClass();
  const r = REC.createRecorder({ canvas: fakeCanvas(1921, 1081), fps: 30, codec: "avc", VideoEncoder: E, VideoFrame: F });
  const s = await r.start();
  assert.equal(s.codec, "avc1.640033");
  assert.equal(s.kind, "avc");
  assert.equal(s.hardwareAcceleration, "prefer-hardware");
  const cfg = E.instances[0].config;
  assert.deepEqual(cfg, { codec: "avc1.640033", width: 1920, height: 1080, bitrate: 40000000, framerate: 30, latencyMode: "quality", hardwareAcceleration: "prefer-hardware", avc: { format: "annexb" } });
  assert.equal(E.queries.length, 1);
  // odd canvas → cropped (visibleRect) to the even encoder size, not scaled
  r.grab(0);
  assert.deepEqual(F.frames[0].init.visibleRect, { x: 0, y: 0, width: 1920, height: 1080 });
  assert.equal(F.frames[0].init.alpha, "discard");
});

check("R2 chain walks avc1.640033 → avc1.4d0033 (each hw pref) → vp09 → frames", async () => {
  // Only Main profile in software.
  let E = makeEncoderClass({ supported: (c) => c.codec === "avc1.4d0033" && c.hardwareAcceleration === "no-preference" });
  let r = REC.createRecorder({ canvas: fakeCanvas(), codec: "avc", VideoEncoder: E, VideoFrame: makeFrameClass() });
  let s = await r.start();
  assert.equal(s.codec, "avc1.4d0033");
  assert.equal(s.hardwareAcceleration, "no-preference");
  assert.deepEqual(E.queries.map((q) => `${q.codec}/${q.hardwareAcceleration}`), [
    "avc1.640033/prefer-hardware", "avc1.640033/no-preference", "avc1.4d0033/prefer-hardware", "avc1.4d0033/no-preference",
  ]);
  assert.equal(s.fallbacks.length, 3);
  // Only VP9.
  E = makeEncoderClass({ supported: (c) => c.codec.startsWith("vp09") });
  r = REC.createRecorder({ canvas: fakeCanvas(), codec: "avc", VideoEncoder: E, VideoFrame: makeFrameClass() });
  s = await r.start();
  assert.equal(s.codec, "vp09.00.40.08");
  assert.equal(s.kind, "vp9");
  assert.equal(E.instances[0].config.avc, undefined);
  // Nothing → JPEG frames.
  E = makeEncoderClass({ supported: () => false });
  r = REC.createRecorder({ canvas: fakeCanvas(), codec: "avc", VideoEncoder: E, VideoFrame: makeFrameClass() });
  s = await r.start();
  assert.equal(s.codec, "frames");
  assert.equal(r.stats().kind, "frames");
  // configure() throwing counts as unsupported.
  E = makeEncoderClass({ configureThrows: (c) => c.codec === "avc1.640033" });
  r = REC.createRecorder({ canvas: fakeCanvas(), codec: "avc", VideoEncoder: E, VideoFrame: makeFrameClass() });
  s = await r.start();
  assert.equal(s.codec, "avc1.4d0033");
  assert.ok(s.fallbacks.some((f) => /configure threw/.test(f.reason)));
  // No WebCodecs at all → frames; 'vp9' requested starts at vp09.
  r = REC.createRecorder({ canvas: fakeCanvas(), codec: "avc", VideoEncoder: null, VideoFrame: null });
  assert.equal((await r.start()).codec, "frames");
  E = makeEncoderClass();
  r = REC.createRecorder({ canvas: fakeCanvas(), codec: "vp9", VideoEncoder: E, VideoFrame: makeFrameClass() });
  assert.equal((await r.start()).codec, "vp09.00.40.08");
});

check("R2 nothing usable → FILM_RECORDER_UNAVAILABLE; bad codec / no canvas → BAD_ARGUMENT; double start refused", async () => {
  const E = makeEncoderClass({ supported: () => false });
  const r = REC.createRecorder({ canvas: fakeCanvas(1280, 720, false), codec: "avc", VideoEncoder: E, VideoFrame: makeFrameClass() });
  await assert.rejects(r.start(), (e) => e instanceof FilmError && e.code === "FILM_RECORDER_UNAVAILABLE");
  assert.equal(r.state, "failed");
  assert.throws(() => REC.createRecorder({ canvas: fakeCanvas(), codec: "hevc" }), (e) => e.code === "BAD_ARGUMENT");
  assert.throws(() => REC.createRecorder({}), (e) => e.code === "BAD_ARGUMENT");
  const ok = REC.createRecorder({ canvas: fakeCanvas(), VideoEncoder: makeEncoderClass(), VideoFrame: makeFrameClass() });
  await ok.start();
  await assert.rejects(ok.start(), (e) => e.code === "FILM_RECORDER_STATE");
});

// ---------------------------------------------------------------------------
// R3 grab
// ---------------------------------------------------------------------------

check("R3 grab: µs timestamps = round(k/fps·1e6), duration, keyframe every keyIntervalSec·fps, every frame closed", async () => {
  const E = makeEncoderClass();
  const F = makeFrameClass();
  const fps = 30;
  const r = REC.createRecorder({ canvas: fakeCanvas(), fps, keyIntervalSec: 0.5, VideoEncoder: E, VideoFrame: F });
  assert.equal(r.grab(0), false, "grab before start is refused");
  await r.start();
  const N = 47;
  for (let k = 0; k < N; k += 1) assert.equal(r.grab(k / fps), true);
  const enc = E.instances[0].encoded;
  assert.equal(enc.length, N);
  for (let k = 0; k < N; k += 1) {
    assert.equal(enc[k].timestamp, Math.round((k / fps) * 1e6), `frame ${k} timestamp`);
    assert.equal(enc[k].duration, Math.round(1e6 / fps));
    assert.equal(enc[k].keyFrame, k % 15 === 0, `frame ${k} keyFrame`);
  }
  assert.equal(F.frames.length, N);
  assert.ok(F.frames.every((f) => f.closed), "every VideoFrame closed");
  assert.equal(F.frames[0].source.width, 1280, "the frame is made from the canvas");
  // A non-increasing time is bumped (encoders need increasing timestamps).
  r.grab(0.1);
  assert.ok(enc[N].timestamp > enc[N - 1].timestamp);
  assert.equal(r.stats().timestampFixes, 1);
  assert.equal(r.stats().framesGrabbed, N + 1);
  const st = await r.stop();
  assert.equal(st.state, "stopped");
  assert.equal(r.grab(5), false, "grab after stop is refused");
});

check("R3 a throwing encode still closes the frame and fails the recorder", async () => {
  const E = makeEncoderClass();
  const F = makeFrameClass();
  const r = REC.createRecorder({ canvas: fakeCanvas(), VideoEncoder: E, VideoFrame: F });
  await r.start();
  E.instances[0].state = "closed"; // the GPU process went away
  assert.equal(r.grab(0), false);
  assert.ok(F.frames[0].closed, "closed in finally");
  assert.equal(r.state, "failed");
  assert.equal(r.stats().grabFailures, 1);
  assert.equal(r.drain().done, true, "a failed recorder with nothing queued is done");
});

// ---------------------------------------------------------------------------
// R4 / R5 drain
// ---------------------------------------------------------------------------

check("R4 Annex-B bytes survive base64 drain bit-exactly; the CLI sniffs 'avc' and names the codec", async () => {
  const E = makeEncoderClass();
  const r = REC.createRecorder({ canvas: fakeCanvas(), fps: 30, keyIntervalSec: 0.1, VideoEncoder: E, VideoFrame: makeFrameClass() });
  await r.start();
  const sent = [];
  for (let k = 0; k < 9; k += 1) r.grab(k / 30);
  // the fake emitted annexB(seq, key) for each
  const enc = E.instances[0];
  for (let s = 0; s < 9; s += 1) sent.push(annexB(s, enc.encoded[s].keyFrame));
  await r.stop();
  const d = r.drain({ maxBytes: 1 << 20 });
  assert.equal(d.chunks.length, 9);
  assert.equal(d.done, true);
  d.chunks.forEach((c, i) => {
    const bytes = DRAIN.chunkBytes(c);
    assert.deepEqual(new Uint8Array(bytes), sent[i], `chunk ${i} bytes`);
    assert.equal(DRAIN.sniffChunkKind(bytes), "avc");
    assert.equal(c.seq, i);
    assert.equal(c.timestampUs, Math.round((i / 30) * 1e6));
    assert.equal(c.key, enc.encoded[i].keyFrame);
    assert.equal(c.type, c.key ? "key" : "delta");
  });
  assert.equal(DRAIN.kindOfCodec(d.stats.codec), "avc");
  assert.equal(d.stats.keyFrames, d.chunks.filter((c) => c.key).length);
});

check("R5 drain splits by maxBytes (base64 chars), ≥ 1 chunk per call, done only after stop + empty queue", async () => {
  const E = makeEncoderClass({ size: () => 3000 }); // 3000 B → 4000 base64 chars
  const r = REC.createRecorder({ canvas: fakeCanvas(), VideoEncoder: E, VideoFrame: makeFrameClass() });
  await r.start();
  for (let k = 0; k < 5; k += 1) r.grab(k / 30);
  let d = r.drain({ maxBytes: 9000 });
  assert.equal(d.chunks.length, 2);
  assert.ok(d.chunks.reduce((a, c) => a + c.b64.length, 0) <= 9000);
  assert.equal(d.done, false, "still recording");
  d = r.drain({ maxBytes: 100 });
  assert.equal(d.chunks.length, 1, "an oversize chunk still drains alone");
  d = r.drain({ maxBytes: 1e9 });
  assert.equal(d.chunks.length, 2);
  assert.equal(d.done, false, "not stopped yet");
  assert.equal(r.drain().chunks.length, 0);
  await r.stop();
  d = r.drain();
  assert.equal(d.done, true);
  assert.equal(d.stats.drainedChunks, 5);
  assert.equal(d.stats.queuedChunks, 0);
  assert.equal(d.stats.bufferedBytes, 0);
  assert.equal(d.stats.bytesOut, 15000);
});

// ---------------------------------------------------------------------------
// R6 backpressure
// ---------------------------------------------------------------------------

check("R6 waitForCapacity waits on encodeQueueSize until the encoder catches up", async () => {
  const E = makeEncoderClass({ manual: true });
  let sleeps = 0;
  const r = REC.createRecorder({
    canvas: fakeCanvas(),
    maxQueue: 2,
    VideoEncoder: E,
    VideoFrame: makeFrameClass(),
    sleep: async () => {
      sleeps += 1;
      E.instances[0].process(1); // the encoder finishes one frame per poll
    },
  });
  await r.start();
  for (let k = 0; k < 6; k += 1) r.grab(k / 30);
  assert.equal(r.hasCapacity(), false);
  const w = await r.waitForCapacity();
  assert.equal(w.ok, true);
  assert.equal(w.timedOut, false);
  assert.equal(sleeps, 4, "6 queued → 2 after 4 polls");
  assert.equal(E.instances[0].encodeQueueSize, 2);
  assert.equal(r.stats().backpressureWaits, 1);
  assert.equal(r.stats().maxEncodeQueueSize, 6);
  // With capacity there is no wait at all.
  const w2 = await r.waitForCapacity();
  assert.equal(w2.waitedMs, 0);
  assert.equal(sleeps, 4);
});

check("R6 undrained output is backpressure too; a stuck encoder times out (counted, never hangs)", async () => {
  // buffered bytes: waits until the CLI drains
  const E = makeEncoderClass({ size: () => 1000 });
  let drained = false;
  let rr = null;
  const r = REC.createRecorder({
    canvas: fakeCanvas(),
    maxBufferedBytes: 2500,
    VideoEncoder: E,
    VideoFrame: makeFrameClass(),
    sleep: async () => {
      if (!drained) {
        rr.drain({ maxBytes: 1e9 });
        drained = true;
      }
    },
  });
  rr = r;
  await r.start();
  for (let k = 0; k < 4; k += 1) r.grab(k / 30);
  assert.equal(r.hasCapacity(), false);
  assert.equal((await r.waitForCapacity()).ok, true);
  assert.equal(r.stats().bufferedBytes, 0);
  // stuck: the encoder never drains, the clock advances 10 ms per poll
  const E2 = makeEncoderClass({ manual: true });
  let now = 0;
  const r2 = REC.createRecorder({ canvas: fakeCanvas(), maxQueue: 0, pollMs: 10, VideoEncoder: E2, VideoFrame: makeFrameClass(), now: () => now, sleep: async (ms) => { now += ms; } });
  await r2.start();
  r2.grab(0);
  const w = await r2.waitForCapacity({ timeoutMs: 100 });
  assert.equal(w.ok, false);
  assert.equal(w.timedOut, true);
  assert.equal(r2.stats().capacityTimeouts, 1);
});

// ---------------------------------------------------------------------------
// R7 frames / stop / abort / error
// ---------------------------------------------------------------------------

check("R7 frames fallback: JPEG toDataURL in the grab, prefix stripped, every chunk a key frame", async () => {
  const c = fakeCanvas();
  const r = REC.createRecorder({ canvas: c, codec: "frames", fps: 24, jpegQuality: 0.9 });
  await r.start();
  for (let k = 0; k < 3; k += 1) assert.equal(r.grab(k / 24), true);
  assert.equal(c.dataUrls, 3);
  assert.equal(c.lastType, "image/jpeg");
  assert.equal(c.lastQ, 0.9);
  await r.stop();
  const d = r.drain();
  assert.equal(d.chunks.length, 3);
  for (const [i, ch] of d.chunks.entries()) {
    assert.ok(!ch.b64.startsWith("data:"));
    assert.equal(ch.key, true);
    assert.equal(ch.timestampUs, Math.round((i / 24) * 1e6));
    assert.equal(DRAIN.sniffChunkKind(DRAIN.chunkBytes(ch)), "frames");
  }
  assert.equal(DRAIN.kindOfCodec(d.stats.codec), "frames");
  assert.equal(d.done, true);
});

check("R7 stop flushes + closes once; abort keeps already-output chunks drainable; encoder error fails the recorder", async () => {
  const E = makeEncoderClass({ manual: true });
  const r = REC.createRecorder({ canvas: fakeCanvas(), VideoEncoder: E, VideoFrame: makeFrameClass() });
  await r.start();
  r.grab(0);
  r.grab(1 / 30);
  const p1 = r.stop();
  const p2 = r.stop();
  assert.equal(p1, p2, "idempotent");
  const st = await p1;
  assert.equal(E.instances[0].flushed, 1);
  assert.equal(E.instances[0].state, "closed");
  assert.equal(st.chunksOut, 2, "flush delivered the pending frames");
  // abort
  const E2 = makeEncoderClass();
  const r2 = REC.createRecorder({ canvas: fakeCanvas(), VideoEncoder: E2, VideoFrame: makeFrameClass() });
  await r2.start();
  r2.grab(0);
  const s2 = r2.abort(new Error("take failed"));
  assert.equal(s2.state, "failed");
  assert.equal(E2.instances[0].flushed, 0, "no flush on abort");
  const d2 = r2.drain();
  assert.equal(d2.chunks.length, 1);
  assert.equal(d2.done, true);
  // the encoder's error callback
  const E3 = makeEncoderClass();
  const r3 = REC.createRecorder({ canvas: fakeCanvas(), VideoEncoder: E3, VideoFrame: makeFrameClass() });
  await r3.start();
  E3.instances[0].error(new Error("EncodingError: hardware lost"));
  assert.equal(r3.state, "failed");
  assert.equal(r3.grab(0), false);
  assert.ok(r3.stats().errors.some((m) => /hardware lost/.test(m)));
});

// ---------------------------------------------------------------------------
// B1 / B2 page bridge
// ---------------------------------------------------------------------------

/** Fake timers: setTimeout records, fire() runs them. */
function fakeTimers() {
  const list = [];
  return {
    setTimeout(fn, ms) {
      const h = { fn, ms, done: false };
      list.push(h);
      return h;
    },
    clearTimeout(h) {
      if (h) h.done = true;
    },
    fireAll() {
      for (const h of list.splice(0)) if (!h.done) {
        h.done = true;
        h.fn();
      }
    },
    get pending() {
      return list.filter((h) => !h.done).length;
    },
  };
}

check("B1 available is re-read every access; no binding → 'disabled' (resolves, never rejects)", async () => {
  const win = {};
  const b = BR.createPageBridge({ window: win });
  assert.equal(b.available, false);
  const r = await b.request({ state: { a: 1 }, questions: {}, seq: 3 });
  assert.equal(r.error.kind, "disabled");
  assert.equal(r.seq, 3);
  win.__filmJev = async () => JSON.stringify({ answers: { maneuver: { type: "choice", choice: "hold_path" } }, usage: { inputTokens: 5, outputTokens: 2, costUsd: 0.001 }, ms: 42, seq: 4, id: "dec_1", model: "typesafe/jev-1.13" });
  assert.equal(b.available, true, "installed later → available now");
  const ok = await b.request({ state: { a: 1 }, questions: { maneuver: {} }, seq: 4 });
  assert.equal(ok.answers.maneuver.choice, "hold_path");
  assert.deepEqual(ok.usage, { inputTokens: 5, outputTokens: 2, costUsd: 0.001 });
  assert.equal(ok.ms, 42);
  assert.equal(ok.id, "dec_1");
  delete win.__filmJev;
  assert.equal(b.available, false, "removed → unavailable");
});

check("B1 wire envelope: JSON string body {state, questions, seq}; object replies; error envelopes; bad replies", async () => {
  let body = null;
  const win = { __filmJev: (json) => { body = json; return { answers: { risk: { type: "score", score: 0 } }, seq: 9 }; } };
  const b = BR.createPageBridge({ window: win });
  const r = await b.request({ state: { s: "w" }, questions: { risk: {} }, seq: 9 });
  assert.equal(typeof body, "string");
  assert.deepEqual(JSON.parse(body), { state: { s: "w" }, questions: { risk: {} }, seq: 9 });
  assert.equal(r.answers.risk.score, 0);
  assert.deepEqual(r.usage, { inputTokens: 0, outputTokens: 0, costUsd: 0 });
  win.__filmJev = async () => JSON.stringify({ error: { kind: "budget", message: "hourly cap", retryable: false }, seq: 10 });
  let e = await b.request({ state: {}, questions: {}, seq: 10 });
  assert.deepEqual(e.error, { kind: "budget", message: "hourly cap", retryable: false });
  win.__filmJev = async () => "not json at all";
  assert.equal((await b.request({ seq: 11 })).error.kind, "bad-response");
  win.__filmJev = async () => JSON.stringify({ hello: 1 });
  assert.equal((await b.request({ seq: 12 })).error.kind, "bad-response");
  win.__filmJev = () => Promise.reject(new Error("CDP binding gone"));
  e = await b.request({ seq: 13 });
  assert.equal(e.error.kind, "network");
  assert.equal(e.error.retryable, true);
  win.__filmJev = () => {
    throw new Error("sync boom");
  };
  assert.equal((await b.request({ seq: 14 })).error.kind, "internal");
  const st = b.stats();
  assert.equal(st.requests, 6);
  assert.equal(st.answers, 1);
  assert.equal(st.byKind["bad-response"], 2);
});

check("B1 timeout resolves 'timeout' (late answer ignored); too-large never calls the broker; configure()", async () => {
  const T = fakeTimers();
  let resolveLate = null;
  const win = { __filmJev: () => new Promise((r) => { resolveLate = r; }) };
  const b = BR.createPageBridge({ window: win, timeoutMs: 1500, setTimeout: T.setTimeout, clearTimeout: T.clearTimeout });
  const p = b.request({ state: {}, questions: {}, seq: 1 });
  assert.equal(T.pending, 1);
  T.fireAll();
  const r = await p;
  assert.equal(r.error.kind, "timeout");
  assert.equal(r.error.retryable, true);
  resolveLate(JSON.stringify({ answers: {} }));
  await tick();
  assert.equal(b.stats().lateAnswers, 1);
  assert.equal(b.stats().timeouts, 1);
  let calls = 0;
  win.__filmJev = () => {
    calls += 1;
    return "{}";
  };
  const big = await b.request({ state: { blob: "x".repeat(60 * 1024) }, questions: {}, seq: 2 });
  assert.equal(big.error.kind, "too-large");
  assert.equal(big.seq, null);
  assert.equal(calls, 0);
  assert.equal(b.timeoutMs, 1500);
  assert.deepEqual(b.configure({ mode: "stepped" }), { timeoutMs: 15000, mode: "stepped" });
  assert.deepEqual(b.configure({ mode: "realtime" }), { timeoutMs: 1500, mode: "realtime" });
  assert.equal(b.configure({ timeoutMs: 900 }).timeoutMs, 900);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal((await b.request({ state: cyclic, seq: 3 })).error.kind, "bad-request");
});

check("B2 the real pilot over the page bridge: JEV answers drive it; a failing broker falls back to the code policy", async () => {
  const sf = emptySensorFrame({ t: 0, pos: [0, 0, 10], h: 0, p: 0, r: 0, q: [1, 0, 0, 0], fov: 60 });
  sf.nearest = { range: 3, kind: "tree", bearingDeg: 0, elevDeg: 0 };
  sf.sectors.center = { range: 3, kind: "tree" };
  const win = {
    __filmJev: async (json) => {
      const req = JSON.parse(json);
      return JSON.stringify({ answers: neutralAnswers(req.questions), usage: { costUsd: 0.0001 }, ms: 30, seq: req.seq });
    },
  };
  const bridge = BR.createPageBridge({ window: win, mode: "stepped" });
  const pilot = createPilot({ bridge, mode: "jev" });
  const out = await pilot.tickStepped(sf, { standingOrder: "keep 3 m from trees", technique: "drone.flythrough", hasSubject: false }, 0);
  assert.equal(out.telemetry.source, "jev");
  assert.equal(out.telemetry.consulted, true);
  win.__filmJev = async () => JSON.stringify({ error: { kind: "rate", message: "slow down", retryable: true } });
  const pilot2 = createPilot({ bridge, mode: "jev" });
  const out2 = await pilot2.tickStepped(sf, { hasSubject: false }, 0);
  assert.equal(out2.telemetry.source, "code");
  assert.equal(out2.telemetry.fallback, "jev-rate");
  delete win.__filmJev;
  const out3 = await createPilot({ bridge, mode: "jev" }).tickStepped(sf, { hasSubject: false }, 0);
  assert.equal(out3.telemetry.source, "code", "no binding → code policy");
});

// ---------------------------------------------------------------------------
// P1 residual math
// ---------------------------------------------------------------------------

/** A straight north-bound dolly at 5 m/s, looking north, 2 s. */
function northDolly(D = 2) {
  return TR.makeTrajectory({ id: "north", technique: "classic.dolly-in", family: "classic", duration: D, positionAt: (t) => [100, 100 + 5 * t, 10], orientAt: { h: 0, p: 0, r: 0 } });
}

check("P1 pathRightVector: right of travel from the tangent; camera right for static shots; heading at the nadir", () => {
  const tr = northDolly();
  const r = TP.pathRightVector(tr, 1, tr.sample(1));
  near(r[0], 1, 1e-9);
  near(r[1], 0, 1e-9);
  const east = TR.makeTrajectory({ duration: 2, positionAt: (t) => [5 * t, 0, 0], orientAt: { h: 0, p: 0, r: 0 } });
  const r2 = TP.pathRightVector(east, 1, east.sample(1));
  near(r2[0], 0, 1e-9);
  near(r2[1], -1, 1e-9, "travelling east, right is south");
  const still = TR.makeTrajectory({ duration: 2, positionAt: [0, 0, 5], orientAt: { h: Math.PI / 2, p: 0, r: 0 } });
  const r3 = TP.pathRightVector(still, 1, still.sample(1));
  near(r3[1], -1, 1e-9, "camera facing east → right is south");
  const nadir = { q: GB.quatFromHPR(0.7, -Math.PI / 2, 0), h: 0.7 };
  const r4 = TP.pathRightVector({ duration: 0, sample: () => null }, 0, nadir);
  near(r4[0], Math.cos(0.7), 1e-9);
  near(r4[1], -Math.sin(0.7), 1e-9);
  assert.ok(r4.every(Number.isFinite));
});

check("P1 applyResidual: lateral/vertical in the path frame keep the subject where it was framed; distanceScale; neutral is identity", () => {
  const subj = { pos: [100, 120, 0], height: 1.8, radius: 0.4 };
  const centre = [100, 120, 0.9];
  const eye = [100, 110, 2];
  const look = GB.lookRotation(eye, centre);
  const pose = { t: 1, pos: eye, q: look.q, h: look.h, p: look.p, r: 0, fov: 60 };
  assert.equal(TP.applyResidual(pose, TP.NEUTRAL_SETPOINT, { right: [1, 0, 0] }), pose, "neutral → the same object");
  const sp = { ...TP.NEUTRAL_SETPOINT, lateral: 1.5, vertical: 1 };
  const out = TP.applyResidual(pose, sp, { right: [1, 0, 0], subjectCenter: centre, bounds: TR.DEFAULT_BOUNDS });
  near(out.pos[0], 101.5, 1e-9, "lateral along right");
  near(out.pos[2], 3, 1e-9, "vertical up");
  const before = FR.projectToNdc(pose, centre, 60, 16 / 9);
  const after = FR.projectToNdc(out, centre, 60, 16 / 9);
  near(after.x, before.x, 1e-6, "subject stays on its NDC x");
  near(after.y, before.y, 1e-6, "subject stays on its NDC y");
  // clamped to bounds (maxLateral 2, maxSink 1)
  const far = TP.applyResidual(pose, { ...sp, lateral: 9, vertical: -9 }, { right: [1, 0, 0], subjectCenter: centre, bounds: TR.DEFAULT_BOUNDS });
  near(far.pos[0], 102, 1e-9);
  near(far.pos[2], 1, 1e-9);
  // distance scale moves along the line to the subject
  const ds = TP.applyResidual(pose, { ...TP.NEUTRAL_SETPOINT, distanceScale: 1.2 }, { right: [1, 0, 0], subjectCenter: centre, bounds: TR.DEFAULT_BOUNDS });
  const d0 = Math.hypot(eye[0] - centre[0], eye[1] - centre[1], eye[2] - centre[2]);
  const d1 = Math.hypot(ds.pos[0] - centre[0], ds.pos[1] - centre[1], ds.pos[2] - centre[2]);
  near(d1 / d0, 1.2, 1e-9);
  assert.deepEqual(ds.q, pose.q, "orientation untouched by a pure distance change");
  void subj;
});

check("P1 framing nudges at straight-down pitch: smooth, no flip, no NaN", () => {
  const h0 = 1.1;
  const pose = { t: 0, pos: [0, 0, 30], q: GB.quatFromHPR(h0, -Math.PI / 2, 0), h: h0, p: -Math.PI / 2, r: 0, fov: 60 };
  const basis = (q) => [qRotate(q, [0, 1, 0]), qRotate(q, [0, 0, 1]), qRotate(q, [1, 0, 0])];
  const angle = (a, b) => Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));
  let prev = pose;
  for (let i = 1; i <= 20; i += 1) {
    const out = TP.applyResidual(pose, { ...TP.NEUTRAL_SETPOINT, framing: { dh: 0.01 * i, dp: 0.005 * i, dfovDeg: 0.2 * i } }, { right: [1, 0, 0] });
    assert.ok(out.q.every(Number.isFinite) && Number.isFinite(out.h) && Number.isFinite(out.p) && Number.isFinite(out.r));
    // The IMAGE (forward, up, right) moves by a small, steady amount per step — no flip.
    const [f0, u0, r0] = basis(prev.q);
    const [f1, u1, r1] = basis(out.q);
    for (const [a, b, name] of [[f0, f1, "forward"], [u0, u1, "up"], [r0, r1, "right"]]) {
      assert.ok(angle(a, b) < 0.03, `step ${i}: ${name} moved ${angle(a, b)} rad (no flip)`);
    }
    // h/p/r stay a faithful decomposition of q (camera_owner writes q).
    const back = GB.quatFromHPR(out.h, out.p, out.r);
    assert.ok(Math.abs(back[0] * out.q[0] + back[1] * out.q[1] + back[2] * out.q[2] + back[3] * out.q[3]) > 1 - 1e-9);
    near(out.fov, 60 + 0.2 * i, 1e-9);
    prev = out;
  }
  // dh turns the image right: the forward vector moves toward the camera's right.
  const [fA, , rA] = basis(pose.q);
  const turned = TP.applyResidual(pose, { ...TP.NEUTRAL_SETPOINT, framing: { dh: 0.1, dp: 0, dfovDeg: 0 } }, { right: [1, 0, 0] });
  const fB = qRotate(turned.q, [0, 1, 0]);
  assert.ok(fB[0] * rA[0] + fB[1] * rA[1] + fB[2] * rA[2] > 0.09, "turned toward the right");
  void fA;
  void h0;
});

// ---------------------------------------------------------------------------
// T1 take player with fakes
// ---------------------------------------------------------------------------

/** A stepped-clock + camera rig around the REAL film hooks. */
function rig(o = {}) {
  const live = { frameTime: { tsMs: 1000 } };
  const hooks = ensureFilmHooks(live);
  const writes = [];
  const cuts = [];
  const cam = {
    owned: true,
    write(p) {
      if (!p || !Array.isArray(p.pos) || !p.pos.every(Number.isFinite)) return false;
      writes.push({ t: p.t, pos: p.pos.slice(), q: p.q.slice(), fov: p.fov, focus: p.focus });
      return true;
    },
    currentPose: () => (writes.length ? { ...writes[writes.length - 1] } : null),
    setCutCell(c) {
      cuts.push(c);
      return c;
    },
    viewerCell: () => 0,
    onPostRender: (fn) => hooks.addPostRender(fn),
  };
  const clockLog = { begins: [], steps: 0, ends: 0 };
  let active = false;
  let lastTs = null;
  let fps = 30;
  const clock = {
    begin(b) {
      if (active) throw new Error("already");
      active = true;
      fps = b.fps;
      clockLog.begins.push({ ...b });
      return { ok: true };
    },
    step() {
      if (!active) return Promise.reject(new Error("idle"));
      lastTs = live.frameTime.tsMs + 1000 / fps;
      live.frameTime = { tsMs: lastTs };
      clockLog.steps += 1;
      if (o.onStep) o.onStep(clockLog.steps);
      hooks.postRender();
      return Promise.resolve({ frame: clockLog.steps });
    },
    async end() {
      active = false;
      clockLog.ends += 1;
      return { ok: true };
    },
    get active() {
      return active;
    },
    stats: () => ({ lastTsMs: lastTs }),
  };
  const senseLog = [];
  const sensors = {
    sense(pose, ctx, dt) {
      senseLog.push({ t: pose.t, dt, subject: !!ctx.subject, ahead: ctx.nominalAhead ? ctx.nominalAhead.length : 0 });
      if (o.onSense) o.onSense(pose, ctx);
      const f = emptySensorFrame(pose);
      if (o.visible) f.subject = { visibleFrac: o.visible(senseLog.length), unseenSec: 0, ndc: [0, 0], sizeRatio: 1, occluderKind: null, occluderIds: o.occluders || [] };
      return f;
    },
    reset() {
      senseLog.length = 0;
    },
  };
  const safetyLog = [];
  const safety = {
    clamp(prev, desired, ctx) {
      safetyLog.push({ cut: ctx.cut, fov: ctx.fovDeg });
      if (o.adjust && o.adjust(desired)) {
        return { pose: { ...desired, pos: [desired.pos[0], desired.pos[1], desired.pos[2] + 0.5] }, adjusted: true, hits: [{ layer: "statics", kind: "tree" }] };
      }
      return { pose: desired, adjusted: false, hits: [] };
    },
    reset() {},
    release: () => 0,
  };
  let speed = o.speed ?? 1;
  const pilotLog = { stepped: 0, rt: 0, resets: 0 };
  const pilot = {
    async tickStepped(sf, ctx, now) {
      pilotLog.stepped += 1;
      if (o.onPilot) o.onPilot(pilotLog.stepped, now);
      return { setpoint: { ...TP.NEUTRAL_SETPOINT, speedScale: speed, ...(o.setpoint || {}) }, telemetry: { source: "code", consulted: true, newDecision: pilotLog.stepped % 5 === 1, t: now } };
    },
    tick(sf, ctx, now) {
      pilotLog.rt += 1;
      return { setpoint: { ...TP.NEUTRAL_SETPOINT, speedScale: speed }, telemetry: { source: "none", consulted: false, newDecision: false, t: now } };
    },
    reset() {
      pilotLog.resets += 1;
    },
    stats: () => ({ mode: "code", sources: { jev: 0, code: pilotLog.stepped, reuse: 0, none: 0 }, agreement: { compared: 0, agreed: 0, rate: null }, consults: pilotLog.stepped, errors: 0, fallbacks: 0, costUsd: 0 }),
  };
  const E = makeEncoderClass();
  const F = makeFrameClass();
  const canvas = fakeCanvas(640, 360);
  const recorders = [];
  const recorder = (ro) => {
    const r = REC.createRecorder({ canvas, ...ro, VideoEncoder: E, VideoFrame: F });
    recorders.push(r);
    return r;
  };
  const player = TP.createTakePlayer({
    cameraOwner: cam,
    clock,
    sensors,
    pilot,
    safety,
    recorder,
    worldQuery: { groundZ: () => 0 },
    liveScene3d: live,
    window: o.window ?? {},
    actor: o.actor,
    requestAnimationFrame: o.raf,
    setTimeout: o.setTimeout,
    clearTimeout: o.clearTimeout,
    now: o.now,
    ...(o.buildShot ? { buildShot: o.buildShot } : {}),
  });
  return {
    live, hooks, cam, writes, cuts, clock, clockLog, sensors, senseLog, safety, safetyLog, pilot, pilotLog, E, F, recorders, player,
    setSpeed: (s) => {
      speed = s;
    },
  };
}

check("T1 stepped shoot: frames = duration·fps, ≥ 6 pre-roll frames rendered but not recorded, µs timestamps, SPEC order", async () => {
  const R = rig();
  const fps = 10;
  const sum = R.player.prepare({ trajectory: northDolly(2), capture: { fps, mode: "stepped" }, preRollSec: 0.25, shotId: "s1" });
  assert.equal(sum.plannedFrames, 20);
  assert.equal(sum.preRollFrames, 6, "max(6, ceil(0.25·10))");
  const rep = await R.player.shoot({ fps });
  assert.equal(rep.frames, 20);
  assert.equal(rep.durationSec, 2);
  assert.equal(rep.preRollFrames, 6);
  assert.equal(R.clockLog.steps, 26, "pre-roll + take frames all rendered");
  assert.equal(R.clockLog.begins.length, 1);
  assert.equal(R.clockLog.ends, 1);
  const enc = R.E.instances[0].encoded;
  assert.equal(enc.length, 20, "only the take frames are recorded");
  enc.forEach((e, k) => assert.equal(e.timestamp, Math.round((k / fps) * 1e6)));
  assert.equal(rep.grabbedFrames, 20);
  assert.equal(rep.droppedFrames, 0);
  assert.ok(R.F.frames.every((f) => f.closed));
  assert.equal(rep.recorder.state, "stopped");
  // pre-roll writes sit at the start pose; take frames follow the dolly
  assert.equal(R.writes.length, 26);
  for (let i = 0; i < 6; i += 1) near(R.writes[i].pos[1], 100, 1e-9);
  for (let k = 0; k < 20; k += 1) near(R.writes[6 + k].pos[1], 100 + 5 * (k / fps), 1e-9);
  assert.equal(R.safetyLog.length, 26, "safety ran on every frame");
  assert.equal(R.safetyLog[0].cut, true, "the first pre-roll frame is a cut");
  assert.equal(R.pilotLog.stepped, 20, "the stepped pilot is awaited once per take frame");
  assert.ok(R.pilotLog.resets >= 1);
  assert.deepEqual(R.cuts, [0], "film viewer cell re-seeded on the cut into the take");
  assert.equal(rep.pilot.decisions, 4);
  assert.equal(rep.safety.adjustedFrames, 0);
  assert.ok(/^[0-9a-f]{8}$/.test(rep.realisedChecksum));
  assert.equal(rep.realisedTable, undefined, "the table only with includeTable");
  // drain everything the CLI would
  const d = R.player.currentRecorder().drain({ maxBytes: 1e9 });
  assert.equal(d.chunks.length, 20);
  assert.equal(d.done, true);
});

check("T1 pilot speedScale < 1 extends progress time; speed 0 runs to the overrun cap", async () => {
  const R = rig({ speed: 0.8 });
  const fps = 10;
  R.player.prepare({ trajectory: northDolly(2), capture: { fps } });
  const rep = await R.player.shoot({ fps, includeTable: true });
  assert.equal(rep.frames, 25, "20 nominal frames at 0.8× progress take 25 frames");
  assert.equal(rep.overrunFrames, 5);
  assert.equal(rep.capped, false);
  const rows = rep.realisedTable.rows;
  for (let k = 0; k < 25; k += 1) {
    near(rows[k * TR.TABLE_STRIDE], k / fps, 1e-12, "take time");
    near(rows[k * TR.TABLE_STRIDE + 2], 100 + 5 * Math.min(2, (0.8 * k) / fps), 1e-9, `row ${k} y follows 0.8× progress`);
  }
  assert.ok(rows[24 * TR.TABLE_STRIDE] > 2, "the take runs past the nominal duration");
  const R0 = rig({ speed: 0 });
  R0.player.prepare({ trajectory: northDolly(2), capture: { fps } });
  const rep0 = await R0.player.shoot({ fps });
  assert.equal(rep0.frames, 40, "maxOverrun 1.0 → 2× nominal");
  assert.equal(rep0.capped, true);
  assert.equal(rep0.progressReached, 0);
});

check("T1 safety adjustments always win and are recorded in the report and the realised table", async () => {
  const R = rig({ adjust: (p) => p.pos[1] >= 103 && p.pos[1] < 105 });
  R.player.prepare({ trajectory: northDolly(2), capture: { fps: 10 } });
  const rep = await R.player.shoot({ fps: 10, includeTable: true });
  // y = 100 + 0.5k ∈ [103, 105) → k = 6..9
  assert.equal(rep.safety.adjustedFrames, 4);
  assert.equal(rep.safety.layerHits.statics, 4);
  const rows = rep.realisedTable.rows;
  for (let k = 0; k < 20; k += 1) near(rows[k * TR.TABLE_STRIDE + 3], k >= 6 && k <= 9 ? 10.5 : 10, 1e-9, `row ${k} z`);
});

check("T1 locked replay reproduces the rehearsal's realised checksum (no pilot, same frames); rehearse records nothing", async () => {
  const R = rig({ setpoint: { lateral: 0.4 } });
  R.player.prepare({ trajectory: northDolly(2), capture: { fps: 10 } });
  const reh = await R.player.rehearse({ fps: 10 });
  assert.equal(reh.ok, true);
  assert.equal(reh.frames, 20);
  assert.equal(R.recorders.length, 0, "a rehearsal creates no recorder");
  assert.equal(reh.checksum, TR.tableChecksum(reh.realisedTable.rows));
  assert.ok(Array.isArray(reh.pilotTelemetry) && reh.pilotTelemetry.length === 20);
  assert.equal(reh.pilotTelemetry[0].frame, 0);
  near(reh.realisedTable.rows[5 * TR.TABLE_STRIDE + 1], 100.4, 1e-9, "the pilot drifted the rehearsal 0.4 m right");
  const json = JSON.parse(JSON.stringify(reh.realisedTable));
  // locked: prepare from the table, shoot locked
  const before = R.pilotLog.stepped;
  R.player.prepare({ table: json, capture: { fps: 10 } });
  const rep = await R.player.shoot({ fps: 10, locked: true });
  assert.equal(rep.realisedChecksum, reh.checksum);
  assert.equal(rep.frames, 20);
  assert.equal(rep.pilot.mode, "off");
  assert.equal(R.pilotLog.stepped, before, "no pilot in a locked take");
  // locked from the last realised table without re-preparing
  R.player.prepare({ trajectory: northDolly(2), capture: { fps: 10 } });
  await R.player.rehearse({ fps: 10 });
  const rep2 = await R.player.shoot({ fps: 10, locked: true });
  assert.equal(rep2.realisedChecksum, reh.checksum);
});

check("T1 rehearse at the CLI's default 8 fps: film time 1/8 s per frame on a ≥ 10 fps clock; render:false never touches the clock", async () => {
  const R = rig();
  R.player.prepare({ trajectory: northDolly(2), capture: { fps: 30 } });
  const reh = await R.player.rehearse({ fps: 8 });
  assert.equal(reh.frames, 16);
  assert.equal(R.clockLog.begins[0].fps, 10, "clamped to the film clock's floor");
  near(reh.realisedTable.rows[15 * TR.TABLE_STRIDE], 15 / 8, 1e-12, "take time stays k/8");
  assert.equal(reh.realisedTable.fps, 8);
  const steps = R.clockLog.steps;
  const dry = await R.player.rehearse({ fps: 8, render: false });
  assert.equal(dry.rendered, false);
  assert.equal(dry.checksum, reh.checksum, "rendering does not change the realised path");
  assert.equal(R.clockLog.steps, steps);
  // the 8 fps rehearsal table replays locked at 30 fps over the same 2 s
  R.player.prepare({ table: JSON.parse(JSON.stringify(reh.realisedTable)), capture: { fps: 30 } });
  const rep = await R.player.shoot({ fps: 30, locked: true, includeTable: true });
  assert.equal(rep.frames, 60);
  near(rep.realisedTable.rows[59 * TR.TABLE_STRIDE + 2], Math.min(100 + 5 * (59 / 30), 100 + 5 * (15 / 8)), 1e-9, "clamped at the table's last row");
});

check("T1 stepped takes are deterministic: two shoots of the same take give the same checksum", async () => {
  const a = rig({ setpoint: { lateral: 0.3, vertical: 0.2 } });
  a.player.prepare({ trajectory: northDolly(2), capture: { fps: 12 } });
  const r1 = await a.player.shoot({ fps: 12 });
  const r2 = await a.player.shoot({ fps: 12 });
  assert.equal(r1.realisedChecksum, r2.realisedChecksum);
  const b = rig({ setpoint: { lateral: 0.3, vertical: 0.2 } });
  b.player.prepare({ trajectory: northDolly(2), capture: { fps: 12 } });
  assert.equal((await b.player.rehearse({ fps: 12 })).checksum, r1.realisedChecksum, "rehearsal == shoot");
});

/** A fake window.__dof with the seam's validation and a write log. */
function fakeDof(enabled = false, focusDistance = 7) {
  const log = [];
  let en = enabled;
  let fd = focusDistance;
  return {
    log,
    flips: 0,
    get enabled() {
      return en;
    },
    set enabled(v) {
      if (!!v !== en) this.flips += 1;
      en = !!v;
    },
    get focusDistance() {
      return fd;
    },
    set focusDistance(v) {
      if (!(typeof v === "number" && Number.isFinite(v) && v >= 0)) throw new RangeError(`focusDistance ${v}`);
      fd = v;
      log.push({ v, enabled: en });
    },
  };
}

check("T1 DoF (owner decision): classic.rack-focus pulls window.__dof.focusDistance every frame, enabled for the take, restored after", async () => {
  const dof = fakeDof(false, 7);
  const R = rig({ window: { __dof: dof } });
  const subj = { pos: [100, 120, 0], height: 1.8, radius: 0.4 };
  const sum = R.player.prepare({ spec: { technique: "classic.rack-focus", duration: 2 }, ctx: { subject: subj }, capture: { fps: 10 } });
  assert.equal(sum.hasFocus, true);
  const rep = await R.player.shoot({ fps: 10 });
  assert.equal(rep.dof.used, true);
  assert.equal(rep.dof.enabled, true);
  const during = dof.log.filter((e) => e.enabled);
  assert.ok(during.length >= 20, `focus written every frame (${during.length})`);
  const vals = during.map((e) => e.v);
  assert.ok(Math.max(...vals) - Math.min(...vals) > 0.5, `focus pulls (${Math.min(...vals)} → ${Math.max(...vals)})`);
  // the recorded frames' focus matches the pose focus channel
  const tr = SHOTS.buildShot({ technique: "classic.rack-focus", duration: 2 }, { subject: subj, groundZ: () => 0 });
  near(R.writes[R.writes.length - 1].focus, tr.sample(1.9).focus, 1e-9);
  assert.equal(dof.enabled, false, "enabled restored");
  assert.equal(dof.focusDistance, 7, "focusDistance restored");
  assert.equal(dof.flips, 2, "one enable, one disable — never per frame");
});

check("T1 DoF: absent __dof is a no-op; a shot without a focus channel leaves an existing __dof alone", async () => {
  const R = rig({ window: {} });
  R.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const rep = await R.player.shoot({ fps: 10 });
  assert.equal(rep.dof.used, false);
  assert.equal(rep.dof.writes, 0);
  const dof = fakeDof(true, 3);
  const R2 = rig({ window: { __dof: dof } });
  R2.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  await R2.player.shoot({ fps: 10 });
  assert.equal(dof.flips, 0);
  assert.equal(dof.focusDistance, 3);
  assert.equal(dof.log.length, 0);
});

check("T1 realtime mode: requestAnimationFrame + wall-clock timestamps, synchronous pilot.tick, grab in postRender", async () => {
  const queue = [];
  const raf = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  const R = rig({ raf });
  R.player.prepare({ trajectory: northDolly(1), capture: { fps: 10, mode: "realtime" } });
  const p = R.player.shoot({ fps: 10 });
  await tick();
  let ts = 5000;
  let frames = 0;
  while (queue.length && frames < 200) {
    const cb = queue.shift();
    ts += 100; // a steady 10 Hz display
    cb(ts);
    R.hooks.postRender(); // the engine draws after the rAF callbacks
    frames += 1;
    await tick();
  }
  const rep = await p;
  assert.equal(rep.mode, "realtime");
  assert.equal(rep.frames, 10);
  assert.equal(R.pilotLog.rt, 10);
  assert.equal(R.pilotLog.stepped, 0);
  assert.equal(R.clockLog.begins.length, 0, "realtime never holds the loop");
  const enc = R.E.instances[0].encoded;
  assert.equal(enc.length, 10);
  enc.forEach((e, k) => assert.equal(e.timestamp, Math.round(k * 0.1 * 1e6)));
  // Frames follow the FILM GRID, not the display (review gate-0 / seams-4): a 20 Hz display
  // records the same 10 frames at k/10 over 1 s of wall time (every other display frame lies
  // between grid points); a locked replay on a 5 Hz display holds each drawn frame for the
  // grid points it covers — still 10 frames at k/10, so `-r fps` muxes both at true speed.
  const run = async (stepMs, locked) => {
    const p2 = R.player.shoot({ fps: 10, mode: "realtime", locked, includeTable: true });
    await tick();
    let ts2 = 9000;
    for (let n = 0; queue.length && n < 400; n += 1) {
      const cb = queue.shift();
      ts2 += stepMs;
      cb(ts2);
      R.hooks.postRender();
      await tick();
    }
    return p2;
  };
  const fast = await run(50, false);
  assert.equal(fast.frames, 10);
  assert.equal(fast.durationSec, 1);
  assert.equal(fast.capped, false);
  const encFast = R.E.instances[R.E.instances.length - 1].encoded;
  assert.equal(encFast.length, 10);
  encFast.forEach((e, k) => assert.equal(e.timestamp, Math.round(k * 0.1 * 1e6)));
  assert.equal(fast.realtime.skippedDisplayFrames, 10, "the display frames between grid points are not recorded");
  assert.equal(fast.realtime.heldFrames, 0);
  const replay = await run(200, true);
  assert.equal(replay.frames, 10, "a 5 Hz display replays the 1 s table as 10 grid frames");
  assert.equal(replay.locked, true);
  const encSlow = R.E.instances[R.E.instances.length - 1].encoded;
  assert.equal(encSlow.length, 10);
  encSlow.forEach((e, k) => assert.equal(e.timestamp, Math.round(k * 0.1 * 1e6)));
  assert.ok(replay.realtime.heldFrames >= 4, `drawn frames held over 2 grid points (${replay.realtime.heldFrames})`);
  assert.equal(replay.droppedFrames, 0);
});

check("T1 drone family flies through the real flight model (lag, continuity, no NaN)", async () => {
  const R = rig();
  const tr = TR.makeTrajectory({ id: "dr", technique: "drone.flyover", family: "drone", duration: 3, positionAt: (t) => [0, 20 * t * t, 40], orientAt: { h: 0, p: -0.4, r: 0 } });
  R.player.prepare({ trajectory: tr, capture: { fps: 20 } });
  const rep = await R.player.shoot({ fps: 20, includeTable: true });
  assert.equal(rep.frames, 60);
  const rows = rep.realisedTable.rows;
  assert.ok(rows.every(Number.isFinite));
  let lag = 0;
  for (let k = 1; k < 60; k += 1) {
    const y = rows[k * TR.TABLE_STRIDE + 2];
    lag = Math.max(lag, Math.abs(y - 20 * (k / 20) ** 2));
    const dy = y - rows[(k - 1) * TR.TABLE_STRIDE + 2];
    assert.ok(Math.abs(dy) < 6, `continuous at ${k}`);
  }
  assert.ok(lag > 0.01, `the craft lags the nominal path (${lag} m)`);
});

check("T1 occluder fades restore after the take; actor cues fire at their take time; obstruction stats", async () => {
  const hidden = [];
  const em = { _filmHiddenGuids: new Set([0x50000001]), setFilmHidden(g, on) { hidden.push([g, on]); return true; } };
  const emitter = { filmHidden: false };
  const cues = [];
  const R = rig({
    setpoint: { fadeIds: [0x80000011, 0x50000001, "m0#3"] },
    visible: (n) => (n > 10 && n < 14 ? 0.05 : 0.9),
    actor: async (cue) => {
      cues.push(cue);
      return { ok: true };
    },
  });
  R.live.entityManager = em;
  const player = TP.createTakePlayer({
    cameraOwner: R.cam, clock: R.clock, sensors: R.sensors, pilot: R.pilot, safety: R.safety,
    recorder: (ro) => REC.createRecorder({ canvas: fakeCanvas(), ...ro, VideoEncoder: R.E, VideoFrame: R.F }),
    liveScene3d: R.live, particles: { snapshot: () => [{ key: "m0#3", emitter }] },
    actor: async (cue) => {
      cues.push(cue);
      return { ok: true };
    },
  });
  player.prepare({ trajectory: northDolly(1), capture: { fps: 10 }, actor: [{ emote: "/wave", at: 0.5 }, { motion: "Cheer", at: 0 }] });
  let duringEmitter = null;
  R.hooks.addPostRender(() => {
    if (duringEmitter === null && emitter.filmHidden === true) duringEmitter = true;
  });
  const rep = await player.shoot({ fps: 10 });
  assert.deepEqual(hidden, [[0x80000011, true], [0x80000011, false]], "the avatar (already hidden) is never touched");
  assert.equal(duringEmitter, true);
  assert.equal(emitter.filmHidden, false, "emitter restored");
  assert.deepEqual(rep.faded, { entities: 1, particles: 1, statics: 0, fallbackFrames: 0 });
  assert.deepEqual(cues.map((c) => c.motion ?? c.emote), ["Cheer", "/wave"]);
  assert.deepEqual(rep.actor.map((a) => a.firedAt), [0, 0.5]);
  assert.equal(rep.obstruction.framesHidden, 3);
  near(rep.obstruction.minVisibleFrac, 0.05, 1e-12);
});

// ---------------------------------------------------------------------------
// T2 review fixes (contracts-1, contracts-3 / seams-2 / gate-2, seams-7)
// ---------------------------------------------------------------------------

// PLACED (LandBlockInfo 'object') keys: v1 never fades procedural scenery (world_query
// FADEABLE_STATIC_SOURCES, r4-scenery-fade), so a faded tree is always a placed one.
const T2_TREE = "placement:00000000:object:4";
const T2_REVEAL = "placement:00000000:object:5";
const T2_GONE = "placement:00000000:object:9";

/** Fake static draws in the shapes world_query.staticFadeTargets returns, with their exact pre-take state. */
function staticDraws() {
  const node = { userData: { modelId: 0x02000246 }, visible: true };
  const marked = { userData: { __filmHidden: false }, visible: true };
  const already = { userData: { __filmHidden: true }, visible: false }; // someone else's hide: left alone
  const arr = new Float32Array(32);
  for (const o of [0, 16]) {
    arr[o] = 1.25; arr[o + 5] = 1.25; arr[o + 10] = 1.25; arr[o + 15] = 1;
  }
  arr[12] = 90; arr[13] = 100; arr[16 + 12] = 100; arr[16 + 13] = 106;
  const inst = { isInstancedMesh: true, count: 2, instanceMatrix: { array: arr, versions: 0, set needsUpdate(v) { if (v) this.versions += 1; } } };
  const vis = new Map([[3, true], [4, true]]);
  const setCalls = [];
  const bm = {
    isBatchedMesh: true,
    getVisibleAt: (i) => vis.get(i),
    setVisibleAt(i, v) {
      setCalls.push([i, v]);
      vis.set(i, v);
      return this;
    },
  };
  const revealNode = { userData: {}, visible: true };
  const before = { inst: Array.from(arr), vis: new Map(vis) };
  const calls = [];
  const wq = {
    groundZ: () => 0,
    staticFadeTargets(key) {
      calls.push(key);
      if (key === T2_TREE) {
        return { key, kind: "tree", did: 0x02000246, pos: [100, 106, 0], targets: [
          { type: "node", node }, { type: "node", node: marked }, { type: "node", node: already },
          { type: "instance", mesh: inst, index: 1 }, { type: "batch", mesh: bm, instanceId: 3 },
        ] };
      }
      if (key === T2_REVEAL) return { key, kind: "tree", did: 1, pos: [120.5, 120, 0], targets: [{ type: "node", node: revealNode }] };
      if (key === T2_GONE) return { key, kind: "prop", did: 2, pos: [0, 0, 0], targets: [] };
      return null;
    },
  };
  return { node, marked, already, inst, arr, bm, vis, setCalls, revealNode, before, calls, wq };
}

/** A take player on rig() R's parts with a given worldQuery / particles / safety / sensors. */
function playerOn(R, extra = {}) {
  return TP.createTakePlayer({
    cameraOwner: R.cam, clock: R.clock, sensors: extra.sensors ?? R.sensors, pilot: R.pilot, safety: extra.safety ?? R.safety,
    recorder: (ro) => REC.createRecorder({ canvas: fakeCanvas(), ...ro, VideoEncoder: R.E, VideoFrame: R.F }),
    liveScene3d: R.live, worldQuery: extra.worldQuery, particles: extra.particles,
  });
}

/** northDolly with a reveal shot's occluder at (120, 120). */
function revealDolly(D = 1) {
  return TR.makeTrajectory({ id: "north-reveal", technique: "classic.dolly-in", family: "classic", duration: D, positionAt: (t) => [100, 100 + 5 * t, 10], orientAt: { h: 0, p: 0, r: 0 }, meta: { revealOccluder: { pos: [120, 120, 0], radius: 1 } } });
}

check("T2 static fades: node marker + visible, one InstancedMesh instance, a BatchedMesh instance — hidden during the take, restored EXACTLY after; reveal occluder kept; sensors told (review contracts-3 / seams-2 / gate-2)", async () => {
  const S = staticDraws();
  const fadedSeen = [];
  const R = rig({ setpoint: { fadeIds: [T2_TREE, T2_REVEAL] }, onSense: (_p, ctx) => fadedSeen.push(ctx.fadedIds ?? null) });
  const player = playerOn(R, { worldQuery: S.wq });
  player.prepare({ trajectory: revealDolly(1), capture: { fps: 10 } });
  let during = null;
  R.hooks.addPostRender(() => {
    if (during === null && S.node.visible === false) {
      during = {
        node: [S.node.userData.__filmHidden, S.node.visible],
        marked: [S.marked.userData.__filmHidden, S.marked.visible],
        inst: Array.from(S.arr.subarray(16, 32)),
        untouched: Array.from(S.arr.subarray(0, 16)),
        bm: S.vis.get(3),
        bmOther: S.vis.get(4),
        reveal: S.revealNode.visible,
      };
    }
  });
  const rep = await player.shoot({ fps: 10 });
  assert.ok(during, "the tree was hidden while frames were rendered");
  assert.deepEqual(during.node, [true, false], "statics marker (cullStaticsGroup honours it) + visible = false");
  assert.deepEqual(during.marked, [true, false]);
  assert.deepEqual([during.inst[0], during.inst[5], during.inst[10]], [0, 0, 0], "instance 1 collapsed to zero scale");
  assert.deepEqual([during.inst[12], during.inst[13], during.inst[15]], [100, 106, 1], "at its own origin");
  assert.deepEqual(during.untouched, S.before.inst.slice(0, 16), "the other instance of the shared mesh still draws");
  assert.deepEqual([during.bm, during.bmOther], [false, true], "only the tree's batch instance");
  assert.equal(during.reveal, true, "a reveal shot's own occluder is never faded");
  // restored exactly
  assert.deepEqual(S.node.userData, { modelId: 0x02000246 }, "marker removed (it was absent)");
  assert.equal(S.node.visible, true);
  assert.deepEqual(S.marked.userData, { __filmHidden: false }, "an own marker gets its previous value back");
  assert.equal(S.marked.visible, true);
  assert.deepEqual([S.already.userData.__filmHidden, S.already.visible], [true, false], "someone else's hide untouched");
  assert.deepEqual(Array.from(S.arr), S.before.inst, "instance matrices bit-identical");
  assert.equal(S.inst.instanceMatrix.versions, 2, "uploaded on hide and on restore");
  assert.deepEqual([...S.vis], [...S.before.vis]);
  assert.deepEqual(S.setCalls, [[3, false], [3, true]]);
  assert.deepEqual(S.calls.filter((k) => k === T2_TREE).length, 1, "resolved once, then remembered for the take");
  assert.deepEqual(rep.faded, { entities: 0, particles: 0, statics: 1, fallbackFrames: 0 });
  assert.ok(fadedSeen.some((f) => Array.isArray(f) && f.includes(T2_TREE)), "the sensors see past what the take faded");
  assert.ok(!fadedSeen.some((f) => Array.isArray(f) && f.includes(T2_REVEAL)));
  // A value rewritten by another writer during the take is never clobbered on restore.
  const S2 = staticDraws();
  const R2 = rig({ setpoint: { fadeIds: [T2_TREE] }, onStep: (n) => {
    if (n === 12) S2.arr[16] = 2; // e.g. the batcher re-placed that instance mid-take
  } });
  const p2 = playerOn(R2, { worldQuery: S2.wq });
  p2.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  await p2.shoot({ fps: 10 });
  assert.equal(S2.arr[16], 2, "not ours any more → left as the other writer set it");
  assert.equal(S2.node.visible, true);
});

check("T2 r2 BatchedMesh restore (round-1 low): an instance another owner hid (park) or moved during the take stays as they left it; an untouched one is re-shown; the setVisibleAt watch is removed", async () => {
  const THREE = await import("three");
  const bm = new THREE.BatchedMesh(8, 200, 400, new THREE.MeshBasicMaterial());
  const gid = bm.addGeometry(new THREE.BoxGeometry(1, 1, 1));
  const at = (x, y) => new THREE.Matrix4().makeTranslation(x, y, 0);
  const ids = {};
  for (const [name, x] of [["kept", 100], ["parked", 100], ["moved", 100], ["other", 50]]) {
    ids[name] = bm.addInstance(gid);
    bm.setMatrixAt(ids[name], at(x, 106));
  }
  const wq = {
    groundZ: () => 0,
    staticFadeTargets: (key) => (key === T2_TREE
      ? { key, kind: "tree", did: 0x02000246, pos: [100, 106, 0], targets: ["kept", "parked", "moved"].map((n) => ({ type: "batch", mesh: bm, instanceId: ids[n] })) }
      : null),
  };
  let mid = null;
  const R = rig({ setpoint: { fadeIds: [T2_TREE] }, onStep: () => {
    if (mid !== null || bm.getVisibleAt(ids.kept) !== false) return;
    mid = { watched: Object.prototype.hasOwnProperty.call(bm, "setVisibleAt"), hidden: ["kept", "parked", "moved"].map((n) => bm.getVisibleAt(ids[n])) };
    bm.setVisibleAt(ids.parked, false); // pool_registry park: a redundant write three leaves no trace of
    bm.setMatrixAt(ids.moved, at(140, 140)); // the batcher re-placed that instance for another placement
    bm.setVisibleAt(ids.other, true); // writes to instances the take does not hold are not ours to track
  } });
  const player = playerOn(R, { worldQuery: wq });
  player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const rep = await player.shoot({ fps: 10 });
  assert.ok(mid, "the tree's instances were hidden mid-take");
  assert.deepEqual(mid, { watched: true, hidden: [false, false, false] });
  assert.equal(rep.faded.statics, 1);
  assert.equal(bm.getVisibleAt(ids.kept), true, "untouched since our hide → re-shown");
  assert.equal(bm.getVisibleAt(ids.parked), false, "parked by its owner during the take → stays parked (round 1: un-parked)");
  assert.equal(bm.getVisibleAt(ids.moved), false, "re-placed (matrix changed) → not ours any more");
  assert.equal(bm.getVisibleAt(ids.other), true);
  assert.equal(Object.prototype.hasOwnProperty.call(bm, "setVisibleAt"), false, "the watch is removed: the prototype method again");
  assert.equal(bm.setVisibleAt, THREE.BatchedMesh.prototype.setVisibleAt);
  // A second take on the same mesh watches afresh and restores normally.
  const R2 = rig({ setpoint: { fadeIds: [T2_TREE] } });
  bm.setMatrixAt(ids.moved, at(100, 106));
  bm.setVisibleAt(ids.parked, true);
  bm.setVisibleAt(ids.moved, true);
  const p2 = playerOn(R2, { worldQuery: wq });
  p2.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  await p2.shoot({ fps: 10 });
  assert.deepEqual(["kept", "parked", "moved", "other"].map((n) => bm.getVisibleAt(ids[n])), [true, true, true, true]);
  assert.equal(Object.prototype.hasOwnProperty.call(bm, "setVisibleAt"), false);
});

check("T2 a fade that hides nothing (no resolvable draw / unknown key) reroutes instead of doing nothing; locked replays never fade", async () => {
  const S = staticDraws();
  const R = rig({ setpoint: { fadeIds: [T2_GONE, "placement:00000000:object:77"] } });
  const player = playerOn(R, { worldQuery: S.wq });
  player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const rep = await player.rehearse({ fps: 10 });
  assert.equal(rep.faded.statics, 0);
  assert.equal(rep.faded.fallbackFrames, rep.frames, "every frame fell back to the reroute bias");
  const lookups = S.calls.filter((k) => k === T2_GONE).length;
  assert.ok(lookups >= 1 && lookups <= Math.ceil(rep.frames / TP.TAKE_DEFAULTS.fadeRetryFrames) + 1, `a key with no draw is not rescanned every frame (${lookups} lookups in ${rep.frames} frames)`);
  const rows = rep.realisedTable.rows;
  const lastX = rows[(rep.frames - 1) * TR.TABLE_STRIDE + 1];
  assert.ok(lastX > 100 + 0.5, `the camera moved off the blocked line toward the roomier side (x ${lastX})`);
  // The same take with nothing to fade flies the nominal path.
  const R0 = rig();
  const p0 = playerOn(R0, { worldQuery: S.wq });
  p0.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const rep0 = await p0.rehearse({ fps: 10 });
  near(rep0.realisedTable.rows[(rep0.frames - 1) * TR.TABLE_STRIDE + 1], 100, 1e-9);
  assert.equal(rep0.faded.fallbackFrames, 0);
  // locked replay of the rerouted rehearsal: no fades, no fallbacks, same path
  const lk = await player.rehearse({ fps: 10, locked: true });
  assert.equal(lk.faded.fallbackFrames, 0);
  assert.equal(lk.realisedChecksum, rep.realisedChecksum);
});

check("T2 r4 (r4-scenery-fade): with the REAL world query, a PROCEDURAL scenery key in the fade ids hides nothing — its draw stays visible every frame and the take reroutes (fallback every frame); a PLACED tree's object key (same model, 4 m away) is hidden for the take and restored", async () => {
  const OAK = 0x02000246;
  const sceneryNode = { position: { x: 100, y: 106, z: 0 }, userData: { modelId: OAK }, visible: true };
  const placedNode = { position: { x: 104, y: 106, z: 0 }, userData: { modelId: OAK }, visible: true };
  const soa = (o) => ({ ...o, free() {} });
  const wasm = {
    async fetch_landblock_objects_soa(ids) {
      return (ids[0] & 0xffff0000) >>> 0 === 0
        ? soa({ len: 1, modelIds: Uint32Array.of(OAK), positions: Float32Array.of(104, 106, 0), scales: Float32Array.of(1), isBuilding: Uint8Array.of(0), landblockIds: Uint32Array.of(0) })
        : soa({ len: 0 });
    },
    async fetch_landblock_scenery_soa(ids) {
      return (ids[0] & 0xffff0000) >>> 0 === 0
        ? soa({ len: 1, objIds: Uint32Array.of(OAK), positions: Float32Array.of(100, 106, 0), scales: Float32Array.of(1), landblockIds: Uint32Array.of(0) })
        : soa({ len: 0 });
    },
  };
  const wq = WQ.createWorldQuery({
    liveScene3d: { frameTime: { tsMs: 0 }, staticsGroup: { children: [sceneryNode, placedNode] }, entityManager: { entityMap: new Map() } },
    wasmExports: wasm,
    catalogs: { vfxArchetypeOf: (did) => (did === OAK ? "trunk-canopy" : null) },
    ownerRegistry: null,
    now: () => 0,
  });
  const rows = await wq.staticsNear([102, 106, 0], 10);
  const sceneryKey = WQ.staticFadeKey(rows.find((r) => r.source === "scenery"));
  const placedKey = WQ.staticFadeKey(rows.find((r) => r.source === "object"));
  assert.deepEqual([sceneryKey, placedKey], ["placement:00000000:scenery:0", "placement:00000000:object:0"]);
  assert.equal(WQ.isStaticFadeKey(sceneryKey), true, "the take player routes it to staticFadeTargets…");
  assert.equal(wq.staticFadeTargets(sceneryKey), null, "…which resolves a scenery key to nothing (v1)");
  // (a) the scenery key: nothing hidden on any frame, every frame falls back to the reroute bias.
  let sceneryHiddenFrames = 0;
  const Ra = rig({ setpoint: { fadeIds: [sceneryKey] }, onStep: () => {
    if (sceneryNode.visible !== true || sceneryNode.userData.__filmHidden !== undefined) sceneryHiddenFrames += 1;
  } });
  const pa = playerOn(Ra, { worldQuery: wq });
  pa.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const repA = await pa.rehearse({ fps: 10 });
  assert.equal(sceneryHiddenFrames, 0, "the procedural tree is never hidden");
  assert.deepEqual([repA.faded.statics, repA.faded.fallbackFrames], [0, repA.frames], "a fade that hides nothing → reroute every frame");
  assert.deepEqual(sceneryNode, { position: { x: 100, y: 106, z: 0 }, userData: { modelId: OAK }, visible: true }, "untouched");
  // (b) the PLACED tree's key: hidden during the take, restored after, no fallback.
  let placedHiddenFrames = 0;
  const Rb = rig({ setpoint: { fadeIds: [placedKey] }, onStep: () => {
    if (placedNode.visible === false) placedHiddenFrames += 1;
    if (sceneryNode.visible !== true) sceneryHiddenFrames += 1;
  } });
  const pb = playerOn(Rb, { worldQuery: wq });
  pb.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const repB = await pb.rehearse({ fps: 10 });
  assert.ok(placedHiddenFrames > 0, "the placed tree was hidden during the take");
  assert.equal(sceneryHiddenFrames, 0, "its procedural neighbour at another spot still never is");
  assert.deepEqual([repB.faded.statics, repB.faded.fallbackFrames], [1, 0]);
  assert.deepEqual([placedNode.visible, placedNode.userData], [true, { modelId: OAK }], "restored exactly");
});

check("T2 seams-7: the real safety lens and a pilot fade share a smoke cloud — release() runs before the fades are restored, the cloud is never left hidden", async () => {
  // (a) the review scene: the pilot fades the cloud, then the SAME frame's lens query (a snapshot
  // cached before the fade) still returns it, so the reflex records "previous = hidden".
  // (b) the other order: the lens hid the cloud first (pre-roll), a stale snapshot still offers it
  // to the fade — the fade must not take it over.
  for (const scene of ["fade-then-lens", "lens-then-fade"]) {
    for (const own of [true, false]) {
      const emitter = own ? { filmHidden: false } : {};
      const order = [];
      let invalidated = 0;
      const lensRows = [{ emitter, key: "m0#3", center: [100, 101, 10], radius: 1, range: 0 }];
      const safety = createSafety({
        los: { segmentBlocked: () => ({ blocked: false }) },
        particles: { near: () => (scene === "lens-then-fade" || emitter.filmHidden === true ? lensRows : []) },
      });
      const realRelease = safety.release;
      safety.release = () => {
        order.push(["release", emitter.filmHidden]);
        return realRelease();
      };
      const R = rig({ setpoint: { fadeIds: ["m0#3"] } });
      const player = playerOn(R, {
        safety,
        particles: { snapshot: () => [{ key: "m0#3", emitter }], invalidate: () => (invalidated += 1) },
      });
      player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
      let during = null;
      R.hooks.addPostRender(() => {
        if (during === null && emitter.filmHidden === true) during = safety.hiddenEmitters();
      });
      const rep = await player.shoot({ fps: 10 });
      const tag = `${scene} / ${own ? "own" : "no own"} property`;
      assert.equal(during, 1, `${tag}: the reflex holds the cloud too`);
      assert.deepEqual(order, [["release", true]], `${tag}: release() first, while the cloud is still hidden`);
      if (own) assert.equal(emitter.filmHidden, false, `${tag}: the pre-take value is restored last — the cloud draws again`);
      else assert.equal("filmHidden" in emitter, false, `${tag}: no own property before → none after`);
      assert.equal(rep.faded.particles, scene === "fade-then-lens" ? 1 : 0, `${tag}: only an emitter the fade itself hid is the fade's`);
      assert.equal(rep.faded.fallbackFrames, 0, `${tag}: an already-hidden cloud counts as handled (no reroute)`);
      if (scene === "fade-then-lens") assert.ok(invalidated >= 1, "the fade invalidated the particle snapshot for the same frame's lens query");
    }
  }
});

check("T2 contracts-1: an indoor take's real sensors sweep the EnvCell walls of the render set (pre-roll and every take frame)", async () => {
  const cell = 0x00000105;
  const cellCalls = [];
  const wallY = 112;
  const sh = {
    getRenderSet: () => [cell],
    sweepSphereAgainstCellMesh(fx, fy, fz, tx, ty, tz, r, cells) {
      cellCalls.push(Array.from(cells));
      // an axis-aligned wall at y = 112 (north of the whole dolly)
      if (!(ty + r > wallY) || fy + r >= wallY) return undefined;
      const t = (wallY - r - fy) / (ty - fy);
      return { t, x: fx + (tx - fx) * t, y: wallY, z: fz + (tz - fz) * t, normalX: 0, normalY: -1, normalZ: 0, free() {} };
    },
  };
  const real = createSensors({ sh, los: LOS.segmentBlocked });
  const frames = [];
  const sensors = {
    sense(pose, ctx, dt) {
      const f = real.sense(pose, ctx, dt);
      frames.push({ f, indoor: ctx.indoor, cellIds: ctx.cellIds });
      return f;
    },
    reset: () => real.reset(),
  };
  const R = rig();
  const player = playerOn(R, { sensors, worldQuery: { groundZ: () => 0 } });
  player.prepare({ trajectory: northDolly(2), capture: { fps: 10 }, indoor: true, cell });
  await player.rehearse({ fps: 10 });
  assert.ok(frames.length > 20, `pre-roll + take frames sensed (${frames.length})`);
  assert.ok(frames.every((x) => x.indoor === true && x.cellIds === undefined), "the take passes no cellIds: the sensors default them");
  assert.ok(cellCalls.length > 0 && cellCalls.every((c) => c.length === 1 && c[0] === cell), "cell sweeps with the render set");
  const first = frames[0].f;
  assert.equal(first.sectors.center.kind, "wall");
  near(first.sectors.center.range, wallY - 100, 1e-6, "the wall 12 m ahead of the start pose");
  const last = frames[frames.length - 1].f;
  assert.ok(last.sectors.center.range < 3.5 && last.sectors.center.kind === "wall", `the wall ahead at the end (${last.sectors.center.range})`);
});

check("T1 abort mid-take, errors: not prepared, bad take, locked without a table, busy, recorder failure", async () => {
  const R = rig({ onPilot: (n) => (n === 5 ? R.player.abort() : null) });
  await assert.rejects(R.player.shoot({}), (e) => e.code === "FILM_NOT_PREPARED");
  assert.throws(() => R.player.prepare(null), (e) => e.code === "FILM_BAD_TAKE");
  assert.throws(() => R.player.prepare({}), (e) => e.code === "FILM_BAD_TAKE");
  assert.throws(() => R.player.prepare({ spec: { technique: "classic.nope", duration: 2 } }), (e) => e.code === "UNKNOWN_TECHNIQUE");
  R.player.prepare({ trajectory: northDolly(2), capture: { fps: 10 } });
  await assert.rejects(R.player.shoot({ locked: true }), (e) => e.code === "FILM_NO_TABLE");
  const p = R.player.shoot({ fps: 10 });
  assert.throws(() => R.player.prepare({ trajectory: northDolly(1) }), (e) => e.code === "FILM_BUSY");
  const rep = await p;
  assert.equal(rep.aborted, true);
  assert.ok(rep.frames < 20 && rep.frames >= 4);
  assert.equal(R.player.currentRecorder().drain({ maxBytes: 1e9 }).done, true, "an aborted take still finishes its recorder");
  // recorder failure mid-take → FILM_RECORDER_FAILED with a partial report, recorder done
  const R2 = rig({ onStep: (n) => (n === 10 ? R2.E.instances[0].error(new Error("GPU lost")) : null) });
  R2.player.prepare({ trajectory: northDolly(2), capture: { fps: 10 } });
  await assert.rejects(R2.player.shoot({ fps: 10 }), (e) => e.code === "FILM_RECORDER_FAILED" && e.details && e.details.partial && e.details.partial.frames > 0);
  assert.equal(R2.player.currentRecorder().drain({ maxBytes: 1e9 }).done, true);
  assert.equal(R2.player.running, false);
  assert.equal(R2.clockLog.ends, 1, "the clock is handed back even on failure");
});

// ---------------------------------------------------------------------------
// T3 realtime takes on the film grid (review gate-0 / seams-4 / contracts-4 / tooling-1):
// whatever the display rate, a realtime take is a CONSTANT-RATE stream of frames at n/fps,
// so the CLI's `-r fps` stream copy, `durationSec = frames / fps` and the frame-indexed EDL
// trims play it at true speed.
// ---------------------------------------------------------------------------

/** A tiny in-memory fs for the CLI's take sink (tools/film/lib/drain.mjs createTakeSink). */
function memFs() {
  const files = new Map();
  let nextFd = 3;
  const fds = new Map();
  return {
    files,
    mkdirSync() {},
    rmSync() {},
    openSync(p) {
      files.set(p, []);
      fds.set(nextFd, p);
      return nextFd++;
    },
    writeSync(fd, buf, off = 0, len = buf.length) {
      files.get(fds.get(fd)).push(Buffer.from(buf.subarray(off, off + len)));
      return len;
    },
    closeSync(fd) {
      fds.delete(fd);
    },
    writeFileSync(p, data) {
      files.set(p, [Buffer.from(data)]);
    },
  };
}

/**
 * Shoot the prepared realtime take on a fake display: rAF timestamps advance by `stepMs(n)`
 * (a number or a function of the display frame index); the engine draws (postRender) the
 * frames for which `draw(n)` is true — and always the last one. Records each display
 * frame's wall time (relative to the first take frame) and the pose written for it.
 */
async function shootOnDisplay(R, queue, o) {
  const p = R.player.shoot({ fps: o.fps, mode: "realtime", includeTable: true, locked: o.locked === true, codec: o.codec });
  await tick();
  let ts = 20000;
  const frames = [];
  for (let n = 0; queue.length && n < 5000; n += 1) {
    const cb = queue.shift();
    ts += typeof o.stepMs === "function" ? o.stepMs(n) : o.stepMs;
    const w0 = R.writes.length;
    cb(ts);
    frames.push({ ts, write: R.writes.length > w0 ? R.writes[R.writes.length - 1] : null });
    if (queue.length === 0 || !o.draw || o.draw(n)) R.hooks.postRender();
    await tick();
  }
  const rep = await p;
  const pre = rep.preRollFrames;
  const t0 = frames[pre].ts;
  return { rep, take: frames.slice(pre).map((f) => ({ t: (f.ts - t0) / 1000, write: f.write })) };
}

/** Assert a realtime take is exactly `n` frames on the fps grid: report, encoder, drain → CLI sink, realised table. */
function assertOnGrid(R, rep, n, fps, label) {
  assert.equal(rep.frames, n, `${label}: frames`);
  near(rep.durationSec, n / fps, 1e-12, `${label}: durationSec = frames / fps`);
  assert.equal(rep.droppedFrames, 0, `${label}: nothing dropped`);
  assert.equal(rep.grabbedFrames, n, `${label}: grabbed`);
  const enc = R.E.instances[R.E.instances.length - 1].encoded;
  assert.equal(enc.length, n, `${label}: encoded frames`);
  enc.forEach((e, k) => assert.equal(e.timestamp, Math.round((k / fps) * 1e6), `${label}: frame ${k} stamped k/fps`));
  assert.ok(enc.every((e) => e.duration === Math.round(1e6 / fps)));
  assert.ok(R.F.frames.every((f) => f.closed), `${label}: every VideoFrame (and held copy) closed`);
  // The CLI's view: drain → take sink (raw Annex-B, no timestamps) → `-r fps` mux.
  const d = R.player.currentRecorder().drain({ maxBytes: 1e9 });
  assert.equal(d.done, true);
  const sink = DRAIN.createTakeSink({ dir: "/mem", name: label, codec: "auto", fps, width: 640, height: 360, fs: memFs() });
  sink.write(d.chunks, d.stats);
  const raw = sink.close();
  assert.equal(raw.kind, "avc");
  assert.equal(raw.frames, n, `${label}: the CLI drains ${n} frames`);
  near((raw.lastTimestampUs - raw.firstTimestampUs) / 1e6 + 1 / fps, raw.frames / fps, 1e-6, `${label}: timestamps span frames / fps (constant rate)`);
  // The realised table: one row per recorded frame at n/fps.
  const tbl = rep.realisedTable;
  assert.equal(tbl.frames, n);
  near(tbl.meta.takeDuration, n / fps, 1e-12);
  for (let k = 0; k < n; k += 1) near(tbl.rows[k * TR.TABLE_STRIDE], k / fps, 1e-12, `${label}: row ${k} time`);
}

check("T3 realtime at 22, 30 and 60 Hz displays: frames = round(D·fps) at n/fps; each grid point is the first drawn frame at wall t ≥ n/fps", async () => {
  const fps = 30;
  const D = 2;
  for (const hz of [22, 30, 60]) {
    const queue = [];
    const R = rig({ raf: (cb) => queue.push(cb) });
    R.player.prepare({ trajectory: northDolly(D), capture: { fps, mode: "realtime" } });
    const { rep, take } = await shootOnDisplay(R, queue, { fps, stepMs: 1000 / hz });
    assertOnGrid(R, rep, Math.round(D * fps), fps, `${hz} Hz`);
    near(rep.realtime.wallSec, D, 1e-9, `${hz} Hz: wall duration`);
    assert.equal(rep.realtime.gridFrames, 60);
    // Which drawn frame each grid point holds: the first display frame at wall t ≥ n/fps
    // (the dolly's y = 100 + 5·t), and the end pose for points after the last take frame.
    const rows = rep.realisedTable.rows;
    for (let k = 0; k < 60; k += 1) {
      const y = rows[k * TR.TABLE_STRIDE + 2];
      const first = take.find((f) => f.t >= k / fps - 1e-9 && f.write);
      near(y, first.write.pos[1], 1e-9, `${hz} Hz: grid ${k} holds the frame drawn at ${first.t}`);
      assert.ok(y >= 100 + 5 * (k / fps) - 1e-9 && y - (100 + 5 * (k / fps)) < 5 / hz + 1e-9, `${hz} Hz: grid ${k} lags < one display frame`);
    }
    if (hz === 22) assert.ok(rep.realtime.heldFrames >= 14 && rep.realtime.skippedDisplayFrames === 0, `22 Hz holds (${JSON.stringify(rep.realtime)})`);
    if (hz === 30) assert.ok(rep.realtime.heldFrames === 0 && rep.realtime.skippedDisplayFrames === 0, JSON.stringify(rep.realtime));
    if (hz === 60) assert.ok(rep.realtime.heldFrames === 0 && rep.realtime.skippedDisplayFrames >= 59, JSON.stringify(rep.realtime));
    // The recorder encoded held points as re-stamped copies of one canvas wrap.
    assert.equal(rep.recorder.heldFrames, rep.realtime.heldFrames);
    assert.equal(rep.recorder.framesGrabbed, 60);
  }
});

check("T3 a jittery ~24 Hz display, frames the engine never draws, and encoder backpressure: still exactly D·fps frames at n/fps", async () => {
  const fps = 30;
  // seeded jitter: 35–48 ms between vsyncs
  let s = 7;
  const jitter = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return 35 + 13 * (s / 4294967296);
  };
  const qa = [];
  const A = rig({ raf: (cb) => qa.push(cb) });
  A.player.prepare({ trajectory: northDolly(3), capture: { fps, mode: "realtime" } });
  const a = await shootOnDisplay(A, qa, { fps, stepMs: jitter });
  assertOnGrid(A, a.rep, 90, fps, "jitter");
  // ?targetFps-style throttle: rAF at 60 Hz, the engine draws only every third callback.
  const qb = [];
  const B = rig({ raf: (cb) => qb.push(cb) });
  B.player.prepare({ trajectory: northDolly(2), capture: { fps, mode: "realtime" } });
  const b = await shootOnDisplay(B, qb, { fps, stepMs: 1000 / 60, draw: (n) => n % 3 === 0 });
  assertOnGrid(B, b.rep, 60, fps, "undrawn");
  assert.ok(b.rep.realtime.undrawnDisplayFrames > 20, `undrawn frames handed their grid points on (${b.rep.realtime.undrawnDisplayFrames})`);
  // backpressure: the recorder refuses every third armed frame; its points ride on the next one.
  const qc = [];
  const C = rig({ raf: (cb) => qc.push(cb) });
  let calls = 0;
  const player = TP.createTakePlayer({
    cameraOwner: C.cam, clock: C.clock, sensors: C.sensors, pilot: C.pilot, safety: C.safety, liveScene3d: C.live,
    requestAnimationFrame: (cb) => qc.push(cb),
    recorder: (ro) => {
      const r = REC.createRecorder({ canvas: fakeCanvas(640, 360), ...ro, VideoEncoder: C.E, VideoFrame: C.F });
      const w = Object.create(r);
      w.hasCapacity = () => calls++ % 3 !== 1;
      return w;
    },
  });
  C.player = player;
  player.prepare({ trajectory: northDolly(2), capture: { fps, mode: "realtime" } });
  const c = await shootOnDisplay(C, qc, { fps, stepMs: 1000 / 30 });
  assertOnGrid(C, c.rep, 60, fps, "backpressure");
  assert.ok(c.rep.realtime.backpressureFrames >= 15 && c.rep.realtime.heldFrames >= 15, JSON.stringify(c.rep.realtime));
});

check("T3 a slowed realtime take runs longer on the wall clock: frames = ⌈wall·fps⌉; its table replays locked (stepped) bit-identically", async () => {
  const fps = 30;
  const queue = [];
  const R = rig({ raf: (cb) => queue.push(cb), speed: 0.8 });
  R.player.prepare({ trajectory: northDolly(1), capture: { fps, mode: "realtime" } });
  const { rep } = await shootOnDisplay(R, queue, { fps, stepMs: 1000 / 30 });
  near(rep.realtime.wallSec, 1.25, 1e-9, "1 s of path at 0.8× takes 1.25 s");
  assertOnGrid(R, rep, 38, fps, "slowed");
  assert.equal(rep.overrunFrames, 8);
  // The realised table is on the grid: a stepped locked replay samples it at its own row times.
  R.setSpeed(1);
  R.player.prepare({ table: JSON.parse(JSON.stringify(rep.realisedTable)), capture: { fps } });
  const replay = await R.player.shoot({ fps, mode: "stepped", locked: true });
  assert.equal(replay.frames, 38);
  assert.equal(replay.realisedChecksum, rep.realisedChecksum, "same poses at the same film times");
});

check("T3 R3b grab([t…]) wraps the canvas once and encodes it once per film time (held frame); 'frames' pushes one JPEG per time", async () => {
  const E = makeEncoderClass();
  const F = makeFrameClass();
  const r = REC.createRecorder({ canvas: fakeCanvas(), fps: 30, keyIntervalSec: 0.1, VideoEncoder: E, VideoFrame: F });
  await r.start();
  assert.equal(r.grab([0]), true);
  assert.equal(r.grab([1 / 30, 2 / 30, 3 / 30]), true);
  assert.equal(r.grab(4 / 30), true);
  assert.equal(r.grab([]), false, "no film time, nothing recorded");
  const enc = E.instances[0].encoded;
  assert.deepEqual(enc.map((e) => e.timestamp), [0, 1, 2, 3, 4].map((k) => Math.round((k / 30) * 1e6)));
  assert.deepEqual(enc.map((e) => e.keyFrame), [true, false, false, true, false], "keyframe every 3 frames, copies included");
  const fromCanvas = F.frames.filter((f) => f.source && f.source.width === 1280);
  assert.equal(fromCanvas.length, 3, "three canvas wraps for five frames");
  assert.equal(F.frames.filter((f) => f.source instanceof F).length, 2, "two re-stamped copies of the wrapped frame");
  assert.ok(F.frames.every((f) => f.closed));
  assert.equal(r.stats().heldFrames, 2);
  assert.equal(r.stats().framesGrabbed, 5);
  const canvas = fakeCanvas();
  const j = REC.createRecorder({ canvas, codec: "frames", fps: 30 });
  await j.start();
  assert.equal(j.grab([0, 1 / 30, 2 / 30]), true);
  assert.equal(canvas.dataUrls, 1, "one toDataURL for a held frame");
  const d = j.drain({ maxBytes: 1e9 });
  assert.deepEqual(d.chunks.map((c) => c.timestampUs), [0, 33333, 66667]);
  assert.ok(d.chunks.every((c) => c.b64 === d.chunks[0].b64));
});

check("T3 a realtime take runs the injected particle cull at recheckInterval 1 and restores the previous interval", async () => {
  const queue = [];
  const R = rig({ raf: (cb) => queue.push(cb) });
  const calls = [];
  let cur = { maxDistance: 220, recheckInterval: 6 };
  const particleCull = {
    setParticleCullConfig(o) {
      calls.push({ ...o });
      const prev = { ...cur };
      if (o.recheckInterval !== undefined && o.recheckInterval !== null) cur.recheckInterval = o.recheckInterval;
      if (o.maxDistance !== undefined && o.maxDistance !== null) cur.maxDistance = o.maxDistance;
      return prev;
    },
  };
  let during = null;
  R.hooks.addPostRender(() => {
    if (during === null && R.player.running) during = cur.recheckInterval;
  });
  R.player = TP.createTakePlayer({
    cameraOwner: R.cam, clock: R.clock, sensors: R.sensors, pilot: R.pilot, safety: R.safety, liveScene3d: R.live,
    requestAnimationFrame: (cb) => queue.push(cb), particleCull,
    recorder: (ro) => REC.createRecorder({ canvas: fakeCanvas(640, 360), ...ro, VideoEncoder: R.E, VideoFrame: R.F }),
  });
  R.player.prepare({ trajectory: northDolly(1), capture: { fps: 10, mode: "realtime" } });
  // Someone retunes maxDistance mid-take: the take restores ONLY the interval it changed.
  const { rep } = await shootOnDisplay(R, queue, { fps: 10, stepMs: 100, draw: (n) => (n === 8 ? (cur.maxDistance = 900, true) : true) });
  assert.equal(during, 1);
  assert.deepEqual(calls, [{ recheckInterval: 1 }, { recheckInterval: 6 }]);
  assert.deepEqual(cur, { maxDistance: 900, recheckInterval: 6 });
  assert.deepEqual(rep.particleCull, { recheckInterval: 1, previous: 6, restored: true });
});

// ---------------------------------------------------------------------------
// L1 live subjects: the nominal is re-anchored to a subject that moves during the take
// (review math-0 / contracts-0). The fake entity ignores t and moves on the wall clock,
// exactly like index.js liveSubject; the shot is built against the prepare-time pose.
// ---------------------------------------------------------------------------

const LIVE_P0 = [1000, 1000, 0];
const LIVE_ASPECT = 16 / 9;

/** A server-driven subject a test moves between display frames; live() reads it like index.js liveSubject (no t). */
function walker(heading = 0) {
  const ent = { pos: LIVE_P0.slice(), heading };
  return { ent, live: () => ({ pos: ent.pos.slice(), radius: 0.45, height: 1.8, heading: ent.heading }) };
}

/** The prepare-time (reference) subject the shot is built against. */
const refSubject = (heading = 0) => ({ pos: LIVE_P0.slice(), radius: 0.45, height: 1.8, heading });

/** Shoot the prepared take in realtime at `hz`; motion(ent, wallSec, n) runs before each display frame. */
async function shootMoving(R, queue, ent, motion, hz = 30) {
  const p = R.player.shoot({ fps: hz, mode: "realtime", includeTable: true });
  await tick();
  let ts = 5000;
  let wall = 0;
  const seen = [];
  for (let n = 0; queue.length && n < 4000; n += 1) {
    const cb = queue.shift();
    ts += 1000 / hz;
    wall += 1 / hz;
    motion(ent, wall, n);
    seen.push(ent.pos.slice());
    cb(ts);
    R.hooks.postRender();
    await tick();
  }
  const rep = await p;
  return { rep, seen };
}

/** Realised row k of a table as a pose. */
function rowPose(rows, k) {
  const o = k * TR.TABLE_STRIDE;
  return { t: rows[o], pos: [rows[o + 1], rows[o + 2], rows[o + 3]], q: [rows[o + 4], rows[o + 5], rows[o + 6], rows[o + 7]], fov: rows[o + 8] };
}

/** NDC of a world point seen from a pose (AC camera: forward +Y, right +X, up +Z); null behind the camera. */
function ndcOf(pose, pt, aspect = LIVE_ASPECT) {
  const d = [pt[0] - pose.pos[0], pt[1] - pose.pos[1], pt[2] - pose.pos[2]];
  const f = qRotate(pose.q, [0, 1, 0]), r = qRotate(pose.q, [1, 0, 0]), u = qRotate(pose.q, [0, 0, 1]);
  const z = d[0] * f[0] + d[1] * f[1] + d[2] * f[2];
  if (!(z > 0)) return null;
  const ty = Math.tan((pose.fov * Math.PI) / 360), tx = ty * aspect;
  return [(d[0] * r[0] + d[1] * r[1] + d[2] * r[2]) / z / tx, (d[0] * u[0] + d[1] * u[1] + d[2] * u[2]) / z / ty];
}

const inFrame = (pose, pt) => {
  const n = ndcOf(pose, pt);
  return !!n && Math.abs(n[0]) <= 1 && Math.abs(n[1]) <= 1;
};

/**
 * The ShotContext of a live take: the static prepare-time subject, or (o.refVelocity) the
 * subject index.js sees walking at prepare — `velocity` + a PURE reference track
 * extrapolated from it (index.js referenceTrack).
 */
function liveCtx(o = {}) {
  if (!o.refVelocity) return { subject: refSubject(0), aspect: LIVE_ASPECT };
  const v = o.refVelocity;
  const s0 = { ...refSubject(0), velocity: v.slice() };
  return { subject: s0, subjectAt: (t) => ({ ...s0, pos: [LIVE_P0[0] + v[0] * t, LIVE_P0[1] + v[1] * t, LIVE_P0[2]] }), aspect: LIVE_ASPECT };
}

/**
 * Prepare `technique` against the reference subject (static, or extrapolated with
 * o.refVelocity; + the walker as the live subject unless `noLive`, starting o.lead m north
 * of the prepare-time spot), shoot it in realtime while `motion` moves the walker, and
 * measure every recorded frame against the live subject: distance from the camera to
 * the framing aim point ÷ the nominal rig's own distance at that progress, and |ndc| ≤ 1.
 */
async function liveTake(technique, motion, o = {}) {
  const queue = [];
  const raf = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  const R = rig({ raf, onSense: o.onSense });
  const W = walker(0);
  W.ent.pos[1] += o.lead ?? 0;
  const D = o.duration ?? 6;
  const spec = { technique, duration: D, params: o.params || {} };
  const ctx = liveCtx(o);
  const sum = R.player.prepare({ spec, ctx, liveSubject: o.noLive ? undefined : W.live, capture: { mode: "realtime", fps: 30 } });
  const nominal = SHOTS.buildShot(spec, { ...ctx, groundZ: () => 0 });
  const framing = nominal.meta.spec.framing;
  const { rep, seen } = await shootMoving(R, queue, W.ent, motion);
  const rows = rep.realisedTable.rows;
  const out = { sum, rep, seen, nominal, frames: rep.frames, ratios: [], framed: 0, poses: [], live: [] };
  for (let k = 0; k < rep.frames; k += 1) {
    const pose = rowPose(rows, k);
    const sNow = seen[rep.preRollFrames + k];
    const aim = FR.aimPointForFraming(framing, { pos: sNow, radius: 0.45, height: 1.8 });
    const nom = nominal.sample(pose.t);
    const aimRef = FR.aimPointForFraming(framing, nominal.subjectAt(pose.t));
    const dn = Math.hypot(nom.pos[0] - aimRef[0], nom.pos[1] - aimRef[1], nom.pos[2] - aimRef[2]);
    const dl = Math.hypot(pose.pos[0] - aim[0], pose.pos[1] - aim[1], pose.pos[2] - aim[2]);
    out.ratios.push(dl / dn);
    if (inFrame(pose, aim)) out.framed += 1;
    out.poses.push(pose);
    out.live.push(sNow);
  }
  return out;
}

/** Every technique registered for realtime capture of a moving subject, plus the steadicam rig. */
const LIVE_RIGS = [...SHOTS.listTechniques({}).filter((t) => t.capture === "realtime").map((t) => t.id), "classic.steadicam"];

/** 3 m/s north (the reference's own heading). */
const walkNorth = (ent) => {
  ent.pos[1] += 3 / 30;
};
/** 3 m/s north for 2 s, then a 90° turn to the east at 45°/s, facing the way it walks. */
const walkTurnEast = (ent, wall) => {
  const a = Math.min(Math.PI / 2, Math.max(0, ((wall - 2) * Math.PI) / 4));
  ent.heading = a;
  ent.pos[0] += (3 / 30) * Math.sin(a);
  ent.pos[1] += (3 / 30) * Math.cos(a);
};

check("L1 every realtime moving-subject rig follows a live subject that walks off: distance ±15 %, always framed, camera travels with it", async () => {
  assert.ok(LIVE_RIGS.length >= 8, `realtime rigs: ${LIVE_RIGS.join(", ")}`);
  for (const id of LIVE_RIGS) {
    const r = await liveTake(id, walkNorth);
    assert.deepEqual({ mode: r.sum.liveSubject.mode, rotate: r.sum.liveSubject.rotate }, { mode: "carry", rotate: true }, id);
    assert.equal(r.frames, 180, `${id}: 6 s at 30 Hz`);
    assert.equal(r.rep.liveSubject.missingFrames, 0, id);
    const lo = Math.min(...r.ratios), hi = Math.max(...r.ratios);
    assert.ok(lo >= 0.85 && hi <= 1.15, `${id}: camera–subject distance ÷ rig distance in [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
    assert.equal(r.framed, r.frames, `${id}: subject framed in ${r.framed}/${r.frames} frames`);
    const dCam = [r.poses[179].pos[0] - r.poses[0].pos[0], r.poses[179].pos[1] - r.poses[0].pos[1]];
    const dSub = [r.live[179][0] - r.live[0][0], r.live[179][1] - r.live[0][1]];
    const err = Math.hypot(dCam[0] - dSub[0], dCam[1] - dSub[1]);
    assert.ok(dSub[1] > 17 && err <= 0.15 * Math.hypot(...dSub), `${id}: the camera moved with the subject (${err.toFixed(2)} m off its ${dSub[1].toFixed(1)} m walk)`);
  }
});

check("L1 a mid-take turn swings the rig round the subject by its travel-heading change (spring-lagged, flown rigs within their craft)", async () => {
  for (const id of LIVE_RIGS) {
    const r = await liveTake(id, walkTurnEast);
    const lo = Math.min(...r.ratios), hi = Math.max(...r.ratios);
    assert.ok(lo >= 0.85 && hi <= 1.15, `${id}: distance ratio in [${lo.toFixed(3)}, ${hi.toFixed(3)}] through the turn`);
    assert.equal(r.framed, r.frames, `${id}: framed ${r.framed}/${r.frames}`);
    assert.ok(r.rep.liveSubject.maxTurnDeg > 80 && r.rep.liveSubject.maxTurnDeg <= 90.5, `${id}: turned ${r.rep.liveSubject.maxTurnDeg}°`);
  }
  // tracking-follow ends BEHIND the subject's new travel (west of it, walking east)
  const f = await liveTake("classic.tracking-follow", walkTurnEast);
  const last = f.poses[f.frames - 1], s = f.live[f.frames - 1];
  const bearing = Math.atan2(last.pos[0] - s[0], last.pos[1] - s[1]) * (180 / Math.PI);
  assert.ok(Math.abs(bearing + 90) < 12, `camera bearing from the subject ${bearing.toFixed(1)}° (behind = −90°)`);
});

check("L1 regression guard: WITHOUT the live subject the same take keeps the frozen rig and loses the walker", async () => {
  const r = await liveTake("classic.tracking-side", walkNorth, { noLive: true });
  assert.equal(r.sum.liveSubject, null);
  assert.equal(r.rep.liveSubject, null);
  assert.ok(r.framed < r.frames / 2, `frozen rig frames the walker only ${r.framed}/${r.frames} times`);
});

check("L1 other techniques keep their camera position and re-aim at the live subject (static, pan, dolly, high angle)", async () => {
  const east = (ent) => {
    ent.pos[0] += 2 / 30;
  };
  for (const id of ["classic.static", "classic.pan", "classic.dolly-in", "classic.high-angle"]) {
    const r = await liveTake(id, east);
    assert.equal(r.sum.liveSubject.mode, "aim", id);
    assert.equal(r.framed, r.frames, `${id}: framed ${r.framed}/${r.frames}`);
    for (let k = 0; k < r.frames; k += 1) {
      const nom = r.nominal.sample(r.poses[k].t).pos;
      assert.ok(Math.hypot(nom[0] - r.poses[k].pos[0], nom[1] - r.poses[k].pos[1], nom[2] - r.poses[k].pos[2]) < 1e-9, `${id}: frame ${k} at the nominal position`);
    }
    const bare = await liveTake(id, east, { noLive: true });
    assert.ok(bare.framed < r.frames, `${id}: without the live subject it is framed ${bare.framed}/${r.frames}`);
  }
});

check("L1 a server snap is eased in (no jump, no swing) and the rig settles back on the subject", async () => {
  const snap = (ent, wall, n) => {
    ent.pos[1] += 3 / 30;
    if (n === 66) ent.pos[0] += 3;
  };
  const r = await liveTake("classic.tracking-follow", snap);
  let maxStep = 0;
  for (let k = 1; k < r.frames; k += 1) {
    const a = r.poses[k - 1].pos, b = r.poses[k].pos;
    maxStep = Math.max(maxStep, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]));
  }
  assert.ok(maxStep < 0.75, `largest per-frame camera step ${maxStep.toFixed(3)} m (the snap is 3 m)`);
  assert.ok(r.rep.liveSubject.maxTurnDeg < 1, `a snap is not travel: turned ${r.rep.liveSubject.maxTurnDeg}°`);
  assert.ok(r.rep.liveSubject.maxLagM > 1, "the snap was felt");
  const tail = r.ratios.slice(-60);
  assert.ok(tail.every((x) => Math.abs(x - 1) < 0.02), `settled within 1 s (${Math.min(...tail).toFixed(3)}…${Math.max(...tail).toFixed(3)})`);
});

check("L1 sensors / pilot see the LIVE subject; a live subject that never leaves the reference changes nothing (stepped bytes identical)", async () => {
  const sensed = [];
  const W = walker(0);
  const onSense = (pose, ctx) => sensed.push(ctx.subject ? ctx.subject.pos.slice() : null);
  const queue = [];
  const R = rig({ raf: (cb) => queue.push(cb), onSense });
  R.player.prepare({ spec: { technique: "classic.tracking-follow", duration: 2 }, ctx: { subject: refSubject(0) }, liveSubject: W.live, capture: { mode: "realtime", fps: 30 } });
  await shootMoving(R, queue, W.ent, walkNorth);
  const late = sensed.filter(Boolean).slice(-5);
  assert.ok(late.every((p) => p[1] > LIVE_P0[1] + 5), `sensors measured the walker (y ${late.map((p) => p[1].toFixed(1)).join(", ")}), not the prepare-time spot`);
  // stepped: a take without a live subject vs one whose live subject sits exactly on the reference
  const run = async (live) => {
    const R2 = rig();
    R2.player.prepare({ spec: { technique: "classic.tracking-follow", duration: 2, seed: 5 }, ctx: { subject: refSubject(0) }, liveSubject: live, capture: { fps: 10 } });
    return R2.player.rehearse({ fps: 10 });
  };
  const still = walker(0);
  const a = await run(undefined);
  const b = await run(still.live);
  assert.equal(b.liveSubject.mode, "carry");
  assert.equal(a.liveSubject, null);
  assert.equal(b.checksum, a.checksum, "identical realised bytes");
  assert.deepEqual(b.realisedTable.rows, a.realisedTable.rows);
});

// ---------------------------------------------------------------------------
// L2 (review round 2, math-0 / contracts-0): a subject already walking at prepare. index.js then
// builds the shot against a reference track EXTRAPOLATED from its velocity, while the pre-roll
// holds that reference at p = 0. The pre-roll must settle the follower on the offset velocity
// the take will see (subject − reference), or the rig surges / drops back when the progress
// starts (a flown craft was reset at double speed: per-frame camera speed 6 m/s for a 3 m/s walk,
// drone.chase 20 % closer, drone.lead 21 % farther, ~3 s to settle).
// ---------------------------------------------------------------------------

const WALK = 3;

/** Per-frame camera speeds (m/s) between consecutive recorded frames. */
function camSpeeds(poses, fps = 30) {
  const out = [];
  for (let k = 1; k < poses.length; k += 1) {
    const a = poses[k - 1].pos, b = poses[k].pos;
    out.push(Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]) * fps);
  }
  return out;
}

/**
 * liveTake's stepped twin (rehearse): the walker moves once per rendered frame (pre-roll and
 * take); frame k's pose was computed at the walker's position after preRoll + k steps.
 */
async function liveRehearse(technique, motion, o = {}) {
  const fps = o.fps ?? 30;
  const W = walker(0);
  W.ent.pos[1] += o.lead ?? 0;
  const seen = [W.ent.pos.slice()];
  const R = rig({
    onStep: (n) => {
      motion(W.ent, n / fps, n, fps);
      seen.push(W.ent.pos.slice());
    },
  });
  const spec = { technique, duration: o.duration ?? 6 };
  const ctx = liveCtx(o);
  const sum = R.player.prepare({ spec, ctx, liveSubject: W.live, capture: { fps } });
  const nominal = SHOTS.buildShot(spec, { ...ctx, groundZ: () => 0 });
  const framing = nominal.meta.spec.framing;
  const rep = await R.player.rehearse({ fps });
  const out = { sum, rep, frames: rep.frames, ratios: [], framed: 0, poses: [], live: [] };
  for (let k = 0; k < rep.frames; k += 1) {
    const pose = rowPose(rep.realisedTable.rows, k);
    const sNow = seen[rep.preRollFrames + k];
    const aim = FR.aimPointForFraming(framing, { pos: sNow, radius: 0.45, height: 1.8 });
    const nom = nominal.sample(pose.t);
    const aimRef = FR.aimPointForFraming(framing, nominal.subjectAt(pose.t));
    out.ratios.push(Math.hypot(pose.pos[0] - aim[0], pose.pos[1] - aim[1], pose.pos[2] - aim[2]) /
      Math.hypot(nom.pos[0] - aimRef[0], nom.pos[1] - aimRef[1], nom.pos[2] - aimRef[2]));
    if (inFrame(pose, aim)) out.framed += 1;
    out.poses.push(pose);
    out.live.push(sNow);
  }
  return out;
}

/** The surge checks of a walking-subject take: speed ≤ k·walk every frame, distance ±15 %, camera travels the walk. */
function assertNoSurge(r, id, k = 1.25) {
  const sp = camSpeeds(r.poses);
  const peak = Math.max(...sp);
  assert.ok(peak <= k * WALK, `${id}: per-frame camera speed peaks at ${peak.toFixed(2)} m/s for a ${WALK} m/s walk (first frames ${sp.slice(0, 4).map((x) => x.toFixed(2)).join(", ")})`);
  const lo = Math.min(...r.ratios), hi = Math.max(...r.ratios);
  assert.ok(lo >= 0.85 && hi <= 1.15, `${id}: camera–subject distance ÷ rig distance in [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
  assert.equal(r.framed, r.frames, `${id}: framed ${r.framed}/${r.frames}`);
  const n = r.frames - 1;
  const dCam = r.poses[n].pos[1] - r.poses[0].pos[1], dSub = r.live[n][1] - r.live[0][1];
  assert.ok(dSub > 15 && Math.abs(dCam - dSub) <= 0.15 * dSub, `${id}: camera moved ${dCam.toFixed(2)} m for the subject's ${dSub.toFixed(2)} m`);
}

check("L2 a subject walking at prepare (extrapolated reference) keeps walking through the pre-roll + take: no surge — per-frame camera speed ≤ 1.25× the walk, distance ±15 %, every realtime rig", async () => {
  for (const id of LIVE_RIGS) {
    const r = await liveTake(id, walkNorth, { refVelocity: [0, WALK, 0], lead: 6 });
    assert.equal(r.frames, 180, id);
    assert.equal(r.sum.liveSubject.mode, "carry", id);
    assertNoSurge(r, id);
    assert.ok(r.rep.liveSubject.maxLagM < 0.05, `${id}: the follower was already in steady state (max lag ${r.rep.liveSubject.maxLagM.toFixed(3)} m)`);
  }
});

check("L2 the same in a stepped rehearsal (the checker's case: drone.chase / drone.lead / tracking-follow); flown rigs are reset at the walk's speed, not double", async () => {
  for (const id of ["drone.chase", "drone.lead", "drone.side-track", "classic.tracking-follow"]) {
    const r = await liveRehearse(id, walkNorth, { refVelocity: [0, WALK, 0], lead: 6 });
    assert.equal(r.frames, 180, id);
    assertNoSurge(r, id);
    const sp = camSpeeds(r.poses);
    assert.ok(Math.abs(sp[0] - WALK) < 0.1, `${id}: the first recorded step already moves at the walk (${sp[0].toFixed(3)} m/s)`);
    if (id.startsWith("drone.")) {
      assert.ok(r.rep.flight && r.rep.flight.tracking, `${id}: flown`);
      assert.ok(r.rep.flight.tracking.maxGapM < 0.1, `${id}: the craft never trailed its re-anchored nominal (max gap ${r.rep.flight.tracking.maxGapM.toFixed(3)} m)`);
    }
  }
});

check("L2 a subject that stopped during the pre-roll (the reference walks on without it): the camera stays at rest, distance ±15 %", async () => {
  const stand = () => {};
  for (const id of LIVE_RIGS) {
    const r = await liveTake(id, stand, { refVelocity: [0, WALK, 0], lead: 6 });
    const peak = Math.max(...camSpeeds(r.poses));
    assert.ok(peak <= 0.25 * WALK, `${id}: the camera drifts at up to ${peak.toFixed(2)} m/s past a standing subject`);
    const lo = Math.min(...r.ratios), hi = Math.max(...r.ratios);
    assert.ok(lo >= 0.85 && hi <= 1.15, `${id}: distance ratio [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
    assert.equal(r.framed, r.frames, `${id}: framed`);
  }
});

// ---------------------------------------------------------------------------
// L3 (review round 3, check:r2-subject): a flown carry rig's craft is fed the FULL time derivative of
// the re-anchored pose (liveDerivs: the reference's travel + the nominal's travel about it turned by θ
// + the swing-rate terms θ̇ / θ̈ + the follower's ẋ / ẍ). Round 2 fed R_θ(vN) + ẋ only — wrong by
// (I − R_θ)·vR whenever the subject walks off the reference heading (θ ≠ 0: drone.chase's first step
// 4.42 m/s for a 3 m/s walk NE of a north reference, drone.side-track 1.36× too far) and blind to the
// swing round a turning subject. A turn sharper than the craft's amax (the 90°/s case: the subject
// alone asks 4.7 m/s² of a 4 m/s² craft) also froze nothing: the swing piled its own acceleration on
// top (drone.side-track 0.75× the distance); now it spends only what the subject leaves (swingStep).
// ---------------------------------------------------------------------------

/** fps-aware walks for liveRehearse: NE at the walk speed (45° off a north reference). */
const walkNE = (ent, t, n, fps) => {
  const s = WALK / fps / Math.SQRT2;
  ent.pos[0] += s;
  ent.pos[1] += s;
  ent.heading = Math.PI / 4;
};
/** North at the walk speed, then a 90°/s turn to the east from t = 1 s (the checker's turnEast). */
const turnEast90 = (ent, t, n, fps) => {
  const a = Math.min(Math.PI / 2, Math.max(0, ((t - 1) * Math.PI) / 2));
  ent.heading = a;
  ent.pos[0] += (WALK / fps) * Math.sin(a);
  ent.pos[1] += (WALK / fps) * Math.cos(a);
};
const L3_RIGS = ["drone.chase", "drone.lead", "drone.side-track", "classic.tracking-follow"];

check("L3 a subject walking 45° off the reference heading (NE; reference extrapolated north): first recorded step at the walk, distance ±2 %, the craft on its nominal — 24 / 30 / 60 fps", async () => {
  for (const fps of [24, 30, 60]) {
    for (const id of L3_RIGS) {
      const tag = `${id} @${fps}`;
      const r = await liveRehearse(id, walkNE, { refVelocity: [0, WALK, 0], lead: 6, fps });
      assert.equal(r.frames, 6 * fps, tag);
      const sp = camSpeeds(r.poses, fps);
      assert.ok(Math.abs(sp[0] - WALK) < 0.05, `${tag}: first recorded step ${sp[0].toFixed(3)} m/s (round 2: 4.42 = |2vL − vR|)`);
      assert.ok(Math.max(...sp) <= 1.02 * WALK, `${tag}: per-frame speed peaks at ${Math.max(...sp).toFixed(3)} m/s`);
      const lo = Math.min(...r.ratios), hi = Math.max(...r.ratios);
      assert.ok(lo >= 0.98 && hi <= 1.02, `${tag}: distance ratio [${lo.toFixed(3)}, ${hi.toFixed(3)}]`);
      assert.equal(r.framed, r.frames, `${tag}: framed`);
      const n = r.frames - 1;
      const dCam = [r.poses[n].pos[0] - r.poses[0].pos[0], r.poses[n].pos[1] - r.poses[0].pos[1]];
      const dSub = [r.live[n][0] - r.live[0][0], r.live[n][1] - r.live[0][1]];
      assert.ok(Math.hypot(dCam[0] - dSub[0], dCam[1] - dSub[1]) <= 0.02 * Math.hypot(...dSub), `${tag}: the camera travelled the subject's NE walk`);
      near(r.rep.liveSubject.maxTurnDeg, 45, 0.5, `${tag}: turned by the 45° travel-heading change`);
      if (id.startsWith("drone.")) {
        assert.ok(r.rep.flight.tracking.maxGapM < 0.1, `${tag}: the craft trailed its re-anchored nominal by ${r.rep.flight.tracking.maxGapM.toFixed(3)} m (round 2: 3.06)`);
      }
    }
  }
});

check("L3 a subject turning 90°/s mid-take (beyond the cinema craft's amax): distance ±15 %, framed, no per-frame speed spike, first step at the walk, the swing still completes — 24 / 30 / 60 fps", async () => {
  for (const fps of [24, 30, 60]) {
    for (const id of L3_RIGS) {
      const tag = `${id} @${fps}`;
      const r = await liveRehearse(id, turnEast90, { refVelocity: [0, WALK, 0], lead: 6, fps });
      const lo = Math.min(...r.ratios), hi = Math.max(...r.ratios);
      assert.ok(lo >= 0.85 && hi <= 1.15, `${tag}: distance ratio [${lo.toFixed(3)}, ${hi.toFixed(3)}] (round 2 + the vR term only: side-track 0.75…, lead …1.18)`);
      assert.equal(r.framed, r.frames, `${tag}: framed ${r.framed}/${r.frames}`);
      const sp = camSpeeds(r.poses, fps);
      assert.ok(Math.abs(sp[0] - WALK) < 0.05, `${tag}: first recorded step ${sp[0].toFixed(3)} m/s`);
      let jump = 0;
      for (let k = 1; k < sp.length; k += 1) jump = Math.max(jump, Math.abs(sp[k] - sp[k - 1]));
      // 6 m/s² of speed change per frame at most: the subject's own 4.7 m/s² turn plus margin (a surge is a whole m/s in one frame)
      assert.ok(jump <= 6 / fps, `${tag}: the per-frame camera speed jumps by ${jump.toFixed(3)} m/s (limit ${(6 / fps).toFixed(3)})`);
      assert.ok(r.rep.liveSubject.maxTurnDeg > 80 && r.rep.liveSubject.maxTurnDeg <= 90.5, `${tag}: swung ${r.rep.liveSubject.maxTurnDeg.toFixed(1)}°`);
      if (id.startsWith("drone.")) {
        assert.ok(r.rep.flight.tracking.maxGapM < 2.5, `${tag}: the craft trailed by ${r.rep.flight.tracking.maxGapM.toFixed(2)} m (the subject's turn alone asks 4.7 m/s²)`);
      }
    }
  }
});

// ---------------------------------------------------------------------------
// F1 flight feasibility (review math-2): a path the flying preset cannot keep up with is reported
// ---------------------------------------------------------------------------

check("F1 prepare reports 'overspeed' with the minimum feasible duration when a drone path outruns the preset's vmax", () => {
  const R = rig();
  const path = (len) => [[1000, 1000, 0], [1000 + len / 2, 1005, 0], [1000 + len, 1000, 0]];
  const spec = { technique: "drone.canyon-run", duration: 12 };
  const fast = R.player.prepare({ spec, ctx: { path: path(200) }, capture: { fps: 30 } });
  assert.equal(fast.flight.preset, "cinema");
  assert.equal(fast.flight.overspeed, true);
  assert.equal(fast.validation.ok, false);
  const iss = fast.validation.issues.find((i) => i.code === "overspeed");
  assert.ok(iss, JSON.stringify(fast.validation));
  assert.equal(fast.validation.counts.overspeed, 1);
  const traj = SHOTS.buildShot(spec, { path: path(200), groundZ: () => 0 });
  assert.equal(traj.meta.overspeed, true);
  assert.equal(fast.flight.profileOverspeed, true);
  // peak = the larger of the builder's profile peak and the peak measured on the baked nominal
  assert.equal(fast.flight.metaPeakSpeed, traj.meta.peakSpeed);
  assert.equal(fast.flight.peakSpeed, Math.max(traj.meta.peakSpeed, fast.flight.sampledPeakSpeed));
  assert.ok(Math.abs(fast.flight.sampledPeakSpeed - traj.meta.peakSpeed) < 0.05 * traj.meta.peakSpeed, "linear ease: measured ≈ profile peak");
  const need = Math.max(12 * fast.flight.peakSpeed, traj.meta.lengthM) / 12;
  near(iss.minDurationSec, Math.ceil(need * 10 - 1e-9) / 10, 1e-9, "duration at which the same profile peaks at vmax (≥ length / vmax)");
  assert.equal(fast.flight.minDurationVerified, true, "the shot rebuilt at minDurationSec passes");
  assert.ok(iss.minDurationSec > 12 && /≤ 12 m\/s/.test(iss.message) && /duration ≥/.test(iss.message), iss.message);
  const atMin = R.player.prepare({ spec: { ...spec, duration: iss.minDurationSec }, ctx: { path: path(200) }, capture: { fps: 30 } });
  assert.equal(atMin.flight.overspeed, false, "the suggested duration is flyable");
  assert.equal(atMin.validation.issues.some((i) => i.code === "overspeed"), false);
  // flyable for cinema, but the director asked for the heavy lifter (vmax 7): measured against the preset that flies
  const mid = R.player.prepare({ spec, ctx: { path: path(110) }, capture: { fps: 30 } });
  assert.equal(mid.flight.overspeed, false);
  assert.equal(mid.validation.issues.some((i) => i.code === "overspeed"), false);
  const heavy = R.player.prepare({ spec, ctx: { path: path(110) }, pilot: { flightPreset: "heavy" }, capture: { fps: 30 } });
  assert.equal(heavy.flight.preset, "heavy");
  const hi = heavy.validation.issues.find((i) => i.code === "overspeed");
  assert.ok(hi && hi.vmax === 7 && hi.minDurationSec > 12, JSON.stringify(heavy.validation));
  // classic shots and replayed tables are not flight-checked
  const cls = R.player.prepare({ trajectory: northDolly(2), capture: { fps: 10 } });
  assert.equal(cls.flight, null);
});

check("F1 round 2: flythrough reports its profile peak; the measured nominal peak catches a heavy-lift gap pass, an ease, and unprofiled moves shortened below their natural duration", () => {
  const R = rig();
  const line = (len) => [[1000, 1000, 10], [1000 + len / 2, 1005, 10], [1000 + len, 1000, 10]];
  // the checker's case: 180 m through a gap in 30 s on the heavy lifter (vmax 7) — mean 6 m/s, but ~8.9 m/s either side of the gap
  const gapSpec = { technique: "drone.flythrough", duration: 30, params: { speed: 12, gapSpeed: 0.3, gapPos: [1090, 1002.5, 10], gapNormal: [1, 0, 0] } };
  const tr = SHOTS.buildShot(gapSpec, { path: line(180), groundZ: () => 0 });
  assert.ok(Number.isFinite(tr.meta.peakSpeed) && tr.meta.peakSpeed > 8, `flythrough meta.peakSpeed ${tr.meta.peakSpeed}`);
  assert.equal(typeof tr.meta.overspeed, "boolean");
  assert.ok(tr.meta.lengthM / 30 < 7, "the MEAN speed alone would pass");
  const heavy = R.player.prepare({ spec: gapSpec, ctx: { path: line(180) }, pilot: { flightPreset: "heavy" }, capture: { fps: 30 } });
  assert.equal(heavy.flight.preset, "heavy");
  assert.equal(heavy.flight.overspeed, true, JSON.stringify(heavy.flight));
  assert.equal(heavy.flight.metaPeakSpeed, tr.meta.peakSpeed);
  const hi = heavy.validation.issues.find((i) => i.code === "overspeed");
  assert.ok(hi && hi.minDurationSec > 30 && heavy.flight.minDurationVerified === true, JSON.stringify(hi));
  const heavyAtMin = R.player.prepare({ spec: { ...gapSpec, duration: hi.minDurationSec }, ctx: { path: line(180) }, pilot: { flightPreset: "heavy" }, capture: { fps: 30 } });
  assert.equal(heavyAtMin.flight.overspeed, false, `flyable at the suggested ${hi.minDurationSec} s (peak ${heavyAtMin.flight.peakSpeed})`);
  // the profile was time-compressed beyond its style caps but stays within the cinema craft's vmax: flyable, reported, not failed
  const comp = R.player.prepare({ spec: { technique: "drone.flythrough", duration: 10.2 }, ctx: { path: line(120) }, capture: { fps: 30 } });
  assert.equal(comp.flight.profileOverspeed, true);
  assert.ok(comp.flight.peakSpeed <= 12 * 1.02, `${comp.flight.peakSpeed}`);
  assert.equal(comp.flight.overspeed, false);
  assert.equal(comp.validation.issues.some((i) => i.code === "overspeed"), false);
  // a non-linear ease speeds the middle of a profile up: measured, and a longer duration does not help (the move covers speed × duration)
  const anchorCtx = { subject: { pos: [1000, 1000, 0], radius: 0.5, height: 1.8, heading: 0 }, anchor: [1000, 1000, 0] };
  const eased = R.player.prepare({ spec: { technique: "drone.terrain-skim", duration: 10, ease: "cubicInOut" }, ctx: anchorCtx, capture: { fps: 30 } });
  near(eased.flight.metaPeakSpeed, 10, 1e-9, "the profile peak alone is within vmax");
  assert.ok(eased.flight.sampledPeakSpeed > 2 * 12, `measured ${eased.flight.sampledPeakSpeed}`);
  assert.equal(eased.flight.overspeed, true);
  assert.equal(eased.flight.durationHelps, false);
  assert.equal(eased.flight.minDurationSec, null);
  assert.equal(eased.flight.minDurationCheck, "failed", "searched, and lengthening does not help (round 3)");
  assert.equal(eased.flight.minDurationVerified, false);
  const ei = eased.validation.issues.find((i) => i.code === "overspeed");
  assert.ok(ei && ei.durationHelps === false && /does not slow/.test(ei.message) && /'cubicInOut' ease/.test(ei.message) && /ease 'linear' flies it at ≤ 10\.0 m\/s/.test(ei.message), ei && ei.message);
  const linear = R.player.prepare({ spec: { technique: "drone.terrain-skim", duration: 10 }, ctx: anchorCtx, capture: { fps: 30 } });
  assert.equal(linear.flight.overspeed, false);
  // an unprofiled move (no meta.peakSpeed) shortened below its natural duration: measured and verified
  const helix = R.player.prepare({ spec: { technique: "drone.helix", duration: 7.3 }, ctx: anchorCtx, capture: { fps: 30 } });
  assert.equal(helix.flight.metaPeakSpeed, null);
  assert.ok(helix.flight.sampledPeakSpeed > 12 * 1.02, `${helix.flight.sampledPeakSpeed}`);
  assert.equal(helix.flight.overspeed, true);
  assert.ok(helix.flight.minDurationSec > 7.3 && helix.flight.minDurationVerified === true, JSON.stringify(helix.flight));
  assert.ok(helix.flight.minDurationCheck === "verified" && helix.flight.dryFlight.maxGapM > GAP_TOL, "round 3: verified by dry-flying the rebuilt shot, not by its speed alone");
  const helixAtMin = R.player.prepare({ spec: { technique: "drone.helix", duration: helix.flight.minDurationSec }, ctx: anchorCtx, capture: { fps: 30 } });
  assert.equal(helixAtMin.flight.overspeed, false);
  const helixDefault = R.player.prepare({ spec: { technique: "drone.helix" }, ctx: anchorCtx, capture: { fps: 30 } });
  assert.equal(helixDefault.flight.overspeed, false, "at its default duration the helix is flyable");
});

check("F2 the rehearse result and the shoot report carry prepare's validation (the 'overspeed' issue + minDurationSec) and flight check, plus how far the craft trailed the nominal", async () => {
  const line = (len) => [[1000, 1000, 10], [1000 + len / 2, 1005, 10], [1000 + len, 1000, 10]];
  const R = rig();
  const sum = R.player.prepare({ spec: { technique: "drone.canyon-run", duration: 6 }, ctx: { path: line(150) }, capture: { fps: 10 } });
  assert.equal(sum.flight.overspeed, true);
  const reh = await R.player.rehearse({ fps: 10 });
  assert.equal(reh.ok, true);
  assert.deepEqual(reh.validation, sum.validation, "prepare's validation, verbatim");
  const iss = reh.validation.issues.find((i) => i.code === "overspeed");
  assert.ok(iss && iss.minDurationSec > 6, JSON.stringify(reh.validation));
  assert.equal(reh.flight.overspeed, true);
  assert.equal(reh.flight.minDurationSec, sum.flight.minDurationSec);
  assert.equal(reh.flight.preset, "cinema");
  assert.ok(reh.flight.tracking && reh.flight.tracking.frames === reh.frames, JSON.stringify(reh.flight.tracking));
  assert.ok(reh.flight.tracking.maxGapM > 10 && reh.flight.tracking.endGapM > 10, `the craft fell behind: ${JSON.stringify(reh.flight.tracking)}`);
  assert.deepEqual(JSON.parse(JSON.stringify(reh.flight)), reh.flight, "JSON-safe");
  const shot = await R.player.shoot({ fps: 10 });
  assert.equal(shot.ok, true);
  assert.deepEqual(shot.validation, sum.validation);
  assert.equal(shot.flight.overspeed, true);
  assert.ok(shot.flight.tracking.maxGapM > 10);
  // a flyable flight: tracking stays tight; a locked replay flew nothing (tracking null, the check kept)
  const ok = R.player.prepare({ spec: { technique: "drone.canyon-run", duration: sum.flight.minDurationSec }, ctx: { path: line(150) }, capture: { fps: 10 } });
  assert.equal(ok.validation.issues.some((i) => i.code === "overspeed"), false);
  const reh2 = await R.player.rehearse({ fps: 10 });
  assert.equal(reh2.flight.overspeed, false);
  assert.ok(reh2.flight.tracking.maxGapM < 1, `${reh2.flight.tracking.maxGapM}`);
  const locked = await R.player.rehearse({ fps: 10, locked: true });
  assert.equal(locked.flight.tracking, null);
  assert.equal(locked.flight.overspeed, false);
  // classic shots have no flight check
  R.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const cls = await R.player.rehearse({ fps: 10 });
  assert.equal(cls.flight, null);
  assert.equal(cls.validation.ok, true);
});

// ---------------------------------------------------------------------------
// F3 (review round 3, check:r2-subject math-2): moves limited by ACCELERATION. Round 2 checked speed
// only, so `minDurationVerified: true` was false for them — boomerang 5 s was told '≥ 6.5 s' (verified)
// and trailed by 32 m there; boomerang 7–9 s and boom-rise 4 s were not flagged and trailed by 5–31 m.
// prepare now dry-flies the nominal through the flight model (FLIGHT_CHECK: the take's own drone
// stepping at 10 fps, gap tolerance 1 m) and searches the minimum duration by rebuilding and dry-flying
// it, within a fixed work budget. The checker's sweep context (sloped, bumpy ground; subject heading 0.4).
// ---------------------------------------------------------------------------

const SX0 = 30016, SY0 = 32128;
const slopeZ = (x, y) => 50 + 0.12 * (x - SX0) + 0.06 * (y - SY0) + 0.8 * Math.sin(x / 23) * Math.cos(y / 31);
const SLOPE_CTX = Object.freeze({ subject: { pos: [SX0, SY0, slopeZ(SX0, SY0)], height: 1.8, radius: 0.5, heading: 0.4 }, groundZ: slopeZ });
const GAP_TOL = TP.FLIGHT_CHECK.gapToleranceM;

check("F3 acceleration-limited moves within vmax (boomerang 7.5 s, boom-rise 4 s) are flagged by the dry flight; the searched minDurationSec really flies (realised rehearsal)", async () => {
  assert.deepEqual({ ...TP.FLIGHT_CHECK }, { fps: 10, gapToleranceM: 1, maxRebuilds: 6, maxFlownSec: 360 });
  for (const [id, D] of [["drone.boomerang", 7.5], ["drone.boom-rise", 4]]) {
    const R = rig();
    const sum = R.player.prepare({ spec: { technique: id, duration: D }, ctx: SLOPE_CTX, capture: { fps: 30 } });
    const f = sum.flight;
    assert.ok(f.peakSpeed <= 12 * 1.02, `${id}: within vmax (peak ${f.peakSpeed}) — round 2's speed-only check passed it`);
    assert.equal(f.overspeed, true, `${id}: ${JSON.stringify(f)}`);
    assert.equal(f.limitedBy, "acceleration");
    assert.equal(f.amax, 4);
    assert.ok(f.dryFlight && f.dryFlight.fps === 10 && f.dryFlight.maxGapM > 4 && f.dryFlight.peakAccel > 4, JSON.stringify(f.dryFlight));
    assert.equal(f.gapToleranceM, GAP_TOL);
    const iss = sum.validation.issues.find((i) => i.code === "overspeed");
    assert.ok(iss && iss.limitedBy === "acceleration" && iss.maxGapM === f.dryFlight.maxGapM, JSON.stringify(iss));
    assert.match(iss.message, /harder than it can follow \(≤ 4 m\/s²/);
    assert.match(iss.message, /dry-flown, the craft trails the planned path by up to \d+\.\d m/);
    assert.match(iss.message, new RegExp(`use duration ≥ ${f.minDurationSec} s \\(dry-flown within 1 m there\\)`));
    assert.equal(f.minDurationVerified, true);
    assert.equal(f.minDurationCheck, "verified");
    assert.ok(f.minDurationSec > D && f.minDurationSec < 2 * D, `${id}: ${f.minDurationSec}`);
    assert.deepEqual(JSON.parse(JSON.stringify(f)), f, "the flight block is JSON-safe");
    // the prediction is right: the rehearsal at D really trails …
    const reh = await R.player.rehearse({ fps: 30 });
    assert.ok(reh.flight.tracking.maxGapM > 4, `${id} @ ${D} s: realised ${reh.flight.tracking.maxGapM}`);
    near(reh.flight.tracking.maxGapM, f.dryFlight.maxGapM, 0.1 * f.dryFlight.maxGapM, `${id}: the 10 fps dry flight predicts the 30 fps take`);
    // … and at the suggested duration the check passes and the take flies within the tolerance (± the fps difference)
    const ok = R.player.prepare({ spec: { technique: id, duration: f.minDurationSec }, ctx: SLOPE_CTX, capture: { fps: 30 } });
    assert.equal(ok.flight.overspeed, false, JSON.stringify(ok.flight));
    assert.ok(ok.flight.dryFlight.maxGapM <= GAP_TOL);
    assert.equal(ok.validation.issues.some((i) => i.code === "overspeed"), false);
    const reh2 = await R.player.rehearse({ fps: 30 });
    assert.ok(reh2.flight.tracking.maxGapM <= 1.15 * GAP_TOL, `${id} @ ${f.minDurationSec} s: realised ${reh2.flight.tracking.maxGapM}`);
  }
});

check("F3 round 2's false 'verified' is gone: boomerang 5 s (speed-limited) is no longer sent to 6.5 s, where it trails by 30 m, but to a duration it flies", async () => {
  const R = rig();
  const b5 = R.player.prepare({ spec: { technique: "drone.boomerang", duration: 5 }, ctx: SLOPE_CTX, capture: { fps: 30 } });
  assert.equal(b5.flight.limitedBy, "speed");
  assert.equal(b5.flight.minDurationCheck, "verified");
  assert.ok(b5.flight.minDurationSec >= 9, `${b5.flight.minDurationSec} (round 2: 6.5, verified on speed alone)`);
  // the old suggestion is still flagged — by its acceleration now
  const b65 = R.player.prepare({ spec: { technique: "drone.boomerang", duration: 6.5 }, ctx: SLOPE_CTX, capture: { fps: 30 } });
  assert.equal(b65.flight.overspeed, true);
  assert.equal(b65.flight.limitedBy, "acceleration");
  const reh65 = await R.player.rehearse({ fps: 30 });
  assert.ok(reh65.flight.tracking.maxGapM > 20, `realised at 6.5 s: ${reh65.flight.tracking.maxGapM}`);
  // the new one flies
  R.player.prepare({ spec: { technique: "drone.boomerang", duration: b5.flight.minDurationSec }, ctx: SLOPE_CTX, capture: { fps: 30 } });
  const reh = await R.player.rehearse({ fps: 30 });
  assert.ok(reh.flight.overspeed === false && reh.flight.tracking.maxGapM <= 1.15 * GAP_TOL, JSON.stringify(reh.flight.tracking));
});

check("F3 no drone / fpv technique is flagged at its default duration (the dry flight stays within the tolerance); canyon-run on a 320 m valley in 12 s is (speed)", () => {
  const valley = [];
  for (let i = 0; i <= 8; i += 1) {
    const x = SX0 - 160 + i * 40, y = SY0 + 25 * Math.sin(i * 0.9);
    valley.push([x, y, slopeZ(x, y) - 3]);
  }
  const all = [...SHOTS.DRONE_TECHNIQUES, ...SHOTS.FPV_TECHNIQUES];
  assert.ok(all.length >= 25, `${all.length} techniques`);
  for (const def of all) {
    const ctx = def.id === "fpv.fpv-corridor"
      ? { indoor: { route: [[100, 200, 1.6], [120, 200, 1.6], [120, 215, 1.6]], floor: () => 0, ceiling: () => 3.4 }, anchor: [100, 200, 0] }
      : { ...SLOPE_CTX, aspect: 16 / 9, ...((def.needs && def.needs.path) || def.id === "fpv.fpv-run" ? { path: valley } : {}) };
    const R = rig();
    const s = R.player.prepare({ spec: { technique: def.id }, ctx, capture: { fps: 30 } });
    assert.ok(s.flight && s.flight.dryFlight, `${def.id}: dry-flown`);
    if (def.id === "drone.canyon-run") {
      assert.equal(s.flight.limitedBy, "speed");
      assert.equal(s.flight.minDurationCheck, "verified");
      continue;
    }
    assert.equal(s.flight.overspeed, false, `${def.id}: ${JSON.stringify(s.flight)}`);
    assert.ok(s.flight.dryFlight.maxGapM <= GAP_TOL, `${def.id}: dry gap ${s.flight.dryFlight.maxGapM}`);
  }
});

check("F3 the search is bounded (deterministic work, not wall time): a move that slows only as √duration spends the budget → 'unverified' estimate, prepare still returns", () => {
  let builds = 0;
  // 192 m/s at 2 s, slowing only as 1/√duration: every lengthening helps, none enough before the flown-seconds budget is spent
  const sqrtLine = (spec) => {
    builds += 1;
    const D = spec.duration;
    const L = 192 * Math.SQRT2 * Math.sqrt(D);
    return TR.makeTrajectory({ id: "sqrt-line", technique: "drone.fly-by", family: "drone", duration: D, positionAt: (t) => [1000 + (L * t) / D, 1000, 60], orientAt: { h: Math.PI / 2, p: 0, r: 0 } });
  };
  const R = rig({ buildShot: sqrtLine });
  const s = R.player.prepare({ spec: { technique: "drone.fly-by", duration: 2 }, capture: { fps: 30 } });
  const f = s.flight;
  assert.equal(f.overspeed, true);
  assert.equal(f.limitedBy, "speed");
  // 2 s → 32 s (48 m/s) → 128 s (24 m/s) → 256 s would exceed the 360 s dry-flight budget (32 + 128 spent)
  assert.equal(builds, 3, "the prepare build + 2 rebuilds");
  assert.equal(f.minDurationCheck, "unverified");
  assert.equal(f.minDurationVerified, null);
  assert.equal(f.durationHelps, null);
  // (the measured chord speed may round the ×10 ceiling up by one tenth)
  assert.ok(f.minDurationSec >= 256 && f.minDurationSec <= 256.2, `${f.minDurationSec}`);
  const iss = s.validation.issues.find((i) => i.code === "overspeed");
  assert.ok(iss && iss.minDurationVerified === null && new RegExp(`use duration ≥ ${f.minDurationSec} s \\(an estimate: not dry-flown within the check's budget\\)`).test(iss.message), iss && iss.message);
  // the same shot from a trajectory (no spec to rebuild) keeps the estimate, unverified
  const t = R.player.prepare({ trajectory: sqrtLine({ duration: 2 }), capture: { fps: 30 } });
  assert.equal(t.flight.minDurationCheck, "unverified");
  assert.ok(t.flight.minDurationSec >= 32 && t.flight.minDurationSec <= 32.1, `${t.flight.minDurationSec}`);
});

// ---------------------------------------------------------------------------
// E1 the pre-roll AdminEnvirons wait (review contracts-5 / seams-3 / gate-1)
// ---------------------------------------------------------------------------

/**
 * loop.js in miniature on a fake wall clock: the REAL environ_override.js state machine and the REAL retail
 * light clock (retail_light_tick.js), ticked per frame the way loop.js does — tickDistanceFogColor: sync +
 * the 0.8 s fog tick (skipped under the "Disable distance fog" option, `fogOff`); tickTerrainSunDir: sync +
 * the light tick whenever the light clock is due — behind the window seams the take player reads
 * (`__environOverrideState` = loop.js's stats accessor, `__setTerrainLightScale` = invalidate the light tick,
 * `__terrainLightState`). The injected setTimeout runs the wall clock (and its frames) forward for the
 * wait's polls (≤ environSettlePollMs); longer timers (realtime watchdog / final grab) go to the real one.
 */
function environLoop(o = {}) {
  let ms = 0;
  let nextFrame = 0;
  let frames = 0;
  let relights = 0;
  let epoch = null;
  const frameMs = o.frameMs ?? 33;
  const env = ENVO.createEnvironOverride({ now: () => ms / 1000, fogTickSec: o.fogTickSec });
  const light = LT.createRetailLightTick({ now: () => ms / 1000 });
  const win = {
    __environFogOverride: null,
    __environOverrideState: () => env.stats(),
    __terrainLightState: () => ({ scale: 0.55 }),
    __setTerrainLightScale: (v) => {
      relights += 1;
      light.invalidate();
      return v;
    },
  };
  const frame = () => {
    frames += 1;
    if (o.onFrame) o.onFrame(ms);
    if (!o.fogOff) {
      env.sync(win.__environFogOverride);
      env.fogTick();
    }
    const e = light.sync(frames);
    if (e !== epoch) {
      epoch = e;
      env.sync(win.__environFogOverride);
      env.lightTick(0x64808080, 0.5);
    }
  };
  const advance = (dt) => {
    const end = ms + dt;
    while (nextFrame <= end) {
      ms = nextFrame;
      frame();
      nextFrame += frameMs;
    }
    ms = end;
  };
  const POLL = TP.TAKE_DEFAULTS.environSettlePollMs;
  return {
    env,
    win,
    advance,
    now: () => ms,
    get relights() {
      return relights;
    },
    setTimeout(fn, delay) {
      if (!(delay <= POLL)) return { real: setTimeout(fn, delay) };
      advance(delay);
      Promise.resolve().then(fn);
      return { real: null };
    },
    clearTimeout(h) {
      if (h && h.real) clearTimeout(h.real);
    },
  };
}

/** rig() wired to an environLoop (its window, timers and clock). */
function envRig(L, o = {}) {
  return rig({ ...o, window: L.win, setTimeout: L.setTimeout.bind(L), clearTimeout: L.clearTimeout.bind(L), now: L.now });
}

check("E1 a changed look.fog: shoot and rehearse wait on the live loop until the REAL roll-in + ambient settle (reported); the same fog never waits again", async () => {
  const L = environLoop();
  let atFirstStep = null;
  const R = envRig(L, { onStep: (n) => (n === 1 ? (atFirstStep = L.env.stats()) : null) });
  // The REAL look controller writes the override (a fresh object: a change).
  const look = LK.createLook({ window: L.win });
  assert.equal(look.apply({ fog: "white" }).applied.fog.changed, true);
  L.advance(500); // prepare takes a moment: the roll-in has started, nowhere near done
  assert.ok(L.env.stats().transition < 0.1);
  R.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const rep = await R.player.shoot({ fps: 10 });
  assert.equal(rep.frames, 10);
  const e = rep.environ;
  assert.equal(e.checked, true);
  assert.equal(e.settled, true, JSON.stringify(e));
  assert.equal(e.timedOut, false);
  assert.equal(e.stalled, false);
  // 25 steps of +0.04: fog ticks every 0.8 s, plus a step on each 15 s light tick → ~18-21 s of wall time.
  assert.ok(e.waitedMs >= 15000 && e.waitedMs <= TP.TAKE_DEFAULTS.environSettleMaxMs, `waited ${e.waitedMs} ms for a ~20 s roll-in`);
  assert.equal(e.relit, true, "one forced light tick latched the ambient at the full override");
  assert.equal(L.relights, 1);
  assert.equal(e.state.name, "WhiteFog");
  assert.ok(e.state.transition >= 1 && e.state.fogT >= 1 && e.state.lightT >= 1, JSON.stringify(e.state));
  assert.ok(atFirstStep && atFirstStep.transition >= 1 && atFirstStep.fogT >= 1 && atFirstStep.lightT >= 1,
    `the first rendered (pre-roll) frame already has the full fog and ambient: ${JSON.stringify(atFirstStep)}`);
  assert.equal(R.clockLog.begins.length, 1, "the film clock began only after the wait");
  assert.doesNotThrow(() => JSON.stringify(rep.environ));
  // The CLI prepares again after a rehearsal; the same fog keeps its object → no wait, no relight.
  const again = look.apply({ fog: "white" });
  assert.equal(again.applied.fog.changed, false);
  R.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const rep2 = await R.player.shoot({ fps: 10 });
  assert.equal(rep2.environ.settled, true);
  assert.equal(rep2.environ.waitedMs, 0);
  assert.equal(rep2.environ.polls, 1);
  assert.equal(rep2.environ.relit, false);
  assert.equal(L.relights, 1);
  assert.equal(rep2.realisedChecksum, rep.realisedChecksum, "the wait never touches the stepped path");
  // A rehearsal waits too (a changed fog: red).
  look.apply({ fog: "red" });
  const reh = await R.player.rehearse({ fps: 10 });
  assert.equal(reh.environ.settled, true);
  assert.ok(reh.environ.waitedMs >= 15000 && reh.environ.waitedMs <= TP.TAKE_DEFAULTS.environSettleMaxMs, `rehearse waited ${reh.environ.waitedMs}`);
  assert.equal(reh.environ.state.name, "RedFog");
  // A dry rehearsal (render:false) renders nothing, so it never waits.
  look.apply({ fog: "green" });
  const dry = await R.player.rehearse({ fps: 10, render: false });
  assert.equal(dry.environ.checked, false);
  assert.equal(dry.environ.reason, "not rendered");
  // Clearing the fog: nothing rolls in; the override ambient still latched is re-lit away before recording.
  look.apply({ fog: "none" });
  const rep3 = await R.player.shoot({ fps: 10 });
  assert.equal(rep3.environ.settled, true);
  assert.equal(rep3.environ.state.active, false);
  assert.equal(rep3.environ.state.lightT, 0);
  assert.ok(rep3.environ.waitedMs < 1000, `a clear settles in a frame or two (${rep3.environ.waitedMs} ms)`);
});

check("E1 realtime takes wait too, before the first animation frame of the pre-roll", async () => {
  const L = environLoop();
  const queue = [];
  const raf = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  const R = envRig(L, { raf });
  LK.createLook({ window: L.win }).apply({ fog: "blue" });
  R.player.prepare({ trajectory: northDolly(1), capture: { fps: 10, mode: "realtime" } });
  let atFirstFrame = null;
  const p = R.player.shoot({ fps: 10 });
  await tick();
  let ts = 5000;
  for (let n = 0; queue.length && n < 200; n += 1) {
    if (atFirstFrame === null) atFirstFrame = L.env.stats();
    const cb = queue.shift();
    ts += 100;
    cb(ts);
    R.hooks.postRender();
    await tick();
  }
  const rep = await p;
  assert.equal(rep.mode, "realtime");
  assert.equal(rep.frames, 10);
  assert.equal(rep.environ.settled, true, JSON.stringify(rep.environ));
  assert.ok(rep.environ.waitedMs >= 15000, `${rep.environ.waitedMs}`);
  assert.ok(atFirstFrame && atFirstFrame.fogT >= 1 && atFirstFrame.lightT >= 1, JSON.stringify(atFirstFrame));
});

check("E1 a server fog arriving mid-wait (right after the forced light tick) is followed: its own roll-in and its own light tick, never the old ambient", async () => {
  let L = null;
  let injectIn = null;
  L = environLoop({
    fogTickSec: 0.3, // a quick roll-in (~7 s) so both fit inside the bound
    onFrame: () => {
      if (injectIn === null && L && L.relights === 1) injectIn = 1; // this frame's light tick latches WhiteFog at 1
      else if (injectIn === 1) {
        injectIn = 0;
        L.win.__environFogOverride = ENVO.environFogFor(1); // the server's RedFog, one frame later
      }
    },
  });
  const R = envRig(L);
  LK.createLook({ window: L.win }).apply({ fog: "white" });
  R.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const rep = await R.player.shoot({ fps: 10 });
  assert.equal(injectIn, 0, "the RedFog arrived mid-wait");
  assert.equal(rep.environ.settled, true, JSON.stringify(rep.environ));
  assert.equal(rep.environ.state.name, "RedFog");
  assert.ok(rep.environ.state.transition >= 1 && rep.environ.state.fogT >= 1 && rep.environ.state.lightT >= 1);
  assert.equal(L.relights, 2, "the new message got its own forced light tick");
  const amb = L.env.ambient(0x64808080, 0.5);
  assert.equal(amb && amb.argb, (0x64000000 | ENVO.ENVIRON_FOG[1].ambRgb) >>> 0, "the latched ambient is RedFog's, not the stale WhiteFog one");
  assert.ok(rep.environ.waitedMs < TP.TAKE_DEFAULTS.environSettleMaxMs);
});

check("E1 the wait is bounded and reported: 30 s cap, a stalled override (fog option off), no accessor, abort()", async () => {
  // A roll-in slower than the bound (fog tick 2 s → ~50 s): recorded anyway at exactly the 30 s cap.
  const S = environLoop({ fogTickSec: 2 });
  const Rs = envRig(S);
  S.win.__environFogOverride = ENVO.environFogFor(3);
  Rs.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const slow = await Rs.player.shoot({ fps: 10 });
  assert.equal(slow.frames, 10, "the take still records");
  assert.equal(slow.environ.settled, false);
  assert.equal(slow.environ.timedOut, true);
  assert.equal(slow.environ.waitedMs, TP.TAKE_DEFAULTS.environSettleMaxMs);
  assert.ok(slow.environ.state.transition < 1);
  // "Disable distance fog": the fog half never ticks (only the 15 s light tick moves it) → stops at the stall bound.
  const F = environLoop({ fogOff: true });
  const Rf = envRig(F);
  F.win.__environFogOverride = ENVO.environFogFor(1);
  Rf.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const off = await Rf.player.shoot({ fps: 10 });
  assert.equal(off.frames, 10);
  assert.equal(off.environ.settled, false);
  assert.equal(off.environ.stalled, true);
  assert.ok(off.environ.waitedMs >= TP.TAKE_DEFAULTS.environSettleStallMs && off.environ.waitedMs < TP.TAKE_DEFAULTS.environSettleMaxMs, `${off.environ.waitedMs}`);
  // No accessor (an older page / the other rigs): checked:false, no wait.
  const N = rig();
  N.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const none = await N.player.shoot({ fps: 10 });
  assert.equal(none.environ.checked, false);
  assert.equal(none.environ.reason, "no window.__environOverrideState");
  assert.equal(none.environ.waitedMs, 0);
  // abort() during the wait stops it (and the take) at once.
  let Ra = null;
  const A = environLoop({ onFrame: (ms) => (ms >= 3000 && Ra ? Ra.player.abort() : null) });
  Ra = envRig(A);
  A.win.__environFogOverride = ENVO.environFogFor(4);
  Ra.player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
  const ab = await Ra.player.shoot({ fps: 10 });
  assert.equal(ab.environ.aborted, true);
  assert.equal(ab.environ.settled, false);
  assert.ok(ab.environ.waitedMs >= 3000 && ab.environ.waitedMs < 4000, `${ab.environ.waitedMs}`);
  assert.equal(ab.aborted, true);
  assert.equal(ab.frames, 0);
  assert.equal(Ra.player.running, false);
});

// ---------------------------------------------------------------------------

check("T2 a POINT subject's own body (holtburg.02: a 1.2 m subject on a Life Stone) is never faded: the stone and a fadeable statue whose footprints hold the subject's axis go to the sensors as subjectBodyIds and the report; a neighbouring NPC, a tree off the axis and procedural scenery do not; a wide point (a town square) has no body", async () => {
  const LS = 0x7a9b4005;
  const NPC = 0x7a9b4010;
  const STATUE = "placement:00000000:object:7";
  const TREE = "placement:00000000:object:8";
  const ents = [
    { guid: LS, pos: [100, 130, 0], radius: 1.6, height: 3.6, isLocal: false },
    { guid: NPC, pos: [103, 132, 0], radius: 0.48, height: 1.8, isLocal: false },
    { guid: 0x50000001, pos: [100, 130, 0], radius: 0.48, height: 1.8, isLocal: true },
  ];
  const rows = [
    { source: "object", kind: "prop", pos: [100.4, 130, 0], radius: 1, height: 2, lbKey: 0, index: 7 },
    { source: "object", kind: "tree", pos: [110, 130, 0], radius: 2.5, height: 8, lbKey: 0, index: 8 },
    { source: "scenery", kind: "rock", pos: [100, 130, 0], radius: 1.5, height: 1.5, lbKey: 0, index: 2 },
    { source: "object", kind: "building", pos: [100, 130, 0], radius: 9, height: 7, lbKey: 0, index: 9 },
  ];
  const fadeLookups = [];
  const wq = {
    groundZ: () => 0,
    entitiesNear: () => ents.map((e) => ({ ...e })),
    staticsNearCached: () => rows.map((r) => ({ ...r })),
    staticFadeTargets: (key) => (fadeLookups.push(key), null),
  };
  const shotOn = async (subject) => {
    const hidden = [];
    const bodies = [];
    const R = rig({ setpoint: { fadeIds: [LS, NPC, STATUE, TREE] }, onSense: (_p, ctx) => bodies.push(ctx.subjectBodyIds) });
    R.live.entityManager = { _filmHiddenGuids: new Set(), setFilmHidden(g, on) { hidden.push([g, on]); return true; } };
    const player = playerOn(R, { worldQuery: wq });
    const tr = TR.makeTrajectory({ id: "stone", technique: "classic.low-angle", family: "classic", duration: 1, positionAt: (t) => [100, 124 + t, 1], orientAt: { h: 0, p: 0.3, r: 0 }, subject });
    player.prepare({ trajectory: tr, capture: { fps: 10 } });
    const rep = await player.shoot({ fps: 10 });
    return { rep, hidden, bodies };
  };
  fadeLookups.length = 0;
  const a = await shotOn({ pos: [100, 130, 0], radius: 1.2, height: 3.2 });
  assert.deepEqual(a.rep.subjectBody, [LS, STATUE], "the stone and the statue on the axis; not the NPC, the dolly, the off-axis tree, scenery or a building");
  assert.ok(a.bodies.length > 0 && a.bodies.every((b) => Array.isArray(b) && b.length === 2 && b[0] === LS && b[1] === STATUE), "every sense() call names the body");
  assert.deepEqual(a.hidden, [[NPC, true], [NPC, false]], "only the NPC is faded (and restored); the Life Stone never");
  assert.equal(a.rep.faded.entities, 1);
  assert.ok(!fadeLookups.includes(STATUE) && fadeLookups.includes(TREE), "the statue is never looked up for a fade; the tree is");
  // A town square (radius 30) is a place, not an object: no body, so the stone at its centre fades like anything else.
  const b = await shotOn({ pos: [100, 130, 0], radius: 30, height: 12 });
  assert.deepEqual(b.rep.subjectBody, []);
  assert.deepEqual(b.hidden.filter(([, on]) => on).map(([g]) => g).sort(), [LS, NPC].sort());
});

// ---------------------------------------------------------------------------
// T4 Egg Orchard FPV run (DESIGN §3): lock windows, the creature fade guard, pilot.fade 'never'
// ---------------------------------------------------------------------------

/** northDolly with lock windows (trajectory meta). */
function lockedDolly(D, windows) {
  return TR.makeTrajectory({ id: "north-lock", technique: "classic.dolly-in", family: "classic", duration: D, positionAt: (t) => [100, 100 + 5 * t, 10], orientAt: { h: 0, p: 0, r: 0 }, meta: windows === undefined ? undefined : { lockWindows: windows } });
}

check("T4 lockWindows: inside a window speedScale is pinned to 1 and the pilot residual is held then eased to 0 over 0.4 s; after it the residual and speed blend back over 0.4 s (stepped)", async () => {
  const R = rig({ speed: 0.5, setpoint: { lateral: 0.8, vertical: 0.4 } });
  const fps = 10;
  const sum = R.player.prepare({ trajectory: lockedDolly(2.5, [[0.5, 1.2]]), capture: { fps } });
  assert.equal(sum.lockWindows, 1);
  const rep = await R.player.shoot({ fps, includeTable: true });
  const rows = rep.realisedTable.rows;
  const n = rep.frames;
  const at = (k) => ({ x: rows[k * TR.TABLE_STRIDE + 1], p: (rows[k * TR.TABLE_STRIDE + 2] - 100) / 5, z: rows[k * TR.TABLE_STRIDE + 3] });
  let inside = 0;
  for (let k = 0; k + 1 < n; k += 1) {
    const a = at(k), b = at(k + 1);
    const dp = b.p - a.p;
    if (a.p >= 0.5 - 1e-9 && a.p <= 1.2 + 1e-9 && b.p < 2.5 - 1e-9) {
      near(dp, 0.1, 1e-9, `frame ${k} inside the window: progress at speed 1`);
      inside += 1;
    } else if (a.p < 0.5 - 1e-9) near(dp, 0.05, 1e-9, `frame ${k} before the window: the pilot's 0.5`);
    else if (a.p > 1.2 + 0.4 + 1e-9 && b.p < 2.5 - 1e-9) near(dp, 0.05, 1e-9, `frame ${k} after the blend: the pilot's 0.5 again`);
    else if (b.p < 2.5 - 1e-9) assert.ok(dp > 0.05 - 1e-9 && dp < 0.1 + 1e-9, `frame ${k} blending back (${dp})`);
    assert.ok(Math.abs(b.x - a.x) <= 0.35 && Math.abs(b.z - a.z) <= 0.2, `frame ${k}: no residual jump (${b.x - a.x}, ${b.z - a.z})`);
  }
  assert.ok(inside >= 6, `${inside} frames flown inside the window`);
  for (let k = 0; k < n; k += 1) {
    const f = at(k);
    if (f.p < 0.5 - 1e-9) {
      near(f.x, 100.8, 1e-9, `frame ${k}: the pilot's lateral before the window`);
      near(f.z, 10.4, 1e-9);
    } else if (f.p >= 0.9 + 1e-9 && f.p <= 1.2 + 1e-9) {
      near(f.x, 100, 1e-9, `frame ${k}: eased to the planned line 0.4 s into the window`);
      near(f.z, 10, 1e-9);
    } else if (f.p >= 1.6 + 1e-9) {
      near(f.x, 100.8, 1e-9, `frame ${k}: the pilot's residual again after the blend`);
    }
  }
  const mid = Array.from({ length: n }, (_, k) => at(k)).find((f) => f.p > 0.6 && f.p < 0.85);
  assert.ok(mid && mid.x > 100.05 && mid.x < 100.8 - 0.05, `held, then easing (${mid && mid.x})`);
  assert.deepEqual(rep.lockWindows.windows, [[0.5, 1.2]]);
  assert.equal(rep.lockWindows.entries, 1);
  assert.equal(rep.lockWindows.lockedFrames, inside, "every frame at p ∈ [0.5, 1.2] is locked");
});

check("T4 lockWindows in realtime takes: progress inside a window runs at speed 1 whatever the pilot asks; merged / clamped windows; none = byte-identical", async () => {
  assert.deepEqual(TP.lockWindowsOf(lockedDolly(3, [[1, 2], [0.2, 0.4], [1.8, 2.5], { t0: -1, t1: 0.1 }, [NaN, 1], [2.9, 9]]), 3), [[0, 0.1], [0.2, 0.4], [1, 2.5], [2.9, 3]]);
  assert.deepEqual(TP.lockWindowsOf(lockedDolly(3, []), 3), []);
  assert.deepEqual(TP.lockWindowsOf(lockedDolly(3), 3), []);
  const queue = [];
  const raf = (cb) => {
    queue.push(cb);
    return queue.length;
  };
  const R = rig({ raf, speed: 0.5 });
  R.pilot.tick = (sf, ctx, now) => ({ setpoint: { ...TP.NEUTRAL_SETPOINT, speedScale: 0.5 }, telemetry: { source: "code", consulted: true, newDecision: false, t: now } });
  R.player.prepare({ trajectory: lockedDolly(2, [[0.5, 1.5]]), capture: { fps: 10, mode: "realtime" } });
  const pr = R.player.shoot({ fps: 10, includeTable: true });
  await tick();
  let ts = 5000;
  for (let i = 0; queue.length && i < 400; i += 1) {
    const cb = queue.shift();
    ts += 50; // 20 Hz display
    cb(ts);
    R.hooks.postRender();
    await tick();
  }
  const rep = await pr;
  const rows = rep.realisedTable.rows;
  const ps = [];
  for (let k = 0; k < rep.frames; k += 1) ps.push((rows[k * TR.TABLE_STRIDE + 2] - 100) / 5);
  let checked = 0;
  for (let k = 0; k + 1 < ps.length; k += 1) {
    if (ps[k] >= 0.55 && ps[k + 1] <= 1.45) {
      near(ps[k + 1] - ps[k], 0.1, 1e-6, `grid ${k}: speed 1 inside the window`);
      checked += 1;
    } else if (ps[k + 1] < 0.45) near(ps[k + 1] - ps[k], 0.05, 1e-6, `grid ${k}: speed 0.5 before it`);
  }
  assert.ok(checked >= 5, `${checked} grid steps inside the window`);
  assert.ok(rep.lockWindows.lockedFrames > 0);
  // No windows: the run is exactly the one without lock code (same realised checksum).
  const shootOf = async (traj) => {
    const Q = rig({ speed: 0.7, setpoint: { lateral: 0.5 } });
    Q.player.prepare({ trajectory: traj, capture: { fps: 10 } });
    return Q.player.shoot({ fps: 10 });
  };
  const a = await shootOf(northDolly(1.5));
  const b = await shootOf(lockedDolly(1.5, []));
  assert.equal(a.realisedChecksum, b.realisedChecksum);
  assert.equal("lockWindows" in a, false);
  assert.equal("lockWindows" in b, false);
});

check("T4 fade() never hides a creature, an NPC or a player (world-query kind / player-tier guid): refused, reported, the frame reroutes; other entities still fade", async () => {
  const CRE = 0x80000a01, NPC = 0x80000a02, PLAYER = 0x50000a03, ITEM = 0x80000a04;
  const kinds = new Map([[CRE, "creature"], [NPC, "npc"], [ITEM, "item"]]);
  const looked = [];
  const wq = {
    groundZ: () => 0,
    subject(g) {
      looked.push(g);
      return kinds.has(g) ? { guid: g, kind: kinds.get(g), pos: [0, 0, 0], radius: 1, height: 2 } : null;
    },
  };
  const take = async (ids) => {
    const hidden = [];
    const R = rig({ setpoint: { fadeIds: ids } });
    R.live.entityManager = { _filmHiddenGuids: new Set(), setFilmHidden(g, on) { hidden.push([g, on]); return true; } };
    const player = playerOn(R, { worldQuery: wq });
    player.prepare({ trajectory: northDolly(1), capture: { fps: 10 } });
    const rep = await player.shoot({ fps: 10, includeTable: true });
    return { rep, hidden };
  };
  looked.length = 0;
  const a = await take([CRE, NPC, PLAYER, ITEM]);
  assert.deepEqual(a.hidden, [[ITEM, true], [ITEM, false]], "only the item is hidden (and restored)");
  assert.equal(a.rep.faded.entities, 1);
  assert.equal(a.rep.faded.refused, 3);
  assert.deepEqual(a.rep.faded.refusedGuids, ["0x80000a01", "0x80000a02", "0x50000a03"]);
  assert.equal(a.rep.faded.fallbackFrames, 0, "the item fade still handled every frame");
  assert.ok(!looked.includes(PLAYER), "a player-tier guid needs no lookup");
  assert.equal(looked.filter((g) => g === CRE).length, 1, "a known kind is looked up once per take");
  // Only creatures named: nothing is hidden, every frame takes the reroute fallback (never a no-op).
  const b = await take([CRE]);
  assert.deepEqual(b.hidden, []);
  assert.equal(b.rep.faded.fallbackFrames, b.rep.frames);
  const rows = b.rep.realisedTable.rows;
  assert.ok(Math.abs(rows[(b.rep.frames - 1) * TR.TABLE_STRIDE + 1] - 100) > 0.5, "the reroute bias moved the camera off the line");
  // Without a world query kind (unknown guid) the old behaviour stands: it fades.
  const c = await take([0x80000a77]);
  assert.deepEqual(c.hidden, [[0x80000a77, true], [0x80000a77, false]]);
  assert.equal("refused" in c.rep.faded, false, "nothing refused: the report block is unchanged");
});

check("T4 pilot.fade 'never' (real code pilot): a soft occluder's 'fade' answer hides nothing and reroutes; 'auto' still fades; stats / report say which", async () => {
  const OCC = 0x80000b01;
  const subjectDolly = () => TR.makeTrajectory({ id: "subj", technique: "classic.dolly-in", family: "classic", duration: 1, positionAt: (t) => [100, 100 + 5 * t, 2], orientAt: { h: 0, p: 0, r: 0 }, subject: { pos: [100, 130, 0], radius: 0.5, height: 1.8 } });
  const run = async (fadePolicy) => {
    const hidden = [];
    const R = rig();
    R.live.entityManager = { _filmHiddenGuids: new Set(), setFilmHidden(g, on) { hidden.push([g, on]); return true; } };
    const sensors = {
      sense(pose) {
        const f = emptySensorFrame(pose);
        f.subject = { visibleFrac: 0, unseenSec: 3, ndc: [0, 0], sizeRatio: 1, occluderKind: "tree", occluderIds: [OCC] };
        return f;
      },
      reset() {},
    };
    const pilots = [];
    const player = TP.createTakePlayer({
      cameraOwner: R.cam, clock: R.clock, sensors, safety: R.safety, liveScene3d: R.live, window: {},
      recorder: (ro) => REC.createRecorder({ canvas: fakeCanvas(), ...ro, VideoEncoder: R.E, VideoFrame: R.F }),
      pilot: (cfg) => {
        const p = createPilot({ mode: "code", fade: cfg.fade });
        pilots.push(p);
        return p;
      },
    });
    player.prepare({ trajectory: subjectDolly(), capture: { fps: 10 }, pilot: { mode: "code", ...(fadePolicy ? { fade: fadePolicy } : {}) } });
    const rep = await player.shoot({ fps: 10, includeTable: true });
    return { rep, hidden, pilot: pilots[0] };
  };
  const auto = await run(undefined);
  assert.deepEqual(auto.hidden, [[OCC, true], [OCC, false]], "auto: the tree is faded and restored");
  assert.equal(auto.rep.pilot.fade, "auto");
  const never = await run("never");
  assert.deepEqual(never.hidden, [], "never: nothing is hidden");
  assert.equal(never.rep.pilot.fade, "never");
  assert.equal(never.pilot.stats().fade, "never");
  assert.equal(never.pilot.mapper.config.limits.maxFadeIds, 0);
  assert.ok(never.pilot.mapper.stats().fadeFallbacks > 0, "the fade answer became a reroute");
  const rows = never.rep.realisedTable.rows;
  assert.ok(Math.abs(rows[(never.rep.frames - 1) * TR.TABLE_STRIDE + 1] - 100) > 0.3, "rerouted off the line");
});

for (const run of pending) await run();
console.log(`film_runtime_capture: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
