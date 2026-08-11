// A11-S1 (unification survey 2026-06-11) — shared PhysicsScript executor.
//
// Retail port of `ScriptManager` (acclient.h:30815-30822; bodies
// acclient.c:329069-329246). One instance per owner (per-CPhysicsObj in
// retail; per-entity-guid / per-static-anchor / per-PlayEffect-group here).
// It is a TIME-ORDERED QUEUE of PhysicsScripts (0x33) executed on a single
// clock, replacing the three independent wall-clock `setTimeout`-per-hook
// walkers the survey flagged as the "fix lands in one copy" split-brain
// (survey §3 rows 1-2; the DIM6-2 regression is the canonical example).
//
// === Seam rule (ROADMAP §2) ===
// This module owns ONLY the queue + timing. It does NOT contain a copy of
// the hook-dispatch switch. Hook execution is delegated to an injected
// `executeHook(entry, ctx)` callback the OWNER supplies — the entity owner's
// callback adapts each entry and calls `EntityManager._fireHook` (A5's
// executor), so there is exactly ONE hook-dispatch implementation, never a
// 4th fork. The PlayEffect / statics owners supply their own thin callbacks
// over the same shape.
//
// === Determinism ===
// Time comes from `time_rng.js` `currentTime()` (mockable via `setCurrentTime`),
// matching the rest of `scene3d/particles/`. `update(now)` also accepts an
// explicit `now` so headless tests can drive the clock without touching the
// global hook. No `setTimeout` — hooks fire from `update()` on the caller's
// clock, exactly like retail `UpdateScripts` runs on the physics clock.
//
// === Retail behaviors reproduced ===
//  - AddScriptInternal (acclient.c:329069-329121): a new script's start_time
//    is the PREVIOUS queued script's `start_time + length` when a script is
//    already queued, else `Timer::cur_time` — scripts chain back-to-back,
//    never overlapped.
//  - NextHook (acclient.c:329142-329187): advance `hook_index` within the
//    current script's sorted hook array; `next_hook_time` = next entry's
//    `start_time + script_start`.
//  - UpdateScripts (acclient.c:329189-329246): `while (cur_time >=
//    next_hook_time)` execute the hook; on exhaustion pop `curr_data`,
//    advance to `next_data`.
//
// === Derived `length` is EXACT — not an approximation (SCRIPTMGR-RATE 2026-08-11) ===
// This note previously read "known JS-side approximation … the best value
// available without a wasm rebuild", and flagged a `PhysicsScriptJs` length
// getter as owed. Read-verified against the decomp: NO getter is owed, because
// retail computes `length` the same way we do. `PhysicsScript::UnPack`
// (acclient.c:336452-336528) reads the entries, qsorts `script_data` by
// `start_time` (`PhysicsScriptData::Sort`), then copies the LAST entry's
// `start_time` straight into `PhysicsScript::length` — the two dwords written
// at `v4+18`/`v4+19`, i.e. the 8 bytes immediately past `num_in_array`, which
// is exactly `length` per the struct (acclient.h:31801-31804). So retail's
// `length` IS max(entry.start_time); there is no separate on-disk field. Our
// derivation therefore reproduces `AddScriptInternal`'s back-to-back chain
// (acclient.c:329090-329093) bit for bit, for EVERY script shape — not just
// ones whose final hook is terminal. The optional `opts.length` override stays
// for callers that synthesize scripts.
//
// === Entry contract (load-bearing) ===
// An entry's schedule key is `startTime`, read in three places (the sort in
// `addScript`, the `length` derivation, and `_armNextHook`). An entry that
// omits it is not rejected — `+undefined || 0` silently reads 0, which arms
// every hook at the script's start and derives length 0. That is exactly how
// SCRIPTMGR-RATE happened: `entities.js#_decodePhysicsScriptHookEntry` emits
// the `AnimationHookJs` shape, whose offset field is named `time`, and nothing
// bridged the two names, so a CallPES self-loop re-armed with zero delay and
// ran one iteration PER FRAME (~17 Hz on the portal, vs 1 per 2.7 s). Owners
// that adapt hooks from another shape MUST map their offset onto `startTime`;
// see `?scriptHookTime` and `harness/test_script_hook_time.mjs`.

