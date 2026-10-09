// scene3d/shard_fetch_worker.js — Workstream B (`?shardFetchWorker`, 2026-10-09):
// shard bodies fetched, read and sha256-verified OFF the main thread.
//
// WHY: the main wasm instance fetched every DAT record with `fetch()` +
// `arrayBuffer()` on the main thread — two main-thread turns per record. During
// a cold academy load the main thread is 90-97 % busy, so on the 1070 (final
// build, fin2A1/fin2A2) a body the network had finished waited p50 0.09-0.32 s /
// p90 0.35-0.56 s before wasm saw it, longer than the network itself took
// (p50 0.19-0.24 s), and a walk round closes only when its slowest body lands.
//
// WHAT: the page (scene3d/shard_fetch_client.js) posts one
//   {type:'batch', reqs:[{id, url, prio:'low'|'high'|'auto', sha:<32 hex>|null}]}
// per microtask of shard requests. Each request is fetched at once (the wasm
// side still holds its fetch permits, so no cap here) with its priority hint:
// `priority:'low'` for the normal lane, `priority:'high'` for the urgent lane
// (`?shardFetchHigh`, default on, decided page-side: a dedicated worker's
// default fetch priority is not guaranteed to be the document's High, so the
// player-blocking lane says so explicitly), nothing for 'auto' (the urgent lane
// with `?shardFetchHigh=off`), the body is read, and when `sha` is given it is hashed
// (crypto.subtle in a secure context, else the pure-JS sha256 below — the raw
// tailnet origin is NOT a secure context) and compared with the catalog's
// truncated hash. Results go back as
//   {type:'results', to:<worker timeOrigin>, lag:{…}, res:[{id, ok, buf,
//    verified, mismatch, status, statusText, msg, tResp, tNetEnd, tReady}]}
// with every body buffer TRANSFERRED, flushed at 64 entries, 4 MB, or 8 ms
// after the first unflushed entry, whichever comes first.
//
// DIAG (2026-10-09 follow-up): on the 1070 academy walk the worker's own
// `tNetEnd` (body in hand) trailed the network's responseEnd (the worker's
// resource timing) by p90 0.18-0.25 s, in clumps — the dominant part of the
// network-end → wasm gap, invisible in `deliverMs` (which starts at
// `tNetEnd`). `tResp` (the fetch() promise resolved: headers in hand) and the
// event-loop LAG probe (a 10 ms timer re-armed while requests are in flight;
// `lag` = {probes, max, over16, over50, over100} ms of lateness, also on every
// results message) tell a blocked worker thread (lag) from a late delivery by
// the browser (no lag, late tResp).
//
// HASH SLICING (`?shardHashSlice`, default ON, 2026-10-09 follow-up): on the
// 1070 (run r5lag, final build) this worker's event loop was blocked up to
// 604 ms (lag over100: 11, over50: 22) during an academy spawn while the main
// thread hashed nothing: on the raw tailnet origin (http, not a secure
// context) the 'js' engine hashed every body in ONE synchronous pass,
// multi-MB HD texture records included (4.1 MB at ~42 MB/s ≈ 100 ms), so small
// urgent interior records, body reads, the flush timer and the lag probe
// queued behind them. ON (the 'js' engine only; 'subtle' is unchanged): a body
// of at most HASH_SLICE_BYTES (64 KB) is hashed synchronously as before; a
// larger one is hashed incrementally (sha256Init / sha256Update / sha256Final,
// the very same round code as `sha256Hex`) one 64 KB slice per event-loop turn,
// the turns given back through a MessageChannel post (no setTimeout(0) clamp).
// One slice per turn across ALL queued bodies: an urgent (non-'low') body's
// slices go first, then the body with the fewest bytes left, so an urgent
// request waits behind at most the one slice already running. The page reads
// the flag and forwards it as `hashSlice` on each batch message (the worker
// also reads its own script URL at boot: no query there today → on);
// `off|0|false|no` = today's one-shot hash. Stats: hashSlice, slicedBodies,
// slices, maxSliceMs (also carried as `hash` on every results message).
//
// A sha MISMATCH is not an error here: the body goes back `verified:false,
// mismatch:true` and the wasm Step E re-hashes it on the main thread exactly as
// before this worker existed (so the failed-key message and `__hbVerifyShards`
// semantics are unchanged). HTTP errors carry `status`; network/body errors
// carry `status:0` + `msg`.
//
// NO imports, NO wasm: nothing here can go stale with a wasm rebuild (no stamp
// site), and the bundled shell's worker guard (scripts/build-shell.mjs) wants
// worker graphs free of non-pkg externals. `createShardFetchHandler` is exported
// so tests drive the exact handler with an injected fetch / clock / timers.

