// tests/drone_gestures.test.mjs
//
// WHY: Drone Deploy's character scene is three JS clips built from retail
// Animation frames (pack 0x030003B7, place 0x03000247, goggles 0x030004F8) plus
// the ReadState held pose, and its timing drives every prop event (the drone
// appears in the hand, is set down, the goggles go on). A clip frame copied from
// the wrong source frame, a reversed half in the wrong order, `posFrames: []`
// (poses NaN), an event that fires twice or never, a replaced job that still
// reports, a Ready issued on a corpse, or a wielded-item hide that un-hides
// film's own hides would all be visible on the 1070 and are pinned here by
// EXECUTING the real scene3d/drone/gestures.js against the real DAT fixtures
// (fixtures/drone/anims.json, rig-table.json) and a fake EntityManager / wasm:
//   G1 constants + GESTURE_CLIPS (frozen at every level, 43 / 50 / 42 frames);
//   G2 clipFrameCount + buildClip on the fixture frames (source order, byte-exact
//      slices, frame times, one segment, posFrames / rootFrames null) and every
//      refusal (null, never a throw);
//   G3 rigProfile on all 26 rig-table rows (22 humanoid / 4 no-hands rows, 11 / 2
//      heritages) and the Map / object / name-keyed / partial inputs;
//   G4 loadAnim (frames read once, freed, cached per DID, rejection → null) and
//      readHoldingLocations;
//   G5 createGestureDriver: ready / profile (never rejects; a POS_FRAMES anim
//      still builds with one warn), clips through playLocalClip, the event and
//      done exactly once per job (also when cut early), timer jobs (part-count
//      mismatch, no-hands, clipMode 'timer' — read per call), replaced / stopped
//      jobs never report, rebind → done + rigChanged (the held command kept),
//      hold / release / the death-aware Ready, the watchdog, the wielded hide
//      round trip, clipParity, dispose.
//
// Flag: ?drone (DEFAULT ON since 2026-10-25, ?drone=off disables it) — the module only loads through the drone HUD.
// Run from apps/holtburger-web/: node tests/drone_gestures.test.mjs

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  FLOATS_PER_PART, HUMANOID_RIG, LOC_RIGHT_HAND, LOC_LEFT_HAND, MOTION, GESTURE_CLIPS,
  clipFrameCount, buildClip, rigProfile, loadAnim, readHoldingLocations, createWieldedHider,
  createGestureDriver,
} from "../scene3d/drone/gestures.js";

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}

const ANIMS = JSON.parse(readFileSync(new URL("../fixtures/drone/anims.json", import.meta.url), "utf8"));
const RIGS = JSON.parse(readFileSync(new URL("../fixtures/drone/rig-table.json", import.meta.url), "utf8"));
const hex8 = (n) => "0x" + (n >>> 0).toString(16).toUpperCase().padStart(8, "0");
const fixtureAnim = (did) => {
  const a = ANIMS.anims[hex8(did)];
  return { did, numFrames: a.numFrames, numParts: a.numParts, flags: 0, frames: Float32Array.from(a.frames) };
};
const NAMES = ["pack", "place", "goggles"];
const range = (from, to) => {
  const out = [];
  const dir = to >= from ? 1 : -1;
  for (let f = from; dir > 0 ? f <= to : f >= to; f += dir) out.push(f);
  return out;
};
const EXPECTED_ORDER = {
  pack: [...range(0, 19), 19, 19, 19, ...range(19, 0)],
  place: [...range(0, 21), 21, 21, 21, 21, 21, 21, ...range(21, 0)],
  goggles: [...range(0, 20), ...range(20, 0)],
};
const tick = () => new Promise((r) => setImmediate(r));

// ---------------------------------------------------------------------------
// fakes
// ---------------------------------------------------------------------------

const GUID = 0x50000abc;

/** A wasm MotionSequence stand-in on the playhead: the test drives its frame. */
function fakeSeq() {
  return {
    _f: 0, freed: false, readsAfterFree: 0,
    get globalFrameIndex() { if (this.freed) this.readsAfterFree += 1; return this._f; },
    free() { this.freed = true; },
  };
}

/**
 * A fake EntityManager: one pilot instance (`parts` of the given count), the
 * seam (`playLocalClip` installs a local record with a fake seq), `setMotion`
 * (records, stamps lastMotionCommand), the death hold, the holding table and the
 * film-hide set — every call recorded in `calls`.
 */
function fakeEm({ parts = 34, holding = { 1: { partId: 15 }, 2: { partId: 12 } }, playOk = true, holdingGate = null } = {}) {
  const calls = [];
  const inst = {
    guid: GUID, parts: Array.from({ length: parts }, (_, i) => ({ name: `part_${i}` })),
    meta: { modelId: 0x02000001 }, lastMotionCommand: MOTION.READY,
    _attachedChildren: null, _unifiedSeq: null,
  };
  const em = {
    calls, inst, deathHeld: false, playOk,
    entityMap: new Map([[GUID, inst]]),
    _filmHiddenGuids: null,
    playLocalClip(guid, desc, opts) {
      calls.push(["playLocalClip", guid, desc, opts]);
      if (!this.playOk) return false;
      const cur = this.entityMap.get(guid >>> 0);
      if (cur._unifiedSeq) cur._unifiedSeq.seq.free();
      cur._unifiedSeq = { seq: fakeSeq(), desc, clearOnDone: true, hooks: [], lastHookTime: -1, speed: opts?.speed ?? 1, localClip: true };
      return true;
    },
    stopLocalClip(guid) {
      calls.push(["stopLocalClip", guid]);
      const cur = this.entityMap.get(guid >>> 0);
      const ua = cur?._unifiedSeq;
      if (!ua || ua.localClip !== true) return false;
      ua.seq.free();
      cur._unifiedSeq = null;
      return true;
    },
    setMotion(guid, cmd, stance, speed) {
      calls.push(["setMotion", guid, cmd >>> 0, stance >>> 0, speed]);
      const cur = this.entityMap.get(guid >>> 0);
      if (cur) cur.lastMotionCommand = cmd >>> 0;
      return Promise.resolve();
    },
    isDeathHeld(guid) { calls.push(["isDeathHeld", guid]); return this.deathHeld; },
    async _resolveHoldingLocation(setupId, key) {
      calls.push(["_resolveHoldingLocation", setupId, key]);
      if (holdingGate) await holdingGate;
      const e = holding[key];
      if (e === "throw") throw new Error("holding fetch failed");
      return e ?? null;
    },
    setFilmHidden(guid, on) {
      calls.push(["setFilmHidden", guid >>> 0, !!on]);
      if (on) { (this._filmHiddenGuids ??= new Set()).add(guid >>> 0); } else this._filmHiddenGuids?.delete(guid >>> 0);
      return this.entityMap.has(guid >>> 0);
    },
  };
  return em;
}

