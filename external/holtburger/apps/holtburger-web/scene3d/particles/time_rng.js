// Workstream Sky-J P4 (2026-05-12) — time + RNG hooks shared by the
// particle runtime modules. Exists as a separate file so all four of
// particle.js / particle_emitter.js / particle_emitter_info.js /
// particle_manager.js import the SAME mutable hook (i.e. setting it
// via `setCurrentTime()` once in the test before the modules run
// changes what every module sees).
//
// **ACE → JS mapping**
//   PhysicsTimer.CurrentTime  → currentTime()  // seconds (double)
//   ThreadSafeRandom.Next(lo,hi) → rng() * (hi - lo) + lo  // uniform
//
// Default `currentTime()` returns `performance.now() / 1000`. In a Node
// test environment without `performance`, falls back to a Date.now()
// shim. Default `rng()` is `Math.random()` (uniform [0, 1)).

let _currentTimeFn = () => {
  if (typeof performance !== "undefined" && typeof performance.now === "function") {
    return performance.now() / 1000.0;
  }
  return Date.now() / 1000.0;
};

let _rngFn = () => Math.random();

// Per-tick clock latch. Retail reads ONE `PhysicsTimer::curr_time` per physics
// tick; reading performance.now() per particle per tick cost ~1.2% of main-
// thread self time at Holtburg (1070). While a latch is held (ParticleManager
// .tick), currentTime() returns the value sampled when the outermost latch
// was taken. Depth-counted so nested ticks share the outer sample.
let _latchDepth = 0;
let _latchedTime = 0;

/** Sample the clock once and hold it until the matching `releaseTimeLatch()`. */
export function holdTimeLatch() {
  if (_latchDepth++ === 0) _latchedTime = _currentTimeFn();
}

/** Release a latch taken by `holdTimeLatch()`. */
export function releaseTimeLatch() {
  if (_latchDepth > 0) _latchDepth--;
}

/** Returns the current "physics time" in seconds. Mockable via `setCurrentTime`. */
export function currentTime() {
  return _latchDepth > 0 ? _latchedTime : _currentTimeFn();
}

/** Returns a uniform random in [0, 1). Mockable via `setRng`. */
export function rng() {
  return _rngFn();
}

/** Install a deterministic time function. Pass `null` to restore default. */
export function setCurrentTime(fn) {
  if (fn === null || fn === undefined) {
    __resetTimeHook();
    return;
  }
  if (typeof fn !== "function") {
    throw new TypeError("setCurrentTime: fn must be a function or null");
  }
  _currentTimeFn = fn;
}

/** Install a deterministic RNG function returning a number in [0, 1). */
export function setRng(fn) {
  if (fn === null || fn === undefined) {
    __resetRngHook();
    return;
  }
  if (typeof fn !== "function") {
    throw new TypeError("setRng: fn must be a function or null");
  }
  _rngFn = fn;
}

export function __resetTimeHook() {
  _currentTimeFn = () => {
    if (typeof performance !== "undefined" && typeof performance.now === "function") {
      return performance.now() / 1000.0;
    }
    return Date.now() / 1000.0;
  };
}

export function __resetRngHook() {
  _rngFn = () => Math.random();
}

// A11-S3 (unification survey 2026-06-11): `?particleClock=off|loop|sim` —
// cached once. "loop": the particle/script managers tick from tickPerFrame
// (retail point in frame: managers run after PositionManager finalizes the
// frame, acclient.c:322887-322892, and statics update in the SAME
// CPhysics::UseTime pass, acclient.c:311381-311386). "sim": additionally
// drive `currentTime()` from the loop's clamped sim clock (retail's single
// `Timer::cur_time` static, acclient.c:46992) so mixers + particles +
// script queues obey ONE clock law. Default "off" = byte-identical legacy
// behavior (entity-tail tick + statics private rAF + wall clock).
let _particleClockMode = null;
export function particleClockMode() {
  if (_particleClockMode !== null) return _particleClockMode;
  let m = "off";
  if (typeof window !== "undefined" && window.location?.search) {
    const v = new URLSearchParams(window.location.search).get("particleClock");
    if (v === "loop" || v === "sim") m = v;
  }
  _particleClockMode = m;
  return m;
}
export function __resetParticleClockMode() { _particleClockMode = null; } // tests