export const FLUSH_MAX_ENTRIES = 64;
export const FLUSH_MAX_BYTES = 4 * 1024 * 1024;
export const FLUSH_DELAY_MS = 8;
export const HEARTBEAT_MS = 2000;
export const LAG_PROBE_MS = 10;
/** `?shardHashSlice`: bodies above this are hashed one slice of this size per
 *  event-loop turn ('js' engine only); at or below it, in one pass as before. */
export const HASH_SLICE_BYTES = 64 * 1024;

/**
 * `?shardHashSlice` — default ON; `off` / `0` / `false` / `no` restore the
 * one-shot hash. Not memoised. The page (shard_fetch_client.js) reads its own
 * query and forwards the result as `hashSlice` on each batch message, which
 * wins; the worker bootstrap applies this reader to the worker's script URL.
 */
export function shardHashSliceEnabled(search) {
  try {
    const v = new URLSearchParams(search || "").get("shardHashSlice");
    if (v == null) return true;
    const t = String(v).trim().toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

// ---------------------------------------------------------------------------
// pure-JS sha256 (FIPS 180-4) — the non-secure-context engine. `sha256Hex` is
// a copy of scene3d/pack_fetch_controller.js `sha256Hex` (kept import-free on
// purpose; tests/shard_fetch_worker.test.mjs pins the two against each other
// and against known vectors) with its block loop factored out into
// `sha256Blocks`, so the incremental sha256Init / sha256Update / sha256Final
// (`?shardHashSlice`) run the very same round code.
// ---------------------------------------------------------------------------
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];
const SHA256_IV = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];

function wordsHex(H) {
  let out = "";
  for (const v of H) out += (v >>> 0).toString(16).padStart(8, "0");
  return out;
}

export function sha256Hex(bytes) {
  const H = SHA256_IV.slice();
  const len = bytes.length;
  const bitLenHi = Math.floor(len / 0x20000000);
  const bitLenLo = (len << 3) >>> 0;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLenHi);
  dv.setUint32(padded.length - 4, bitLenLo);
  sha256Blocks(H, new Int32Array(64), dv, 0, padded.length);
  return wordsHex(H);
}

/** The FIPS 180-4 compression function over the 64-byte blocks at byte
 *  offsets [start, end) of `dv` (end - start a multiple of 64), into the eight
 *  state words `H`; `w` is the 64-word message-schedule scratch. */
function sha256Blocks(H, w, dv, start, end) {
  const K = SHA256_K;
  for (let off = start; off < end; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const a = w[i - 15];
      const b = w[i - 2];
      const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
      const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
    }
    let [a, b, c, d, e, f, g, h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const t1 = (h + S1 + ch + K[i] + w[i]) | 0;
      const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
}

/** Incremental SHA-256: a fresh state (feed it with sha256Update, read it
 *  once with sha256Final). */
export function sha256Init() {
  return { H: SHA256_IV.slice(), w: new Int32Array(64), tail: new Uint8Array(64), tailLen: 0, len: 0 };
}

/** Feed `bytes[start, end)` (a Uint8Array; the whole array by default). Whole
 *  64-byte blocks go straight through `sha256Blocks` from the caller's buffer;
 *  a partial block waits in `st.tail`. Returns `st`. */
export function sha256Update(st, bytes, start = 0, end = bytes.length) {
  let p = start;
  st.len += end - p;
  if (st.tailLen > 0) {
    const take = Math.min(64 - st.tailLen, end - p);
    st.tail.set(bytes.subarray(p, p + take), st.tailLen);
    st.tailLen += take;
    p += take;
    if (st.tailLen < 64) return st;
    sha256Blocks(st.H, st.w, new DataView(st.tail.buffer), 0, 64);
    st.tailLen = 0;
  }
  const whole = end - p - ((end - p) % 64);
  if (whole > 0) {
    sha256Blocks(st.H, st.w, new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), p, p + whole);
    p += whole;
  }
  if (p < end) {
    st.tail.set(bytes.subarray(p, end), 0);
    st.tailLen = end - p;
  }
  return st;
}

