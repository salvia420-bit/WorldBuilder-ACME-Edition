// tests/link_status_packet_loss.test.mjs — net-transport-6 (2026-10-13).
//
// Retail's Link Status panel (gmLinkStatusUI::Update, acclient.c:226356)
// shows a packet-loss figure — CLinkStatusAverages::GetAveragePacketLoss,
// 2 × (NAKed + retransmitted) / (received + sent) over 40 two-second
// snapshots — next to the ping. holtburger now counts packets in Rust
// (crates/holtburger-session/src/link_status.rs, native unit tests there) and
// shows the figure in the link indicator's tooltip. The ping RTT clock counts
// the in-world pings still out and stamps a send only when none is
// (src/ping_round_trip.rs, native unit tests); under `?netWorker` the worker
// measures both numbers and posts them.
//
// This pins the JS display layer and the two worker hops:
//
//   L1 tooltip detail line: "Ping · Packet loss N.NN% · last packet", unchanged without loss
//   L2 linkLossFact: no getter / junk / link never spoke -> no line
//   L3 linkTierFor unchanged for the existing inputs (the tier ignores loss)
//   L4 plugin wiring: pollLink reads sessionPacketLossPct behind a typeof guard
//   L5 Rust/JS kind tag: RX_KIND_LINK_STATUS = 3 in net_worker.rs and net_worker.js
//   L6 net_worker.js: kind 3 (u32 rtt + f32 loss) -> {t:'linkstatus', rttMs, loss}
//   L7 net_worker_client.js: {t:'linkstatus'} -> handle.netWorkerLinkStatus(rtt, loss), guarded
//   L8 the single overwritten ping slot is gone from every writer
//
// Run: node tests/link_status_packet_loss.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");

const { __test } = await import(new URL("../plugins/status-indicators.js", here).href);
const MAX = 0xFFFFFFFF;

/** Load an ES module from source with its `../pkg/holtburger_web.js` import
 * swapped for `globalThis[stubKey]` and `import.meta.url` pinned (same
 * loader as tests/net_worker_disconnect_kind.test.mjs). */
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

function linkStatusBytes(rttMs, loss) {
  const bytes = new Uint8Array(8);
  const dv = new DataView(bytes.buffer);
  dv.setUint32(0, rttMs >>> 0, true);
  dv.setFloat32(4, loss, true);
  return bytes;
}

test("L1 tooltip detail line carries the retail packet-loss figure", () => {
  const d = __test.linkTooltipDetail;
  assert.equal(typeof d, "function");
  assert.equal(
    d({ rttMs: 42.4, ageMs: 1234, lossPct: 0.0123 }),
    "Ping 42 ms · Packet loss 0.01% · last packet 1.2 s ago",
  );
  // Retail prints the doubled ratio unscaled with 2 decimals.
  assert.equal(d({ lossPct: 0.06 }), "Packet loss 0.06%");
  assert.equal(d({ ageMs: 500, lossPct: 0 }), "Packet loss 0.00% · last packet 0.5 s ago");
  // Without a loss fact the line is exactly the pre-change text.
  assert.equal(d({ rttMs: 88, ageMs: 2000, lossPct: null }), "Ping 88 ms · last packet 2.0 s ago");
  assert.equal(d({ rttMs: null, ageMs: null, lossPct: null }), "No data from the server yet.");
  assert.equal(d({}), "No data from the server yet.");
  assert.equal(d(), "No data from the server yet.");
});

test("L2 linkLossFact shows a figure only for a link that has spoken", () => {
  const f = __test.linkLossFact;
  assert.equal(typeof f, "function");
  assert.equal(f(null, 100), null, "no getter (stale pkg/)");
  assert.equal(f(undefined, 100), null);
  assert.equal(f(0, MAX), null, "nothing received yet: no 0.00% line");
  assert.equal(f(0.5, 0xFFFFFFF0), null, "LINK_NO_DATA band");
  assert.equal(f(Number.NaN, 100), null);
  assert.equal(f(Infinity, 100), null);
  assert.equal(f(-1, 100), null);
  assert.equal(f(0, 100), 0);
  assert.equal(f(0.0625, 0), 0.0625);
  assert.equal(f(2, 4999), 2, "the doubled ratio can exceed 1");
});