import { currentTime } from "./particles/time_rng.js";

/**
 * @typedef {Object} ScriptEntry
 * @property {number} startTime  hook offset within its script, seconds.
 * (Plus any owner-specific fields the owner's executeHook reads — this module
 *  treats entries as opaque except for `startTime`.)
 */

/**
 * @typedef {Object} ScriptData
 * @property {number} scriptDid   the 0x33 DID (diagnostics only).
 * @property {ScriptEntry[]} entries  hook entries, sorted ascending by startTime.
 * @property {number} startTime   absolute clock time this script's t=0 maps to.
 * @property {number} length      script length (seconds) for chaining the next.
 */

export class ScriptManager {
  /**
   * @param {Object} [opts]
   * @param {(entry: ScriptEntry, ctx: {scriptDid:number, scriptStart:number, manager:ScriptManager}) => void} [opts.executeHook]
   *   Owner-supplied hook dispatcher. REQUIRED before any hook can fire; may be
   *   set later via `setExecutor`. This is the seam — it must funnel to the
   *   shared `_fireHook`, not reimplement dispatch.
   * @param {string|number} [opts.owner]  owner key (diagnostics only).
   */
  constructor(opts = {}) {
    this.owner = opts.owner ?? null;
    /** @type {(entry: ScriptEntry, ctx: Object) => void | null} */
    this._executeHook = typeof opts.executeHook === "function" ? opts.executeHook : null;
    // Retail field analogues (acclient.h:30815-30822):
    //   curr_data       → this._currData (ScriptData | null)
    //   last_data       → this._queue tail (we keep the whole pending queue)
    //   hook_index      → this._hookIndex
    //   next_hook_time  → this._nextHookTime
    /** @type {ScriptData | null} */
    this._currData = null;
    /** @type {ScriptData[]} */     // scripts queued behind currData (FIFO)
    this._queue = [];
    this._hookIndex = 0;
    this._nextHookTime = Infinity;
    // Diagnostics — used by the headless diag-counter parity test.
    this._hooksFired = 0;
    this._scriptsCompleted = 0;
  }

  /** Install / replace the shared hook executor (the seam to `_fireHook`). */
  setExecutor(fn) {
    this._executeHook = typeof fn === "function" ? fn : null;
  }

  /** True while a script is playing or queued. */
  get active() {
    return this._currData !== null || this._queue.length > 0;
  }

  /** Hooks fired so far (diagnostics / parity counter). */
  get hooksFired() {
    return this._hooksFired;
  }

  /** Scripts that ran to exhaustion + popped (diagnostics). */
  get scriptsCompleted() {
    return this._scriptsCompleted;
  }

  /**
   * Queue a script. Mirrors AddScriptInternal (acclient.c:329069-329121):
   * the new script starts back-to-back after the last queued script's
   * `start_time + length`; if nothing is queued it starts at `now`.
   *
   * @param {number} scriptDid    0x33 DID (diagnostics).
   * @param {ScriptEntry[]} entries  hook entries (any extra owner fields kept).
   * @param {Object} [opts]
   * @param {number} [opts.length]  explicit script length (seconds). When
   *   omitted, derived as the max entry startTime (see file header).
   * @param {number} [opts.now]     clock override for the FIRST-script start;
   *   defaults to `currentTime()`.
   * @returns {ScriptData} the queued ScriptData.
   */
  addScript(scriptDid, entries, opts = {}) {
    // Defensive copy + stable ascending sort by startTime (retail hooks are
    // pre-sorted; this guarantees `hookIndex` walks monotonically even if a
    // caller hands an unsorted array).
    const sorted = (Array.isArray(entries) ? entries.slice() : []).sort(
      (a, b) => (+a.startTime || 0) - (+b.startTime || 0),
    );
    const length =
      typeof opts.length === "number"
        ? opts.length
        : sorted.length
          ? Math.max(0, +sorted[sorted.length - 1].startTime || 0)
          : 0;

    // Determine this script's absolute start. The "previous queued script"
    // is the queue tail if anything is queued, else currData if it's playing,
    // else `now`. (Retail keys off last_data; last_data is currData when the
    // queue is empty.)
    let prev = null;
    if (this._queue.length > 0) prev = this._queue[this._queue.length - 1];
    else if (this._currData !== null) prev = this._currData;

    const start =
      prev !== null
        ? (+prev.startTime || 0) + (+prev.length || 0)
        : typeof opts.now === "number"
          ? opts.now
          : currentTime();

    /** @type {ScriptData} */
    const data = { scriptDid: scriptDid >>> 0, entries: sorted, startTime: start, length };

    if (this._currData === null) {
      // No active script — this becomes current; arm the first hook.
      this._currData = data;
      this._hookIndex = 0;
      this._armNextHook();
    } else {
      this._queue.push(data);
    }
    return data;
  }