/** Pad (0x80, zeros, the 64-bit big-endian bit length — as `sha256Hex`) and
 *  return the 64-hex-char digest. The state is spent afterwards. */
export function sha256Final(st) {
  const len = st.len;
  const pad = new Uint8Array(st.tailLen + 9 <= 64 ? 64 : 128);
  pad.set(st.tail.subarray(0, st.tailLen));
  pad[st.tailLen] = 0x80;
  const dv = new DataView(pad.buffer);
  dv.setUint32(pad.length - 8, Math.floor(len / 0x20000000));
  dv.setUint32(pad.length - 4, (len << 3) >>> 0);
  sha256Blocks(st.H, st.w, dv, 0, pad.length);
  st.tailLen = 0;
  return wordsHex(st.H);
}

/**
 * One event-loop turn between hash slices: a MessageChannel post (each
 * message is its own task; no timer clamp — nested setTimeout(0) is clamped to
 * >= 4 ms after five levels); setTimeout(0) only where MessageChannel is
 * missing. The channel is closed once no callback is pending (an open port
 * with a handler keeps a Node process alive) and made again on the next post.
 * Returns { kind: "MessageChannel" | "setTimeout", yieldTurn(fn) }.
 */
export function makeTurnYielder(scope = globalThis) {
  const MC = scope && scope.MessageChannel;
  if (typeof MC !== "function") return { kind: "setTimeout", yieldTurn: (fn) => setTimeout(fn, 0) };
  let ch = null;
  const q = [];
  function onTurn() {
    const fn = q.shift();
    try {
      if (fn) fn();
    } finally {
      if (q.length === 0 && ch) {
        const c = ch;
        ch = null;
        c.port1.onmessage = null;
        c.port1.close();
        c.port2.close();
      }
    }
  }
  return {
    kind: "MessageChannel",
    yieldTurn(fn) {
      if (!ch) {
        ch = new MC();
        ch.port1.onmessage = onTurn;
      }
      q.push(fn);
      ch.port2.postMessage(0);
    },
  };
}

function hexOfDigest(buf) {
  const u = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < u.length; i++) out += u[i].toString(16).padStart(2, "0");
  return out;
}

/** The digest engine for this context: `subtle` (secure context) or `js`.
 *  Returns { engine, digestHex(ArrayBuffer) -> Promise<string> }. */
export function pickDigest(scope = globalThis) {
  try {
    const subtle = scope && scope.isSecureContext && scope.crypto && scope.crypto.subtle;
    if (subtle && typeof subtle.digest === "function") {
      return {
        engine: "subtle",
        digestHex: async (buf) => hexOfDigest(await subtle.digest("SHA-256", buf)),
      };
    }
  } catch (_) {
    /* fall through to the JS engine */
  }
  return { engine: "js", digestHex: async (buf) => sha256Hex(new Uint8Array(buf)) };
}

/** A catalog hash we can check: >= 32 lowercase-able hex chars, else null. */
function normaliseSha(sha) {
  if (typeof sha !== "string") return null;
  const s = sha.toLowerCase();
  return s.length >= 32 && /^[0-9a-f]+$/.test(s) ? s : null;
}

/**
 * The worker's message handler, with every effect injected:
 *   fetchImpl(url, init) -> Promise<Response-like {ok,status,statusText,arrayBuffer(),body?}>
 *   post(msg, transfer)      — postMessage
 *   now()                    — performance.now() of THIS context
 *   timeOrigin               — performance.timeOrigin of THIS context (sent with results)
 *   setTimer(fn, ms) / clearTimer(id)
 *   digest                   — { engine, digestHex } (default: pickDigest())
 *   maxEntries / maxBytes / delayMs — flush policy (defaults 64 / 4 MB / 8 ms)
 *   hashSlice                — `?shardHashSlice` (default true; a batch message's
 *                              boolean `hashSlice` overrides it from then on)
 *   sliceBytes               — slice size / one-pass limit (default 64 KB)
 *   yieldTurn(fn)            — run fn on a later event-loop turn (default: a
 *                              MessageChannel post, makeTurnYielder())
 */
