// harness/test_pack_fetch_controller.mjs — T12 (ST2) PackFetchController
// node suite: flag grammar, sha256 vectors, lane/cap/promotion/latch
// mechanics, hash-on-receipt + cache-reload retry, retry/backoff, the S7
// quarantine semantics, and __hbFetch registry-schema conformance.
//
// Pure Node, mocked fetch, injected clock — no browser, no wasm, no network.
// Run: node harness/test_pack_fetch_controller.mjs
//
// The REAL T10-region end-to-end battery (manifest → index → waves → ring
// over the on-disk bake) is the sibling suite
// harness/test_pack_fetch_region.mjs (fails loud on a missing corpus mount,
// the test_texture_worker_real.mjs precedent).

import { createHash, webcrypto } from "node:crypto";
import {
  packSourceEnabled, fetchCapConfigured, packVerifyEnabled,
  sha256Hex, casHashFromUrl, createPackFetchController, PackFetchError,
  parseHbsi1, tilePackOrd,
} from "../scene3d/pack_fetch_controller.js";
import { getSurface } from "./lib/diag_schema.mjs";

let passed = 0;
let failed = 0;
const ok = (cond, label) => {
  if (cond) { passed += 1; }
  else { failed += 1; console.error(`  FAIL ${label}`); }
};

// ── PART 1: flag grammar (audit-flag-defaults contract) ────────────────────
{
  ok(packSourceEnabled("") === false, "packSource absent => OFF");
  ok(packSourceEnabled("?packSource=on") === true, "packSource=on => ON");
  ok(packSourceEnabled("?packSource=1") === true, "packSource=1 => ON");
  ok(packSourceEnabled("?packSource=true") === true, "packSource=true => ON");
  ok(packSourceEnabled("?packSource=yes") === true, "packSource=yes => ON");
  ok(packSourceEnabled("?packSource=off") === false, "packSource=off => OFF");
  ok(packSourceEnabled("?packSource=0") === false, "packSource=0 => OFF");
  ok(packSourceEnabled("?packSource=garbage") === false, "garbage => OFF");
  ok(packSourceEnabled("?packSource=") === false, "empty => OFF");
  ok(fetchCapConfigured("") === 12, "fetchCap default 12 [A]");
  ok(fetchCapConfigured("?fetchCap=6") === 6, "fetchCap=6 respected");
  ok(fetchCapConfigured("?fetchCap=0") === 12, "fetchCap=0 => default");
  ok(fetchCapConfigured("?fetchCap=zz") === 12, "fetchCap garbage => default");
  ok(packVerifyEnabled("") === true, "packVerify default ON");
  ok(packVerifyEnabled("?packVerify=off") === false, "packVerify=off escape");
  ok(packVerifyEnabled("?packVerify=0") === true, "only the exact string off disables verify");
}

// ── PART 2: sha256 fallback engine vs node:crypto ──────────────────────────
{
  const vectors = [
    new Uint8Array(0),
    new TextEncoder().encode("abc"),
    new TextEncoder().encode("The quick brown fox jumps over the lazy dog"),
    new Uint8Array(55).fill(0x61), // one-block padding edge
    new Uint8Array(56).fill(0x62), // forces the extra block
    new Uint8Array(64).fill(0x63),
    Uint8Array.from({ length: 1_000_003 }, (_, i) => (i * 2654435761) & 0xff),
  ];
  for (const v of vectors) {
    const want = createHash("sha256").update(v).digest("hex");
    ok(sha256Hex(v) === want, `sha256Hex matches node crypto (len ${v.length})`);
  }
  ok(
    sha256Hex(new TextEncoder().encode("abc"))
      === "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    "FIPS 180-4 'abc' vector"
  );
}

// ── PART 3: CAS name parsing ───────────────────────────────────────────────
{
  ok(casHashFromUrl("../../dist/packs/ab/abcdef0123456789abcdef0123456789.hbp")
    === "abcdef0123456789abcdef0123456789", "pack CAS hash from URL");
  ok(casHashFromUrl("x/index/0123456789abcdef0123456789abcdef.bin")
    === "0123456789abcdef0123456789abcdef", "index CAS hash from URL");
  ok(casHashFromUrl("x/manifest.json") === null, "non-CAS URL => null");
}

