// tests/cast_busy_count.test.mjs — spellcast-4 (2026-10-08).
//
// Retail busy is a count of outstanding requests: ClientMagicSystem::CastSpell
// always sends and then ClientUISystem::IncrementBusyCount (acclient.c:401885);
// Handle_Item__UseDone (:401924) decrements on every UseDone. Vanilla ACE
// answers a cast sent while another is outstanding with UseDone(YoureTooBusy),
// but holtburger's local prediction used a per-spell time window, so a
// DIFFERENT spell pressed mid-cast played a phantom windup over the real one.
// The wasm SessionHandle.getBusyState() is the m_cBusy analog; the local cast
// senders read it before the send and playCastSequence suppresses the chain
// when it was > 0 (ui/ac_cast_predict.js).
//
// Run from apps/holtburger-web/:  node tests/cast_busy_count.test.mjs

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
// Browser globals the plugin facade and entities.js read at import time
// (bare URL: ?castStateMachine and ?castBusyCount default ON).
globalThis.window = globalThis;
globalThis.location = { search: "" };
globalThis.__playEffectVfxBound = true;
globalThis.__spellShapePreviewBound = true;
if (typeof globalThis.addEventListener !== "function") globalThis.addEventListener = () => {};
if (typeof globalThis.removeEventListener !== "function") globalThis.removeEventListener = () => {};
const { readBusyCount, castSuppressReason } = await import(
  pathToFileURL(path.join(APP, "ui", "ac_cast_predict.js")).href
);

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log(`  [PASS] ${name}`); }
  catch (e) { failed++; console.log(`  [FAIL] ${name} — ${e.message}`); }
}

console.log("\n[1] readBusyCount");
await check("number from getBusyState; undefined when missing, throwing or not a number", () => {
  assert.equal(readBusyCount({ getBusyState: () => 2 }), 2);
  assert.equal(readBusyCount({ getBusyState: () => 0 }), 0);
  assert.equal(readBusyCount({}), undefined);
  assert.equal(readBusyCount(null), undefined);
  assert.equal(readBusyCount({ getBusyState: () => { throw new Error("freed"); } }), undefined);
  assert.equal(readBusyCount({ getBusyState: () => "1" }), undefined);
});

console.log("\n[2] castSuppressReason");
const now = 1000;
const inWindow = { busyUntilMs: 5000, nowMs: now };
await check("count on: 0 outstanding → predict, even a same-spell repeat inside the window", () => {
  assert.equal(castSuppressReason({ countOn: true, busyBefore: 0, sameSpell: true, ...inWindow }), null);
});
await check("count on: 1 outstanding → busyOutstanding, even for a different spell", () => {
  assert.equal(castSuppressReason({ countOn: true, busyBefore: 1, sameSpell: false, ...inWindow }), "busyOutstanding");
  assert.equal(castSuppressReason({ countOn: true, busyBefore: 1, sameSpell: false, busyUntilMs: 0, nowMs: now }), "busyOutstanding");
});
await check("unknown count (remote caster / old pkg) → the time window", () => {
  assert.equal(castSuppressReason({ countOn: true, busyBefore: undefined, sameSpell: true, ...inWindow }), "busyWindow");
  assert.equal(castSuppressReason({ countOn: true, busyBefore: undefined, sameSpell: false, ...inWindow }), null);
  assert.equal(castSuppressReason({ countOn: true, busyBefore: undefined, sameSpell: true, busyUntilMs: 900, nowMs: now }), null);
});
await check("?castBusyCount=off → the time window whatever the count", () => {
  assert.equal(castSuppressReason({ countOn: false, busyBefore: 1, sameSpell: false, ...inWindow }), null);
  assert.equal(castSuppressReason({ countOn: false, busyBefore: 0, sameSpell: true, ...inWindow }), "busyWindow");
});

console.log("\n[3] send / UseDone sequence (wasm counter model: +1 per send, -1 per UseDone, floor 0)");
await check("A predicts; B mid-cast is suppressed; after both UseDones C predicts", () => {
  let busy = 0;
  const handle = { getBusyState: () => busy };
  const send = () => { const before = readBusyCount(handle); busy += 1; return before; };
  const useDone = () => { busy = Math.max(0, busy - 1); };
  const gate = (before) => castSuppressReason({ countOn: true, busyBefore: before, sameSpell: false, busyUntilMs: 0, nowMs: now });
  assert.equal(gate(send()), null, "send A");
  assert.equal(gate(send()), "busyOutstanding", "send B (different spell)");
  useDone();                    // UseDone(YoureTooBusy 0x1D) for B
  assert.equal(busy, 1, "A still outstanding");
  useDone();                    // UseDone(None) for A
  assert.equal(busy, 0);
  assert.equal(gate(send()), null, "send C");
});

