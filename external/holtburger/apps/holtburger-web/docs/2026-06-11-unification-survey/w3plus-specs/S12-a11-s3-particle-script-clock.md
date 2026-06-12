# S12 — A11-S3: particle/script clock move (execution-grade spec)

Agent S12 · ROADMAP item A11-S3 (W5) · 2026-06-11 · READ-ONLY survey of
`/home/wbterminal/WorldBuilder-ACME-Edition` (holtburger at `external/holtburger`; all
repo paths below are relative to `external/holtburger` unless rooted). Retail truth:
`/home/wbterminal/ac-headers/acclient.c` / `.h`.

---

## 1. read-HEAD + W2 assumptions

**read-HEAD: `61bea82f`** ("holtburger: W2/Batch-R2 buildbox dispatch manifest").
Verified landed at read time (git log):

- A11-S0 `7b6a7456` (emitter replace-leak + blocking semantics) and A11-S1 `d8974cf2`
  + fixup `27fbe834` (`scene3d/script_manager.js`, `?scriptQueue=on`) — **S3's
  prerequisites within A11 are in-tree.**
- A1-O1 `656c8ef1` (`?unifiedTick=on`, canonical `crates/holtburger-core/src/client/tick_spine.rs`)
  and A1-O2 `54162642` (`?posePublishPostTick=on`) — the W1 spine exists.
- A15-Q1 `2f50b269` / A15-Q2 `1396967c`, A8-M1 `174fa1b4` / A8-M2 `b4e87213`,
  A13-W1/W2 — W1 complete.

**In-flight W2 items this spec depends on: NONE directly.** A4-Q1, A3-D2, A2-P1,
A7-R1/R2/R3/R6, A9-Stage1 all live in the movement/spatial crates and `lib.rs`; A11-S3
edits only `scene3d/loop.js`, `scene3d/entities.js`, `scene3d/statics.js`,
`scene3d/index.js`, `scene3d/particles/time_rng.js`. No symbol this spec names is
touched by the W2 batch.

**Hard sequencing assumption (NOT yet landed):** per ROADMAP §3 (`scene3d/loop.js`
row), A11-S3 lands **last** in the loop.js column: A15-Q3 → A8-M3 → A15-Q4 → A1-O4 →
**A11-S3**. None of A15-Q3/A8-M3/A15-Q4/A1-O4 (nor A1-O3, nor A11-S2 `?particleOwner`)
exist at read-HEAD. All `loop.js` line numbers below are read-HEAD values and **will
drift**; every insertion point is therefore also given as a *relational anchor*
(phase comment text), which is the normative reference. See §3.6 for the
serialize-with-A1 contract.

---

## 2. Current-state map (post-W0/W1, at read-HEAD)

### 2.1 Retail contract being targeted

- Both managers are updated **per object, inside the object's own update, after the
  position/movement managers, unconditionally (even for inactive objects), before
  `process_hooks`**: `CPhysicsObj::UpdateObjectInternal` runs
  `PositionManager::UseTime` (acclient.c:322883-322885) then — *outside* the
  active-only branch — `ParticleManager::UpdateParticles` (acclient.c:322887-322889)
  then `ScriptManager::UpdateScripts` (acclient.c:322890-322892).
- Statics are NOT on a separate clock: `CPhysics::UseTime` updates all dynamic
  objects (acclient.c:311371-311378, with the player's
  `SmartBox::PlayerPhysicsUpdatedCallback` fired immediately post-update) and then,
  **in the same pass**, walks `static_animating_objects` calling
  `animate_static_object` (acclient.c:311381-311386), which itself runs
  `UpdateScripts` (gated `state & 0x80000`, acclient.c:321185-321190) and
  `UpdateParticles` (ungated, acclient.c:321191-321193) before `process_hooks`
  (acclient.c:321194).
- `update_position` (parented objects) likewise: `set_frame` →
  `UpdateParticles` (acclient.c:321686-321688) → `UpdateScripts`
  (acclient.c:321689-321691); children update their managers immediately after
  `set_frame` inside `UpdateChild` (acclient.c:320050-320058) — never a frame late
  vs their parent.
- One clock: both managers compare against the single global `Timer::cur_time`
  static (declared acclient.c:46992; read by `ScriptManager::UpdateScripts` at
  acclient.c:329201; `ScriptManager::AddScriptInternal` seeds from it,
  acclient.c:329093-329096). The whole physics pass is gated ≥ MIN_QUANTUM (1/30 s)
  at acclient.c:311350-311353.