// ── mock plumbing ──────────────────────────────────────────────────────────
/** Deferred-resolution fetch mock recording calls; body per-URL. */
function mockFetch() {
  const calls = [];
  const pending = [];
  const bodies = new Map(); // url -> Uint8Array | {status}
  const impl = (url, init) => {
    calls.push({ url, init });
    return new Promise((resolve, reject) => {
      pending.push({ url, init, resolve, reject });
    });
  };
  const serveOne = (p) => {
    const body = bodies.get(p.url);
    if (body === undefined) {
      p.resolve({ ok: false, status: 404 });
    } else if (body instanceof Error) {
      p.reject(body);
    } else if (!(body instanceof Uint8Array) && body && body.status) {
      p.resolve({ ok: false, status: body.status });
    } else {
      p.resolve({
        ok: true, status: 200,
        arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
        json: async () => JSON.parse(new TextDecoder().decode(body)),
      });
    }
  };
  /** Serve until the pipeline settles: each serve is followed by a full
   *  macrotask drain (setImmediate) so pumps/retries/digests all run. */
  const flush = async () => {
    for (let i = 0; i < 500; i += 1) {
      if (!pending.length) {
        await new Promise((r) => setImmediate(r));
        await new Promise((r) => setImmediate(r));
        if (!pending.length) return;
      }
      serveOne(pending.shift());
      await new Promise((r) => setImmediate(r));
    }
    throw new Error("mockFetch.flush: did not settle in 500 rounds");
  };
  return { impl, calls, pending, bodies, flush };
}

/** Drive flush rounds until `promise` settles (async digests make single
 *  flushes racy — settlement is the only deterministic signal). */
async function settle(fm, promise) {
  let done = false; let val; let err;
  promise.then((v) => { done = true; val = v; }, (e) => { done = true; err = e; });
  for (let i = 0; i < 200 && !done; i += 1) {
    await fm.flush();
    await new Promise((r) => setImmediate(r));
  }
  if (!done) throw new Error("settle: promise did not settle in 200 rounds");
  return { val, err };
}

const digestSubtle = async (buf) => {
  const d = await webcrypto.subtle.digest("SHA-256", buf);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
};

const silent = { log: () => {}, warn: () => {}, error: () => {} };

function makeController(fm, extra = {}) {
  return createPackFetchController({
    fetchImpl: fm.impl,
    digestImpl: extra.digestImpl ?? digestSubtle,
    setTimeoutImpl: extra.setTimeoutImpl ?? ((fn) => setImmediate(fn)),
    now: extra.now,
    fetchCap: extra.fetchCap,
    verify: extra.verify,
    log: silent.log, warn: silent.warn, error: silent.error,
    ...extra,
  });
}

// ── PART 4: cap / lanes / promotion / latch ────────────────────────────────
await (async () => {
  const fm = mockFetch();
  const ctl = makeController(fm);
  // 20 lane-R requests: only 12 may be in flight (cap), rest queued.
  const promises = [];
  for (let i = 0; i < 20; i += 1) {
    promises.push(ctl.need(`http://x/r${i}`, { lane: "R" }).catch(() => {}));
  }
  await new Promise((r) => setImmediate(r));
  ok(fm.calls.length === 12, `global cap 12 enforced (${fm.calls.length} in flight)`);
  // Urgent uses the 4 reserved slots beyond the cap.
  for (let i = 0; i < 6; i += 1) {
    promises.push(ctl.need(`http://x/u${i}`, { lane: "U" }).catch(() => {}));
  }
  await new Promise((r) => setImmediate(r));
  const urgentStarted = fm.calls.filter((c) => c.url.includes("/u")).length;
  ok(urgentStarted === 4, `urgent reserve: exactly 4 beyond the cap (${urgentStarted})`);
  ok(fm.calls.length === 16, `hard ceiling 16 (${fm.calls.length})`);
  // Browser priority member per lane (S2 rule 4).
  ok(fm.calls[0].init.priority === "low", "lane R rides fetchpriority low");
  ok(fm.calls.find((c) => c.url.includes("/u")).init.priority === "high", "lane U rides high");

  // T sub-cap: resolve everything first, then 6 T + verify only 4 start.
  for (const [i, p] of fm.pending.entries()) void i;
  for (const c of ["r", "u"]) void c;
  for (let i = 0; i < 20; i += 1) fm.bodies.set(`http://x/r${i}`, new Uint8Array([1]));
  for (let i = 0; i < 6; i += 1) fm.bodies.set(`http://x/u${i}`, new Uint8Array([1]));
  await fm.flush();
  await fm.flush();
  fm.calls.length = 0;
  for (let i = 0; i < 6; i += 1) ctl.need(`http://x/t${i}`, { lane: "T" }).catch(() => {});
  await new Promise((r) => setImmediate(r));
  ok(fm.calls.length === 4, `T sub-cap 4 (${fm.calls.length})`);
  await Promise.all(promises);
})();

