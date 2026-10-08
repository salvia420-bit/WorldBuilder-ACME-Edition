// tests/teleport_hook_autorun.test.mjs — streaming-teleport-2 (2026-10-08
// follow-ups, `?teleportHook`).
//
// Retail `SmartBox::PlayerPositionUpdated(teleporting=1)` (acclient.c:
// 144695-144712) runs `CPhysicsObj::teleport_hook` and then
// `CommandInterpreter::PlayerTeleported` (:716924) — SetAutoRun(0,1), which
// prints "AutoRun OFF" (:718270-718287) — when the local player's
// destination pose lands. The wasm runs the movement half at the
// TeleportArrived edge (kind 66); app/client_events.js clears the autorun
// key handler's mirror (`window.__autoRunOn`) at the same edge so the next
// toggle turns autorun ON again. `?teleportHook=off` leaves it alone.
//
// Run: node tests/teleport_hook_autorun.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

globalThis.window = globalThis;
globalThis.location = { search: "", href: "http://test/index.html", reload() {} };
globalThis.sessionStorage = { getItem: () => null, setItem() {} };
globalThis.document = {
  getElementById: () => null,
  createElement: () => ({ style: {} }),
  body: { appendChild() {} },
};

const { dispatchClientEvent } = await import("../app/client_events.js");
const { ClientEventKind } = await import("../scene3d/client_event_kinds.js");

function arrive(lines) {
  const evt = { kind: ClientEventKind.TELEPORT_ARRIVED, u32Payload: 0xa9b40001, u32Payload2: 3, free() {} };
  dispatchClientEvent(evt, {
    appendChatLine: (text, cat) => lines.push([text, cat]),
    setBootState() {},
    EVT_GUARD_ON: true,
  });
}

test("TeleportArrived clears the autorun mirror and prints AutoRun OFF", () => {
  const lines = [];
  window.__autoRunOn = true;
  location.search = "";
  arrive(lines);
  assert.equal(window.__autoRunOn, false);
  assert.deepEqual(lines, [["AutoRun OFF", 10]]);
});

test("no notice when autorun was not on", () => {
  const lines = [];
  window.__autoRunOn = false;
  arrive(lines);
  assert.equal(window.__autoRunOn, false);
  assert.deepEqual(lines, []);
});

test("?teleportHook=off / 0 / false leaves the mirror alone", () => {
  for (const v of ["off", "0", "false", "OFF"]) {
    const lines = [];
    window.__autoRunOn = true;
    location.search = `?nosw=1&teleportHook=${v}`;
    arrive(lines);
    assert.equal(window.__autoRunOn, true, v);
    assert.deepEqual(lines, [], v);
  }
  location.search = "";
});

test("plumbing: the wasm arrival edge queues the movement hook behind the flag", () => {
  const pos = readFileSync(new URL("../src/session/messages/position.rs", import.meta.url), "utf8");
  const i = pos.indexOf("kind: CLIENT_EVENT_KIND_TELEPORT_ARRIVED");
  assert.ok(i > 0);
  assert.match(pos.slice(i, i + 1500), /if teleport_hook_on \{\s*movement\.player_teleported\(\);/);
  const lib = readFileSync(new URL("../src/lib.rs", import.meta.url), "utf8");
  assert.match(lib, /fn parse_teleport_hook_flag\(search: &str\) -> bool/);
});
