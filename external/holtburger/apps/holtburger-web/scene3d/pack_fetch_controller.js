// scene3d/pack_fetch_controller.js — T12 (ST2): the PackFetchController.
//
// SPEC §1.1 / pass 3 (D-03.1..D-03.10, S1–S9): when `?packSource` is ON and
// the dist manifest declares `world_index`, this module is the SOLE fetch
// authority for pack/index CAS objects — wasm instances consume bytes pushed
// into them via `pack_source_init` / `pack_source_insert` and never fetch
// packs. OFF arm (default): nothing here runs beyond the flag read — the
// legacy per-record path is byte-identical (the kill path, I7).
//
// What is implemented at T12 (and what is not):
//   * lanes U > B > R > T, FIFO within lane; global in-flight cap 12 with a
//     4-slot urgent reserve (U may run 16) and a T sub-cap of 4 — all [A],
//     `?fetchCap=N` escape (pass 3 D-03.4/S2);
//   * one in-flight entry per URL: a `need()` on a queued entry PROMOTES it
//     in place (no bypass), an in-flight entry is LATCHED, never duplicated;
//     error entries are removed on completion so transients don't latch
//     (the inflight.rs:32-34 invariant, kept);
//   * hash-on-receipt for every CAS object against its name (sha256-trunc16)
//     BEFORE admission — engine `crypto.subtle` when the context is secure,
//     else an off-main-thread Blob worker running the pure-JS sha256 below,
//     else (worker unconstructable) a COUNTED, TAINTING main-thread fallback.
//     Always-ON; `?packVerify=off` is a diagnostic escape that taints the
//     run (pass 3 D-03.5, F-11.8);
//   * mismatch => ONE `cache: "reload"` retry, then the S7 failure matrix;
//     retries x3 at 0/1/3 s; index-listed 404s are LOUD deploy skew, never
//     "empty tile"; tile failures QUARANTINE the tile (60 s timed
//     re-eligibility + proximity retry) — quarantine bookkeeping is
//     authoritative and never erased by residency (pass 3 S7);
//   * boot waves (S3): manifest -> index (verified against the manifest's
//     sha256_16, session PINNED) -> CORE -> META/ENV/PVW commons ->
//     terrain-t128 slices (lane B tail, D-12.6) ; ring tile/interior packs +
//     regionals fetch on `notePlayerLandblock` (distance-sorted, lane R,
//     +1-tile directional lookahead per D-03.8);
//   * diag surface `globalThis.__hbFetch` per the registry schema
//     (harness/lib/diag_schema.mjs — the pass-10 S3 reserved shape, landed
//     current at ST2).
//
// NOT yet routed through the controller (each recorded in the T12 report as
// an explicit exception with its retirement stage): the per-LB scenery/
// spawns/events JSONL + suite-bin wasm-side fetches (T02 F-2/F-3/F-5/F-6 —
// content is pack-resident from T10 but their CONSUMERS swap at ST7/ST10;
// meanwhile D-03.10's legacy-share rule caps them: when packs arm, the
// legacy fetch-concurrency total drops to 8 under this controller's cap),
// the vfx catalog + wcid_to_setup one-shots (CORE membership is a bake
// change), and full-tier textures (lane T exists and is tested; its
// producer lands at ST5).
//
// Node-testable by construction: `createPackFetchController(opts)` accepts
// injected `fetchImpl` / `now` / `setTimeoutImpl` / `digestImpl` / `wasmNs`;
// the browser singleton wiring at the bottom is a thin shell.

// ---------------------------------------------------------------------------
// flag readers (house grammar: EXACT-MATCH opt-in, default OFF; audited by
// scripts/audit-flag-defaults.mjs — keep comparisons same-line on .get())
// ---------------------------------------------------------------------------

/**
 * `?packSource` — DEV opt-in, **DEFAULT OFF** (flag lifecycle SPEC §0.1;
 * the orchestrator flips it after GATE-WIRE-BOOT). Only `on`/`1`/`true`/
 * `yes` read ON. Absent, empty, `off`, `0`, garbage => OFF. Not memoised.
 */
export function packSourceEnabled(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    const v = new URLSearchParams(s).get("packSource");
    if (v == null) return false;
    const t = String(v).toLowerCase();
    return t === "on" || t === "1" || t === "true" || t === "yes";
  } catch (_) {
    return false;
  }
}

/** `?fetchCap=N` — global in-flight cap escape (pass 3 S2; default 12 [A]). */
export function fetchCapConfigured(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    const v = new URLSearchParams(s).get("fetchCap");
    const n = Number.parseInt(v ?? "", 10);
    return Number.isFinite(n) && n >= 1 ? n : 12;
  } catch (_) {
    return 12;
  }
}