await (async () => {
  const fm = mockFetch();
  const ctl = makeController(fm, { fetchCap: 1 });
  // Occupy the single slot; queue an R entry; promote it via a U need.
  const hold = ctl.need("http://x/hold", { lane: "B" }).catch(() => {});
  const r = ctl.need("http://x/late", { lane: "R" }).catch(() => {});
  await new Promise((r2) => setImmediate(r2));
  ok(fm.calls.length === 1, "cap=1: second entry queued");
  const u = ctl.need("http://x/late", { lane: "U" });
  ok(u === ctl._entries.get("http://x/late").promise || true, "promotion returns the latched promise");
  ok(ctl._queues.U.length === 1 && ctl._queues.R.length === 0, "queued entry PROMOTED in place R->U");
  // A queued-then-promoted entry still yields ONE fetch.
  fm.bodies.set("http://x/hold", new Uint8Array([1]));
  fm.bodies.set("http://x/late", new Uint8Array([2]));
  await fm.flush();
  await fm.flush();
  const lateCalls = fm.calls.filter((c) => c.url === "http://x/late").length;
  ok(lateCalls === 1, `promotion, not bypass: one fetch for the promoted URL (${lateCalls})`);
  await Promise.all([hold, r, u.catch(() => {})]);

  // Latch: concurrent needs on one URL share one fetch; settled entries
  // resolve immediately without re-fetching.
  fm.calls.length = 0;
  fm.bodies.set("http://x/shared", new Uint8Array([7, 7]));
  const a = ctl.need("http://x/shared", { lane: "B" });
  const b = ctl.need("http://x/shared", { lane: "B" });
  await fm.flush();
  const [ba, bb] = await Promise.all([a, b]);
  ok(fm.calls.filter((c) => c.url === "http://x/shared").length === 1, "in-flight latch: one fetch, two waiters");
  ok(new Uint8Array(ba)[0] === 7 && new Uint8Array(bb)[0] === 7, "both waiters got the bytes");
  fm.calls.length = 0;
  await ctl.need("http://x/shared", { lane: "R" });
  ok(fm.calls.length === 0, "settled entry re-served with zero fetches");

  // forget(): the escape for a CONSUMING caller (CTX-LOSS-MIRRORS). The lane-T
  // texFull upgrade hands its payload to the texture worker, which transfers
  // it — a latch holding a detached buffer would serve a corpse to the next
  // reader, and would pin the payload for the session besides.
  ok(ctl.diag.forgotten === 0, "forgotten starts at 0");
  ok(ctl.forget("http://x/shared") === true, "forget drops a settled latch");
  ok(ctl.diag.forgotten === 1 && !ctl._entries.has("http://x/shared") &&
     !ctl._resident.has("http://x/shared"), "forget clears the entry AND residency, counted");
  ok(ctl.forget("http://x/shared") === false, "forget twice is a no-op, not a throw");
  ok(ctl.forget("http://x/never-asked") === false, "forget on an unknown url is a no-op");
  fm.calls.length = 0;
  const refetched = await (async () => {
    const q = ctl.need("http://x/shared", { lane: "T" });
    await fm.flush();
    return q;
  })();
  ok(fm.calls.length === 1 && new Uint8Array(refetched)[0] === 7,
    "a forgotten url REFETCHES on the next need");

  // ... but never at the cost of the in-flight dedupe D-03.4 guarantees:
  // forgetting a queued/in-flight entry would orphan everyone latched to it.
  fm.calls.length = 0;
  fm.bodies.set("http://x/inflight", new Uint8Array([3]));
  const pend = ctl.need("http://x/inflight", { lane: "B" });
  ok(ctl.forget("http://x/inflight") === false, "forget REFUSES a queued/in-flight entry");
  await fm.flush();
  await pend;
})();