/** A fake wasm: fetchAnimation → an AnimationJs-like box over the fixture (frames getter counted). */
function fakeWasm({ gate = null, fail = new Set(), flags = 0 } = {}) {
  const w = {
    fetches: [], frameReads: 0, frees: 0,
    async fetchAnimation(did) {
      w.fetches.push(did >>> 0);
      if (gate) await gate;
      if (fail.has(did >>> 0)) throw new Error("DAT miss");
      const a = fixtureAnim(did >>> 0);
      return {
        numFrames: a.numFrames, numParts: a.numParts, flags,
        get frames() { w.frameReads += 1; return new Float32Array(a.frames); },
        free() { w.frees += 1; },
      };
    },
  };
  return w;
}

const calls = (em, name) => em.calls.filter((c) => c[0] === name);

/**
 * A FRESH instance of the real gestures.js (a distinct module URL): loadAnim's
 * per-DID cache is module state, so a check that needs the three clip anims to
 * load differently (POS_FRAMES flags, a DAT miss) must not share it.
 */
const freshGestures = (tag) => import(new URL(`../scene3d/drone/gestures.js?${tag}`, import.meta.url).href);

/** Poll until the job reports done (max n polls); returns the polls (copied). */
function pollAll(g, dt, n, onPoll = null) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    if (onPoll) onPoll(i);
    const p = g.poll(dt);
    rows.push({ ...p });
    if (p.done) break;
  }
  return rows;
}

// ---------------------------------------------------------------------------
// G1 constants
// ---------------------------------------------------------------------------

check("G1 constants: FLOATS_PER_PART, HUMANOID_RIG, LOC_*, MOTION (exact, frozen)", () => {
  assert.equal(FLOATS_PER_PART, 7);
  assert.deepEqual({ ...HUMANOID_RIG }, { rightHand: 15, leftHand: 12, head: 16, minParts: 17 });
  assert.ok(Object.isFrozen(HUMANOID_RIG));
  assert.equal(LOC_RIGHT_HAND, 1);
  assert.equal(LOC_LEFT_HAND, 2);
  assert.deepEqual({ ...MOTION }, { READY: 0x41000003, READ_STATE: 0x43000146, NONCOMBAT: 0x8000003d });
  assert.ok(Object.isFrozen(MOTION));
});

check("G1 GESTURE_CLIPS: frozen at every level, anims / events / frames 43 / 50 / 42 = clipFrameCount(plan)", () => {
  assert.ok(Object.isFrozen(GESTURE_CLIPS));
  assert.deepEqual(Object.keys(GESTURE_CLIPS), NAMES);
  const want = { pack: [0x030003b7, 18, 43], place: [0x03000247, 18, 50], goggles: [0x030004f8, 14, 42] };
  for (const n of NAMES) {
    const c = GESTURE_CLIPS[n];
    assert.ok(Object.isFrozen(c), `${n} frozen`);
    assert.ok(Object.isFrozen(c.plan), `${n}.plan frozen`);
    for (const e of c.plan) assert.ok(Object.isFrozen(e), `${n} plan entry frozen`);
    assert.deepEqual([c.anim, c.eventAtFrame, c.frames], want[n]);
    assert.equal(clipFrameCount(c.plan), c.frames, `${n} frames = clipFrameCount`);
    assert.ok(c.eventAtFrame < c.frames);
  }
  assert.deepEqual(GESTURE_CLIPS.pack.plan.map((e) => ({ ...e })), [{ from: 0, to: 19 }, { hold: 19, frames: 3 }, { from: 19, to: 0 }]);
  assert.deepEqual(GESTURE_CLIPS.place.plan.map((e) => ({ ...e })), [{ from: 0, to: 21 }, { hold: 21, frames: 6 }, { from: 21, to: 0 }]);
  assert.deepEqual(GESTURE_CLIPS.goggles.plan.map((e) => ({ ...e })), [{ from: 0, to: 20 }, { from: 20, to: 0 }]);
});

// ---------------------------------------------------------------------------
// G2 clipFrameCount / buildClip
// ---------------------------------------------------------------------------

check("G2 clipFrameCount: ranges + holds, 0 for every bad plan", () => {
  assert.equal(clipFrameCount([{ from: 0, to: 0 }]), 1);
  assert.equal(clipFrameCount([{ from: 5, to: 2 }, { hold: 2, frames: 4 }]), 8);
  for (const bad of [null, undefined, 7, "x", {}, [], [null], [3], [{}], [{ from: 1 }], [{ hold: 1 }],
    [{ hold: 1, frames: 0 }], [{ hold: -1, frames: 2 }], [{ from: -1, to: 2 }], [{ from: 0.5, to: 2 }],
    [{ hold: 1, frames: 1.5 }], [[0, 1]], [{ from: 0, to: 1 }, "x"], [{ hold: 0, frames: 4000 }]]) {
    assert.equal(clipFrameCount(bad), 0, `bad plan ${JSON.stringify(bad)}`);
  }
});

