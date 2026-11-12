// tests/worker_panic_and_stall_recovery.test.mjs
//
// Test suite for WASM export manifest version, worker panic hooks,
// job timeouts, stall watchdogs, and recovery from wedged workers across
// bake_worker, net_worker, and texture_worker.
//
// Run: cd apps/holtburger-web && node tests/worker_panic_and_stall_recovery.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

let passed = 0;
let failed = 0;
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [OK] ${name}`);
  } catch (e) {
    failed += 1;
    console.log(`  [FAIL] ${name} — ${(e && e.stack) || e}`);
  }
}

// ---------------------------------------------------------------------------
// 1. WASM Export Manifest Version
// ---------------------------------------------------------------------------
await t("1.1 wasm_manifest_version.js exports EXPECTED_WASM_MANIFEST_VERSION === 7", async () => {
  const { EXPECTED_WASM_MANIFEST_VERSION } = await import("../scene3d/wasm_manifest_version.js");
  assert.equal(EXPECTED_WASM_MANIFEST_VERSION, 7);
});

await t("1.2 src/lib.rs defines WASM_EXPORT_MANIFEST_VERSION = 7 matching JS export", async () => {
  const { EXPECTED_WASM_MANIFEST_VERSION } = await import("../scene3d/wasm_manifest_version.js");
  const libRs = readFileSync(path.join(APP, "src/lib.rs"), "utf8");
  const m = libRs.match(/pub\s+const\s+WASM_EXPORT_MANIFEST_VERSION:\s*u32\s*=\s*(\d+);/);
  assert.ok(m, "WASM_EXPORT_MANIFEST_VERSION defined in src/lib.rs");
  assert.equal(Number(m[1]), EXPECTED_WASM_MANIFEST_VERSION);
});

// ---------------------------------------------------------------------------
// 2. Bake Worker Panic and Job Timeout Recovery
// ---------------------------------------------------------------------------
class MockWorker {
  constructor() {
    MockWorker.instances.push(this);
    this.posted = [];
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
  }
  postMessage(msg, transfers) {
    this.posted.push({ msg, transfers });
  }
  reply(data) {
    if (this.onmessage) this.onmessage({ data });
  }
  terminate() {
    this.terminated = true;
  }
}
MockWorker.instances = [];

await t("2.1 bake_worker_client exports BAKE_JOB_TIMEOUT_MS = 30000", async () => {
  const { BAKE_JOB_TIMEOUT_MS } = await import("../scene3d/bake_worker_client.js");
  assert.equal(BAKE_JOB_TIMEOUT_MS, 30000);
});

await t("2.2 bake_worker_client unhandled worker error triggers _failAll and worker termination", async () => {
  const savedWorker = globalThis.Worker;
  const savedWindow = globalThis.window;
  const savedLocation = globalThis.location;

  try {
    MockWorker.instances = [];
    globalThis.Worker = MockWorker;
    globalThis.window = {};
    globalThis.location = { search: "?bakeWorker=1", href: "http://localhost/" };

    const { BakeWorkerClient } = await import("../scene3d/bake_worker_client.js");
    const client = new BakeWorkerClient({
      manifestUrl: "manifest.json",
      sceneryBaseUrl: "scenery/",
    });

    const readyP = client._ensureWorker();
    const worker = MockWorker.instances[0];
    assert.ok(worker, "worker spawned");

    // Send init ready
    const initId = worker.posted[0]?.msg?.id ?? 1;
    worker.reply({ type: "ready", id: initId });
    await readyP;

    // Enqueue a request
    let rejected = false;
    let rejectErr = null;
    const reqP = client._request("fetchModelMeshes", { ids: [123] }).catch((e) => {
      rejected = true;
      rejectErr = e;
    });

    // Worker experiences uncaught panic/error without an id
    worker.reply({
      type: "error",
      id: null,
      message: "wasm panic: memory out of bounds",
    });

    await reqP;
    assert.ok(rejected, "pending request was rejected");
    assert.ok(
      String(rejectErr).includes("wasm panic: memory out of bounds"),
      `expected panic message in rejection: ${rejectErr}`,
    );
    assert.ok(worker.terminated, "worker was terminated after panic");
  } finally {
    globalThis.Worker = savedWorker;
    globalThis.window = savedWindow;
    globalThis.location = savedLocation;
  }
});

await t("2.3 bake_worker_client job timeout recovers wedged worker", async () => {
  const savedWorker = globalThis.Worker;
  const savedWindow = globalThis.window;
  const savedLocation = globalThis.location;
  const { BakeWorkerClient, _setBakeTimeoutForTest } = await import("../scene3d/bake_worker_client.js");

  try {
    MockWorker.instances = [];
    globalThis.Worker = MockWorker;
    globalThis.window = {};
    globalThis.location = { search: "?bakeWorker=1", href: "http://localhost/" };

    const client = new BakeWorkerClient({
      manifestUrl: "manifest.json",
      sceneryBaseUrl: "scenery/",
    });

    const readyP = client._ensureWorker();
    const worker = MockWorker.instances[0];
    const initId = worker.posted[0]?.msg?.id ?? 1;
    worker.reply({ type: "ready", id: initId });
    await readyP;

    // Fast-forward timeout: test with a short timeout by mocking timeout hook
    let timerCallback = null;
    _setBakeTimeoutForTest((cb, delay) => {
      if (delay === 30000) {
        timerCallback = cb;
        return 9999;
      }
      return setTimeout(cb, delay);
    });

    let rejected = false;
    let rejectErr = null;
    const reqP = client._request("fetchModelMeshes", { ids: [456] }).catch((e) => {
      rejected = true;
      rejectErr = e;
    });

    assert.ok(timerCallback, "job timeout was scheduled");
    // Fire the timeout callback simulating worker wedging
    timerCallback();

    await reqP;
    assert.ok(rejected, "job was rejected on timeout");
    assert.ok(
      String(rejectErr).includes("timed out / wedged"),
      `expected timeout message, got: ${rejectErr}`,
    );
    assert.ok(worker.terminated, "wedged worker was terminated on timeout");

    _setBakeTimeoutForTest(null);
  } finally {
    _setBakeTimeoutForTest(null);
    globalThis.Worker = savedWorker;
    globalThis.window = savedWindow;
    globalThis.location = savedLocation;
  }
});

// ---------------------------------------------------------------------------
// 3. Net Worker Batching, Stall Watchdog, and Logoff
// ---------------------------------------------------------------------------
async function loadNetWorkerClientWithStubs(stubKey) {
  let code = readFileSync(path.join(APP, "scene3d/net_worker_client.js"), "utf8");
  const importRe = /import\s+init\s*,\s*\{([^}]*)\}\s*from\s*"\.\.\/pkg\/holtburger_web\.js[^"]*";/;
  const m = code.match(importRe);
  assert.ok(m, "pkg import found");
  const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  code = code.replace(
    importRe,
    `const { init, ${names.join(", ")} } = globalThis[${JSON.stringify(stubKey)}];`,
  );
  code = code.replaceAll("import.meta.url", JSON.stringify("file:///hb/apps/holtburger-web/scene3d/net_worker_client.js"));
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(url);
}

await t("3.1 net_worker_client exports NET_WORKER_STALL_TIMEOUT_MS = 30000", async () => {
  globalThis.__nwStubs = {
    init: async () => {},
    start_session: async () => ({}),
    net_worker_arm: () => {},
    net_proxy_push_inbound: () => {},
    net_proxy_push_disconnect: () => {},
    net_proxy_push_timesync: () => {},
  };
  const { NET_WORKER_STALL_TIMEOUT_MS } = await loadNetWorkerClientWithStubs("__nwStubs");
  assert.equal(NET_WORKER_STALL_TIMEOUT_MS, 30000);
});

await t("3.2 net_worker.rs defines RX_KIND_BATCH = 4 and net_worker.js supports rx_batch", async () => {
  const netWorkerRs = readFileSync(path.join(APP, "src/net_worker.rs"), "utf8");
  assert.ok(
    netWorkerRs.includes("pub const RX_KIND_BATCH: u8 = 4;"),
    "RX_KIND_BATCH = 4 defined in net_worker.rs",
  );

  const netWorkerJs = readFileSync(path.join(APP, "scene3d/net_worker.js"), "utf8");
  assert.ok(netWorkerJs.includes("const RX_KIND_BATCH = 4;"), "RX_KIND_BATCH = 4 in net_worker.js");
  assert.ok(
    netWorkerJs.includes('{ t: "rx_batch", batch }, transfer)'),
    "net_worker.js posts rx_batch with transferred buffers",
  );

  const netWorkerClientJs = readFileSync(path.join(APP, "scene3d/net_worker_client.js"), "utf8");
  assert.ok(
    netWorkerClientJs.includes('m.t === "rx_batch"'),
    "net_worker_client.js handles rx_batch",
  );
});

await t("3.3 net_worker resets in_world on logoff (opcode 0xF653)", async () => {
  const netWorkerRs = readFileSync(path.join(APP, "src/net_worker.rs"), "utf8");
  assert.ok(
    netWorkerRs.includes("is_character_logoff_message"),
    "is_character_logoff_message helper present in net_worker.rs",
  );
  assert.ok(
    netWorkerRs.includes("in_world = false;") && netWorkerRs.includes("ping.note_entered_world();"),
    "in_world reset on logoff in net_worker.rs",
  );
});

await t("3.4 net_worker_client processes rx_batch and pushes every item to inbound", async () => {
  const pushed = [];
  globalThis.__nwBatchStubs = {
    init: async () => {},
    start_session: async () => ({}),
    net_worker_arm: () => {},
    net_proxy_push_inbound: (bytes) => pushed.push(bytes),
    net_proxy_push_disconnect: () => {},
    net_proxy_push_timesync: () => {},
  };
  const { startNetWorkerSession } = await loadNetWorkerClientWithStubs("__nwBatchStubs");

  const prevWorker = globalThis.Worker;
  let activeMockWorker = null;
  class NetMockWorker extends MockWorker {
    constructor() {
      super();
      activeMockWorker = this;
      setTimeout(() => this.reply({ t: "ready" }), 0);
    }
  }
  globalThis.Worker = NetMockWorker;

  try {
    const handle = await startNetWorkerSession("ws://bridge", "127.0.0.1", 9000, "user", "pass");
    assert.ok(activeMockWorker, "worker active");

    const item1 = new Uint8Array([1, 2, 3]);
    const item2 = new Uint8Array([4, 5, 6]);
    activeMockWorker.reply({ t: "rx_batch", batch: [item1, item2] });

    assert.equal(pushed.length, 2, "both messages in batch pushed");
    assert.deepEqual(pushed[0], item1);
    assert.deepEqual(pushed[1], item2);
  } finally {
    globalThis.Worker = prevWorker;
  }
});

await t("3.5 net_worker_client stall watchdog triggers disconnect when worker wedges", async () => {
  let disconnectReason = null;
  globalThis.__nwWatchdogStubs = {
    init: async () => {},
    start_session: async () => ({}),
    net_worker_arm: () => {},
    net_proxy_push_inbound: () => {},
    net_proxy_push_disconnect: (reason) => { disconnectReason = reason; },
    net_proxy_push_timesync: () => {},
  };
  const { startNetWorkerSession } = await loadNetWorkerClientWithStubs("__nwWatchdogStubs");

  const prevWorker = globalThis.Worker;
  let activeMockWorker = null;
  class NetMockWorker extends MockWorker {
    constructor() {
      super();
      activeMockWorker = this;
      setTimeout(() => this.reply({ t: "ready" }), 0);
    }
  }
  globalThis.Worker = NetMockWorker;

  const origSetTimeout = globalThis.setTimeout;
  let watchdogCb = null;
  globalThis.setTimeout = (cb, delay) => {
    if (delay === 30000) {
      watchdogCb = cb;
      return 6666;
    }
    return origSetTimeout(cb, delay);
  };

  try {
    const handle = await startNetWorkerSession("ws://bridge", "127.0.0.1", 9000, "user", "pass");
    assert.ok(watchdogCb, "stall watchdog timer installed");

    // Simulate 30s stall with worker wedged
    watchdogCb();

    assert.ok(
      disconnectReason && disconnectReason.includes("net worker wedged (stall timeout)"),
      `expected stall disconnect reason, got: ${disconnectReason}`,
    );
    assert.ok(activeMockWorker.terminated, "wedged worker terminated by watchdog");
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.Worker = prevWorker;
  }
});

// ---------------------------------------------------------------------------
// 4. Texture Worker Panic and Timeout Recovery
// ---------------------------------------------------------------------------
await t("4.1 xu7_textures exports TW_JOB_TIMEOUT_MS = 15000", async () => {
  const { TW_JOB_TIMEOUT_MS } = await import("../scene3d/xu7_textures.js");
  assert.equal(TW_JOB_TIMEOUT_MS, 15000);
});

await t("4.2 xu7_textures recovers when texture worker wedges on a job", async () => {
  const {
    _setTexWorkerFactoryForTest,
    _resetTexWorkerForTest,
    _texWorkerStateForTest,
    workerTerrainAssemble,
  } = await import("../scene3d/xu7_textures.js");

  _resetTexWorkerForTest();

  let mockWorker = null;
  _setTexWorkerFactoryForTest(() => {
    mockWorker = new MockWorker();
    return mockWorker;
  });

  // Fast-forward timeout
  const origSetTimeout = globalThis.setTimeout;
  let jobTimeoutCallback = null;
  globalThis.setTimeout = (cb, delay) => {
    if (delay === 15000) {
      jobTimeoutCallback = cb;
      return 8888;
    }
    return origSetTimeout(cb, delay);
  };

  try {
    // Initiate job
    const jobP = workerTerrainAssemble({
      tileSize: 256,
      levels: 1,
      depth: 1,
      layerRs: [1],
      payloads: [{ rs: 1, bytes: new ArrayBuffer(16) }],
    }).catch((e) => {
      return { caught: true, error: e };
    });

    // Make worker ready
    assert.ok(mockWorker, "mock texture worker created");
    mockWorker.reply({ type: "ready" });

    // Job is now submitted to the worker and in flight
    await new Promise((r) => origSetTimeout(r, 10));
    assert.ok(jobTimeoutCallback, "job timeout was installed");

    // Worker wedges! Fire the timeout
    jobTimeoutCallback();

    const res = await jobP;
    assert.ok(res && res.caught, "job rejected on wedged worker");
    assert.equal(_texWorkerStateForTest(), "dead", "state transitioned to dead");
    assert.ok(mockWorker.terminated, "texture worker was terminated");
  } finally {
    globalThis.setTimeout = origSetTimeout;
    _setTexWorkerFactoryForTest(null);
    _resetTexWorkerForTest();
  }
});

await t("4.3 xu7_textures transitions to dead when worker reports error", async () => {
  const {
    _setTexWorkerFactoryForTest,
    _resetTexWorkerForTest,
    _texWorkerStateForTest,
    workerTerrainAssemble,
  } = await import("../scene3d/xu7_textures.js");

  _resetTexWorkerForTest();

  let mockWorker = null;
  _setTexWorkerFactoryForTest(() => {
    mockWorker = new MockWorker();
    return mockWorker;
  });

  try {
    const jobP = workerTerrainAssemble({
      tileSize: 256,
      levels: 1,
      depth: 1,
      layerRs: [1],
      payloads: [{ rs: 1, bytes: new ArrayBuffer(16) }],
    }).catch((e) => {
      return { caught: true, error: e };
    });

    assert.ok(mockWorker);
    mockWorker.reply({ type: "ready" });
    await new Promise((r) => setTimeout(r, 10));

    // Worker posts error
    mockWorker.reply({ type: "error", err: "fatal panic in worker" });

    await jobP;
    assert.equal(_texWorkerStateForTest(), "dead", "state transitioned to dead on error");
    assert.ok(mockWorker.terminated, "worker terminated on error");
  } finally {
    _setTexWorkerFactoryForTest(null);
    _resetTexWorkerForTest();
  }
});

await t("4.4 cancelTextureWorkerJob clears job timeout", async () => {
  const {
    _setTexWorkerFactoryForTest,
    _resetTexWorkerForTest,
    cancelTextureWorkerJob,
    workerTerrainAssemble,
  } = await import("../scene3d/xu7_textures.js");

  _resetTexWorkerForTest();

  let mockWorker = null;
  _setTexWorkerFactoryForTest(() => {
    mockWorker = new MockWorker();
    return mockWorker;
  });

  let timeoutCleared = false;
  const origClearTimeout = globalThis.clearTimeout;
  globalThis.clearTimeout = (id) => {
    if (id === 7777) timeoutCleared = true;
    return origClearTimeout(id);
  };

  const origSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (cb, delay) => {
    if (delay === 15000) return 7777;
    return origSetTimeout(cb, delay);
  };

  try {
    workerTerrainAssemble({
      tileSize: 256,
      levels: 1,
      depth: 1,
      layerRs: [1],
      payloads: [{ rs: 1, bytes: new ArrayBuffer(16) }],
    }).catch(() => {});

    assert.ok(mockWorker);
    mockWorker.reply({ type: "ready" });
    await new Promise((r) => origSetTimeout(r, 10));

    const cancelled = cancelTextureWorkerJob(1);
    assert.ok(cancelled, "job cancelled");
    assert.ok(timeoutCleared, "job timeout was cleared on cancellation");
  } finally {
    globalThis.setTimeout = origSetTimeout;
    globalThis.clearTimeout = origClearTimeout;
    _setTexWorkerFactoryForTest(null);
    _resetTexWorkerForTest();
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
