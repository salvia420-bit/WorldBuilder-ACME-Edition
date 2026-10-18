// tests/net_worker_superseded.test.mjs — RUSTNET-1 (2026-10-18 review).
//
// A `?netWorker` connect attempt that a newer Connect supersedes while it
// waits for its worker's `{t:'ready'}` used to sit out the 12 s ready timeout
// and then fall back to a DIRECT main-thread login for the same account,
// behind the newer session; ACE (account_login_boots_in_use) then booted
// both. The superseded attempt must now reject at once with
// `err.superseded === true` and never call start_session, while a genuine
// init failure of the CURRENT worker keeps its direct fallback.
//
//   S1 double Connect: attempt 1 rejects superseded immediately, start_session
//      runs once (attempt 2, armed), attempt 1's worker is terminated
//   S2 superseded while the main-thread init() is still pending: no worker
//      is spawned for the stale attempt
//   S3 the current worker's init error still falls back to direct()
//
// The module is loaded from source with its pkg/ import replaced by stubs
// (no wasm, no Worker, no browser).
//
// Run: node tests/net_worker_superseded.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");

let loadSeq = 0;
/** Fresh module instance per test (module state is per instance). */
async function loadClient(stubKey) {
  let code = src("../scene3d/net_worker_client.js");
  const importRe = /import\s+init\s*,\s*\{([^}]*)\}\s*from\s*"\.\.\/pkg\/holtburger_web\.js[^"]*";/;
  const m = code.match(importRe);
  assert.ok(m, "pkg import found");
  const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  code = code.replace(importRe, `const { init, ${names.join(", ")} } = globalThis[${JSON.stringify(stubKey)}];`);
  code = code.replaceAll("import.meta.url", JSON.stringify("file:///hb/apps/holtburger-web/scene3d/net_worker_client.js"));
  code += `\n// load ${++loadSeq}\n`;
  return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

const tick = () => new Promise((r) => setTimeout(r, 0));

/** Worker fake that answers `ready` only when told to. */
function makeWorkerClass() {
  class FakeWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      this.terminated = false;
      this.posted = [];
      FakeWorker.all.push(this);
    }
    postMessage(msg) {
      this.posted.push(msg);
    }
    terminate() {
      this.terminated = true;
    }
    answer(data) {
      if (this.onmessage) this.onmessage({ data });
    }
  }
  FakeWorker.all = [];
  return FakeWorker;
}

function makeStubs(log, initGate = null) {
  return {
    init: async () => {
      if (initGate) await initGate.promise;
    },
    start_session: async (...args) => {
      log.push({ call: "start_session", armed: log.armed === true, args });
      log.armed = false;
      return { free() {} };
    },
    net_worker_arm: () => {
      log.armed = true;
    },
    net_proxy_push_inbound: () => {},
    net_proxy_push_disconnect: () => {},
    net_proxy_push_timesync: () => {},
  };
}

async function withEnv(FakeWorker, stubs, fn) {
  const prevWorker = globalThis.Worker;
  const key = `__nwSupersedeStubs${loadSeq + 1}`;
  globalThis.Worker = FakeWorker;
  globalThis[key] = stubs;
  const prevWarn = console.warn;
  const prevLog = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    const mod = await loadClient(key);
    await fn(mod);
  } finally {
    console.warn = prevWarn;
    console.log = prevLog;
    globalThis.Worker = prevWorker;
    delete globalThis[key];
  }
}

test("S1 a superseded attempt rejects at once and never logs in directly", async () => {
  const FakeWorker = makeWorkerClass();
  const log = [];
  await withEnv(FakeWorker, makeStubs(log), async (mod) => {
    const t0 = Date.now();
    const a1 = mod.startNetWorkerSession("ws://bridge/", "127.0.0.1", 9000, "acct", "pw");
    let a1Err = null;
    const a1Settled = a1.then(() => null, (e) => (a1Err = e));
    await tick();
    assert.equal(FakeWorker.all.length, 1, "attempt 1 spawned its worker and is waiting for ready");

    // Second Connect while attempt 1 waits.
    const a2 = mod.startNetWorkerSession("ws://bridge/", "127.0.0.1", 9000, "acct", "pw");
    await a1Settled;
    assert.ok(a1Err, "attempt 1 rejected");
    assert.equal(a1Err.superseded, true, "rejection is marked superseded");
    assert.ok(Date.now() - t0 < 2000, "no 12 s ready-timeout wait");
    assert.equal(FakeWorker.all[0].terminated, true, "attempt 1's worker terminated");

    await tick();
    assert.equal(FakeWorker.all.length, 2, "attempt 2 spawned its own worker");
    FakeWorker.all[1].answer({ t: "ready" });
    const handle = await a2;
    assert.ok(handle, "attempt 2 resolved a handle");
    assert.equal(log.length, 1, "start_session called exactly once");
    assert.equal(log[0].armed, true, "and through the armed worker proxy, not direct()");
    assert.equal(FakeWorker.all[1].posted[0]?.t, "connect");
  });
});

test("S2 superseded during the main-thread init(): no worker for the stale attempt", async () => {
  const FakeWorker = makeWorkerClass();
  const log = [];
  let release;
  const gate = { promise: new Promise((r) => (release = r)) };
  await withEnv(FakeWorker, makeStubs(log, gate), async (mod) => {
    const a1 = mod.startNetWorkerSession("ws://bridge/", "127.0.0.1", 9000, "acct", "pw");
    let a1Err = null;
    const a1Settled = a1.then(() => null, (e) => (a1Err = e));
    const a2 = mod.startNetWorkerSession("ws://bridge/", "127.0.0.1", 9000, "acct", "pw");
    release();
    await a1Settled;
    assert.equal(a1Err?.superseded, true, "attempt 1 rejected superseded");
    await tick();
    assert.equal(FakeWorker.all.length, 1, "only attempt 2 spawned a worker");
    FakeWorker.all[0].answer({ t: "ready" });
    await a2;
    assert.equal(log.length, 1);
    assert.equal(log[0].armed, true);
  });
});

test("S3 the current worker's init error still falls back to direct()", async () => {
  const FakeWorker = makeWorkerClass();
  const log = [];
  await withEnv(FakeWorker, makeStubs(log), async (mod) => {
    const a1 = mod.startNetWorkerSession("ws://bridge/", "127.0.0.1", 9000, "acct", "pw");
    await tick();
    FakeWorker.all[0].answer({ t: "error", reason: "wasm init failed" });
    const handle = await a1;
    assert.ok(handle, "direct fallback resolved a handle");
    assert.equal(log.length, 1, "start_session called once");
    assert.equal(log[0].armed, false, "unarmed: the direct main-thread path");
    assert.equal(FakeWorker.all[0].terminated, true, "the failed worker was terminated");
  });
});