check("G2 buildClip on the fixture frames: source order, byte-exact slices, k/30 times, one segment, null posFrames", () => {
  for (const n of NAMES) {
    const spec = GESTURE_CLIPS[n];
    const anim = fixtureAnim(spec.anim);
    const c = buildClip(anim, spec.plan);
    assert.ok(c, `${n} built`);
    assert.equal(c.partCount, 34);
    assert.equal(c.numFrames, spec.frames);
    assert.equal(c.framerate, 30);
    assert.deepEqual(Array.from(c.sourceFrames), EXPECTED_ORDER[n], `${n} source order`);
    assert.ok(c.sourceFrames instanceof Uint16Array);
    assert.ok(c.partFrames instanceof Float32Array);
    assert.equal(c.partFrames.length, spec.frames * 34 * 7);
    const stride = 34 * 7;
    const srcBytes = new Uint8Array(anim.frames.buffer);
    const clipBytes = new Uint8Array(c.partFrames.buffer);
    for (let k = 0; k < c.numFrames; k += 1) {
      const s = c.sourceFrames[k] * stride * 4;
      const d = k * stride * 4;
      for (let b = 0; b < stride * 4; b += 1) {
        if (clipBytes[d + b] !== srcBytes[s + b]) assert.fail(`${n} clip frame ${k} byte ${b} differs from source frame ${c.sourceFrames[k]}`);
      }
    }
    assert.ok(c.frameTimes instanceof Float32Array);
    assert.equal(c.frameTimes.length, c.numFrames);
    for (let k = 0; k < c.numFrames; k += 1) assert.equal(c.frameTimes[k], Math.fround(k / 30));
    assert.equal(c.duration, spec.frames / 30);
    assert.equal(c.posFrames, null, "posFrames is null");
    assert.notEqual(Array.isArray(c.posFrames), true, "never an empty array");
    assert.equal(c.rootFrames, null);
    assert.deepEqual(Array.from(c.segmentStarts), [0]);
    assert.deepEqual(Array.from(c.segmentCounts), [spec.frames]);
    assert.deepEqual(Array.from(c.segmentFramerates), [30]);
    assert.deepEqual(Array.from(c.segmentAnimIds), [spec.anim]);
    assert.ok(c.segmentStarts instanceof Uint32Array && c.segmentCounts instanceof Uint32Array);
    assert.ok(c.segmentFramerates instanceof Float32Array && c.segmentAnimIds instanceof Uint32Array);
  }
});

check("G2 buildClip: plain number frames (fixture JSON) == Float32Array frames; deterministic; fps option", () => {
  const spec = GESTURE_CLIPS.goggles;
  const raw = ANIMS.anims[hex8(spec.anim)];
  const a1 = buildClip({ numFrames: raw.numFrames, numParts: raw.numParts, frames: raw.frames }, spec.plan);
  const a2 = buildClip(fixtureAnim(spec.anim), spec.plan);
  assert.deepEqual(Array.from(a1.partFrames), Array.from(a2.partFrames));
  assert.deepEqual(Array.from(a1.segmentAnimIds), [0], "no did → 0");
  assert.deepEqual(buildClip(fixtureAnim(spec.anim), spec.plan), a2, "same inputs → deep-equal");
  const c60 = buildClip(fixtureAnim(spec.anim), spec.plan, { fps: 60 });
  assert.equal(c60.framerate, 60);
  assert.equal(c60.duration, 42 / 60);
  assert.equal(c60.frameTimes[3], Math.fround(3 / 60));
  assert.deepEqual(buildClip(fixtureAnim(spec.anim), spec.plan, null), a2, "a null options argument is the default");
});

check("G2 buildClip refusals → null, never a throw", () => {
  const good = fixtureAnim(GESTURE_CLIPS.pack.anim);
  const plan = GESTURE_CLIPS.pack.plan;
  const cases = [
    [null, plan], [undefined, plan], [7, plan],
    [{ ...good, numParts: 0 }, plan], [{ ...good, numParts: undefined }, plan], [{ ...good, numParts: -34 }, plan],
    [{ ...good, numFrames: 0 }, plan], [{ ...good, numFrames: undefined }, plan],
    [{ ...good, frames: good.frames.subarray(0, good.frames.length - 1) }, plan],
    [{ ...good, frames: null }, plan],
    [good, []], [good, null], [good, "plan"], [good, [null]], [good, [5]],
    [good, [{ from: 0, to: good.numFrames }]], [good, [{ from: good.numFrames, to: 0 }]],
    [good, [{ hold: good.numFrames, frames: 2 }]], [good, [{ from: 0, to: 3 }, { hold: 99, frames: 1 }]],
  ];
  for (const [anim, p] of cases) assert.equal(buildClip(anim, p), null, `refused: ${JSON.stringify(p)?.slice(0, 60)}`);
  for (const fps of [0, -30, NaN, Infinity, "x"]) assert.equal(buildClip(good, plan, { fps }), null, `fps ${fps}`);
});

// ---------------------------------------------------------------------------
// G3 rigProfile
// ---------------------------------------------------------------------------

check("G3 rigProfile on all 26 rig-table rows = row.profile (22 humanoid / 4 no-hands; 11 / 2 heritages)", () => {
  assert.equal(RIGS.rigs.length, 26);
  const kinds = { humanoid: new Set(), "no-hands": new Set() };
  let hum = 0;
  let none = 0;
  for (const row of RIGS.rigs) {
    const m = new Map();
    if (row.rightHandPart !== null) m.set(1, { partId: row.rightHandPart });
    if (row.leftHandPart !== null) m.set(2, { partId: row.leftHandPart });
    const p = rigProfile({ partCount: row.parts, holdingLocations: m });
    assert.equal(p.kind, row.profile, `${row.heritage} ${row.sex} ${row.setup}`);
    kinds[p.kind].add(row.heritage);
    if (p.kind === "humanoid") {
      hum += 1;
      assert.deepEqual([p.rightHand, p.leftHand, p.head], [15, 12, 16]);
      assert.equal(p.head, row.headPart);
      assert.deepEqual(p.rightGrip, { partId: 15 });
      assert.deepEqual(p.leftGrip, { partId: 12 });
    } else {
      none += 1;
      assert.deepEqual(p, { kind: "no-hands", rightHand: -1, leftHand: -1, head: -1, rightGrip: null, leftGrip: null });
    }
  }
  assert.equal(hum, 22);
  assert.equal(none, 4);
  assert.equal(kinds.humanoid.size, 11);
  assert.equal(kinds["no-hands"].size, 2);
});

