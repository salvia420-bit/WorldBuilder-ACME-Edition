// unified_queue_preempt.test.mjs — OpenAC comparison 2026-10-04, combat P0-1.
//
// setMotion used to free the in-flight one-shot for EVERY command (the next
// swing/cast included) but left the freed record at the head of
// `_unifiedQueue`; `_promoteUnifiedHead` then promoted it, its advance() threw
// every tick and the entity's gestures wedged. These cases drive the REAL
// method bodies, lifted out of scene3d/entities.js by brace matching (the full
// module needs three.js + wasm), against the real scene3d/motion_queue.js.
//
// Run: node tests/unified_queue_preempt.test.mjs   (from apps/holtburger-web/)

import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import * as MQ from "../scene3d/motion_queue.js";

const SRC = readFileSync(new URL("../scene3d/entities.js", import.meta.url), "utf8");

function methodSource(name) {
  const start = SRC.indexOf(`\n  ${name}(`);
  assert.ok(start >= 0, `method ${name} not found in entities.js`);
  let i = SRC.indexOf("{", SRC.indexOf(")", start));
  let depth = 0;
  for (let j = i; j < SRC.length; j += 1) {
    if (SRC[j] === "{") depth += 1;
    else if (SRC[j] === "}" && --depth === 0) return SRC.slice(start + 1, j + 1);
  }
  throw new Error(`unbalanced ${name}`);
}

// Stub classifier: the test only needs gesture vs. locomotion.
const ATTACK = 0x10000062;
const CAST = 0x40000030;
const RUN = 0x44000007;
const classifyMotionCommand = (c) =>
  c === ATTACK ? "attack" : c === CAST ? "cast" : "walk";

const methods = [
  "_enqueueUnifiedOneShot",
  "_promoteUnifiedHead",
  "_unifiedOneShotFinished",
  "_clearUnifiedQueue",
  "_preemptUnifiedForMotion",
].map(methodSource).join("\n");

const Harness = new Function(
  "createMotionQueue", "addToQueue", "animationsDone", "headMotion",
  "classifyMotionCommand", "_UNIFIED_QUEUE_MAX",
  `return class Harness {\n${methods}\n};`,
)(MQ.createMotionQueue, MQ.addToQueue, MQ.animationsDone, MQ.headMotion,
  classifyMotionCommand, 4);

// A fake wasm MotionSequence: free() zeroes __wbg_ptr like wasm-bindgen does.
function fakeRec(tag) {
  const seq = {
    __wbg_ptr: 1, tag, freed: 0,
    free() { this.freed += 1; this.__wbg_ptr = 0; },
  };
  return { seq, clearOnDone: true, tag };
}

test("a second gesture over a finishing one-shot appends instead of wedging", () => {
  const h = new Harness();
  const inst = {};
  const a = fakeRec("a");
  assert.equal(h._enqueueUnifiedOneShot(inst, ATTACK, 1, a), true);
  // setMotion(ATTACK) for the next swing while `a` is still playing.
  h._preemptUnifiedForMotion(inst, ATTACK);
  assert.equal(inst._unifiedSeq, a, "the in-flight swing keeps the playhead");
  assert.equal(a.seq.freed, 0);
  const b = fakeRec("b");
  h._enqueueUnifiedOneShot(inst, ATTACK, 1, b);
  // `a` finishes (tick frees it, then retires it).
  a.seq.free();
  inst._unifiedSeq = null;
  h._unifiedOneShotFinished(inst, a);
  assert.equal(inst._unifiedSeq, b, "the queued swing is promoted");
  assert.notEqual(b.seq.__wbg_ptr, 0);
});

test("bug 2: locomotion never cuts a finishing one-shot — it keeps the playhead and its queue", () => {
  // Retail appends a new cycle behind the queued links/actions
  // (acclient.c:337737/:337796; OpenAC CMotionTable.cs:193, :255). Cutting
  // here is what made attack spells cast while turning/strafing never animate.
  const h = new Harness();
  const inst = {};
  const a = fakeRec("a");
  const b = fakeRec("b");
  h._enqueueUnifiedOneShot(inst, ATTACK, 1, a);
  h._enqueueUnifiedOneShot(inst, CAST, 1, b);
  h._preemptUnifiedForMotion(inst, RUN);
  assert.equal(inst._unifiedSeq, a, "the in-flight one-shot keeps the playhead");
  assert.equal(a.seq.freed, 0);
  assert.equal(b.seq.freed, 0);
  // `a` finishes → the queued one is promoted.
  a.seq.free();
  inst._unifiedSeq = null;
  h._unifiedOneShotFinished(inst, a);
  assert.equal(inst._unifiedSeq, b);
});

test("a held one-shot pre-empted by locomotion drops the queue too — no freed head left", () => {
  const h = new Harness();
  const inst = {};
  const hold = fakeRec("death");
  hold.clearOnDone = false;
  inst._unifiedSeq = hold;
  const q = fakeRec("q");
  q.numAnims = 1;
  inst._unifiedQueue = MQ.createMotionQueue();
  MQ.addToQueue(inst._unifiedQueue, ATTACK, 1, q);
  h._preemptUnifiedForMotion(inst, RUN);
  assert.equal(inst._unifiedSeq, null);
  assert.equal(inst._unifiedQueue, null);
  assert.equal(hold.seq.freed, 1);
  assert.equal(q.seq.freed, 1);
  // The next gesture plays immediately.
  const c = fakeRec("c");
  assert.equal(h._enqueueUnifiedOneShot(inst, CAST, 1, c), true);
  assert.equal(inst._unifiedSeq, c);
});

test("a held (clearOnDone:false) one-shot is still pre-empted by a gesture", () => {
  const h = new Harness();
  const inst = {};
  const hold = fakeRec("death");
  hold.clearOnDone = false;
  inst._unifiedSeq = hold;
  h._preemptUnifiedForMotion(inst, ATTACK);
  assert.equal(inst._unifiedSeq, null);
  assert.equal(hold.seq.freed, 1);
});

test("a freed record at the queue head is retired, never promoted", () => {
  const h = new Harness();
  const inst = {};
  const zombie = fakeRec("zombie");
  const next = fakeRec("next");
  inst._unifiedQueue = MQ.createMotionQueue();
  MQ.addToQueue(inst._unifiedQueue, ATTACK, 1, zombie);
  MQ.addToQueue(inst._unifiedQueue, CAST, 1, next);
  zombie.numAnims = 1;
  next.numAnims = 1;
  zombie.seq.free();
  h._promoteUnifiedHead(inst);
  assert.equal(inst._unifiedSeq, next);
});