### 2.2 Ours (the divergence this item closes — A11 §3 row 4, class DIFF-ALGO)

Three different clocks/drivers advance the particle/script runtime today:

| runtime piece | where it ticks | clock |
|---|---|---|
| world `ParticleManager` (`entityManager._worldParticleManager`, scene3d/entities.js:2241, lazy-built :7679-7740) | tail of `EntityManager.tick(dt)` — H2 block, scene3d/entities.js:9569-9581, reached from `tickPerFrame` at scene3d/loop.js:1564 | internal absolute clock `currentTime()` = `performance.now()/1000` (scene3d/particles/time_rng.js:16-21) |
| per-guid `ScriptManager`s (A11-S1, `?scriptQueue=on`; map at scene3d/entities.js:2224) | tail of `EntityManager.tick(dt)`, scene3d/entities.js:9582-9600 (`mgr.update()`) | same `currentTime()` wall clock (scene3d/script_manager.js:20-25, import :52) |
| static `ParticleManager` (`scene3d._staticParticleManager`, scene3d/statics.js:2666-2731) | **its own private rAF loop** `_spLoop`, scene3d/statics.js:2927-2945 (self-armed at module load when `?staticScripts` ≠ off, :2935; the comment at :2928-2931 explicitly says it exists only because loop.js was "another agent's file") | rAF cadence + wall clock |
| PlayEffect one-shot walker hook timing | wall-clock `setTimeout` per hook (scene3d/play_effect_vfx.js:1406, :1517) | wall clock — **out of scope for S3** (it is S1-completion/S5 territory; see §6 Q4) |

vs retail's single pass: dynamic objects' managers and the static-animating list run
inside ONE `CPhysics::UseTime` invocation per frame on ONE `Timer::cur_time`
(acclient.c:311371-311389; manager reads acclient.c:322887-322892, 329201).

Symptoms (A11 §3 row 4): static emitters advance on a different clock than the scene
(jitter when the main loop hitches or is paced via `?targetFps` /
`?renderOnDemand` — the statics rAF keeps firing while `tickPerFrame` idles); the
loop's dt-clamp regime (0.1 cap + DT_RECOVERY freeze, scene3d/index.js:1382-1392,
threshold scaling :1408-1420) freezes mixers/sim while particles and script queues
keep running on wall time (anim/particle skew during recovery frames; A1 §3 row 10
documents the clamp regime as EXTRA).

Already-parity (do not touch): manager-tick relative order *particles → scripts* in
the entity tail (scene3d/entities.js:9572 before :9587) matches retail's
dynamic-object order (acclient.c:322887-322889 before :322890-322892). Both manager
ticks live in the never-RP3-gated CRITICAL block (loop.js:1559-1592 "All
unconditional — RP3 NEVER budget-gates this block") matching retail's unconditional
manager update (acclient.c:322886-322892 sits outside the active-object branch).

### 2.3 Relevant loop.js phase order at read-HEAD (`tickPerFrame`, scene3d/loop.js:1299)

… → `cameraSwitcher.tick(dt)` (loop.js:1533-1543, "CRITICAL #13 Phase 7.5") →
`tickPortalSpace` (:1548) → `tickAnimatedSurfaces` (:1558) → CRITICAL #15/#16/#19
block (:1559-1592): `entityManager.tick(dt)` (:1564, mixers + remote ease + the two
manager tails) → `drainEntityEvents3D` (:1565) → `drainMotionActions` /
`drainMotionAxes` (:1570-1573) → `applyLocalPlayerPoseFromIntegrator` (:1581) →
DEFERRABLE #20 nameplates (:1593+, RP3-gated) → render (in scene3d/index.js after
`tickPerFrame` returns).

Note: part-anchored emitters sample part world frames lazily through the
`partFrames` accessor (composed via `getWorldPosition`/`getWorldQuaternion`, which
recompute world matrices on demand — scene3d/particles/particle_emitter.js:332-349),
so a manager tick placed after the pose phase reads **this frame's** frames; retail
equivalence is the managers running after `PositionManager::UseTime` finalizes the
frame (acclient.c:322883-322892).

---

## 3. Staged implementation plan