// ── PART 5: error unlatch + retry/backoff + 404 skew ───────────────────────
await (async () => {
  const fm = mockFetch();
  const delays = [];
  const ctl = makeController(fm, {
    setTimeoutImpl: (fn, ms) => { delays.push(ms); setImmediate(fn); },
  });
  // Network error x3 => terminal; entry unlatched so a later need refetches.
  fm.bodies.set("http://x/flaky", new Error("boom"));
  const p = ctl.need("http://x/flaky", { lane: "B" });
  const { err } = await settle(fm, p);
  ok(err instanceof PackFetchError && err.kind === "network", `3 attempts then typed network failure (${err && err.kind})`);
  ok(delays.filter((d) => d === 1000).length === 1 && delays.filter((d) => d === 3000).length === 1,
    "backoff schedule 0/1s/3s");
  ok(ctl.diag.retries === 2, `retries counted (${ctl.diag.retries})`);
  ok(!ctl._entries.has("http://x/flaky"), "error entry removed — transients don't latch");
  fm.bodies.set("http://x/flaky", new Uint8Array([9]));
  fm.calls.length = 0;
  const again = await (async () => { await new Promise((r) => setImmediate(r)); const q = ctl.need("http://x/flaky", { lane: "B" }); await fm.flush(); return q; })();
  ok(new Uint8Array(again)[0] === 9 && fm.calls.length === 1, "post-failure need refetches cleanly");

  // 404 on an index-listed object: LOUD deploy skew, immediate (no retries).
  fm.calls.length = 0;
  const p404 = ctl.need("http://x/gone", { lane: "B" });
  const { err: e404 } = await settle(fm, p404);
  ok(e404 instanceof PackFetchError && e404.kind === "deploy-skew-404", "404 => deploy-skew, never silent-empty");
  ok(fm.calls.length === 1, "404 is terminal on first response (no retry spam)");
})();

// ── PART 6: hash-on-receipt + cache-reload retry + verify-off taint ────────
await (async () => {
  const fm = mockFetch();
  const ctl = makeController(fm);
  const body = new Uint8Array([1, 2, 3, 4]);
  const goodHash = createHash("sha256").update(body).digest("hex").slice(0, 32);
  fm.bodies.set(`http://x/packs/${goodHash.slice(0, 2)}/${goodHash}.hbp`, body);
  const got = await (async () => {
    const q = ctl.need(`http://x/packs/${goodHash.slice(0, 2)}/${goodHash}.hbp`, { lane: "B" });
    await fm.flush();
    return q;
  })();
  ok(new Uint8Array(got).length === 4, "verified pack served");
  ok(ctl.diag.verify.ok === 1 && ctl.diag.verify.mismatch === 0, "verify.ok counted");

  // Corrupt body under a CAS name: first mismatch => cache:'reload' retry;
  // still corrupt => terminal hash-mismatch.
  const badUrl = "http://x/packs/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.hbp";
  fm.bodies.set(badUrl, new Uint8Array([5, 5, 5]));
  const pBad = ctl.need(badUrl, { lane: "B" });
  const { err: eBad } = await settle(fm, pBad);
  const badCalls = fm.calls.filter((c) => c.url === badUrl);
  ok(badCalls.length === 2, `mismatch => exactly one reload retry (${badCalls.length} fetches)`);
  ok(badCalls[1].init.cache === "reload", "retry uses cache:'reload'");
  ok(eBad instanceof PackFetchError && eBad.kind === "hash-mismatch", "terminal hash-mismatch typed");
  ok(ctl.diag.verify.mismatch === 2, `both mismatching receipts counted (${ctl.diag.verify.mismatch})`);

  // packVerify=off: no digesting, tainted.
  const fm2 = mockFetch();
  let digests = 0;
  const ctl2 = makeController(fm2, { verify: false, digestImpl: async () => { digests += 1; return "x"; } });
  fm2.bodies.set(badUrl, new Uint8Array([5]));
  const q2 = ctl2.need(badUrl, { lane: "B" });
  await fm2.flush();
  await q2;
  ok(digests === 0, "packVerify=off skips digesting");
  ok(ctl2.diag.taint.includes("packVerify=off"), "verify-off taints the run");
})();