check("G3 rigProfile inputs: Map by number or name, plain object, the recon frame shape, partial / malformed → no-hands", () => {
  const H = (r, l) => ({ 1: { partId: r }, 2: { partId: l } });
  assert.equal(rigProfile({ partCount: 34, holdingLocations: new Map([["RightHand", { partId: 15 }], ["LeftHand", { partId: 12 }]]) }).kind, "humanoid");
  assert.equal(rigProfile({ partCount: 34, holdingLocations: H(15, 12) }).kind, "humanoid");
  assert.equal(rigProfile({ partCount: 34, holdingLocations: { RightHand: { partId: 15 }, LeftHand: { partId: 12 } } }).kind, "humanoid");
  // The rig table's human Setup carries named entries with {partId, frame: {origin, orientation}}.
  const named = rigProfile({ partCount: 34, holdingLocations: RIGS.humanSetup0x02000001.holdingLocations });
  assert.equal(named.kind, "humanoid");
  assert.deepEqual(named.rightGrip, { partId: 15, ox: 0.025, oy: 0, oz: -0.076, qw: 0.707107, qx: 0.707107, qy: 0, qz: 0 });
  // A live _resolveHoldingLocation entry keeps its numeric fields (a copy, not the cached object).
  const live = { partId: 15, ox: 0.025, oy: 0, oz: -0.076, qw: 0.707107, qx: 0.707107, qy: 0, qz: 0, extra: () => 1 };
  const p = rigProfile({ partCount: 34, holdingLocations: new Map([[1, live], [2, { partId: 12 }]]) });
  assert.deepEqual(p.rightGrip, { partId: 15, ox: 0.025, oy: 0, oz: -0.076, qw: 0.707107, qx: 0.707107, qy: 0, qz: 0 });
  assert.notEqual(p.rightGrip, live);
  assert.doesNotThrow(() => JSON.stringify(p));
  for (const bad of [
    undefined, null, 5, {}, { partCount: 34 }, { holdingLocations: H(15, 12) },
    { partCount: 16, holdingLocations: H(15, 12) }, { partCount: 34, holdingLocations: H(12, 15) },
    { partCount: 34, holdingLocations: { 1: { partId: 15 } } }, { partCount: 34, holdingLocations: { 1: null, 2: { partId: 12 } } },
    { partCount: "34", holdingLocations: H(15, 12) }, { partCount: NaN, holdingLocations: H(15, 12) },
    { partCount: 34, holdingLocations: H("15", "12") }, { partCount: 34, holdingLocations: "x" },
  ]) {
    assert.equal(rigProfile(bad).kind, "no-hands", `no-hands for ${JSON.stringify(bad)}`);
  }
  assert.deepEqual(rigProfile({ partCount: 34, holdingLocations: H(15, 12) }), rigProfile({ partCount: 34, holdingLocations: H(15, 12) }));
  assert.notEqual(rigProfile(), rigProfile(), "fresh objects");
});

// ---------------------------------------------------------------------------
// G4 loadAnim / readHoldingLocations
// ---------------------------------------------------------------------------

check("G4 loadAnim: frames read once, AnimationJs freed, cached per DID; rejection / missing export → null (retried)", async () => {
  let reads = 0;
  let frees = 0;
  let fetches = 0;
  const DID = 0x03001001;
  const frames = new Float32Array(2 * 3 * 7).map((_, i) => i * 0.5);
  const wasm = {
    async fetchAnimation(did) {
      fetches += 1;
      assert.equal(did, DID);
      return {
        numFrames: 2, numParts: 3, flags: 1,
        get frames() { reads += 1; return new Float32Array(frames); },
        free() { frees += 1; },
      };
    },
  };
  const a = await loadAnim(wasm, DID);
  assert.deepEqual({ ...a, frames: Array.from(a.frames) }, { did: DID, numFrames: 2, numParts: 3, flags: 1, frames: Array.from(frames) });
  assert.equal(reads, 1, "the frames getter is read exactly once");
  assert.equal(frees, 1, "freed in finally");
  const again = await loadAnim({ fetchAnimation() { throw new Error("must not be called"); } }, DID);
  assert.equal(again, a, "cached per DID");
  assert.equal(fetches, 1);
  // a rejection (DAT miss) → null, and the miss is not cached
  let rejects = 0;
  const bad = { async fetchAnimation() { rejects += 1; throw new Error("DAT miss"); } };
  assert.equal(await loadAnim(bad, 0x03001002), null);
  assert.equal(await loadAnim(bad, 0x03001002), null);
  assert.equal(rejects, 2, "a miss is retried");
  // a throwing frames getter still frees
  let freed = 0;
  const throwing = { async fetchAnimation() { return { numFrames: 1, numParts: 1, get frames() { throw new Error("freed ptr"); }, free() { freed += 1; } }; } };
  assert.equal(await loadAnim(throwing, 0x03001003), null);
  assert.equal(freed, 1);
  assert.equal(await loadAnim(null, 0x03001004), null);
  assert.equal(await loadAnim({}, 0x03001004), null, "missing export");
  assert.equal(await loadAnim({ async fetchAnimation() { return null; } }, 0x03001005), null);
});

check("G4 loadAnim: concurrent callers share one fetch", async () => {
  let fetches = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const wasm = { async fetchAnimation() { fetches += 1; await gate; return { numFrames: 1, numParts: 1, frames: new Float32Array(7), free() {} }; } };
  const p1 = loadAnim(wasm, 0x03001006);
  const p2 = loadAnim(wasm, 0x03001006);
  release();
  const [a, b] = await Promise.all([p1, p2]);
  assert.equal(a, b);
  assert.equal(fetches, 1);
});

check("G4 readHoldingLocations: keys 1 and 2 through _resolveHoldingLocation; a throw or null → missing", async () => {
  const em = fakeEm({ holding: { 1: { partId: 15 }, 2: "throw" } });
  const m = await readHoldingLocations(em, 0x102000001);
  assert.ok(m instanceof Map);
  assert.deepEqual([...m.keys()], [1]);
  assert.deepEqual(calls(em, "_resolveHoldingLocation").map((c) => [c[1], c[2]]), [[0x02000001, 1], [0x02000001, 2]], "setupId >>> 0, keys 1 then 2");
  assert.equal((await readHoldingLocations(fakeEm({ holding: {} }), 1)).size, 0);
  assert.equal((await readHoldingLocations(null, 1)).size, 0);
  assert.equal((await readHoldingLocations({}, 1)).size, 0);
});

