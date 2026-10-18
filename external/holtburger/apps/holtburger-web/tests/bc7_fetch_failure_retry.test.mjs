// tests/bc7_fetch_failure_retry.test.mjs — STREAM-TERRAIN-2 (2026-10-18 review).
//
// A FAILED HD record fetch (network blip, 5xx, sha mismatch) used to be cached
// as a permanent "absent" verdict, so the RenderSurface stayed at retail
// resolution for the rest of the session. The wasm exports (bc7_blocks /
// bc7_pre_blocks / xu7_blocks) now REJECT only for a failed fetch of a record
// that may exist and resolve EMPTY for proven absence; Bc7RecordSource keeps
// the failure's null verdict for BC7_FAIL_RETRY_MS (30 s) and then re-asks.
//
//   R1 full lane: a rejected fetch is a null verdict for 30 s (no re-hammer),
//      then known() clears and the next ask re-fetches and lands the record
//   R2 full lane: an EMPTY payload stays a permanent verdict (proven absent)
//   R3 pre lane: same split (rejection retried, empty permanent)
//   R4 twin lane (hbc7Fallback): a rejection is retried after 30 s, an empty
//      twin stays absent
//
// No GPU, no wasm: fetchImpl / preFetchImpl injected, HBC7 payloads
// synthesized, clock injected through the `now` seam.
//
// Run: node tests/bc7_fetch_failure_retry.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { Bc7RecordSource } from "../scene3d/bc7_textures.js";

const blocks = (n) => Math.ceil(n / 4);
function hbc7(w, h) {
  const total = 20 + blocks(w) * blocks(h) * 16;
  const buf = new Uint8Array(total);
  const dv = new DataView(buf.buffer);
  dv.setUint32(0, 0x37434248, true);
  dv.setUint32(4, w, true);
  dv.setUint32(8, h, true);
  dv.setUint32(12, blocks(w), true);
  dv.setUint32(16, blocks(h), true);
  return buf;
}

const RS = 0x06001234;

function quiet(fn) {
  return async () => {
    const warn = console.warn;
    console.warn = () => {};
    try {
      await fn();
    } finally {
      console.warn = warn;
    }
  };
}

/** A fetch fake: `plan` is consumed one entry per call ("fail" rejects,
 *  "empty" resolves an empty payload, "ok" resolves a valid HBC7). */
function planned(plan) {
  const f = (id) => {
    f.calls.push(id);
    const step = plan.shift() ?? "ok";
    if (step === "fail") return Promise.reject(new Error("holtburger/tex-bc7 fetch failed: HTTP 503"));
    if (step === "empty") return Promise.resolve(new Uint8Array(0));
    return Promise.resolve(hbc7(16, 16));
  };
  f.calls = [];
  return f;
}

test("R1 full lane: a failed fetch is retried after 30 s, not latched", quiet(async () => {
  let now = 1_000_000;
  const fetchImpl = planned(["fail", "ok"]);
  const src = new Bc7RecordSource({ fetchImpl, budgetBytes: Infinity, now: () => now });

  assert.equal(await src.getAsync(RS), null, "the failed fetch resolves null");
  assert.equal(src.known(RS), true, "a verdict for now (consumers use retail)");
  assert.equal(await src.getAsync(RS), null, "inside the window: still null");
  assert.equal(src.get(RS), null);
  assert.equal(fetchImpl.calls.length, 1, "no re-hammer inside the window");

  now += 29_999;
  assert.equal(src.known(RS), true, "29.999 s: still held");
  now += 1;
  assert.equal(src.known(RS), false, "30 s: the failure verdict expired");
  const parsed = await src.getAsync(RS);
  assert.ok(parsed && parsed.width === 16, "the retry landed the HD record");
  assert.equal(fetchImpl.calls.length, 2);
  assert.equal(src.known(RS), true);
  assert.equal(src._failedAt.size, 0, "failure bookkeeping cleared");
}));

test("R2 full lane: an empty payload stays a permanent absent verdict", quiet(async () => {
  let now = 1_000_000;
  const fetchImpl = planned(["empty", "ok"]);
  const src = new Bc7RecordSource({ fetchImpl, budgetBytes: Infinity, now: () => now });
  assert.equal(await src.getAsync(RS), null);
  now += 3_600_000;
  assert.equal(src.known(RS), true, "proven absence never expires");
  assert.equal(await src.getAsync(RS), null);
  assert.equal(fetchImpl.calls.length, 1, "absent is asked exactly once per session");
}));

test("R3 pre lane: rejection retried, empty permanent", quiet(async () => {
  let now = 1_000_000;
  const preFetchImpl = planned(["fail", "ok"]);
  const src = new Bc7RecordSource({ fetchImpl: planned([]), preFetchImpl, budgetBytes: Infinity, now: () => now });
  assert.equal(await src.getPreAsync(RS), null);
  assert.equal(await src.getPreAsync(RS), null);
  assert.equal(preFetchImpl.calls.length, 1, "held inside the window");
  now += 30_000;
  const pre = await src.getPreAsync(RS);
  assert.ok(pre && pre.width === 16, "the retry landed the pre record");
  assert.equal(preFetchImpl.calls.length, 2);

  const absentPre = planned(["empty", "ok"]);
  const src2 = new Bc7RecordSource({ fetchImpl: planned([]), preFetchImpl: absentPre, budgetBytes: Infinity, now: () => now });
  assert.equal(await src2.getPreAsync(RS), null);
  now += 3_600_000;
  assert.equal(await src2.getPreAsync(RS), null);
  assert.equal(absentPre.calls.length, 1, "an absent pre record is asked once");
}));

test("R4 twin lane: a failed hbc7Fallback is retried after 30 s", quiet(async () => {
  let now = 1_000_000;
  const fetchImpl = planned(["fail", "ok"]);
  const src = new Bc7RecordSource({ fetchImpl, budgetBytes: Infinity, now: () => now });
  assert.equal(await src.hbc7Fallback(RS), null);
  assert.equal(src._hbc7Absent.has(RS), false, "a failure is not an absent verdict");
  assert.equal(await src.hbc7Fallback(RS), null);
  assert.equal(fetchImpl.calls.length, 1, "held inside the window");
  now += 30_000;
  const twin = await src.hbc7Fallback(RS);
  assert.ok(twin && twin.width === 16, "the retry landed the twin");
  assert.equal(fetchImpl.calls.length, 2);

  const absent = planned(["empty", "ok"]);
  const src2 = new Bc7RecordSource({ fetchImpl: absent, budgetBytes: Infinity, now: () => now });
  assert.equal(await src2.hbc7Fallback(RS), null);
  assert.equal(src2._hbc7Absent.has(RS), true, "an empty twin is absent");
  now += 3_600_000;
  assert.equal(await src2.hbc7Fallback(RS), null);
  assert.equal(absent.calls.length, 1);
}));
