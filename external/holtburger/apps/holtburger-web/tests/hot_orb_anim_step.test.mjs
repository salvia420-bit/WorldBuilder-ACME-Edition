// tests/hot_orb_anim_step.test.mjs — lane F hot spots (2026-10-26): the
// ?orbAnimSync step in plugins/vitals-orbs.js reads first, then writes.
//
// CLAIM: the new `step(now)` leaves every Animation in exactly the state the
// shipped read-write-interleaved step leaves it (play state, current time,
// adoption start), issues exactly the same state-changing calls per animation
// in the same order (pause, currentTime =, play on release), keeps the same
// live list in the same order, and survives the same exceptions — while
// forcing ONE style flush per cadence tick instead of one per pane plus one
// per loop.
//
// HOW: a small model of Blink's Web Animations surface. `getAnimations()` and
// a CSSAnimation's `playState` getter flush style (Blink CSSAnimation::
// playState → FlushStyles → UpdateStyleAndLayoutTree); `currentTime =` dirties
// the target's animation style; `pause()` is a no-op on a paused animation and
// leaves a pending pause that the next `currentTime =` completes (spec "silently
// set the current time"). The SHIPPED step is copied verbatim below as the
// reference; both run over identical scripted worlds (loops starting and
// ending between ticks, a finite glare, a not-yet-started loop, loops that
// throw from playState / pause / the currentTime setter), then release().
//
// Run:   cd apps/holtburger-web && node tests/hot_orb_anim_step.test.mjs [--bench]

globalThis.window = globalThis;
globalThis.addEventListener = () => {};
globalThis.removeEventListener = () => {};
globalThis.document = {
  createElement: () => ({ style: {}, dataset: {}, classList: { add() {}, remove() {}, toggle() {} }, appendChild() {}, setAttribute() {}, addEventListener() {} }),
  getElementById: () => null, head: { appendChild() {}, prepend() {} }, body: { appendChild() {} },
  addEventListener() {}, removeEventListener() {},
  documentElement: { style: { setProperty() {} } },
};

const O = await import("../plugins/vitals-orbs.js");
const { __setOrbAnimSyncForTest, makeOrbAnimSync } = O;

let passed = 0, failed = 0;
function check(name, fn) {
  try { fn(); passed += 1; console.log(`  [PASS] ${name}`); }
  catch (err) { failed += 1; console.log(`  [FAIL] ${name} — ${err.message}`); }
}
function assert(c, m) { if (!c) throw new Error(m); }

// ── the shipped step (vitals-orbs.js before 2026-10-26), verbatim ───────────
function makeReferenceSync(roots) {
  const _animStart = new WeakMap();
  let live = [];
  return {
    step(now) {
      const next = [];
      for (const root of roots) {
        if (!root || typeof root.getAnimations !== "function") continue;
        let anims;
        try { anims = root.getAnimations({ subtree: true }); } catch (_) { continue; }
        for (const a of anims) {
          let start = _animStart.get(a);
          if (start === undefined) {
            let inf = false;
            try { inf = a.effect?.getTiming?.().iterations === Infinity; } catch (_) {}
            const ct = a.currentTime;
            if (!inf || ct == null) continue;
            start = now - Number(ct);
            _animStart.set(a, start);
          }
          try {
            if (a.playState !== "paused") a.pause();
            a.currentTime = now - start;
            next.push(a);
          } catch (_) {}
        }
      }
      live = next;
    },
    release(now) {
      for (const a of live) {
        try {
          const start = _animStart.get(a);
          if (start !== undefined) a.currentTime = now - start;
          a.play();
        } catch (_) {}
      }
      live = [];
    },
    get count() { return live.length; },
  };
}