// ---------------------------------------------------------------------------
// G5 the driver
// ---------------------------------------------------------------------------

check("G5 createGestureDriver requires entityManager and a non-zero guid", () => {
  assert.throws(() => createGestureDriver({ guid: GUID }), TypeError);
  assert.throws(() => createGestureDriver({ entityManager: fakeEm() }), TypeError);
  assert.throws(() => createGestureDriver({ entityManager: fakeEm(), guid: 0 }), TypeError);
  assert.throws(() => createGestureDriver(), TypeError);
  assert.doesNotThrow(() => createGestureDriver({ entityManager: fakeEm(), guid: GUID }));
});

check("G5 ready(): humanoid profile known before the clips finish; three clips built; memoised; JSON-safe", async () => {
  const em = fakeEm();
  let release;
  const gate = new Promise((r) => { release = r; });
  const wasm = fakeWasm({ gate });
  const g = createGestureDriver({ entityManager: em, wasm, guid: GUID });
  assert.equal(g.profile(), null);
  const p = g.ready();
  assert.equal(g.ready(), p, "memoised");
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(g.profile()?.kind, "humanoid", "the profile is known while the anims still load");
  release();
  const r = await p;
  assert.equal(r.ok, true);
  assert.equal(r.profile.kind, "humanoid");
  assert.deepEqual(r.clips, { pack: true, place: true, goggles: true });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  assert.deepEqual(calls(em, "_resolveHoldingLocation").map((c) => c[1]), [0x02000001, 0x02000001], "setup = meta.modelId");
  g.dispose();
});

check("G5 ready() never rejects: missing pilot → {ok:false, profile:null}; throwing entityMap / holding table / DAT misses still resolve", async () => {
  const NONE = { pack: false, place: false, goggles: false };
  // no pilot instance: index.js maps `profile: null` to the no-hands flow
  const em0 = fakeEm();
  em0.entityMap.delete(GUID);
  const r0 = await createGestureDriver({ entityManager: em0, wasm: fakeWasm(), guid: GUID }).ready();
  assert.deepEqual(r0, { ok: false, profile: null, clips: NONE });
  // a throwing entityMap
  const emT = fakeEm();
  emT.entityMap = { get() { throw new Error("boom"); } };
  const gT = createGestureDriver({ entityManager: emT, wasm: fakeWasm(), guid: GUID });
  assert.deepEqual(await gT.ready(), { ok: false, profile: null, clips: NONE });
  assert.equal(gT.profile(), null);
  assert.doesNotThrow(() => { // the per-call methods never throw either (SPEC §2.8)
    assert.equal(gT.clip("pack").mode, "timer");
    gT.poll(0.1);
    gT.stop();
    gT.hold();
    assert.equal(gT.watch(1), false);
    assert.equal(gT.watch(3), false);
    gT.hideWielded(true);
    gT.applyWielded();
    gT.hideWielded(false);
    gT.release();
    gT.rebind(null);
    gT.dispose();
  });
  // both holding lookups throw → a resolved no-hands rig, nothing loaded
  const w = fakeWasm();
  const rH = await createGestureDriver({ entityManager: fakeEm({ holding: { 1: "throw", 2: "throw" } }), wasm: w, guid: GUID }).ready();
  assert.equal(rH.ok, true);
  assert.equal(rH.profile.kind, "no-hands");
  assert.deepEqual(rH.clips, NONE);
  assert.equal(w.fetches.length, 0);
  // a humanoid whose three anims all miss in the DAT (fresh module: empty anim cache) → timer jobs
  const G = await freshGestures("dat-miss");
  const emM = fakeEm();
  const gM = G.createGestureDriver({ entityManager: emM, guid: GUID,
    wasm: fakeWasm({ fail: new Set([0x030003b7, 0x03000247, 0x030004f8]) }) });
  const rM = await gM.ready();
  assert.equal(rM.ok, true);
  assert.equal(rM.profile.kind, "humanoid");
  assert.deepEqual(rM.clips, NONE);
  assert.equal(gM.clip("pack").mode, "timer");
  assert.equal(calls(emM, "playLocalClip").length, 0);
  for (const r of [r0, rH, rM]) assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  gM.dispose();
});

check("G5 ready(): an Animation with POS_FRAMES (flags & 1) still builds; exactly one warn (root motion dropped)", async () => {
  const G = await freshGestures("root-motion");
  const logs = [];
  const em = fakeEm();
  const g = G.createGestureDriver({ entityManager: em, wasm: fakeWasm({ flags: 1 }), guid: GUID, log: (e) => logs.push(e) });
  const r = await g.ready();
  assert.deepEqual(r.clips, { pack: true, place: true, goggles: true }, "built anyway");
  const warns = logs.filter((e) => e && e.level === "warn");
  assert.equal(warns.length, 1, "one warn for the whole rig");
  assert.equal(warns[0].event, "drone");
  assert.equal(typeof warns[0].message, "string");
  assert.equal(await g.ready(), r);
  assert.equal(logs.filter((e) => e && e.level === "warn").length, 1, "memoised: no second warn");
  assert.equal(g.clip("place").mode, "clip");
  const desc = calls(em, "playLocalClip").at(-1)[2];
  assert.equal(desc.posFrames, null, "the root motion is never carried");
  assert.equal(desc.rootFrames, null);
  const p = await g.clipParity();
  for (const n of NAMES) assert.equal(p.clips[n].flags, 1, `${n}: clipParity reports the flags`);
  g.dispose();
});