export function createShardFetchHandler(deps = {}) {
  const fetchImpl = deps.fetchImpl || ((u, i) => fetch(u, i));
  const post = deps.post || (() => {});
  const now = deps.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const timeOrigin = deps.timeOrigin != null
    ? deps.timeOrigin
    : (typeof performance !== "undefined" && performance.timeOrigin) || 0;
  const setTimer = deps.setTimer || ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer || ((id) => clearTimeout(id));
  const digest = deps.digest || pickDigest();
  const maxEntries = deps.maxEntries || FLUSH_MAX_ENTRIES;
  const maxBytes = deps.maxBytes || FLUSH_MAX_BYTES;
  const delayMs = deps.delayMs != null ? deps.delayMs : FLUSH_DELAY_MS;
  const heartbeatMs = deps.heartbeatMs != null ? deps.heartbeatMs : HEARTBEAT_MS;
  const lagProbeMs = deps.lagProbeMs != null ? deps.lagProbeMs : LAG_PROBE_MS;
  const sliceBytes = deps.sliceBytes > 0 ? deps.sliceBytes : HASH_SLICE_BYTES;
  const yielder = typeof deps.yieldTurn === "function" ? { kind: "injected", yieldTurn: deps.yieldTurn } : makeTurnYielder();

  let out = [];
  let transfer = [];
  let outBytes = 0;
  let timer = null;
  // Liveness while requests are in flight: the page fails the worker (and goes
  // direct) after 30 s of silence with requests pending, so a legitimately slow
  // body (a 4 MB HD record on a slow link) must not look like a dead worker.
  let inflight = 0;
  let beat = null;
  function armBeat() {
    if (beat !== null || !(heartbeatMs > 0) || inflight === 0) return;
    beat = setTimer(() => {
      beat = null;
      if (inflight > 0) {
        try {
          post({ type: "alive", inflight }, []);
        } catch (_) {
          /* the next results post will try again */
        }
        armBeat();
      }
    }, heartbeatMs);
  }
  // Event-loop lag probe (diag only): while requests are in flight, a timer
  // due every `lagProbeMs` records how late it fired.
  const lag = { probes: 0, max: 0, over16: 0, over50: 0, over100: 0 };
  let probe = null;
  function armProbe() {
    if (probe !== null || !(lagProbeMs > 0) || inflight === 0) return;
    const due = now() + lagProbeMs;
    probe = setTimer(() => {
      probe = null;
      const late = Math.max(0, now() - due);
      lag.probes += 1;
      if (late > lag.max) lag.max = Math.round(late * 10) / 10;
      if (late > 16) lag.over16 += 1;
      if (late > 50) lag.over50 += 1;
      if (late > 100) lag.over100 += 1;
      armProbe();
    }, lagProbeMs);
  }
  const stats = {
    engine: digest.engine,
    batches: 0,
    reqs: 0,
    ok: 0,
    httpErrors: 0,
    netErrors: 0,
    verified: 0,
    mismatch: 0,
    bytes: 0,
    hashMs: 0,
    flushes: 0,
    flushBy: { count: 0, bytes: 0, time: 0 },
    // requests by the priority member they were fetched with
    prio: { low: 0, high: 0, auto: 0 },
    lag,
    // `?shardHashSlice`: the mode for bodies hashed from now on, bodies hashed
    // in slices, slices run, the longest single slice (ms, hashing only).
    hashSlice: deps.hashSlice !== false,
    hashYield: yielder.kind,
    slicedBodies: 0,
    slices: 0,
    maxSliceMs: 0,
  };
  const hashSnap = () => ({
    slice: stats.hashSlice,
    yield: stats.hashYield,
    slicedBodies: stats.slicedBodies,
    slices: stats.slices,
    maxSliceMs: stats.maxSliceMs,
  });

  // -------------------------------------------------------------------------
  // `?shardHashSlice`: bodies over `sliceBytes` are hashed ONE slice per
  // event-loop turn, across every queued body: urgent (non-'low') bodies
  // first, then the fewest bytes left (arrival order on ties), so an urgent
  // body waits behind at most the slice already running and a 200 KB body is
  // not stuck behind a 4 MB one.
  // -------------------------------------------------------------------------
  const jobs = [];
  let pumpArmed = false;

  function sliceable(buf) {
    return stats.hashSlice && digest.engine === "js" && buf.byteLength > sliceBytes;
  }

  /** Resolves with the job ({hex, cpuMs}) once its last slice ran. */
  function hashSliced(buf, urgent) {
    return new Promise((resolve, reject) => {
      jobs.push({ u8: new Uint8Array(buf), off: 0, st: sha256Init(), urgent, cpuMs: 0, hex: null, resolve, reject });
      stats.slicedBodies += 1;
      armPump();
    });
  }

  function armPump() {
    if (pumpArmed || jobs.length === 0) return;
    pumpArmed = true;
    try {
      yielder.yieldTurn(pump);
    } catch (_) {
      // No way to yield (not expected): finish every queued body in one pass,
      // as the one-shot hash would have.
      pumpArmed = false;
      for (const j of jobs.splice(0)) {
        const t0 = now();
        try {
          sha256Update(j.st, j.u8, j.off, j.u8.length);
          j.off = j.u8.length;
          j.hex = sha256Final(j.st);
          j.cpuMs += now() - t0;
          j.resolve(j);
        } catch (e) {
          j.reject(e);
        }
      }
    }
  }

  function pickJob() {
    let best = -1;
    for (let i = 0; i < jobs.length; i++) {
      if (best < 0) {
        best = i;
        continue;
      }
      const j = jobs[i];
      const b = jobs[best];
      if (j.urgent !== b.urgent) {
        if (j.urgent) best = i;
      } else if (j.u8.length - j.off < b.u8.length - b.off) {
        best = i;
      }
    }
    return best;
  }

  function pump() {
    pumpArmed = false;
    const i = pickJob();
    if (i >= 0) {
      const j = jobs[i];
      const t0 = now();
      try {
        const end = Math.min(j.u8.length, j.off + sliceBytes);
        sha256Update(j.st, j.u8, j.off, end);
        j.off = end;
        if (end >= j.u8.length) j.hex = sha256Final(j.st);
      } catch (e) {
        jobs.splice(i, 1);
        j.reject(e);
      }
      const dt = now() - t0;
      j.cpuMs += dt;
      stats.slices += 1;
      if (dt > stats.maxSliceMs) stats.maxSliceMs = Math.round(dt * 10) / 10;
      if (j.hex !== null) {
        jobs.splice(i, 1);
        j.resolve(j);
      }
    }
    armPump();
  }

  function flush(reason) {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
    if (out.length === 0) return;
    const res = out;
    const xfer = transfer;
    out = [];
    transfer = [];
    outBytes = 0;
    stats.flushes += 1;
    stats.flushBy[reason] = (stats.flushBy[reason] || 0) + 1;
    try {
      post({ type: "results", to: timeOrigin, lag: { ...lag }, hash: hashSnap(), res }, xfer);
    } catch (e) {
      // A failed post must not strand the page's promises: answer every body
      // id with a network-class error (the wasm walk retries those keys). An
      // entry that already IS an error carries no buffer and goes back as it
      // is, so an HTTP status (a tolerated convention-URL 404) survives.
      stats.postErrors = (stats.postErrors || 0) + 1;
      const msg = `results postMessage failed: ${String((e && e.message) || e)}`;
      try {
        post({ type: "results", to: timeOrigin, res: res.map((r) => (r.ok ? { id: r.id, ok: false, status: 0, msg } : r)) }, []);
      } catch (_) {
        /* the page's onerror/ready watchdog is the last line */
      }
    }
  }

  function push(entry) {
    out.push(entry);
    if (entry.buf) {
      transfer.push(entry.buf);
      outBytes += entry.buf.byteLength;
    }
    if (out.length >= maxEntries) flush("count");
    else if (outBytes >= maxBytes) flush("bytes");
    else if (timer === null) timer = setTimer(() => { timer = null; flush("time"); }, delayMs);
  }

  async function one(req) {
    const id = req.id;
    // "low" = the normal lane; "high" = the urgent lane, explicit (the page's
    // `?shardFetchHigh`, default on); anything else = no init (the urgent lane
    // with `?shardFetchHigh=off`: the browser's default for a worker fetch).
    const init = req.prio === "low" ? { priority: "low" } : req.prio === "high" ? { priority: "high" } : undefined;
    stats.prio[init ? init.priority : "auto"] += 1;
    let res;
    try {
      res = init ? await fetchImpl(req.url, init) : await fetchImpl(req.url);
    } catch (e) {
      stats.netErrors += 1;
      push({ id, ok: false, status: 0, msg: String((e && e.message) || e), tNetEnd: now() });
      return;
    }
    const tResp = now();
    if (!res || !res.ok) {
      stats.httpErrors += 1;
      const status = res ? res.status | 0 : 0;
      // The error body is left unread, as the wasm direct path leaves it.
      push({
        id,
        ok: false,
        status,
        statusText: res ? String(res.statusText || "") : "",
        msg: `HTTP ${status}`,
        tResp,
        tNetEnd: now(),
      });
      return;
    }
    let buf;
    try {
      buf = await res.arrayBuffer();
    } catch (e) {
      stats.netErrors += 1;
      push({ id, ok: false, status: 0, msg: `body read: ${String((e && e.message) || e)}`, tNetEnd: now() });
      return;
    }
    const tNetEnd = now();
    let verified = false;
    let mismatch = false;
    const want = normaliseSha(req.sha);
    if (want) {
      const t0 = now();
      let cpuMs = null;
      try {
        let got;
        if (sliceable(buf)) {
          // `?shardHashSlice`: one 64 KB slice per event-loop turn; the
          // urgent lane (anything but 'low') is served first.
          const job = await hashSliced(buf, req.prio !== "low");
          got = job.hex;
          cpuMs = job.cpuMs;
        } else {
          got = await digest.digestHex(buf);
        }
        if (got.slice(0, want.length) === want) verified = true;
        else mismatch = true;
      } catch (_) {
        /* hash engine failed: deliver unverified, the wasm Step E verifies */
      }
      // hashing time (a sliced body: its slices only, not the turns between)
      stats.hashMs += cpuMs !== null ? cpuMs : now() - t0;
    }
    stats.ok += 1;
    stats.bytes += buf.byteLength;
    if (verified) stats.verified += 1;
    if (mismatch) stats.mismatch += 1;
    push({ id, ok: true, buf, verified, mismatch, tResp, tNetEnd, tReady: now() });
  }

  function onMessage(msg) {
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "batch" && Array.isArray(msg.reqs)) {
      // `?shardHashSlice` as the page read it (absent: keep the current mode).
      if (typeof msg.hashSlice === "boolean") stats.hashSlice = msg.hashSlice;
      stats.batches += 1;
      stats.reqs += msg.reqs.length;
      for (const r of msg.reqs) {
        inflight += 1;
        one(r)
          .catch((e) => {
            // Never strand an id: anything unexpected answers as a network error.
            stats.netErrors += 1;
            push({ id: r && r.id, ok: false, status: 0, msg: `worker: ${String((e && e.message) || e)}`, tNetEnd: now() });
          })
          .finally(() => {
            inflight -= 1;
          });
      }
      armBeat();
      armProbe();
    } else if (msg.type === "stats") {
      post({ type: "stats", stats: snapshot() }, []);
    }
  }

  function snapshot() {
    return { ...stats, flushBy: { ...stats.flushBy }, prio: { ...stats.prio }, lag: { ...lag }, slicesQueued: jobs.length };
  }

  return { onMessage, flush: () => flush("time"), stats, snapshot, engine: digest.engine };
}