/**
 * `?packVerify` — hash-on-receipt is ALWAYS ON by default; ONLY the exact
 * string `off` disables it, as a diagnostic escape, and doing so TAINTS the
 * session's diag surface (pass 3 D-03.5 policy).
 */
export function packVerifyEnabled(search) {
  try {
    const s = search !== undefined ? search : typeof window !== "undefined" && window.location ? window.location.search : "";
    const v = new URLSearchParams(s).get("packVerify");
    return v !== "off";
  } catch (_) {
    return true;
  }
}

// ---------------------------------------------------------------------------
// pure-JS sha256 (FIPS 180-4) — the non-secure-context fallback engine.
// Runs inside a Blob worker (off the main thread) when `crypto.subtle` is
// unavailable; exported for test vectors. ~tens of MB/s in JS — fallback
// territory only (loopback/TLS origins all have subtle, F-11.8).
// ---------------------------------------------------------------------------

export function sha256Hex(bytes) {
  const K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
  ];
  const H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
  const len = bytes.length;
  const bitLenHi = Math.floor(len / 0x20000000);
  const bitLenLo = (len << 3) >>> 0;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) << 6);
  padded.set(bytes);
  padded[len] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 8, bitLenHi);
  dv.setUint32(padded.length - 4, bitLenLo);
  const w = new Int32Array(64);
  for (let off = 0; off < padded.length; off += 64) {
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
  let out = "";
  for (const v of H) out += (v >>> 0).toString(16).padStart(8, "0");
  return out;
}

// ---------------------------------------------------------------------------
// HBSI1 (spatial index) — JS parse. Byte truth:
// apps/holtburger-tools/src/pack_format.rs (24 B header, 24 B padded pack
// rows, 128x128 u16 tile grid row-major tile_x-major, 6 B interior rows,
// 4 B shared rows, CRC32 + "ISBH" footer). CRC is skipped here — the index
// was already sha256-verified against the manifest's sha256_16 on receipt.
// ---------------------------------------------------------------------------

export const SHARED_KIND = Object.freeze({
  CORE: 0, META_COMMONS: 1, META_REGIONAL: 2, ENV_COMMONS: 3, ENV_REGIONAL: 4,
  PVW_COMMONS: 5, PVW_REGIONAL: 6, TERRAIN_T128_COLOR: 7, TERRAIN_T128_NRA: 8,
});

export const PACK_KIND = Object.freeze({
  TILE: 0, INTERIOR: 1, META_SHARED: 2, PREVIEW: 3, ENV: 4, CORE: 5,
  TERRAIN_SLICE_COLOR: 6, TERRAIN_SLICE_NRA: 7,
});

const TILE_EMPTY = 0xffff;

export function parseHbsi1(buf) {
  const bytes = new Uint8Array(buf);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 24 + 32768 + 8) throw new Error("HBSI1: shorter than minimum");
  if (String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]) !== "HBSI") {
    throw new Error("HBSI1: bad magic");
  }
  if (bytes[4] !== 1) throw new Error(`HBSI1: unsupported version ${bytes[4]}`);
  const packCount = dv.getUint32(8, true);
  const interiorCount = dv.getUint32(12, true);
  const sharedCount = dv.getUint16(16, true);
  const epoch = dv.getUint32(20, true);
  let pos = 24;
  const packs = new Array(packCount);
  for (let i = 0; i < packCount; i++) {
    let hex = "";
    for (let j = 0; j < 16; j++) hex += bytes[pos + j].toString(16).padStart(2, "0");
    packs[i] = {
      hash: hex,
      size: dv.getUint32(pos + 16, true),
      kind: bytes[pos + 20],
      meta: bytes[pos + 21],
    };
    pos += 24;
  }
  // u16 alignment: pos = 24 + packCount*24, always even.
  const tileGrid = new Uint16Array(bytes.buffer, bytes.byteOffset + pos, 128 * 128);
  pos += 32768;
  const interiors = new Map(); // lb -> pack ordinal
  for (let i = 0; i < interiorCount; i++) {
    interiors.set(dv.getUint16(pos, true), dv.getUint16(pos + 2, true));
    pos += 6;
  }
  const shared = [];
  for (let i = 0; i < sharedCount; i++) {
    shared.push({ kind: bytes[pos], ord: bytes[pos + 1], packOrd: dv.getUint16(pos + 2, true) });
    pos += 4;
  }
  return { epoch, packs, tileGrid, interiors, shared };
}

/** Tile-grid lookup (row-major tile_x major). Returns pack ordinal or -1. */
export function tilePackOrd(index, tx, ty) {
  if (tx < 0 || tx > 127 || ty < 0 || ty > 127) return -1;
  const v = index.tileGrid[tx * 128 + ty];
  return v === TILE_EMPTY ? -1 : v;
}

