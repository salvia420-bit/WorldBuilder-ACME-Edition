// tests/corpse_command.test.mjs — inventory-session-7 (2026-10-13): the
// retail `@corpse` / `@cor` client command in app/slash_commands.js.
//   - cellIdToCoordinateString = LandDefs::CellidToCoordinateString
//     (acclient.c:467472) over gid_to_lcoord (:209521): cell-granular,
//     (lcoord - 1024) * 0.1 + 0.5, "%.1f%s, %.1f%s" N/S first, no letter at 0.
//   - the verb = ClientCommunicationSystem::DoCorpse (acclient.c:418186):
//     prints the "no record" line or the coordinate line locally and sends
//     nothing; a pkg without SessionHandle.playerLastOutsideDeath keeps the
//     old server forward.
//
// Run from apps/holtburger-web/:  node tests/corpse_command.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";

globalThis.window ??= {};

const {
  initSlashCommands, normalizeChatLine, RETAIL_CLIENT_VERBS, RS_PREFIX_SET,
  CORPSE_VERBS, CORPSE_NO_RECORD_TEXT, cellIdToCoordinateString, corpseCommandText,
} = await import("../app/slash_commands.js");
const { CHAT_CATEGORY } = await import("../app/chat_log.js");

const { routeSlashCommand } = initSlashCommands();

/** objcell id for landblock (lbx, lby) and outdoor cell column / row 0..7. */
function outdoorCell(lbx, lby, col, row) {
  return ((lbx << 24) | (lby << 16) | (col * 8 + row + 1)) >>> 0;
}

function fakeHandle(snapshot) {
  const calls = [];
  const h = {
    calls,
    freed: 0,
    sendChat: (...a) => calls.push(["sendChat", ...a]),
    sendTell: (...a) => calls.push(["sendTell", ...a]),
    sendChannel: (...a) => calls.push(["sendChannel", ...a]),
    sendTurbineChannel: (...a) => calls.push(["sendTurbineChannel", ...a]),
    resolveSoulEmote: () => null,
  };
  if (snapshot !== "stale") {
    h.playerLastOutsideDeath = () => {
      calls.push(["playerLastOutsideDeath"]);
      if (snapshot == null) return undefined; // wasm Option::None
      return { ...snapshot, free: () => { h.freed += 1; } };
    };
  }
  return h;
}

function withChatCapture(fn) {
  const lines = [];
  const prev = window.__appendChatLine;
  window.__appendChatLine = (text, category) => lines.push([text, category]);
  try { return { result: fn(), lines }; }
  finally {
    if (prev === undefined) delete window.__appendChatLine; else window.__appendChatLine = prev;
  }
}

test("cellIdToCoordinateString: hand-computed retail values", () => {
  // Holtburg 0xA9B40021: lcoord x = 169*8 + (32>>3) = 1356, y = 180*8 + (32&7) = 1440
  // → EW (1356-1024)*0.1+0.5 = 33.7, NS (1440-1024)*0.1+0.5 = 42.1.
  assert.equal(cellIdToCoordinateString(0xA9B40021), "42.1N, 33.7E");
  // Landblock 0x0000 cell 1: lcoord 0,0 → -101.9 on both axes.
  assert.equal(cellIdToCoordinateString(0x00000001), "101.9S, 101.9W");
  // Landblock 0xFEFE cell 0x40: lcoord 2039,2039 → 102.0 on both axes.
  assert.equal(cellIdToCoordinateString(0xFEFE0040), "102.0N, 102.0E");
  // lcoord 1019 = 127*8 + 3 → (1019-1024)*0.1+0.5 = 0.0, printed with no letter.
  assert.equal(cellIdToCoordinateString(outdoorCell(127, 127, 3, 3)), "0.0, 0.0");
  assert.equal(cellIdToCoordinateString(0x7F7F001C), "0.0, 0.0");
  assert.equal(cellIdToCoordinateString(outdoorCell(127, 180, 3, 0)), "42.1N, 0.0");
  // lcoord x 1018 → -0.1 (W), y 1020 → +0.1 (N).
  assert.equal(cellIdToCoordinateString(outdoorCell(127, 127, 2, 4)), "0.1N, 0.1W");
  // The LastOutsideDeath cell in the captured ACE PlayerDescription
  // (crates/holtburger-protocol/tests/fixtures/player_description.bin):
  // 0xDA55001D → lcoord x = 218*8 + 3 = 1747 (72.8E), y = 85*8 + 4 = 684 (33.5S).
  assert.equal(cellIdToCoordinateString(0xDA55001D), "33.5S, 72.8E");
  // Cell-granular: 0xA9B40021 is column 4 / row 0 of 0xA9B4; the next column
  // east and the next row north are each exactly 0.1 further.
  assert.equal(cellIdToCoordinateString(outdoorCell(169, 180, 4, 0)), "42.1N, 33.7E");
  assert.equal(cellIdToCoordinateString(outdoorCell(169, 180, 5, 0)), "42.1N, 33.8E");
  assert.equal(cellIdToCoordinateString(outdoorCell(169, 180, 4, 1)), "42.2N, 33.7E");
});

