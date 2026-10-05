// harness/lib/fake_motion_sequence.mjs — a pure-JS stand-in for the wasm
// `MotionSequence` class (src/motion_sequence.rs) so headless Node tests can
// drive entities.js's single animation authority without a wasm runtime.
//
// Surface mirrors the wasm-bindgen class the client reads off
// `window.__hbWasm.MotionSequence`: `fromDescriptor(numFrames, framerate,
// duration, frameTimes, segmentStarts, segmentCounts, cyclic)`, `advance(dt)`,
// `globalFrameIndex`, `done`, `phase`, `seekPhase(p)`, `free()` (zeroes
// `__wbg_ptr` like wasm-bindgen does). Timing is the simple single-node case
// (frame = floor(t * framerate)); the real multi-node CSequence math is
// cargo-tested in Rust — this only has to be faithful enough for the JS
// plumbing (which record is on the playhead, holds, wrap, completion).

export class FakeMotionSequence {
  static fromDescriptor(numFrames, framerate, duration, _frameTimes, _segStarts, _segCounts, cyclic) {
    const n = numFrames >>> 0;
    if (n === 0) return null;
    const s = new FakeMotionSequence();
    s.numFrames = n;
    s.framerate = +framerate > 0 ? +framerate : 30;
    s.duration = +duration > 0 ? +duration : n / s.framerate;
    s.cyclic = !!cyclic;
    s.t = 0;
    s._done = false;
    s.advanced = 0;
    FakeMotionSequence.built += 1;
    return s;
  }

  advance(dt) {
    if (this.__wbg_ptr === 0) throw new Error("FakeMotionSequence: use after free");
    if (!(dt > 0) || this._done) return;
    this.advanced += 1;
    this.t += dt;
    if (this.cyclic) {
      this.t %= this.duration;
    } else if (this.t >= this.duration) {
      this.t = this.duration;
      this._done = true;
    }
  }

  get globalFrameIndex() {
    const f = Math.floor(this.t * this.framerate);
    return Math.max(0, Math.min(this.numFrames - 1, f));
  }

  get done() { return this._done; }

  get phase() { return this.duration > 0 ? this.t / this.duration : 0; }

  seekPhase(p) {
    const q = ((+p % 1) + 1) % 1;
    this.t = q * this.duration;
  }

  free() {
    if (this.__wbg_ptr === 0) { FakeMotionSequence.doubleFrees += 1; return; }
    this.__wbg_ptr = 0;
    FakeMotionSequence.freed += 1;
  }
}
FakeMotionSequence.prototype.__wbg_ptr = 1;
FakeMotionSequence.built = 0;
FakeMotionSequence.freed = 0;
FakeMotionSequence.doubleFrees = 0;

/** Install the fake on `window.__hbWasm` (creating a bare `window` if absent).
 *  Call AFTER importing entities.js so its module-top flag readers saw the
 *  same (window-less) environment as before. */
export function installFakeMotionSequence() {
  const w = (globalThis.window ??= {});
  w.__hbWasm = { ...(w.__hbWasm || {}), MotionSequence: FakeMotionSequence };
  return FakeMotionSequence;
}