// ---------------------------------------------------------------------------
// Worker bootstrap — only inside a real dedicated worker (never on import from
// a test or the main thread).
// ---------------------------------------------------------------------------
if (
  typeof WorkerGlobalScope !== "undefined" &&
  typeof self !== "undefined" &&
  self instanceof WorkerGlobalScope
) {
  const handler = createShardFetchHandler({
    fetchImpl: (u, i) => (i ? fetch(u, i) : fetch(u)),
    post: (m, t) => self.postMessage(m, t),
    digest: pickDigest(self),
    // `?shardHashSlice` on the worker's own script URL (no query there today
    // → on); the page's flag arrives as `hashSlice` on each batch and wins.
    hashSlice: shardHashSliceEnabled((self.location && self.location.search) || ""),
  });
  // Diag for a CDP session on the WORKER target: the same snapshot as the
  // {type:'stats'} reply (hashSlice, slicedBodies, slices, maxSliceMs, lag, …).
  self.__shardFetchWorkerStats = handler.snapshot;
  self.onmessage = (ev) => handler.onMessage(ev.data);
  self.postMessage({
    type: "ready",
    to: (typeof performance !== "undefined" && performance.timeOrigin) || 0,
    engine: handler.engine,
    secure: !!self.isSecureContext,
  });
}