test("cellIdToCoordinateString: matches the cell-centre map coordinate for every outdoor cell sampled", () => {
  // Independent derivation: the cell centre in metres (landblock * 192 +
  // column * 24 + 12) over 240 m per map unit, minus 101.95.
  const centre = (lb, i) => (lb * 192 + i * 24 + 12) / 240 - 101.95;
  const fmt = (v, pos, neg) => {
    const r = Math.round(v * 10) / 10;
    return `${Math.abs(r).toFixed(1)}${r > 0 ? pos : r < 0 ? neg : ""}`;
  };
  for (const lbx of [0, 1, 0x30, 0x7E, 0x7F, 0x80, 0xA9, 0xDA, 0xFE]) {
    for (const lby of [0, 0x3F, 0x7F, 0xB4, 0xFE]) {
      for (let col = 0; col < 8; col++) {
        for (let row = 0; row < 8; row++) {
          const id = outdoorCell(lbx, lby, col, row);
          const want = `${fmt(centre(lby, row), "N", "S")}, ${fmt(centre(lbx, col), "E", "W")}`;
          assert.equal(cellIdToCoordinateString(id), want, `0x${id.toString(16)}`);
        }
      }
    }
  }
});

test("corpseCommandText: retail DoCorpse strings", () => {
  assert.equal(CORPSE_NO_RECORD_TEXT,
    "We're sorry, but we have no record of your last outside corpse location.");
  assert.equal(corpseCommandText(null), CORPSE_NO_RECORD_TEXT);
  assert.equal(corpseCommandText(undefined), CORPSE_NO_RECORD_TEXT);
  assert.equal(corpseCommandText(0xA9B40021),
    "The last time you died outside, your corpse was located at (42.1N, 33.7E).");
});

test("corpse / cor are retail client verbs; @ forms reroute to the client", () => {
  assert.deepEqual([...CORPSE_VERBS].sort(), ["cor", "corpse"]);
  assert.equal(RETAIL_CLIENT_VERBS.has("corpse"), true);
  assert.equal(RETAIL_CLIENT_VERBS.has("cor"), true);
  // RynthSuite prefixes are untouched.
  assert.equal(RS_PREFIX_SET.has("cor"), false);
  assert.equal(RS_PREFIX_SET.has("corpse"), false);
  assert.deepEqual(normalizeChatLine("@corpse"), { kind: "command", line: "/corpse" });
  assert.deepEqual(normalizeChatLine("@COR"), { kind: "command", line: "/COR" });
});

test("no record: prints the retail line locally and sends nothing", () => {
  for (const line of ["/corpse", "@corpse", "/cor", "@Cor,", "/corpse ignored args"]) {
    const h = fakeHandle(null);
    const { result, lines } = withChatCapture(() => routeSlashCommand(h, line));
    assert.equal(result.dispatched, true, line);
    assert.equal(result.echo, null, line);
    assert.deepEqual(result.lines, [CORPSE_NO_RECORD_TEXT], line);
    assert.equal(result.category, CHAT_CATEGORY.SYSTEM, line);
    assert.deepEqual(lines, [[CORPSE_NO_RECORD_TEXT, CHAT_CATEGORY.SYSTEM]], line);
    assert.deepEqual(h.calls, [["playerLastOutsideDeath"]], `${line}: nothing sent`);
  }
});

test("recorded death: prints the coordinate line from the cell id and frees the snapshot", () => {
  const h = fakeHandle({ cellId: 0xA9B40021, x: 108.5, y: 12.25, z: 42 });
  const { result, lines } = withChatCapture(() => routeSlashCommand(h, "@cor"));
  const want = "The last time you died outside, your corpse was located at (42.1N, 33.7E).";
  assert.equal(result.dispatched, true);
  assert.deepEqual(result.lines, [want]);
  assert.deepEqual(lines, [[want, CHAT_CATEGORY.SYSTEM]]);
  assert.deepEqual(h.calls, [["playerLastOutsideDeath"]], "nothing sent to the server");
  assert.equal(h.freed, 1, "the wasm snapshot is freed");
});

test("a getter failure is reported, never sent", () => {
  const h = fakeHandle(null);
  h.playerLastOutsideDeath = () => { throw new Error("boom"); };
  const { result, lines } = withChatCapture(() => routeSlashCommand(h, "/corpse"));
  assert.equal(result.dispatched, true);
  assert.equal(result.error, "/corpse: boom");
  assert.deepEqual(lines, []);
  assert.deepEqual(h.calls, []);
});

test("a pkg without playerLastOutsideDeath keeps the server forward", () => {
  const h = fakeHandle("stale");
  const r = routeSlashCommand(h, "@corpse");
  assert.equal(r.dispatched, true);
  assert.deepEqual(h.calls, [["sendChat", "@corpse"]]);
  assert.equal(r.echo, "> @corpse");
});

test("RynthSuite lines mentioning corpse still go to the VTank layer", () => {
  const routed = [];
  const prev = window.__rynthVt;
  window.__rynthVt = { route: (_h, line) => routed.push(line) };
  try {
    const h = fakeHandle(null);
    const r = routeSlashCommand(h, "/vt corpse");
    assert.equal(r.dispatched, true);
    assert.deepEqual(routed, ["/vt corpse"]);
    assert.deepEqual(h.calls, []);
  } finally {
    if (prev === undefined) delete window.__rynthVt; else window.__rynthVt = prev;
  }
});