check("G5 clip(): through playLocalClip(guid, desc, {speed}); event exactly once at the event frame; done once; then inactive", async () => {
  const em = fakeEm();
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  await g.ready();
  const r = g.clip("pack", 1.5);
  assert.deepEqual(r, { ok: true, mode: "clip", name: "pack" });
  const play = calls(em, "playLocalClip");
  assert.equal(play.length, 1);
  assert.equal(play[0][1], GUID);
  assert.equal(play[0][2].numFrames, 43);
  assert.equal(play[0][2].posFrames, null);
  assert.deepEqual(play[0][3], { speed: 1.5 });
  const rec = em.inst._unifiedSeq;
  const rows = pollAll(g, 1 / 60, 60, (i) => {
    rec.seq._f = Math.min(42, i); // the playhead walks one clip frame per poll
    if (i === 45) { rec.seq.free(); em.inst._unifiedSeq = null; } // clearOnDone hand-back
  });
  const events = rows.map((p, i) => (p.event ? i : -1)).filter((i) => i >= 0);
  assert.deepEqual(events, [18], "the event fires on the first poll with globalFrameIndex >= 18, once");
  const dones = rows.filter((p) => p.done);
  assert.equal(dones.length, 1);
  assert.equal(rows.length, 46, "done on the poll after the record left the playhead");
  assert.equal(dones[0].active, false);
  assert.equal(dones[0].name, "pack");
  assert.equal(dones[0].rigChanged, false);
  assert.equal(rec.seq.readsAfterFree, 0, "never touches rec.seq once it is no longer the playhead");
  const after = g.poll(1 / 60);
  assert.deepEqual({ ...after }, { active: false, name: null, event: false, done: false, rigChanged: false });
  assert.equal(g.poll(0), after, "the poll object is reused");
  g.dispose();
});

check("G5 a clip cut before its event frame fires the event on its done poll (once)", async () => {
  const em = fakeEm();
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  await g.ready();
  g.clip("place");
  const rec = em.inst._unifiedSeq;
  rec.seq._f = 5;
  assert.equal(g.poll(0.016).event, false);
  // a fizzle / death branch frees our one-shot mid-clip
  rec.seq.free();
  em.inst._unifiedSeq = null;
  const p = g.poll(0.016);
  assert.equal(p.event, true);
  assert.equal(p.done, true);
  assert.equal(p.rigChanged, false);
  const later = g.poll(0.016);
  assert.equal(later.event || later.done, false);
  assert.equal(rec.seq.readsAfterFree, 0);
  g.dispose();
});

check("G5 timer jobs: part-count mismatch (33-part humanoid), no-hands (3 parts) and clipMode 'timer' — event 18/30/s, end 43/30/s", async () => {
  // a humanoid holding table on 33 parts: the profile is humanoid, the 34-part anims cannot play
  const em33 = fakeEm({ parts: 33 });
  const g33 = createGestureDriver({ entityManager: em33, wasm: fakeWasm(), guid: GUID });
  const r33 = await g33.ready();
  assert.equal(r33.profile.kind, "humanoid");
  assert.deepEqual(r33.clips, { pack: false, place: false, goggles: false });
  // a 3-part rig: no-hands, nothing loaded
  const w3 = fakeWasm();
  const em3 = fakeEm({ parts: 3 });
  const g3 = createGestureDriver({ entityManager: em3, wasm: w3, guid: GUID });
  const r3 = await g3.ready();
  assert.equal(r3.profile.kind, "no-hands");
  assert.equal(w3.fetches.length, 0, "a no-hands rig loads no anims");
  // a built humanoid forced to timer by clipMode
  const emT = fakeEm();
  const gT = createGestureDriver({ entityManager: emT, wasm: fakeWasm(), guid: GUID, clipMode: () => "timer" });
  await gT.ready();
  for (const [g, em] of [[g33, em33], [g3, em3], [gT, emT]]) {
    for (const speed of [1, 1.5]) {
      assert.deepEqual(g.clip("pack", speed), { ok: true, mode: "timer", name: "pack" });
      const dt = 1 / 120;
      const rows = pollAll(g, dt, 400);
      const ev = rows.findIndex((p) => p.event);
      const done = rows.findIndex((p) => p.done);
      assert.equal(rows.filter((p) => p.event).length, 1);
      assert.equal(rows.filter((p) => p.done).length, 1);
      assert.equal(ev + 1, Math.round((18 / 30 / speed) / dt), `event at 18/30/${speed} s`);
      assert.equal(done + 1, Math.round((43 / 30 / speed) / dt), `end at 43/30/${speed} s`);
    }
    assert.equal(calls(em, "playLocalClip").length, 0, "a timer job moves no rig");
    g.dispose();
  }
});

check("G5 clipMode() is read on every clip() call (a live tune switch, DV-28); an invalid speed plays at 1", async () => {
  let mode = "clip";
  const em = fakeEm();
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID, clipMode: () => mode });
  await g.ready();
  assert.equal(g.clip("pack").mode, "clip");
  const a = em.inst._unifiedSeq;
  mode = "timer";
  assert.equal(g.clip("place").mode, "timer");
  assert.ok(a.seq.freed, "the replaced clip left the playhead");
  assert.equal(em.inst._unifiedSeq, null);
  assert.equal(calls(em, "playLocalClip").length, 1, "a timer job moves no rig");
  mode = "clip";
  for (const bad of [NaN, 0, -2, "x"]) {
    assert.equal(g.clip("goggles", bad).mode, "clip");
    assert.deepEqual(calls(em, "playLocalClip").at(-1)[3], { speed: 1 }, `speed ${bad} → 1`);
  }
  const gX = createGestureDriver({ entityManager: fakeEm(), wasm: fakeWasm(), guid: GUID, clipMode: () => { throw new Error("tune"); } });
  await gX.ready();
  assert.equal(gX.clip("pack").mode, "clip", "a throwing clipMode reads as 'clip'");
  g.dispose();
  gX.dispose();
});

check("G5 the seam refusing (playLocalClip false) → a timer job", async () => {
  const em = fakeEm({ playOk: false });
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  await g.ready();
  assert.equal(g.clip("goggles").mode, "timer");
  assert.equal(calls(em, "playLocalClip").length, 1);
  const rows = pollAll(g, 0.1, 30);
  assert.equal(rows.findIndex((p) => p.event), 4, "14/30 s = 0.467 → the 5th 0.1 s poll");
  assert.equal(rows.findIndex((p) => p.done), 13, "42/30 s = 1.4 → the 14th poll");
  g.dispose();
});