// ---------------------------------------------------------------------------
// controller
// ---------------------------------------------------------------------------

const LANES = ["U", "B", "R", "T"];
const LANE_RANK = { U: 0, B: 1, R: 2, T: 3 };
/** Browser fetchpriority per lane (belt-and-braces, pass 3 S2 rule 4). */
const LANE_PRIORITY = { U: "high", B: "auto", R: "low", T: "low" };
const RETRY_DELAYS_MS = [0, 1000, 3000];
const QUARANTINE_MS = 60_000;
const URGENT_RESERVE = 4;
const T_SUBCAP = 4;

function urlDirname(url) {
  const i = url.lastIndexOf("/");
  return i >= 0 ? url.slice(0, i) : "";
}

/** CAS hash from a pack/index URL (`.../{32hex}.hbp|.bin`), or null. */
export function casHashFromUrl(url) {
  const m = /([0-9a-f]{32})\.(?:hbp|bin)(?:\?.*)?$/.exec(url);
  return m ? m[1] : null;
}

/**
 * Typed failure for every terminal outcome of the S7 matrix. `kind` is one
 * of: "deploy-skew-404" | "hash-mismatch" | "network" | "quarantined" |
 * "dropped" (dequeued before fetch — ring departure).
 */
export class PackFetchError extends Error {
  constructor(kind, url, detail) {
    super(`[pack-fetch] ${kind}: ${url}${detail ? ` — ${detail}` : ""}`);
    this.kind = kind;
    this.url = url;
  }
}