// ── a Blink-like model ───────────────────────────────────────────────────────
function makeWorld() {
  const doc = { dirty: false, flushes: 0, timeline: 0, log: [] };
  const flush = () => { if (doc.dirty) { doc.flushes += 1; doc.dirty = false; } };
  class Anim {
    constructor(id, { start = 0, iterations = Infinity, unstarted = false, throws = null } = {}) {
      this.id = id; this._start = start; this._paused = false; this._pendingPause = false;
      this._hold = null; this._iterations = iterations; this._unstarted = unstarted; this._throws = throws;
      this.effect = { getTiming: () => ({ iterations: this._iterations }) };
    }
    get playState() {
      flush(); // CSSAnimation::playState → FlushStyles
      if (this._throws === "playState") throw new Error("playState");
      return this._paused ? "paused" : "running";
    }
    get currentTime() {
      if (this._unstarted) return null;
      return this._paused ? this._hold : doc.timeline - this._start;
    }
    set currentTime(v) {
      if (this._throws === "set") throw new Error("set");
      doc.log.push(`${this.id}:set:${v}`);
      if (this._paused) { this._hold = v; this._pendingPause = false; }
      else this._start = doc.timeline - v;
      doc.dirty = true; // effect invalidated → animation style recalc
    }
    pause() {
      if (this._throws === "pause") throw new Error("pause");
      if (this._paused) return; // spec: abort when already paused
      doc.log.push(`${this.id}:pause`);
      this._hold = doc.timeline - this._start; this._paused = true; this._pendingPause = true;
    }
    play() {
      doc.log.push(`${this.id}:play`);
      if (this._paused) { this._start = doc.timeline - this._hold; this._paused = false; this._pendingPause = false; }
    }
    snapshot() { return [this.id, this._paused, this._paused ? this._hold : this.currentTime, this._pendingPause]; }
  }
  const root = (list) => ({ list, getAnimations(opts) { assert(opts && opts.subtree === true, "subtree"); flush(); return this.list.slice(); } });
  return { doc, Anim, root };
}

// Scripted 3-pane world; `script(world, tick)` mutates the lists between ticks.
function buildScenario() {
  const w = makeWorld();
  const A = (id, o) => new w.Anim(id, o);
  const health = [A("sspecH", { start: -500 }), A("bub1", { start: -900 }), A("bub2", { start: -120 }), A("glareH", { iterations: 1 })];
  const stamina = [A("sspecS", { start: -40 }), A("bub3", { start: -77 }), A("notYet", { unstarted: true })];
  const mana = [A("shimmer", { start: -1200 }), A("glint1", { start: -10 }), A("glint2", { start: -20 }), A("bad1", { throws: "playState" })];
  const roots = [w.root(health), w.root(stamina), w.root(mana), null, {}];
  const extra = { beat: A("beat", { start: -3 }), bloom: A("bloom", { start: -60 }), bad2: A("bad2", { throws: "pause" }), bad3: A("bad3", { throws: "set" }) };
  const script = (tick) => {
    if (tick === 3) roots[0].list.push(extra.beat);                // low-HP heartbeat starts
    if (tick === 5) roots[2].list.splice(1, 1);                     // a glint ended
    if (tick === 6) roots[1].list.push(extra.bad2, extra.bloom);   // fracture web built lazily
    if (tick === 7) roots[1].list[2]._unstarted = false;            // the pending loop started
    if (tick === 8) roots[0].list.push(extra.bad3);
    if (tick === 9) roots[0].list.splice(3, 1);                     // glare finished
    if (tick === 11) roots[0].list = roots[0].list.filter((a) => a.id !== "beat"); // HP recovered
  };
  return { w, roots, script, all: [...health, ...stamina, ...mana, ...Object.values(extra)] };
}

