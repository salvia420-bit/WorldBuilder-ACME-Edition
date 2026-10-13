// tests/net_worker_disconnect_kind.test.mjs — net-transport-2 (2026-10-13).
//
// In `?netWorker` mode (automatic for `?bot=1` / `?agent=1`) the worker owns
// the WebSocket, so `SessionHandle.disconnect()` used to send nothing and ACE
// held the session for its 60 s timeout. The main-thread proxy now posts
// TX_KIND_DISCONNECT (2, no bytes) and the worker runs
// `Session::send_disconnect` (Rust: src/net_worker_outbound.rs, with native
// unit tests on a real `Session`; the bridge's own teardown Disconnect is in
// apps/holtburger-wsbridge/src/disconnect.rs).
//
// The two JS hops between them carry no kind table of their own: this pins
// that they forward an outbound `kind` as is, so the new kind reaches the
// worker's wasm.
//
//   K1 the Rust kind tags: ACTION 0, MESSAGE 1, DISCONNECT 2, distinct, < 256
//   K2 net_worker_client.js outbound sink: kind 2 + empty bytes -> worker.postMessage({t:'tx', kind:2})
//   K3 net_worker.js: {t:'tx', kind:2} -> net_worker_submit_outbound(2, bytes); kinds 0/1 unchanged
//
// Both modules are loaded from source with their pkg/ import replaced by
// stubs (no wasm, no Worker, no browser).
//
// Run: node tests/net_worker_disconnect_kind.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");

/** Load an ES module from source with its `../pkg/holtburger_web.js` import
 * swapped for `globalThis[stubKey]` and `import.meta.url` pinned. */
async function loadWithStubs(rel, stubKey) {
  let code = src(rel);
  const importRe = /import\s+init\s*,\s*\{([^}]*)\}\s*from\s*"\.\.\/pkg\/holtburger_web\.js[^"]*";/;
  const m = code.match(importRe);
  assert.ok(m, `${rel}: pkg import found`);
  const names = m[1].split(",").map((s) => s.trim()).filter(Boolean);
  code = code.replace(
    importRe,
    `const { init, ${names.join(", ")} } = globalThis[${JSON.stringify(stubKey)}];`,
  );
  code = code.replaceAll("import.meta.url", JSON.stringify(`file:///hb/apps/holtburger-web/${rel.replace(/^\.\.\//, "")}`));
  const url = "data:text/javascript;base64," + Buffer.from(code).toString("base64");
  return import(url);
}

const tick = () => new Promise((r) => setTimeout(r, 0));

test("K1 the Rust outbound kind tags", () => {
  const rs = src("../src/net_worker_outbound.rs");
  const kind = (name) => {
    const m = rs.match(new RegExp(`pub const ${name}: u8 = (\\d+);`));
    assert.ok(m, `${name} defined`);
    return Number(m[1]);
  };
  const action = kind("TX_KIND_ACTION");
  const message = kind("TX_KIND_MESSAGE");
  const disconnect = kind("TX_KIND_DISCONNECT");
  assert.equal(action, 0);
  assert.equal(message, 1);
  assert.equal(disconnect, 2);
  for (const k of [action, message, disconnect]) assert.equal(k & 0xff, k, "survives the JS `& 0xff`");
  // The proxy posts it and the worker loop stops on it.
  const nw = src("../src/net_worker.rs");
  assert.match(nw, /self\.post\(TX_KIND_DISCONNECT, &\[\]\)/);
  assert.match(nw, /LoopSession::Proxy\(p\) => p\.send_disconnect\(\)\.await/);
  assert.match(nw, /Ok\(OutboundOutcome::Disconnected\) => \{[\s\S]{0,200}?return;/);
});

test("K2 net_worker_client.js posts kind 2 to the worker unchanged", async () => {
  const posted = [];
  let armedSink = null;
  class FakeWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      FakeWorker.last = this;
      // The real worker answers `ready` once its wasm is up.
      setTimeout(() => this.onmessage && this.onmessage({ data: { t: "ready" } }), 0);
    }
    postMessage(msg, transfer) {
      posted.push({ msg, transfer });
    }
    terminate() {}
  }
  const prevWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  globalThis.__nwClientStubs = {
    init: async () => {},
    start_session: async () => ({}),
    net_worker_arm: (sink) => {
      armedSink = sink;
    },
    net_proxy_push_inbound: () => {},
    net_proxy_push_disconnect: () => {},
    net_proxy_push_timesync: () => {},
  };
  try {
    const mod = await loadWithStubs("../scene3d/net_worker_client.js", "__nwClientStubs");
    const handle = await mod.startNetWorkerSession("ws://bridge/", "127.0.0.1", 9000, "acct", "pw");
    assert.ok(handle, "session handle returned");
    assert.equal(typeof armedSink, "function", "the proxy's outbound sink was armed");
    assert.equal(posted[0]?.msg?.t, "connect", "connect goes first");

    const bytes = new Uint8Array(0); // RemoteSessionProxy::send_disconnect posts no bytes
    armedSink(2, bytes);
    const tx = posted.at(-1);
    assert.deepEqual({ t: tx.msg.t, kind: tx.msg.kind }, { t: "tx", kind: 2 });
    assert.equal(tx.msg.bytes, bytes);
    assert.deepEqual(tx.transfer, [bytes.buffer]);
  } finally {
    globalThis.Worker = prevWorker;
    delete globalThis.__nwClientStubs;
  }
});

test("K3 net_worker.js hands kind 2 to the worker's wasm unchanged", async () => {
  const submitted = [];
  const runs = [];
  const fakeSelf = {
    onmessage: null,
    sent: [],
    postMessage(msg) {
      this.sent.push(msg);
    },
  };
  const prevSelf = globalThis.self;
  globalThis.self = fakeSelf;
  globalThis.__nwWorkerStubs = {
    init: async () => {},
    net_worker_run: (...args) => {
      runs.push(args);
    },
    net_worker_submit_outbound: (kind, bytes) => {
      submitted.push({ kind, bytes });
    },
    net_worker_set_sink: () => {},
    hb_mem_census: () => "{}",
  };
  try {
    await loadWithStubs("../scene3d/net_worker.js", "__nwWorkerStubs");
    for (let i = 0; i < 5 && !fakeSelf.sent.some((m) => m.t === "ready"); i++) await tick();
    assert.ok(fakeSelf.sent.some((m) => m.t === "ready"), "worker reported ready");

    fakeSelf.onmessage({
      data: { t: "connect", bridgeUrl: "ws://bridge/", host: "127.0.0.1", port: 9000, user: "a", pass: "p" },
    });
    assert.equal(runs.length, 1, "net_worker_run started");

    const empty = new Uint8Array(0);
    fakeSelf.onmessage({ data: { t: "tx", kind: 2, bytes: empty } });
    const action = new Uint8Array([1, 2, 3, 4]);
    fakeSelf.onmessage({ data: { t: "tx", kind: 0, bytes: action } });
    const message = new Uint8Array([5, 6, 7, 8]);
    fakeSelf.onmessage({ data: { t: "tx", kind: 1, bytes: message } });

    assert.deepEqual(
      submitted.map((s) => s.kind),
      [2, 0, 1],
    );
    assert.equal(submitted[0].bytes, empty);
    assert.equal(submitted[1].bytes, action);
    assert.equal(submitted[2].bytes, message);
    assert.ok(!fakeSelf.sent.some((m) => m.t === "error"), JSON.stringify(fakeSelf.sent));
  } finally {
    globalThis.self = prevSelf;
    delete globalThis.__nwWorkerStubs;
  }
});