check("G5 clip(B) while A runs and stop(): only the current job ever reports", async () => {
  const em = fakeEm();
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  await g.ready();
  g.clip("pack");
  const a = em.inst._unifiedSeq;
  a.seq._f = 10;
  g.poll(0.016);
  g.clip("goggles"); // replaces A: our clip leaves the playhead first
  assert.equal(calls(em, "stopLocalClip").length, 1, "A stopped before B plays");
  assert.ok(a.seq.freed);
  const b = em.inst._unifiedSeq;
  assert.notEqual(b, a);
  b.seq._f = 3;
  const p1 = g.poll(0.016);
  assert.equal(p1.name, "goggles");
  assert.equal(p1.event || p1.done, false, "A's event (frame 18) and end never surface");
  assert.equal(a.seq.readsAfterFree, 0);
  // stop(): B is discarded silently
  assert.equal(g.stop(), true, "our clip was freed");
  assert.equal(em.inst._unifiedSeq, null);
  for (let i = 0; i < 5; i += 1) {
    const p = g.poll(0.5);
    assert.equal(p.event || p.done || p.active, false);
  }
  assert.equal(g.stop(), false, "nothing left to stop");
  // a timer job replaced by clip() never reports either
  const emT = fakeEm({ parts: 3 });
  const gT = createGestureDriver({ entityManager: emT, wasm: fakeWasm(), guid: GUID });
  await gT.ready();
  gT.clip("pack");
  gT.poll(0.5);
  gT.clip("place");
  const rows = pollAll(gT, 0.05, 100);
  assert.equal(rows.filter((p) => p.event).length, 1);
  assert.ok(rows.every((p) => p.name === "place"));
  g.dispose();
  gT.dispose();
});

check("G5 rebind(): the next poll reports done with rigChanged; ready() re-resolves; an instance swap without rebind does too", async () => {
  const em = fakeEm();
  const w = fakeWasm();
  const g = createGestureDriver({ entityManager: em, wasm: w, guid: GUID });
  const r1 = g.ready();
  await r1;
  g.clip("pack");
  const rec = em.inst._unifiedSeq;
  rec.seq._f = 4;
  g.poll(0.016);
  // the rig is rebuilt: a NEW EntityInstance under the same guid
  const fresh = { ...em.inst, _unifiedSeq: null, parts: em.inst.parts.slice() };
  em.entityMap.set(GUID, fresh);
  g.rebind(fresh);
  const p = g.poll(0.016);
  assert.equal(p.done, true);
  assert.equal(p.rigChanged, true);
  assert.equal(p.active, false);
  assert.equal(g.poll(0.016).done, false, "done exactly once");
  const r2 = g.ready();
  assert.notEqual(r2, r1, "the memo was dropped");
  assert.equal((await r2).profile.kind, "humanoid");
  // no rebind: the instance changes under a running clip → done + rigChanged on the next poll
  g.clip("place");
  const em2inst = { ...fresh, _unifiedSeq: null };
  em.entityMap.set(GUID, em2inst);
  const q = g.poll(0.016);
  assert.equal(q.done && q.rigChanged, true);
  // a timer job is ended by rebind the same way
  const emT = fakeEm({ parts: 3 });
  const gT = createGestureDriver({ entityManager: emT, wasm: w, guid: GUID });
  await gT.ready();
  gT.clip("goggles");
  gT.rebind(emT.inst);
  const t = gT.poll(0.016);
  assert.equal(t.done && t.rigChanged, true);
  g.dispose();
  gT.dispose();
});

check("G5 a rebind while ready() is still resolving hands the first promise the rebuilt rig's answer (never a stale no-hands)", async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const em = fakeEm({ holdingGate: gate });
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  const first = g.ready(); // index.js latches `rig` from this one
  for (let i = 0; i < 5; i += 1) await tick();
  assert.equal(g.profile(), null, "still resolving the holding table");
  const fresh = { ...em.inst, parts: em.inst.parts.slice(), _unifiedSeq: null };
  em.entityMap.set(GUID, fresh);
  g.rebind(fresh); // the rig was rebuilt mid-resolve
  release();
  const r = await first;
  assert.equal(r.ok, true);
  assert.equal(r.profile.kind, "humanoid");
  assert.deepEqual(r.clips, { pack: true, place: true, goggles: true });
  assert.equal(await g.ready(), r, "the re-resolution is the new memo");
  g.dispose();
});

check("G5 hold / release: setMotion(guid, cmd, 0x8000003D, 1); no Ready on a death-held rig; never rejects", async () => {
  const em = fakeEm();
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  await g.hold();
  await g.hold(MOTION.READ_STATE, 1);
  assert.deepEqual(calls(em, "setMotion").map((c) => c.slice(1)), [
    [GUID, 0x43000146, 0x8000003d, 1], [GUID, 0x43000146, 0x8000003d, 1],
  ]);
  await g.release();
  assert.deepEqual(calls(em, "setMotion").at(-1).slice(1), [GUID, 0x41000003, 0x8000003d, 1]);
  em.deathHeld = true;
  const before = calls(em, "setMotion").length;
  await g.release();
  assert.equal(calls(em, "setMotion").length, before, "Ready on a corpse would stand it up (CQ-06 lets Ready through)");
  // a throwing / rejecting setMotion never rejects hold / release
  em.setMotion = () => { throw new Error("boom"); };
  em.deathHeld = false;
  await g.hold();
  em.setMotion = () => Promise.reject(new Error("boom"));
  await g.release();
  g.dispose();
});

check("G5 watch(): re-issues at most once per second, only on a differing lastMotionCommand, never on a death hold", async () => {
  const em = fakeEm();
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  assert.equal(g.watch(0), false, "nothing held");
  await g.hold();
  const issued = () => calls(em, "setMotion").length;
  const n0 = issued();
  assert.equal(g.watch(10.0), false, "the first watch after a hold starts the 1 s clock");
  assert.equal(g.watch(11.5), false, "lastMotionCommand is still ReadState");
  em.inst.lastMotionCommand = MOTION.READY; // a server UpdateMotion / local lane re-issued Ready
  assert.equal(g.watch(11.6), true, "re-issued");
  assert.deepEqual(calls(em, "setMotion").at(-1).slice(1), [GUID, 0x43000146, 0x8000003d, 1]);
  em.inst.lastMotionCommand = MOTION.READY; // stomped again at once
  assert.equal(g.watch(11.9), false, "at most once per second");
  assert.equal(g.watch(12.59), false);
  assert.equal(g.watch(12.6), true);
  em.inst.lastMotionCommand = MOTION.READY;
  em.deathHeld = true;
  assert.equal(g.watch(14), false, "a death-held rig is never re-posed");
  em.deathHeld = false;
  assert.equal(g.watch(NaN), false);
  await g.release();
  em.inst.lastMotionCommand = MOTION.READY;
  assert.equal(g.watch(20), false, "release() clears the held command");
  assert.equal(issued(), n0 + 2 + 1, "two watchdog re-issues + the release Ready");
  g.dispose();
});

