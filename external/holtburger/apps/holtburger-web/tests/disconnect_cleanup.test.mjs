// tests/disconnect_cleanup.test.mjs — Verify disconnect recovery, transport timeout, and event cleanup
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { STOP_PUMP } from "../app/client_events.js";
import { showDisconnectBanner } from "../app/dom_utils.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_DIR = path.resolve(HERE, "..");
const INDEX_HTML = path.join(APP_DIR, "index.html");
const CLIENT_EVENTS_JS = path.join(APP_DIR, "app", "client_events.js");
const TRANSPORT_RS = path.resolve(APP_DIR, "..", "..", "crates", "holtburger-transport-ws", "src", "transport.rs");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  [OK] ${name}`);
  } catch (err) {
    failed++;
    console.error(`  [FAIL] ${name}`);
    console.error(err);
  }
}

console.log("disconnect_cleanup.test.mjs — testing disconnect cleanup, reconnect button, and transport timeout");

// 1. showDisconnectBanner creates banner with Reconnect button
await test("showDisconnectBanner creates #hbDisconnectBanner and #hbBannerReconnectBtn", () => {
  // Setup minimal DOM mocks
  const elements = new Map();
  const listeners = new Map();

  class MockElement {
    constructor(id) {
      this._id = id;
      this.style = {};
      this.children = [];
      this.textContent = "";
      if (id) elements.set(id, this);
    }
    get id() { return this._id; }
    set id(val) {
      if (this._id) elements.delete(this._id);
      this._id = val;
      elements.set(val, this);
    }
    appendChild(child) {
      this.children.push(child);
    }
    addEventListener(evt, fn) {
      listeners.set(`${this.id}:${evt}`, fn);
    }
  }

  const mockBody = new MockElement("body");
  globalThis.document = {
    body: mockBody,
    getElementById(id) {
      return elements.get(id) || null;
    },
    createElement(tag) {
      return new MockElement(tag + "_" + Math.random().toString(36).slice(2, 6));
    },
  };
  globalThis.window = { __bootState: "ready" };

  let reconnected = false;
  showDisconnectBanner("Session closed", () => {
    reconnected = true;
  });

  const banner = elements.get("hbDisconnectBanner");
  assert.ok(banner, "banner element was created");
  assert.ok(banner.textContent.includes("Session closed"), "banner displays reason");

  const btn = elements.get("hbBannerReconnectBtn");
  assert.ok(btn, "reconnect button was created");
  assert.equal(btn.textContent, "Reconnect");

  // Trigger button click
  const clickHandler = listeners.get("hbBannerReconnectBtn:click");
  assert.ok(clickHandler, "click handler registered on reconnect button");
  clickHandler();
  assert.equal(reconnected, true, "clicking reconnect executes onReconnect callback");
});

// 2. Trailing ClientEvent wasm boxes freed on STOP_PUMP
await test("pumpNetFrame loop frees trailing wasm ClientEvent boxes when dispatchClientEvent returns STOP_PUMP", () => {
  const indexHtml = fs.readFileSync(INDEX_HTML, "utf8");
  assert.ok(
    indexHtml.includes("if (dispatchClientEvent(evt, __clientEventDeps) === STOP_PUMP)"),
    "checks STOP_PUMP from dispatchClientEvent"
  );
  assert.ok(
    indexHtml.includes("events[j]?.free?.()"),
    "frees trailing events when STOP_PUMP is encountered"
  );

  // Behavioral simulation of the loop
  const freed = [];
  const mockEvents = [
    { id: 1, free() { freed.push(1); } },
    { id: 2, free() { freed.push(2); } },
    { id: 3, free() { freed.push(3); } },
  ];

  function simulatePump(events) {
    for (let i = 0; i < events.length; i++) {
      const evt = events[i];
      if (evt.id === 1) {
        // Disconnect returns STOP_PUMP
        for (let j = i + 1; j < events.length; j++) {
          events[j]?.free?.();
        }
        return STOP_PUMP;
      }
    }
  }

  const result = simulatePump(mockEvents);
  assert.equal(result, STOP_PUMP);
  assert.deepEqual(freed, [2, 3], "trailing events 2 and 3 were freed; event 1 was consumed");
});

// 3. transport.rs has 10s connect and handshake timeouts using select and wait_timeout
await test("transport.rs implements 10s connect & handshake timeout with socket cleanup", () => {
  const rustCode = fs.readFileSync(TRANSPORT_RS, "utf8");

  // Imports
  assert.ok(rustCode.includes("use futures::future::{select, Either};"), "imports futures select & Either");

  // wait_timeout helper
  assert.ok(rustCode.includes("fn wait_timeout("), "implements wait_timeout helper function");

  // open_rx select with 10s timeout
  assert.ok(rustCode.includes("select(open_rx, wait_timeout(10_000.0))"), "open_rx has 10s timeout");
  assert.ok(rustCode.includes('"ws connection timed out after 10s"'), "returns ws connection timeout error");

  // handshake_rx select with 10s timeout
  assert.ok(rustCode.includes("select(handshake_rx, wait_timeout(10_000.0))"), "handshake_rx has 10s timeout");
  assert.ok(rustCode.includes('"ws handshake timed out after 10s"'), "returns ws handshake timeout error");

  // WebSocket is closed on timeout
  assert.ok(rustCode.includes("ws.close()"), "calls ws.close() to abort socket on timeout");
});

// 4. client_events.js cleans up world entities and resets drain queue on disconnect
await test("client_events.js cleans up world entities and drain queue on disconnect", () => {
  const code = fs.readFileSync(CLIENT_EVENTS_JS, "utf8");
  assert.ok(
    code.includes("window.liveScene3d?.entityManager?.clearWorldEntities?.()"),
    "clears world entities on disconnect"
  );
  assert.ok(
    code.includes('__resetEntDrainPending("disconnect")'),
    "resets entity drain pending queue on disconnect"
  );
  assert.ok(
    code.includes("showDisconnectBanner("),
    "invokes showDisconnectBanner on disconnect"
  );
  assert.ok(
    code.includes("return STOP_PUMP;"),
    "returns STOP_PUMP on disconnect"
  );
});

if (failed > 0) {
  console.error(`\n${failed} test(s) failed, ${passed} passed.`);
  process.exit(1);
} else {
  console.log(`\nAll ${passed} tests passed.`);
  process.exit(0);
}