One flag, three values: **`?particleClock=off|loop|sim`** (default **off** =
byte-identical current behavior). Parsed once. All stages are **JS-live — no wasm
rebuild, no `dist/manifest.json` bump** (that manifest is the DAT resource manifest,
index.html:1335-1341; nothing here touches it). Document the flag in
`apps/holtburger-web/docs/url-flags.md` (existing convention per A11 §4).

### 3.1 S3-pre — flag plumbing (new helper, shared by 4 files)

File: `scene3d/particles/time_rng.js` (already imported, directly or transitively, by
entities.js via script_manager.js:52, statics.js via particles/index.js, and the node
tests). Add:

```js
// A11-S3: ?particleClock=off|loop|sim — cached once. "loop": managers tick from
// tickPerFrame (retail point in frame, acclient.c:322887-322892, 311381-311386).
// "sim": additionally drive currentTime() from the loop's clamped sim clock.
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
```

(Pattern precedent: `_staticScriptsEnabled`, scene3d/statics.js:2642; scriptQueue
parse, scene3d/entities.js:679-686.)

### 3.2 S3a — extract the entity-side manager tail into a callable phase

File: `scene3d/entities.js`. Move the two tail blocks of `EntityManager.tick(dt)`
(method head :8990) — the H2 world-particle block (:9569-9581) and the A11-S1
script-queue block (:9582-9600) — **verbatim** into a new public method:

```js
/** A11-S3: retail manager phase — ParticleManager::UpdateParticles then
 *  ScriptManager::UpdateScripts (acclient.c:322887-322892 order). Called from
 *  tick(dt) when ?particleClock=off (legacy point), or from tickPerFrame's
 *  particle phase when =loop|sim. NEVER RP3-gated (retail updates managers
 *  even for inactive objects, acclient.c:322886). */
tickParticlesAndScripts() { /* moved blocks, unchanged, incl. both
                               _particleTickWarned/_scriptQueueTickWarned guards */ }
```

In `tick(dt)`, replace the moved blocks with:

```js
if (particleClockMode() === "off") this.tickParticlesAndScripts();
```

Flag-off is call-graph-identical (same statements, same position at the tail of
`tick`). Keep the internal order particles → scripts (retail:
acclient.c:322887-322889 then :322890-322892).

### 3.3 S3b — statics manager onto the main loop (kill the private rAF)

File: `scene3d/statics.js`.

1. Add export:

```js
/** A11-S3: advance the static ParticleManager from the main loop — retail runs
 *  animate_static_object's UpdateParticles in the SAME CPhysics::UseTime pass as
 *  dynamic objects (acclient.c:311381-311386, 321191-321193), not on a private
 *  clock. No-op until a manager exists. */
export function tickStaticParticles(scene3d) {
  const mgr = scene3d?._staticParticleManager;
  if (mgr) { try { mgr.tick(); } catch (_) {} }
}
```

2. Gate the self-armed rAF block (scene3d/statics.js:2927-2945) so it does not arm
   when the flag is on: change the arming condition at :2935 from
   `if (typeof window !== "undefined" && _staticScriptsEnabled())` to additionally
   require `particleClockMode() === "off"` (import `particleClockMode` from
   `./particles/time_rng.js`; statics.js already imports from `./particles/index.js`
   at :2675 — a second specifier to the sibling module is cycle-safe;
   time_rng.js has no imports).
3. `disposeStaticParticles` (:2909-2925) is already idempotent about `_spRafId === 0`
   — no change.