test("L3 linkTierFor is unchanged for the existing inputs", () => {
  const t = __test.linkTierFor;
  const cases = [
    [0, MAX, "good"],
    [5000, MAX, "good"],
    [5001, MAX, "uncertain"],
    [20000, MAX, "uncertain"],
    [20001, MAX, "bad"],
    [40000, MAX, "bad"],
    [40001, MAX, "disconnected"],
    [MAX, MAX, "disconnected"],
    [MAX, 50, "good"],
    [100, 50, "good"],
    [100, 1000, "good"],
    [100, 1500, "uncertain"],
    [100, 3000, "uncertain"],
    [100, 4000, "bad"],
    [25000, 20, "bad"],
  ];
  for (const [age, rtt, want] of cases) {
    assert.equal(t(age, rtt), want, `linkTierFor(${age}, ${rtt})`);
  }
  assert.equal(t(100, 1500, { middlingMs: 2000 }), "good", "legacy override");
  assert.equal(t.length, 2, "still (ageMs, rttMs, th = {}) — no loss input");
});

test("L4 the plugin polls sessionPacketLossPct behind a typeof guard", () => {
  const js = src("../plugins/status-indicators.js");
  assert.match(js, /typeof handle\?\.sessionPacketLossPct === "function"\) lossPct = handle\.sessionPacketLossPct\(\)/);
  assert.match(js, /f\.lossPct = linkLossFact\(lossPct, ageMs\);/);
  assert.match(js, /detail: linkTooltipDetail\(f\),/);
  // The tier never reads the loss figure.
  assert.match(js, /const tier = linkTierFor\(ageMs, rttMs, window\.__linkStatusThresholds \|\| \{\}\);/);
  // The wasm getters exist under the names the JS calls.
  const rs = src("../src/lib.rs");
  assert.match(rs, /#\[wasm_bindgen\(js_name = sessionPacketLossPct\)\]\s*pub fn session_packet_loss_pct\(&self\) -> f32/);
  assert.match(rs, /#\[wasm_bindgen\(js_name = netWorkerLinkStatus\)\]\s*pub fn net_worker_link_status\(&self, rtt_ms: u32, packet_loss: f32\)/);
});

test("L5 RX_KIND_LINK_STATUS is 3 on both sides and distinct", () => {
  const rs = src("../src/net_worker.rs");
  const kind = (name) => {
    const m = rs.match(new RegExp(`pub const ${name}: u8 = (\\d+);`));
    assert.ok(m, `${name} defined`);
    return Number(m[1]);
  };
  const ls = kind("RX_KIND_LINK_STATUS");
  assert.equal(ls, 3);
  for (const other of ["RX_KIND_MESSAGE", "RX_KIND_DISCONNECT", "RX_KIND_TIMESYNC"]) {
    assert.notEqual(kind(other), ls, other);
  }
  const js = src("../scene3d/net_worker.js");
  assert.match(js, /const RX_KIND_LINK_STATUS = 3;/);
});

test("L6 net_worker.js turns kind 3 into {t:'linkstatus', rttMs, loss}", async () => {
  let sink = null;
  const fakeSelf = {
    onmessage: null,
    sent: [],
    postMessage(msg) {
      this.sent.push(msg);
    },
  };
  const prevSelf = globalThis.self;
  globalThis.self = fakeSelf;
  globalThis.__lsWorkerStubs = {
    init: async () => {},
    net_worker_run: () => {},
    net_worker_submit_outbound: () => {},
    net_worker_set_sink: (fn) => {
      sink = fn;
    },
    hb_mem_census: () => "{}",
  };
  try {
    const mod = await loadWithStubs("../scene3d/net_worker.js", "__lsWorkerStubs");
    for (let i = 0; i < 5 && !sink; i++) await tick();
    assert.equal(typeof sink, "function", "the wasm post sink was registered");

    sink(3, linkStatusBytes(123, 0.25));
    sink(3, linkStatusBytes(MAX, 0));
    sink(3, new Uint8Array(4)); // short: dropped
    const ls = fakeSelf.sent.filter((m) => m.t === "linkstatus");
    assert.deepEqual(ls, [
      { t: "linkstatus", rttMs: 123, loss: 0.25 },
      { t: "linkstatus", rttMs: MAX, loss: 0 },
    ]);
    assert.ok(!fakeSelf.sent.some((m) => m.t === "error"), JSON.stringify(fakeSelf.sent));

    // The decoder on its own: a sub-view of a larger buffer, junk, NaN.
    const big = new Uint8Array(12);
    big.set(linkStatusBytes(7, 1.5), 4);
    assert.deepEqual(mod.decodeLinkStatus(big.subarray(4)), { rttMs: 7, loss: 1.5 });
    assert.equal(mod.decodeLinkStatus(null), null);
    assert.equal(mod.decodeLinkStatus(linkStatusBytes(1, Number.NaN)), null);
  } finally {
    globalThis.self = prevSelf;
    delete globalThis.__lsWorkerStubs;
  }
});

test("L7 net_worker_client.js hands linkstatus to the live handle, guarded", async () => {
  const calls = [];
  let handleToReturn = {
    netWorkerLinkStatus: (rtt, loss) => calls.push([rtt, loss]),
  };
  class FakeWorker {
    constructor() {
      this.onmessage = null;
      this.onerror = null;
      FakeWorker.last = this;
      setTimeout(() => this.onmessage && this.onmessage({ data: { t: "ready" } }), 0);
    }
    postMessage() {}
    terminate() {}
  }
  const prevWorker = globalThis.Worker;
  globalThis.Worker = FakeWorker;
  let releaseStart = null;
  globalThis.__lsClientStubs = {
    init: async () => {},
    start_session: () =>
      new Promise((resolve) => {
        releaseStart = () => resolve(handleToReturn);
      }),
    net_worker_arm: () => {},
    net_proxy_push_inbound: () => {},
    net_proxy_push_disconnect: () => {},
    net_proxy_push_timesync: () => {},
  };
  try {
    const mod = await loadWithStubs("../scene3d/net_worker_client.js", "__lsClientStubs");
    const pending = mod.startNetWorkerSession("ws://bridge/", "127.0.0.1", 9000, "acct", "pw");
    for (let i = 0; i < 10 && !releaseStart; i++) await tick();
    assert.equal(typeof releaseStart, "function", "start_session reached");

    // Before the handle exists the post is dropped, not thrown.
    FakeWorker.last.onmessage({ data: { t: "linkstatus", rttMs: 10, loss: 0.1 } });
    assert.deepEqual(calls, []);

    releaseStart();
    const handle = await pending;
    assert.equal(handle, handleToReturn);
    FakeWorker.last.onmessage({ data: { t: "linkstatus", rttMs: 88, loss: 0.5 } });
    FakeWorker.last.onmessage({ data: { t: "linkstatus", rttMs: MAX, loss: 0 } });
    assert.deepEqual(calls, [
      [88, 0.5],
      [MAX, 0],
    ]);

    // A stale pkg/ handle without the method: ignored.
    delete handle.netWorkerLinkStatus;
    FakeWorker.last.onmessage({ data: { t: "linkstatus", rttMs: 5, loss: 0 } });
    assert.equal(calls.length, 2);
  } finally {
    globalThis.Worker = prevWorker;
    delete globalThis.__lsClientStubs;
  }
});

test("L8 no writer overwrites the ping stamp any more", () => {
  const files = [
    "../src/lib.rs",
    "../src/session/commands/lifecycle.rs",
    "../src/session/messages/game_event.rs",
    "../src/net_worker.rs",
  ];
  for (const f of files) {
    assert.doesNotMatch(src(f), /PING_SEND_INSTANT/, `${f} still uses the old slot`);
  }
  // Both main-thread drivers stamp through the one helper, after the send.
  const lifecycle = src("../src/session/commands/lifecycle.rs");
  assert.match(lifecycle, /Ok\(\(\)\) => note_keepalive_ping_sent\(session, state\),/);
  const lib = src("../src/lib.rs");
  assert.match(lib, /Ok\(\(\)\) => note_keepalive_ping_sent\(session, state\),/);
  assert.match(lib, /fn note_keepalive_ping_sent\(session: &net_worker::LoopSession, state: &LoopState\)/);
  // The response arm reads the clock (the stamp of the one ping sent with
  // none out).
  assert.match(src("../src/session/messages/game_event.rs"), /\.note_response_ms\(web_time::Instant::now\(\)\)/);
});