check("G5 rebind(inst) keeps heldCmd: the watchdog re-asserts ReadState on the rebuilt rig", async () => {
  const em = fakeEm();
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  await g.ready();
  await g.hold();
  assert.equal(g.watch(10), false, "the clock starts");
  const fresh = { ...em.inst, parts: em.inst.parts.slice(), _unifiedSeq: null, lastMotionCommand: MOTION.READY };
  em.entityMap.set(GUID, fresh); // the rebuilt rig spawned in Ready
  g.rebind(fresh);
  assert.equal(g.watch(11.2), true, "still held after the rebind");
  assert.deepEqual(calls(em, "setMotion").at(-1).slice(1), [GUID, 0x43000146, 0x8000003d, 1]);
  assert.equal(fresh.lastMotionCommand, MOTION.READ_STATE, "re-issued on the NEW instance");
  g.dispose();
});

check("G5 hideWielded round trip: only the pilot's children, film's hides skipped, exactly ours restored (absent guids too)", () => {
  const em = fakeEm();
  const other = { guid: 0x50000def, _attachedChildren: new Set([0x80000099]) };
  em.entityMap.set(other.guid, other);
  em.entityMap.set(0x80000001, { guid: 0x80000001 });
  em.entityMap.set(0x80000002, { guid: 0x80000002 });
  em.inst._attachedChildren = new Set([0x80000001, 0x80000002, 0x80000003 /* not spawned */]);
  em._filmHiddenGuids = new Set([0x80000002]); // film already hides this one
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  assert.equal(g.applyWielded(), 0, "not hidden yet: applyWielded does nothing");
  assert.equal(calls(em, "setFilmHidden").length, 0);
  assert.equal(g.hideWielded(true), 2);
  assert.deepEqual(calls(em, "setFilmHidden").map((c) => c.slice(1)), [[0x80000001, true], [0x80000003, true]]);
  // a newly wielded item while flying
  em.inst._attachedChildren.add(0x80000004);
  assert.equal(g.applyWielded(), 3);
  assert.equal(g.applyWielded(), 3, "idempotent");
  assert.deepEqual(calls(em, "setFilmHidden").map((c) => c.slice(1)).at(-1), [0x80000004, true]);
  assert.equal(g.hideWielded(false), 3);
  const offs = calls(em, "setFilmHidden").filter((c) => c[2] === false).map((c) => c[1]).sort();
  assert.deepEqual(offs, [0x80000001, 0x80000003, 0x80000004], "exactly ours, absent guid included");
  assert.ok(em._filmHiddenGuids.has(0x80000002), "film's hide survives");
  assert.ok(!calls(em, "setFilmHidden").some((c) => c[1] === 0x80000099), "another entity's children untouched");
  assert.equal(g.hideWielded(false), 0);
  g.dispose();
});

check("G5 createWieldedHider (SPEC §6.10): apply / restore / hidden; no children → 0", () => {
  const em = fakeEm();
  const h = createWieldedHider(em, GUID);
  assert.equal(h.apply(), 0, "null _attachedChildren");
  em.inst._attachedChildren = new Set([0x80000010]);
  assert.equal(h.apply(), 1);
  assert.deepEqual(h.hidden(), [0x80000010]);
  assert.equal(h.restore(), 1);
  assert.deepEqual(h.hidden(), []);
  assert.equal(h.restore(), 0);
});

check("G5 clipParity(): every clip rebuilt with zero error; JSON-safe; setupId hex", async () => {
  const em = fakeEm();
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  const r = await g.clipParity();
  assert.equal(r.ok, true);
  assert.equal(r.setupId, "0x02000001");
  for (const n of NAMES) assert.deepEqual(r.clips[n], { built: true, flags: 0, maxPosErr: 0, maxQuatErr: 0 });
  assert.deepEqual(JSON.parse(JSON.stringify(r)), r);
  const em33 = fakeEm({ parts: 33 });
  const r33 = await createGestureDriver({ entityManager: em33, wasm: fakeWasm(), guid: GUID }).clipParity();
  assert.equal(r33.clips.pack.built, false, "34-part anims are not playable on a 33-part rig");
  g.dispose();
});

check("G5 unknown clip → {ok:false, mode:null}; dispose stops, restores, issues no Ready, is idempotent, leaves the driver inert", async () => {
  const em = fakeEm();
  const g = createGestureDriver({ entityManager: em, wasm: fakeWasm(), guid: GUID });
  await g.ready();
  assert.deepEqual(g.clip("dance"), { ok: false, mode: null, name: "dance" });
  assert.deepEqual(g.clip(undefined), { ok: false, mode: null, name: undefined });
  em.inst._attachedChildren = new Set([0x80000001]);
  g.hideWielded(true);
  await g.hold();
  g.clip("pack");
  const n = calls(em, "setMotion").length;
  g.dispose();
  assert.equal(em.inst._unifiedSeq, null, "our clip was stopped");
  assert.deepEqual(calls(em, "setFilmHidden").at(-1).slice(1), [0x80000001, false]);
  assert.equal(calls(em, "setMotion").length, n, "dispose issues no Ready");
  g.dispose();
  assert.deepEqual(g.clip("pack"), { ok: false, mode: null, name: "pack" });
  assert.equal(g.poll(0.1).active, false);
  assert.equal(g.watch(100), false);
  assert.equal(g.applyWielded(), 0);
  await g.hold();
  assert.equal(calls(em, "setMotion").length, n, "inert after dispose");
});

// ---------------------------------------------------------------------------

for (const run of pending) await run();
console.log(`drone_gestures: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