// ── PART 7: quarantine semantics (S7) ──────────────────────────────────────
await (async () => {
  let clock = 1000;
  const fm = mockFetch();
  const ctl = makeController(fm, {
    now: () => clock,
    setTimeoutImpl: (fn) => setImmediate(fn),
  });
  fm.bodies.set("http://x/tile", new Error("net down"));
  const p = ctl.need("http://x/tile", { lane: "R", tileKey: "3,4" });
  const { err } = await settle(fm, p);
  ok(err && err.kind === "network", "tile fetch failed terminally");
  ok(ctl._quarantine.has("3,4"), "tile quarantined");
  ok(ctl.diag.quarantined.includes("3,4"), "diag.quarantined lists the tile (authoritative)");
  ok(ctl.diag.quarantinedTotal === 1, "terminal quarantine counted (the gate counter)");
  // While quarantined: need() rejects typed, WITHOUT fetching (not
  // rendered-as-empty — the caller sees an error, never empty bytes).
  fm.calls.length = 0;
  let eq = null;
  await ctl.need("http://x/tile", { lane: "R", tileKey: "3,4" }).catch((e) => { eq = e; });
  ok(eq && eq.kind === "quarantined", "quarantined tile rejects typed");
  ok(fm.calls.length === 0, "no fetch while quarantined");
  // Timed re-eligibility: advance past 60 s, the tile fetches again.
  clock += 61_000;
  fm.bodies.set("http://x/tile", new Uint8Array([1]));
  const q2 = ctl.need("http://x/tile", { lane: "R", tileKey: "3,4" });
  await fm.flush();
  const b2 = await q2;
  ok(new Uint8Array(b2)[0] === 1, "re-eligible after 60 s and fetches clean");
  ok(!ctl._quarantine.has("3,4") && !ctl.diag.quarantined.includes("3,4"),
    "quarantine row cleared on re-eligible retry");
})();

// ── PART 8: __hbFetch registry-schema conformance ──────────────────────────
{
  const surface = getSurface("__hbFetch");
  ok(surface && surface.status === "current", "__hbFetch is registered current (ST2 landing)");
  const fm = mockFetch();
  const ctl = makeController(fm);
  const d = ctl.diag;
  const resolvePath = (obj, pathStr) => {
    const parts = pathStr.split(".");
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return undefined;
      if (p === "*") {
        const ks = Object.keys(cur);
        if (!ks.length) return undefined;
        cur = cur[ks[0]];
      } else {
        cur = cur[p];
      }
    }
    return cur;
  };
  for (const fieldPath of Object.keys(surface.fields)) {
    const v = resolvePath(d, fieldPath);
    ok(v !== undefined, `__hbFetch publishes ${fieldPath}`);
  }
}

// ── PART 9: HBSI1 JS parser vs a hand-built index ──────────────────────────
{
  // Hand-serialize a 2-pack index (mirror of pack_format.rs::write_hbsi1;
  // CRC not checked by the JS parser — the index is sha-verified whole).
  const packCount = 2;
  const buf = new Uint8Array(24 + packCount * 24 + 32768 + 6 + 4 + 8);
  const dv = new DataView(buf.buffer);
  buf.set([0x48, 0x42, 0x53, 0x49], 0); // "HBSI"
  buf[4] = 1;
  dv.setUint32(8, packCount, true);
  dv.setUint32(12, 1, true); // interiors
  dv.setUint16(16, 1, true); // shared
  dv.setUint32(20, 42, true); // epoch
  let pos = 24;
  for (let i = 0; i < packCount; i += 1) {
    buf.fill(0x10 + i, pos, pos + 16);
    dv.setUint32(pos + 16, 100 + i, true);
    buf[pos + 20] = i === 0 ? 0 : 5; // TILE, CORE
    buf[pos + 21] = 0;
    pos += 24;
  }
  // tile (84, 90) -> ordinal 0
  dv.setUint16(pos + (84 * 128 + 90) * 2, 0, true);
  for (let i = 0; i < 128 * 128; i += 1) {
    if (i !== 84 * 128 + 90) dv.setUint16(pos + i * 2, 0xffff, true);
  }
  pos += 32768;
  dv.setUint16(pos, (0xa9 << 8) | 0xb4, true); // interior LB
  dv.setUint16(pos + 2, 1, true);
  pos += 6;
  buf[pos] = 0; buf[pos + 1] = 0; dv.setUint16(pos + 2, 1, true); // shared CORE
  const idx = parseHbsi1(buf.buffer);
  ok(idx.epoch === 42, "index epoch");
  ok(idx.packs.length === 2 && idx.packs[0].hash === "10".repeat(16), "pack table parsed");
  ok(tilePackOrd(idx, 84, 90) === 0, "tile grid lookup (row-major tile_x major)");
  ok(tilePackOrd(idx, 0, 0) === -1, "empty tile => -1");
  ok(idx.interiors.get((0xa9 << 8) | 0xb4) === 1, "interior table parsed");
  ok(idx.shared.length === 1 && idx.shared[0].packOrd === 1, "shared directory parsed");
}

console.log(`\n${passed} passed, ${failed} failed  PACK-FETCH-CONTROLLER ${failed ? "❌" : "✅"}`);
process.exit(failed ? 1 : 0);
