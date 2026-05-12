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

/** Returns the current "physics time" in seconds. Mockable via `setCurrentTime`. */
export function currentTime() {
  return _currentTimeFn();
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