  /**
   * Arm `_nextHookTime` for the current script's `_hookIndex`th entry, or
   * Infinity if the script is exhausted. Mirrors NextHook
   * (acclient.c:329142-329187): `next_hook_time = entry.start_time + script_start`.
   */
  _armNextHook() {
    const cur = this._currData;
    if (cur === null || this._hookIndex >= cur.entries.length) {
      this._nextHookTime = Infinity;
      return;
    }
    this._nextHookTime = cur.startTime + (+cur.entries[this._hookIndex].startTime || 0);
  }

  /** Advance to the next queued script (or idle). */
  _popCurrent() {
    this._scriptsCompleted += 1;
    if (this._queue.length > 0) {
      this._currData = this._queue.shift();
      this._hookIndex = 0;
      this._armNextHook();
    } else {
      this._currData = null;
      this._hookIndex = 0;
      this._nextHookTime = Infinity;
    }
  }

  /**
   * Run the clock to `now`, firing every hook whose `next_hook_time` has
   * elapsed (and chaining into queued scripts). Mirrors UpdateScripts
   * (acclient.c:329189-329246): `while (cur_time >= next_hook_time)` execute.
   *
   * @param {number} [now]  clock seconds; defaults to `currentTime()`.
   * @returns {number} number of hooks fired in this call.
   */
  update(now) {
    const t = typeof now === "number" ? now : currentTime();
    let fired = 0;
    // Guard against a pathological script whose every hook is already due
    // (start far in the past): the loop is bounded by the total entry count
    // across currData + queue, so it always terminates.
    let guard = 0;
    const guardMax = this._totalPendingEntries() + this._queue.length + 4;
    while (this._currData !== null && t >= this._nextHookTime) {
      if (++guard > guardMax + 1) break; // belt-and-suspenders; never expected
      const cur = this._currData;
      if (this._hookIndex < cur.entries.length) {
        const entry = cur.entries[this._hookIndex];
        this._hookIndex += 1;
        // Fire via the shared executor (the seam). If no executor is wired,
        // we still advance timing so the queue drains deterministically.
        if (this._executeHook) {
          try {
            this._executeHook(entry, {
              scriptDid: cur.scriptDid,
              scriptStart: cur.startTime,
              manager: this,
            });
          } catch (_) {
            // A hook executor must never break the queue clock.
          }
        }
        this._hooksFired += 1;
        fired += 1;
        if (this._hookIndex >= cur.entries.length) {
          this._popCurrent();
        } else {
          this._armNextHook();
        }
      } else {
        this._popCurrent();
      }
    }
    return fired;
  }

  _totalPendingEntries() {
    let n = this._currData ? this._currData.entries.length - this._hookIndex : 0;
    for (const s of this._queue) n += s.entries.length;
    return n;
  }

  /** Drop all queued + current scripts (owner teardown). */
  clear() {
    this._currData = null;
    this._queue.length = 0;
    this._hookIndex = 0;
    this._nextHookTime = Infinity;
  }
}

export default ScriptManager;