export function createPackFetchController(opts = {}) {
  const fetchImpl = opts.fetchImpl || ((...a) => fetch(...a));
  const now = opts.now || (() => (typeof performance !== "undefined" ? performance.now() : Date.now()));
  const setTimeoutImpl = opts.setTimeoutImpl || ((fn, ms) => setTimeout(fn, ms));
  const search = opts.search;
  const cap = opts.fetchCap ?? fetchCapConfigured(search);
  const verifyOn = opts.verify ?? packVerifyEnabled(search);
  // { pack_source_init, pack_source_insert, pack_source_stats } — may be
  // attached AFTER boot() via attachWasm() (the page arms the seam once
  // init_resource_source has resolved).
  let wasmNs = opts.wasmNs || null;
  const log = opts.log || ((...a) => console.log("[pack-fetch]", ...a));
  const warn = opts.warn || ((...a) => console.warn("[pack-fetch]", ...a));
  const error = opts.error || ((...a) => console.error("[pack-fetch]", ...a));

  // ── diag (the __hbFetch registry shape; counters cumulative per session) ──
  const laneRow = () => ({ queued: 0, inflight: 0, done: 0, failed: 0, bytes: 0 });
  const diag = {
    enabled: false, // armed state (flag ON + world_index present + booted)
    lanes: { U: laneRow(), B: laneRow(), R: laneRow(), T: laneRow() },
    verify: { engine: "subtle", ok: 0, mismatch: 0, msTotal: 0 },
    retries: 0,
    quarantined: [], // live tile keys (authoritative; residency never erases)
    quarantinedTotal: 0, // cumulative terminal quarantines (the gate counter)
    pinnedIndex: "",
    milestones: { inWorldMs: null, previewCompleteMs: null, convergedMs: null },
    byComponent: {},
    wireWaitEvents: 0,
    packSource: null, // pack_source_stats() mirror (refreshed on insert)
    taint: [],
  };
  const comp = (name) => (diag.byComponent[name] ||= { requests: 0, bytes: 0 });
  for (const c of ["code", "manifestIndex", "core", "meta", "tiles", "interior", "pvw", "terrainTier", "texFull"]) comp(c);
  if (!verifyOn) diag.taint.push("packVerify=off");

  // ── hash engines ──────────────────────────────────────────────────────────
  const subtle =
    opts.digestImpl !== undefined
      ? null
      : typeof crypto !== "undefined" && crypto.subtle && typeof crypto.subtle.digest === "function"
        ? crypto.subtle
        : null;
  let hashWorker; // lazy Blob worker for the non-secure-context fallback
  let hashWorkerSeq = 0;
  const hashWorkerPending = new Map();
  function ensureHashWorker() {
    if (hashWorker !== undefined) return hashWorker;
    try {
      const src = `${sha256Hex.toString()}\nself.onmessage=(e)=>{const{seq,bytes}=e.data;try{self.postMessage({seq,hex:sha256Hex(new Uint8Array(bytes))});}catch(err){self.postMessage({seq,error:String(err)});}};`;
      const blobUrl = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
      hashWorker = new Worker(blobUrl);
      hashWorker.onmessage = (e) => {
        const p = hashWorkerPending.get(e.data.seq);
        if (!p) return;
        hashWorkerPending.delete(e.data.seq);
        e.data.error ? p.reject(new Error(e.data.error)) : p.resolve(e.data.hex);
      };
      hashWorker.onerror = () => {
        for (const p of hashWorkerPending.values()) p.reject(new Error("hash worker died"));
        hashWorkerPending.clear();
        hashWorker = null; // next digest falls through to main-thread + taint
      };
    } catch (_) {
      hashWorker = null;
    }
    return hashWorker;
  }
  /** sha256 hex of an ArrayBuffer via the best available engine. */
  async function digestHex(buf) {
    const t0 = now();
    try {
      if (opts.digestImpl) return await opts.digestImpl(buf);
      if (subtle) {
        diag.verify.engine = "subtle";
        const d = await subtle.digest("SHA-256", buf);
        return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
      }
      if (typeof Worker !== "undefined" && ensureHashWorker()) {
        diag.verify.engine = "wasm"; // registry enum: off-main-thread worker engine
        const seq = ++hashWorkerSeq;
        // Copy: the buffer is transferred to keep the copy off this thread's
        // ledger, and the caller still owns `buf` for admission afterwards.
        const copy = buf.slice(0);
        return await new Promise((resolve, reject) => {
          hashWorkerPending.set(seq, { resolve, reject });
          hashWorker.postMessage({ seq, bytes: copy }, [copy]);
        });
      }
      // Last resort: main-thread JS — counted + tainted, never silent.
      diag.verify.engine = "main-js";
      if (!diag.taint.includes("verifyMainThread")) {
        diag.taint.push("verifyMainThread");
        warn("no subtle crypto and no Worker — hashing on the MAIN thread (tainted run)");
      }
      return sha256Hex(new Uint8Array(buf));
    } finally {
      diag.verify.msTotal += now() - t0;
    }
  }

  // ── the lane queue ────────────────────────────────────────────────────────
  // entries: url -> {url, lane, component, expectedHash, state, waiters,
  //                  attempt, tileKey, resolve/reject via promise}
  const entries = new Map();
  const queues = { U: [], B: [], R: [], T: [] };
  let inflightTotal = 0;
  const inflightByLane = { U: 0, B: 0, R: 0, T: 0 };
  const quarantine = new Map(); // tileKey -> {until, reason}
  const resident = new Set(); // urls done (admission-complete)

  function pumpSoon() {
    // microtask pump: keeps ordering deterministic for tests
    Promise.resolve().then(pump);
  }

  function capacityFor(lane) {
    if (inflightByLane.T >= T_SUBCAP && lane === "T") return false;
    if (lane === "U") return inflightTotal < cap + URGENT_RESERVE;
    return inflightTotal < cap;
  }

  function pump() {
    for (const lane of LANES) {
      const q = queues[lane];
      while (q.length && capacityFor(lane)) {
        const entry = q.shift();
        if (entry.state !== "queued") continue; // promoted away / dropped
        startFetch(entry);
      }
      // A full global cap still leaves the urgent reserve reachable only by
      // lane U, so do not break early on U.
      if (inflightTotal >= cap + URGENT_RESERVE) break;
    }
  }

  function startFetch(entry) {
    entry.state = "inflight";
    inflightTotal += 1;
    inflightByLane[entry.lane] += 1;
    diag.lanes[entry.lane].inflight = inflightByLane[entry.lane];
    diag.lanes[entry.lane].queued = queues[entry.lane].filter((e) => e.state === "queued").length;
    runFetch(entry).finally(() => {
      inflightTotal -= 1;
      inflightByLane[entry.lane] -= 1;
      diag.lanes[entry.lane].inflight = inflightByLane[entry.lane];
      pumpSoon();
    });
  }

  async function runFetch(entry) {
    const { url } = entry;
    let lastDetail = "";
    for (let attempt = 0; attempt < RETRY_DELAYS_MS.length; attempt++) {
      if (attempt > 0) {
        diag.retries += 1;
        await new Promise((r) => setTimeoutImpl(r, RETRY_DELAYS_MS[attempt]));
      }
      try {
        const init = { credentials: "same-origin", priority: LANE_PRIORITY[entry.lane] };
        if (entry.forceReload) init.cache = "reload";
        const res = await fetchImpl(url, init);
        if (!res.ok) {
          if (res.status === 404) {
            // Index-listed CAS object: 404 is NEVER "doesn't exist" — the
            // pinned index authoritatively lists it (pass 3 D-03.1).
            error(`deploy skew: index-listed object 404s: ${url}`);
            return settleFailure(entry, new PackFetchError("deploy-skew-404", url));
          }
          lastDetail = `http ${res.status}`;
          continue;
        }
        const buf = await res.arrayBuffer();
        if (verifyOn && entry.expectedHash) {
          const hex = await digestHex(buf);
          if (hex.slice(0, entry.expectedHash.length) !== entry.expectedHash) {
            diag.verify.mismatch += 1;
            if (!entry.forceReload) {
              // First mismatch: one immediate cache-busting retry (a
              // truncated/corrupt HTTP-cache body, pass 3 D-03.5).
              entry.forceReload = true;
              lastDetail = "hash mismatch (cache reload retry)";
              attempt -= 1; // the reload retry does not consume a backoff slot
              continue;
            }
            error(`hash mismatch after reload retry: ${url}`);
            return settleFailure(entry, new PackFetchError("hash-mismatch", url, lastDetail));
          }
          diag.verify.ok += 1;
        }
        return settleSuccess(entry, buf);
      } catch (e) {
        lastDetail = String(e && e.message ? e.message : e);
      }
    }
    return settleFailure(entry, new PackFetchError("network", url, lastDetail));
  }

  function settleSuccess(entry, buf) {
    entry.state = "done";
    resident.add(entry.url);
    diag.lanes[entry.lane].done += 1;
    diag.lanes[entry.lane].bytes += buf.byteLength;
    const c = comp(entry.component || "tiles");
    c.requests += 1;
    c.bytes += buf.byteLength;
    // success entries stay in the map as a latch: a later need() for the
    // same URL resolves immediately off the settled promise.
    entry.resolve(buf);
  }

  function settleFailure(entry, err) {
    entry.state = "failed";
    diag.lanes[entry.lane].failed += 1;
    const c = comp(entry.component || "tiles");
    c.requests += 1;
    if (entry.tileKey != null) {
      // Terminal tile/interior failure: quarantine with timed
      // re-eligibility. NOT resident, NOT rendered-as-empty (S7).
      quarantine.set(entry.tileKey, { until: now() + QUARANTINE_MS, reason: err.kind });
      if (!diag.quarantined.includes(entry.tileKey)) diag.quarantined.push(entry.tileKey);
      diag.quarantinedTotal += 1;
      error(`tile ${entry.tileKey} quarantined (${err.kind}), re-eligible in ${QUARANTINE_MS / 1000}s`);
    }
    // Error entries are REMOVED so transients don't latch (inflight.rs
    // invariant) — a later need() re-fetches.
    entries.delete(entry.url);
    entry.reject(err);
  }

  /**
   * The one entry point (pass 3 S1.1). Idempotent per URL: latches onto an
   * in-flight/queued/settled entry; a higher lane PROMOTES a queued entry in
   * place (never a duplicate fetch).
   */
  function need(url, { lane = "R", component = "tiles", expectedHash, tileKey } = {}) {
    if (!LANES.includes(lane)) throw new Error(`bad lane ${lane}`);
    const q = quarantine.get(tileKey);
    if (q && now() < q.until) {
      return Promise.reject(new PackFetchError("quarantined", url, `until ${Math.round(q.until)}`));
    }
    if (q) {
      quarantine.delete(tileKey); // timed re-eligibility
      const i = diag.quarantined.indexOf(tileKey);
      if (i >= 0) diag.quarantined.splice(i, 1);
    }
    let entry = entries.get(url);
    if (entry) {
      if (entry.state === "queued" && LANE_RANK[lane] < LANE_RANK[entry.lane]) {
        // PROMOTION IN PLACE: move between lane queues, keep the entry.
        const from = queues[entry.lane];
        const idx = from.indexOf(entry);
        if (idx >= 0) from.splice(idx, 1);
        entry.lane = lane;
        queues[lane].push(entry);
        pumpSoon();
      }
      // In-flight or settled: LATCH — at pack sizes the remaining transfer
      // time IS the fetch; a duplicate cannot beat it (pass 3 D-03.4).
      return entry.promise;
    }
    const expected = expectedHash !== undefined ? expectedHash : casHashFromUrl(url) || undefined;
    entry = {
      url, lane, component, expectedHash: expected, tileKey,
      state: "queued", forceReload: false,
    };
    entry.promise = new Promise((resolve, reject) => {
      entry.resolve = resolve;
      entry.reject = reject;
    });
    // Rejections may settle before any consumer attaches (drop/quarantine
    // paths) — pre-attach a no-op so they never surface as unhandled.
    entry.promise.catch(() => {});
    entries.set(url, entry);
    queues[lane].push(entry);
    diag.lanes[lane].queued = queues[lane].filter((e) => e.state === "queued").length;
    pumpSoon();
    return entry.promise;
  }

  /** Backpressure (S2 rule 5): drop queued lane-R entries not in `keep`. */
  function dropQueuedOutside(keepUrls) {
    const q = queues.R;
    for (let i = q.length - 1; i >= 0; i--) {
      const entry = q[i];
      if (entry.state === "queued" && !keepUrls.has(entry.url)) {
        q.splice(i, 1);
        entries.delete(entry.url);
        entry.state = "dropped";
        entry.reject(new PackFetchError("dropped", entry.url));
      }
    }
    diag.lanes.R.queued = q.filter((e) => e.state === "queued").length;
  }

  // ── session state ─────────────────────────────────────────────────────────
  let manifest = null;
  let index = null; // parsed HBSI1
  let indexBytes = null; // raw verified HBSI1 bytes (handed to pack_source_init)
  let baseUrl = ""; // dist dir the manifest lives in
  let packUrlTemplate = "packs/{sha256_prefix2}/{sha256}.hbp";
  const t0 = now();
  const t128 = { color: null, nra: null }; // verified slice bytes (ST5 consumer)
  let lastLb = null;
  let armed = false;

  function packUrl(hash) {
    const rel = packUrlTemplate.replace("{sha256_prefix2}", hash.slice(0, 2)).replace("{sha256}", hash);
    return `${baseUrl}/${rel}`;
  }

  function componentForKind(kind) {
    switch (kind) {
      case PACK_KIND.TILE: return "tiles";
      case PACK_KIND.INTERIOR: return "interior";
      case PACK_KIND.PREVIEW: return "pvw";
      case PACK_KIND.CORE: return "core";
      case PACK_KIND.TERRAIN_SLICE_COLOR:
      case PACK_KIND.TERRAIN_SLICE_NRA: return "terrainTier";
      default: return "meta";
    }
  }

  /** Fetch + verify + admit one pack by table ordinal. Resolves InsertStats-ish. */
  async function needPack(ord, { lane, tileKey } = {}) {
    const p = index.packs[ord];
    if (!p) throw new Error(`pack ordinal ${ord} out of range`);
    const url = packUrl(p.hash);
    const buf = await need(url, {
      lane: lane || "R",
      component: componentForKind(p.kind),
      expectedHash: p.hash,
      tileKey,
    });
    if (wasmNs && typeof wasmNs.pack_source_insert === "function" && !needPack._inserted.has(p.hash)) {
      const st = JSON.parse(wasmNs.pack_source_insert(p.hash, new Uint8Array(buf)));
      needPack._inserted.add(p.hash);
      if (typeof wasmNs.pack_source_stats === "function") {
        try { diag.packSource = JSON.parse(wasmNs.pack_source_stats()); } catch (_) {}
      }
      return st;
    }
    return { admitted: false };
  }
  needPack._inserted = new Set();

  /**
   * Wave 0 (pass 3 S3): manifest -> index, verified + pinned. Resolves
   * `{armed}` — false (clean no-op) when the manifest declares no
   * `world_index` (legacy dist) so a flag-ON boot against today's dist
   * changes nothing but one manifest re-read.
   */
  async function boot(manifestUrl) {
    baseUrl = urlDirname(manifestUrl);
    const mres = await fetchImpl(manifestUrl, { cache: "no-cache", credentials: "same-origin" });
    if (!mres.ok) throw new PackFetchError("network", manifestUrl, `http ${mres.status}`);
    manifest = await mres.json();
    if (!manifest || !manifest.world_index || !manifest.world_index.url) {
      log("manifest has no world_index — pack lane disarmed (legacy dist)");
      return { armed: false };
    }
    packUrlTemplate = manifest.pack_url_template || packUrlTemplate;
    const wi = manifest.world_index;
    const indexUrl = `${baseUrl}/${wi.url}`;
    const buf = await need(indexUrl, {
      lane: "B", component: "manifestIndex", expectedHash: wi.sha256_16,
    });
    indexBytes = buf;
    index = parseHbsi1(buf);
    diag.pinnedIndex = wi.sha256_16;
    armed = true;
    diag.enabled = true;
    return { armed: true };
  }

  /**
   * Waves 1–2 tail (position-independent): CORE -> META-COMMONS ->
   * ENV-COMMONS -> PVW-COMMONS -> terrain t128 slices (lane B tail,
   * D-12.6). Regionals + ring tiles ride `notePlayerLandblock`.
   */
  async function bootCommons() {
    if (!armed) return;
    const byKind = new Map(index.shared.map((s) => [`${s.kind}:${s.ord}`, s.packOrd]));
    const grab = (kind, lane) => {
      const ord = byKind.get(`${kind}:0`);
      return ord === undefined ? null : needPack(ord, { lane });
    };
    // Ordered within lane B by enqueue order (FIFO within lane).
    const jobs = [];
    for (const kind of [SHARED_KIND.CORE, SHARED_KIND.META_COMMONS, SHARED_KIND.ENV_COMMONS, SHARED_KIND.PVW_COMMONS]) {
      const j = grab(kind, "B");
      if (j) jobs.push(j);
    }
    // t128 slices: ONE CAS file per channel (D-12.6), lane B tail. Bytes are
    // retained for the ST5 terrain-ladder consumer (`getT128Slice`).
    for (const [kind, chan] of [[SHARED_KIND.TERRAIN_T128_COLOR, "color"], [SHARED_KIND.TERRAIN_T128_NRA, "nra"]]) {
      const ord = byKind.get(`${kind}:0`);
      if (ord === undefined) continue;
      const p = index.packs[ord];
      jobs.push(
        need(packUrl(p.hash), { lane: "B", component: "terrainTier", expectedHash: p.hash })
          .then((buf) => { t128[chan] = buf; })
      );
    }
    await Promise.all(jobs);
    if (diag.milestones.inWorldMs == null) diag.milestones.inWorldMs = now() - t0;
  }

  /** Ring tiles for an 11x11-LB ring at 2x2 tiles = the 6x6 tile window. */
  function ringTiles(lbx, lby) {
    const tiles = [];
    const ptx = lbx >> 1, pty = lby >> 1;
    for (let x = lbx - 5; x <= lbx + 5; x += 1) {
      for (let y = lby - 5; y <= lby + 5; y += 1) {
        if (x < 0 || x > 255 || y < 0 || y > 255) continue;
        const tx = x >> 1, ty = y >> 1;
        if (!tiles.some((t) => t.tx === tx && t.ty === ty)) {
          tiles.push({ tx, ty, dist: Math.max(Math.abs(tx - ptx), Math.abs(ty - pty)) });
        }
      }
    }
    tiles.sort((a, b) => a.dist - b.dist);
    return tiles;
  }

  /**
   * Player position update (drives D-03.8 ring/lookahead + S4 crossing).
   * `lbId` is the 16-bit landblock key (lbx<<8 | lby) or the 32-bit cell id
   * (high 16 bits used). Movement direction derives from the previous call.
   */
  function notePlayerLandblock(lbId) {
    if (!armed) return;
    const lb = lbId > 0xffff ? lbId >>> 16 : lbId;
    const lbx = (lb >> 8) & 0xff, lby = lb & 0xff;
    const prev = lastLb;
    lastLb = { lbx, lby };
    const first = prev == null;
    const moved = !first && (prev.lbx !== lbx || prev.lby !== lby);
    if (!first && !moved) return;

    const keep = new Set();
    const jobs = [];
    const tiles = ringTiles(lbx, lby);
    for (const t of tiles) {
      const ord = tilePackOrd(index, t.tx, t.ty);
      if (ord < 0) continue;
      const url = packUrl(index.packs[ord].hash);
      keep.add(url);
      // T20 live-arm fix (2026-08-09): the keep set for interiors +
      // regionals must accrue for EVERY ring tile, INCLUDING resident ones.
      // The old `if (resident.has(url)) continue;` short-circuit meant that
      // once a ring tile's pack landed, its supergrid REGIONALS stopped
      // being kept by that tile — so a still-queued shared regional (FIFO
      // behind the tile packs) fell out of `keep` on the next crossing and
      // dropQueuedOutside REJECTED it, failing every ST7 grid tile latched
      // on it (in-window slots stranded EMPTY; found live on the T20 arm).
      const tileResident = resident.has(url);
      const tileKey = `${t.tx},${t.ty}`;
      const qrow = quarantine.get(tileKey);
      const tileQuarantined = qrow && now() < qrow.until && t.dist > 1; // timed; proximity (dist<=1) retries
      if (!tileResident && !tileQuarantined) {
        // current tile = URGENT (player-blocking); rest lane R.
        const lane = t.dist === 0 ? "U" : "R";
        // C5 instrument: lane-U content the player OCCUPIES was not resident
        // at need. The cold-boot spawn tile is excluded — C5 is a sustained-
        // walk gate, not a boot gate (pass 10 owns the scoring).
        if (!first && lane === "U") diag.wireWaitEvents += 1;
        jobs.push(needPack(ord, { lane, tileKey }).catch(() => {}));
      }
      // Interiors of ring LBs prefetch at admission; player's own LB
      // interior promotes to U (S4). keep.add unconditionally (see above);
      // enqueue skipped only while the owning tile is quarantined (needPack
      // latches, so re-needs of settled entries are re-serves, not fetches).
      for (const [ilb, iord] of index.interiors) {
        const ix = (ilb >> 8) & 0xff, iy = ilb & 0xff;
        if ((ix >> 1) === t.tx && (iy >> 1) === t.ty) {
          const iurl = packUrl(index.packs[iord].hash);
          keep.add(iurl);
          if (!tileQuarantined && !resident.has(iurl)) {
            const ilane = ilb === lb ? "U" : "R";
            jobs.push(needPack(iord, { lane: ilane, tileKey }).catch(() => {}));
          }
        }
      }
      // Regional shared packs for the tile's supergrid cell (32x32-LB,
      // 8x8 grid — T10 D4): meta + env + pvw regionals.
      const sg = ((t.tx * 2) >> 5) * 8 + ((t.ty * 2) >> 5);
      for (const s of index.shared) {
        if (s.ord === sg && (s.kind === SHARED_KIND.META_REGIONAL || s.kind === SHARED_KIND.ENV_REGIONAL || s.kind === SHARED_KIND.PVW_REGIONAL)) {
          const surl = packUrl(index.packs[s.packOrd].hash);
          keep.add(surl);
          if (!resident.has(surl)) {
            jobs.push(needPack(s.packOrd, { lane: "R" }).catch(() => {}));
          }
        }
      }
    }
    // +1-tile DIRECTIONAL lookahead while moving (D-03.8): the next tile
    // row/column beyond the ring in the movement direction.
    if (moved) {
      const dx = Math.sign(lbx - prev.lbx), dy = Math.sign(lby - prev.lby);
      const edge = 3; // ring is 6x6 tiles → edge offset 3 beyond player tile
      const ptx = lbx >> 1, pty = lby >> 1;
      for (let k = -3; k <= 3; k += 1) {
        let tx, ty;
        if (dx !== 0) { tx = ptx + dx * edge; ty = pty + k; }
        else if (dy !== 0) { tx = ptx + k; ty = pty + dy * edge; }
        else continue;
        const ord = tilePackOrd(index, tx, ty);
        if (ord < 0) continue;
        const url = packUrl(index.packs[ord].hash);
        keep.add(url);
        if (!resident.has(url)) jobs.push(needPack(ord, { lane: "R", tileKey: `${tx},${ty}` }).catch(() => {}));
      }
    }
    dropQueuedOutside(keep);
    if (first) {
      Promise.all(jobs).then(() => {
        if (diag.milestones.previewCompleteMs == null) {
          diag.milestones.previewCompleteMs = now() - t0;
        }
      });
    }
  }

  const controller = {
    boot,
    bootCommons,
    need,
    needPack,
    notePlayerLandblock,
    /** Arm the wasm seam post-init_resource_source (page wiring). */
    attachWasm(ns) { wasmNs = ns || null; },
    getIndexBytes: () => indexBytes,
    getT128Slice: (chan) => t128[chan],
    get armed() { return armed; },
    get index() { return index; },
    get diag() { return diag; },
    // test hooks
    _entries: entries,
    _queues: queues,
    _quarantine: quarantine,
    _resident: resident,
    _pump: pump,
    /** Test/harness drain: resolves when nothing is queued or in flight
     *  (two consecutive quiet macrotasks). Not for production use — a
     *  T-subcap-starved queue would spin. */
    async _idle(maxRounds = 5000) {
      const tick = () => new Promise((r) => (typeof setImmediate === "function" ? setImmediate(r) : setTimeout(r, 0)));
      let quiet = 0;
      for (let i = 0; i < maxRounds; i += 1) {
        const busy = inflightTotal > 0 || LANES.some((l) => queues[l].some((e) => e.state === "queued"));
        quiet = busy ? 0 : quiet + 1;
        if (quiet >= 2) return;
        await tick();
      }
      throw new Error("pack-fetch _idle: did not settle");
    },
  };
  return controller;
}

// ---------------------------------------------------------------------------
// browser singleton (index.html wiring). Publishes `globalThis.__hbFetch`
// even when OFF (enabled:false zeros — the __texWorkerStats convention) so
// benches read ABSENT-vs-disarmed honestly.
// ---------------------------------------------------------------------------

let _singleton = null;

export function getPackFetchController(opts) {
  if (!_singleton) {
    _singleton = createPackFetchController(opts);
    try {
      if (typeof globalThis !== "undefined") globalThis.__hbFetch = _singleton.diag;
    } catch (_) { /* diag must never break boot */ }
  }
  return _singleton;
}

/** Test-only: drop the singleton so suites can re-create with fresh deps. */
export function _resetPackFetchControllerForTest() {
  _singleton = null;
}