function runArm(makeSync, ticks = 14) {
  const sc = buildScenario();
  const sync = makeSync(sc.roots);
  const perTickFlushes = [];
  const counts = [];
  const tickStates = [];
  for (let t = 0; t < ticks; t++) {
    sc.script(t);
    sc.w.doc.timeline = 1000 + t * 33.3;
    sc.w.doc.dirty = true;                       // other rAF callbacks dirtied style this frame
    const f0 = sc.w.doc.flushes;
    sync.step(sc.w.doc.timeline);
    perTickFlushes.push(sc.w.doc.flushes - f0);
    counts.push(sync.count);
    tickStates.push(JSON.stringify(sc.all.map((a) => a.snapshot())));
  }
  sc.w.doc.timeline += 50;
  sync.release(sc.w.doc.timeline);
  counts.push(sync.count);
  return { log: sc.w.doc.log, states: sc.all.map((a) => a.snapshot()), perTickFlushes, counts, tickStates };
}

__setOrbAnimSyncForTest(true);
const ref = runArm(makeReferenceSync);
const neu = runArm(makeOrbAnimSync);
__setOrbAnimSyncForTest(undefined);

check("[1] same final Animation states (paused, current time, pending pause) after 14 ticks + release", () => {
  const a = JSON.stringify(ref.states), b = JSON.stringify(neu.states);
  assert(a === b, `\n    ref ${a}\n    new ${b}`);
});
check("[1b] same Animation states after EVERY tick (what the next frame renders)", () => {
  const i = ref.tickStates.findIndex((x, k) => x !== neu.tickStates[k]);
  assert(i < 0, `tick ${i}:\n    ref ${ref.tickStates[i]}\n    new ${neu.tickStates[i]}`);
});
check("[2] same state-changing calls per animation, in the same order", () => {
  const per = (log) => { const m = new Map(); for (const e of log) { const id = e.split(":")[0]; (m.get(id) || m.set(id, []).get(id)).push(e); } return JSON.stringify([...m].sort()); };
  assert(per(ref.log) === per(neu.log), `\n    ref ${per(ref.log)}\n    new ${per(neu.log)}`);
});
check("[3] same live-loop counts every tick (and 0 after release)", () => {
  assert(JSON.stringify(ref.counts) === JSON.stringify(neu.counts), `ref ${ref.counts} vs new ${neu.counts}`);
});
check("[4] one style flush per tick (was one per pane + one per loop)", () => {
  assert(neu.perTickFlushes.every((n) => n === 1), `new ${neu.perTickFlushes}`);
  const refMin = Math.min(...ref.perTickFlushes);
  assert(refMin >= 3, `reference should flush per pane + per loop, got ${ref.perTickFlushes}`);
  console.log(`      flushes per tick: reference ${ref.perTickFlushes.join(",")} → new ${neu.perTickFlushes.join(",")}`);
});

if (process.argv.includes("--bench")) {
  // JS-side cost only (no Blink): 3 panes x 8 loops, 30 Hz ticks.
  const bench = (makeSync, label) => {
    const w = makeWorld();
    const roots = [0, 1, 2].map((p) => w.root(Array.from({ length: 8 }, (_, i) => new w.Anim(`${p}.${i}`, { start: -i * 37 }))));
    const s = makeSync(roots);
    const N = 20000;
    for (let t = 0; t < 2000; t++) { w.doc.timeline = t * 33.3; s.step(w.doc.timeline); }
    w.doc.log.length = 0;
    const t0 = process.hrtime.bigint();
    for (let t = 0; t < N; t++) { w.doc.timeline = t * 33.3; w.doc.dirty = true; s.step(w.doc.timeline); if ((t & 1023) === 0) w.doc.log.length = 0; }
    const us = Number(process.hrtime.bigint() - t0) / N / 1000;
    console.log(`  bench ${label}: ${us.toFixed(2)} us/tick JS-side, model flushes/tick ${(w.doc.flushes / (N + 2000)).toFixed(2)}`);
  };
  __setOrbAnimSyncForTest(true);
  bench(makeReferenceSync, "shipped step ");
  bench(makeOrbAnimSync, "two-phase step");
  __setOrbAnimSyncForTest(undefined);
}

console.log(`\n${passed} passed / ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