console.log("\n[4] api.js castSpell reads the count BEFORE it sends");
await check("playCastSequence gets busyBefore = the count before the send", async () => {
  const { createClient } = await import(pathToFileURL(path.join(APP, "plugins", "api.js")).href);
  let busy = 0;
  const sent = [];
  const handle = {
    getBusyState: () => busy,
    castTargetedSpell: (t, s) => { sent.push(["targeted", t, s]); busy += 1; },
    castUntargetedSpell: (s) => { sent.push(["untargeted", s]); busy += 1; },
    getSpellRecord: () => null,
  };
  const plays = [];
  globalThis.getLocalPlayerGuid = () => 0x50000001;
  globalThis.liveScene3d = { entityManager: { playCastSequence: (g, s, o) => plays.push({ g, s, o }) } };
  try {
    const client = createClient(handle);
    client.player.castSpell(27, 0x50000abc);
    client.player.castSpell(28, 0x50000abc);
    assert.deepEqual(sent, [["targeted", 0x50000abc, 27], ["targeted", 0x50000abc, 28]]);
    assert.equal(plays.length, 2);
    assert.equal(plays[0].o?.busyBefore, 0, "first cast: nothing outstanding");
    assert.equal(plays[1].o?.busyBefore, 1, "second cast: the first is outstanding");
  } finally {
    delete globalThis.liveScene3d;
    delete globalThis.getLocalPlayerGuid;
  }
});

console.log("\n[5] EntityManager.playCastSequence (the real gate)");
await check("busyBefore 1 → suppressed busyOutstanding; 0 → the chain starts (no same-spell window)", async () => {
  const { EntityManager } = await import(pathToFileURL(path.join(APP, "scene3d", "entities.js")).href);
  const { _loadSequenceSync } = await import(pathToFileURL(path.join(APP, "ui", "ac_spell_cast_sequence.js")).href);
  const gesture = { motion: "0x40000035", name: "MagicTransfer", durationS: 0.5 };
  _loadSequenceSync({
    27: { school: "War", shape: "Bolt", level: 1, fastCast: true, windupGestures: [], castGesture: gesture, totalDurationS: 0.5 },
    28: { school: "War", shape: "Bolt", level: 1, fastCast: true, windupGestures: [], castGesture: gesture, totalDurationS: 0.5 },
  });
  const G = 0x50000001;
  const inst = {};
  const em = {
    entityMap: new Map([[G, inst]]),
    setSwingMotion: async () => {},
    _castDiag: EntityManager.prototype._castDiag,
  };
  const suppressed = [];
  globalThis.__diag = { cast: { onCastSuppressed: (m) => suppressed.push(m.reason) } };
  const play = (spellId, opts) => {
    // Past the gate the chain needs the whole manager; only the synchronous
    // gate + token bump matter here.
    EntityManager.prototype.playCastSequence.call(em, G, spellId, opts).catch(() => {});
  };
  try {
    play(27, { busyBefore: 1 });
    assert.deepEqual(suppressed, ["busyOutstanding"]);
    assert.equal(globalThis.__diag.cast.busyOutstanding, 1, "diag counter");
    assert.equal(inst._castSequenceToken, undefined, "no chain started");
    play(27, { busyBefore: 0 });
    assert.equal(inst._castSequenceToken, 1, "chain started");
    play(27, { busyBefore: 0 });        // same spell inside its window, nothing outstanding
    assert.equal(inst._castSequenceToken, 2, "count, not the window, decides");
    play(27, {});                       // no count (old pkg) → the same-spell window drops it
    assert.deepEqual(suppressed, ["busyOutstanding", "busyWindow"]);
    assert.equal(inst._castSequenceToken, 2);
  } finally {
    delete globalThis.__diag;
  }
});

console.log("\n[6] wiring");
await check("picking.js reads the count before castTargetedSpell and passes it on", () => {
  const src = fs.readFileSync(path.join(APP, "scene3d", "picking.js"), "utf8");
  const read = src.indexOf("const busyBefore = readBusyCount(sessionHandle);");
  const sendAt = src.indexOf("sessionHandle.castTargetedSpell(guid, spellId);", read);
  assert.ok(read > 0 && sendAt > read, "read precedes the send");
  assert.ok(src.indexOf("busyBefore,", sendAt) > sendAt, "passed to playCastSequence");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