4. The billboard rAF `_bbLoop` (statics.js:2580-2582) is a **non-goal** (different
   subsystem, not part of A11's divergence table).

### 3.4 S3c — the loop phase itself

File: `scene3d/loop.js`. Imports: add `tickStaticParticles` to the existing
`from "./statics.js"` import (loop.js:42-45); add
`{ particleClockMode } from "./particles/time_rng.js"`.

Insert a new phase in `tickPerFrame` **immediately after the CRITICAL #15/#16/#19
block closes** (read-HEAD: after the `if (scene3d?.entityManager) { … }` brace at
~:1592, i.e. after `applyLocalPlayerPoseFromIntegrator`) and **before** the
"DEFERRABLE #20 nameplates" comment. Normative relational anchor (line numbers will
have drifted after A15-Q3/A8-M3/A15-Q4/A1-O4): *after mixer advance + entity drains +
local-pose application; before any RP3-deferrable phase; never RP3-gated.*

```js
// ── A11-S3 (CRITICAL — never RP3-gated): particle/script manager phase. ──
// Retail point in frame: managers run after PositionManager finalizes the
// frame, unconditionally (acclient.c:322883-322892), and statics update in
// the SAME pass as dynamic objects (acclient.c:311381-311386). Order:
// world (dynamic) managers first, then statics, mirroring CPhysics::UseTime
// (acclient.c:311371-311386). Re-entry guard: under multi-driver regimes
// (?netDrainHz + rAF) tickPerFrame can run twice per display frame; managers
// are absolute-clock based so a second tick is wasted work, not corruption —
// skip if this driver call carries the same rp3 timestamp second… (guard on
// scene3d._a11s3LastTickMs, see below).
const _pcMode = particleClockMode();
if (_pcMode !== "off") {
  const _pcNowMs = performance.now();
  if (scene3d._a11s3LastTickMs !== _pcNowMs) {   // same-task double-call guard
    scene3d._a11s3LastTickMs = _pcNowMs;
    if (_pcMode === "sim") {
      // S3d: advance the shared sim clock by the loop's CLAMPED dt; never
      // ahead of wall time (absorbs double-driver overcount).
      scene3d._particleSimNowS = Math.min(
        (scene3d._particleSimNowS ?? _pcNowMs / 1000) + dt,
        _pcNowMs / 1000
      );
    }
    try { scene3d.entityManager?.tickParticlesAndScripts(); } catch (_) {}
    try { tickStaticParticles(scene3d); } catch (_) {}
  }
}
```

Diag (cheap, matches A11 §4 S3's "tick-count == frame-count" headless diag): keep
counters `scene3d._a11s3Diag = { managerTicks: n, frames: n }` incremented in the
phase and in `tickPerFrame`'s prologue respectively; exposed for tests/console only.

### 3.5 S3d — unified sim clock (`=sim` only)

File: `scene3d/index.js` (init path that builds `liveScene3dRef`, ~:1395-1420
read-HEAD). When `particleClockMode() === "sim"`, after the scene3d object exists:

```js
// A11-S3 =sim: ONE clock for mixers + particles + script queues. Retail runs
// every manager off the single Timer::cur_time static (acclient.c:46992;
// UpdateScripts read at :329201; AddScriptInternal seed :329093-329096). Ours
// previously mixed clamped-dt mixers with wall-clock particles. Install the
// loop-owned clock into the shared time hook; seeded so pre-existing absolute
// timestamps stay monotonic.
scene3d._particleSimNowS = performance.now() / 1000;
setCurrentTime(() => scene3d._particleSimNowS);
```

(`setCurrentTime` from `scene3d/particles/time_rng.js:35-44`; the hook is shared by
all four particle modules AND `script_manager.js` by design — time_rng.js:1-14,
script_manager.js:20-25 — so one install covers emitters, RNG-paused CallPES
scheduling, and script-queue `next_hook_time` comparison.) `=sim` consequence: during
DT_RECOVERY freeze frames (scene3d/index.js:1382-1392) and the 0.1 dt cap, particles
and script hooks freeze/slow **with** the mixers instead of jumping on wall time.
Retail comparison: retail *drops* a >2.0 s hitch entirely per-object
(acclient.c:323124-323159); ours clamps instead — that clamp-law difference is
A1-O5's decision (A1 §4 Stage O5), not S3's; S3 only makes all consumers obey one
law. CallPES rand-pause in the executor and the off-path `setTimeout` walker
(entities.js:7908-7927 region) remain wall-clock on the off-path — under
`?scriptQueue=on` + `=sim` the queue path is fully sim-clocked.

### 3.6 Serialize-with-A1 (REQUIRED ordering contract)

1. **Hard order, same file:** ROADMAP §3 `scene3d/loop.js` row rules
   A15-Q3 → A8-M3 → A15-Q4 → **A1-O4** → A11-S3 ("each restructures dispatch the
   next depends on"). Do not land S3 edits to loop.js before A1-O4
   (`?singleDriver`) merges; rebase the §3.4 phase onto the post-O4 frame contract
   (A1 §4 O4: net-apply → physics → camera/input → anim → pose → render). The §3.4
   relational anchor ("after pose application, before deferrables/render") is
   stated so it survives that restructure unchanged.
2. **Why O4 is a real dependency, not ceremony:** killing the statics rAF makes
   `tickPerFrame` the only driver of static particles; pre-O4 there are still
   multiple drivers (2D `drainEvents` rAF, 3D rAF, `?netDrainHz` interval —
   index.html:8974/10974, scene3d/index.js:1458 region, index.js:338-369), and the
   `=sim` clock must have exactly one advancing owner. The §3.4 same-timestamp guard
   plus the `Math.min(…, wallNow)` bound make accidental double-drive non-fatal, but
   the design intent is single-driver.
3. **A1-O3 (`?syncPhysicsTick`) compatibility:** O3 inserts a physics phase #0 at
   the top of `tickPerFrame` (A1 §4 O3); it does not move the mixer/pose phases, so
   S3's phase position is unaffected whether O3 is on or off. Retail anchor holds in
   both shapes: managers after position finalization (acclient.c:322883-322892).
4. **A1-O5 owns the dt-clamp law** (MAX_QUANTUM/hitch-drop decision record). S3d
   *inherits* whatever dt `tickPerFrame` is given (scene3d/index.js:1382-1392 clamp
   today); it must not introduce its own clamp constants.
5. **`?unifiedTick` / `?posePublishPostTick` (landed W1):** no interaction — those
   are Rust-side (tick_spine.rs; lib.rs pose-shadow ordering). S3 is JS-only and
   reads poses through the already-published shadows.
6. **A11-S2 (`?particleOwner`, W3) ↔ S3:** independent flags. If S2 lands first, the
   bodies of `tickParticlesAndScripts()`/`tickStaticParticles()` collapse into the
   owner-facade's single `update()`; the loop.js insertion point and flag are
   unchanged. If S3 lands first, S2 retargets the same two functions. Keep both
   functions as the seam either way.

### 3.7 Classification summary

| stage | files | flag | class |
|---|---|---|---|
| S3-pre | particles/time_rng.js | `?particleClock` parse | JS-live |
| S3a | entities.js | off-value preserves byte-identical call graph | JS-live |
| S3b | statics.js | rAF arm gated to `off` | JS-live |
| S3c | loop.js | `loop`/`sim` | JS-live |
| S3d | index.js (+ time_rng hook) | `sim` only | JS-live |

No wasm rebuild → **no manifest bump**. No new module files (no
`gen-modulepreload`/`?v=` cache-bust churn — import specifiers unchanged except two
added named imports).

---

## 4. Test plan

### Headless-now (node, `apps/holtburger-web/`, mirrors `test_particles.mjs` / `test_script_manager.mjs` check() pattern)

1. **New `test_particle_clock.mjs`:**
   - `particleClockMode()` parse matrix (no window → "off"; mock
     `window.location.search` for loop/sim/garbage) + `__resetParticleClockMode`.
   - Extraction equivalence: fake `EntityManager`-shaped object with stub
     `_worldParticleManager.tick` and one stub `ScriptManager` (`active`,
     `update()` counters): assert `tickParticlesAndScripts()` fires particles
     before scripts (retail order acclient.c:322887-322892) and that mode "off"
     `tick(dt)` reaches it exactly once.
   - Sim clock law: drive the §3.4 advance arithmetic with synthetic
     (dt, wallNow) sequences; assert monotonic, never > wall, freeze under dt=0
     (DT_RECOVERY analog).
   - Clock-hook integration: `setCurrentTime(() => simNow)`, build a real
     `ScriptManager` (existing module), `addScript` two scripts, advance simNow in
     steps and assert hooks fire at queue-chained times (re-uses
     test_script_manager.mjs assertions under the external clock — proves
     script_manager needs zero changes for =sim).
2. **Regression:** `node test_particles.mjs` and `node test_script_manager.mjs`
   unchanged-green (they install their own `setCurrentTime`; production install
   happens only under a browser `window` with the flag, so no interference).
3. **Headless diag parity (browser-less harness or `?renderOnDemand` capture rig):**
   `scene3d._a11s3Diag.managerTicks === frames` after N driven frames with
   `?particleClock=loop` (A11 §4 S3's stated diag).

### 1070-gated (parked, Lane B per ROADMAP §4 — A11-S3 is listed there)

- Static-emitter jitter eye test: induced main-loop hitch (`?targetFps=5`, tab
  switch) with `=loop` — static fires/torches must advance in lockstep with the
  scene instead of free-running (A11 §4 S3 symptom).
- `=sim` feel test: alt-tab 5 s → particles freeze-and-resume with mixers (no
  forward jump); compare vs `off`.
- Regression sweep: PlayEffect one-shots (unchanged path) still fire; statics still
  spawn with `?staticScripts` default-on; `?renderOnDemand=1&netDrainHz=30` bot run
  shows particles advancing only on drain ticks (expected new behavior, note in
  url-flags.md).

---

## 5. Risks + rollback

- **Rollback = flag off** (default). Off-path is call-graph identical: S3a keeps the
  manager tail executing at the same point in `tick(dt)`; S3b's rAF arms exactly as
  today (statics.js:2935 condition only ANDs a new term that is true when off);
  S3c/S3d are dead code when off. Single-commit revert is also clean (5 files, no
  wasm artifacts).
- **Risk: loop.js churn.** Four planned restructures land before S3 in the same
  function (§3.6.1). Mitigation: relational anchors, tiny phase body, land last in
  the column as ruled.
- **Risk: multi-driver double-tick** (pre-O4 testing with flag on): bounded by the
  same-timestamp guard + wall-clock min-bound (§3.4); worst case is extra no-op
  manager walks, never clock runaway.
- **Risk: `=sim` starves emitters when rendering is paused** (`?renderOnDemand`
  without drains): emitters with authored `total_seconds` expire on the sim clock —
  they now *pause* instead of expiring off-screen. This is retail-ward
  (retail's whole pass simply doesn't run when frames don't run,
  acclient.c:311350-311353 gate) but is a behavior change for bot rigs; documented
  in url-flags.md.
- **Risk: production use of the test seam `setCurrentTime`.** Mitigated: it is the
  module's designed mutable hook shared by all consumers (time_rng.js:1-14); node
  tests run in separate processes; `__resetTimeHook` semantics unchanged.
- **Not changed (explicit non-goals):** PlayEffect `setTimeout` hook timing
  (play_effect_vfx.js:1406/:1517 — S1-completion/S5 scope); billboard rAF
  (statics.js:2580-2582); RP6 cull cadence (`_rp6Frame` counts manager ticks —
  unchanged semantics since the phase still runs once per frame); degrade ladder
  (A11-S4, wasm batch R4).

---

## 6. OPEN QUESTIONS

1. **Retail static-script gate `state & 0x80000`** (acclient.c:321185-321190): still
   undetermined what sets that bit (carried from A11 §6). Our statics path executes
   no runtime script hooks (create-only at attach, statics.js:2753+), so S3 does not
   need the answer — but S5/statics-scriptQueue work will.
2. **Is `Timer::cur_time` stamped once per frame (frame-coherent) or live?** The
   static exists (acclient.c:46992) and all managers read it
   (acclient.c:329201, :329093), but I could not locate the updater
   (`Timer::Update` grep: no hits). The `=sim` single-snapshot-per-frame clock
   assumes frame-coherence; if retail re-samples mid-pass the difference is ≤ one
   pass of skew. Single-cited — hence here and not in §2 claims.
3. **Should the manager phase move again under a future per-object update model?**
   Retail updates managers per object interleaved with that object's transition
   (acclient.c:322813 → :322887), and children immediately after `set_frame`
   (acclient.c:320050-320058); ours is one global pass after all entities. Closing
   that residual (per-entity interleave) is beyond S3's "clock + ordering" charter
   (A11 §4 scopes S3 to clock + frame-point) and only observable for emitter-parented
   chains we don't currently build. Flagged for a future A11 stage if part-attached
   emitter lag is ever eye-visible.
4. **PlayEffect walker on the queue:** should `?particleClock=sim` be allowed
   without `?scriptQueue=on`? As specced, yes — but then the off-path entity walker's
   `setTimeout` hooks stay wall-clock while emitters go sim-clock (mixed regime).
   Recommend documenting `=sim` as intended-with-`?scriptQueue=on`; an
   implementor could alternatively hard-couple them (one-line check). Left open as a
   product choice, not a correctness one.
5. **True ScriptData `length` export** (script_manager.js:41-49 known approximation,
   retail chaining acclient.c:329093-329096): not a dependency for S3, but if the
   lib.rs getter ships in wasm batch R4 alongside A11-S4, sim-clock chaining becomes
   exact. No ordering constraint either way.
