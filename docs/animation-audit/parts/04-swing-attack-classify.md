I now have the complete resolution chain, both dispatch paths, the legacy fallback, the blend mechanism, and the retail comparison. Here is the audit.

---

# Audit — Attack/Swing Resolution in `entities.js`

**Scope:** how a melee swing resolves from a MotionCommand to a played clip, and why only the upper body animates. Web root `external/holtburger/apps/holtburger-web`; all `file:line` cites are in `scene3d/entities.js` unless noted. Retail comparison against `/home/wbterminal/ac-headers/acclient.c`.

## What exists

There is no single swing resolver. The path is spread across **two classifiers, two dispatch entry points, one shared clip-player, and one legacy procedural fallback**, plus a spec doc that was only ever partially wired in.

| Piece | Location | Role |
|---|---|---|
| `classifyMotionCommand(cmd)` | `entities.js:1745` | Coarse string classifier. Masks `cmd & 0xffff`, returns `"attack"`/`"cast"`/`"walk"`/`"idle"`/`null`. Stance- and table-blind. |
| `classifyMotionCommandTyped(mtId, stance, cmd)` | `entities.js:1914` | Wasm-backed link lookup (`lookupMotionLinkForSwing`). Returns a typed `{kind, height, anim, durationSec, resolvedCommand, source}` envelope; **falls back to wrapping the coarse string** when wasm misses (`entities.js:1959`). |
| `expandActionCommandLow16(cmd)` | `entities.js:1865` | Reconstructs the full 32-bit command class by ID range so the link inner key resolves. |
| `setMotion` attack/cast branch | `entities.js:6602`, dispatch at `:6638` | Server `KIND_MOTION_ACTION` echo path. |
| `setSwingMotion(guid, cmd, opts)` | `entities.js:6014` | CMT/optimistic + `damageTaken`-guessed swing path (separate entry point). |
| `_tryPlayLink(...)` | `entities.js:8145` | The actual MotionTable-link fetch → `THREE.LoopOnce` overlay. Shared by both paths. |
| `setSwingPose(guid)` | `entities.js:5603` | Legacy "vibe-coded" single-bone fallback (right upper arm only). |
| `_suppressBaseCycleForOverlay` | `entities.js:8338` | Band-aid that zeroes the base-cycle weight so the overlay isn't halved. |
| Spec | `docs/swing-classification-spec-2026-05-19.md` | Design that `links[(stance,Ready)][cmd]` holds swings; never fully delivered (see §7, §8.3 "no actual code written here"). |

`MotionTable.links[(stance,Ready)][cmd]` is **not** a JS data structure in `entities.js` — it lives wasm-side. JS reaches it two ways: `lookupMotionLinkForSwing(mtId, stance, cmd)` (the typed path, `entities.js:1921`) and `animationCache.get(setupId, mtId, toCmd, stance, …, {fromMotion})` (the clip-fetch path, `entities.js:8150`), where `fromMotion = READY_SUBSTATE` keys the `(stance, Ready→cmd)` link.

## How it works (file:line)

### A melee swing, server-echo path (`setMotion`)

1. **`entities.js:6602`** — `const cls = classifyMotionCommand(cmd);` Coarse classify. `ATTACK_COMMANDS.has(low) → "attack"` (`entities.js:1782`).
2. **`entities.js:6638`** — `if (cls === "attack" || cls === "cast")`. Clears any in-flight `_swingTween`/`_castTween` (`:6643`, `:6647`), then:
3. **`entities.js:6652`** — `const linkCmd = expandActionCommandLow16(cmd);` low-16 → full 32-bit so the link key resolves (e.g. `SlashHigh 0x5B → 0x1000005B`).
4. **`entities.js:6653`** — `this._tryPlayLink(inst, setupId, mtableId, READY_SUBSTATE, linkCmd, stance);` — `from = Ready = 0x0003`, exactly per spec §1/§3.2.
5. **`entities.js:8150`** — `_tryPlayLink` calls `animationCache.get(setupId, mtableId, toCmd, stance, …, {fromMotion: fromCmd})`. This is the `links[(stance, Ready)][cmd]` lookup.
6. **`entities.js:8169`** — `if (!clip)`: a null clip means **no link entry for this (stance, from→to)** → for attack/cast it `console.warn`s "swing/cast/eat will not play" (`:8184`) and returns. This is the silent-miss path.
7. **`entities.js:8199-8203`** — clip found: `mixer.clipAction(clip)`, `setLoop(THREE.LoopOnce, 1)`, `clampWhenFinished = false`. Played as an **overlay on top of the still-running locomotion cycle** (`:8261-8262` `action.reset(); action.play();`). No `crossFadeTo` — the comment at `:6622-6627` states the design intent: "the walk/run continues to animate the legs while the swing animates the arms."

### A melee swing, CMT/optimistic path (`setSwingMotion`)

1. **`entities.js:6023`** — `const result = classifyMotionCommandTyped(mtableId, stance, motionCmd >>> 0);`
2. **`entities.js:6039-6043`** — `canPlayReal = result && (kind === "swing"||"cast") && resolvedCommand !== 0 && source === "wasm-link"`.
3. **`entities.js:6045`** — `if (!canPlayReal || !fetchKeyframes) { this.setSwingPose(g); return; }` — **falls back to the single-bone tween** whenever wasm hasn't resolved a real link (table not cached yet, coarse fallback, or no link entry).
4. **`entities.js:6072-6074`** — even on `canPlayReal`, if the actual keyframe fetch returns no clip, it again drops to `setSwingPose`.
5. **`entities.js:6076-6108`** — clip found → `swing:<cmd>:<stance>` action, `LoopOnce`, `clampWhenFinished=true` (`:6088-6089`), timescale from `durationSec` (`:6100-6105`).

### Why only the upper body animates — two concrete code mechanisms

**Mechanism 1 — three.js weight normalization halves the swing (the documented root cause).**
The overlay is `play()`-ed while the base locomotion/Ready cycle is still running at weight 1.0. The authors' own diagnosis, `entities.js:584-591`:

> "an attack/cast/emote overlay plays on top of the still-running base locomotion cycle, so three.js normalizes them to ~50/50 and the swing plays at half amplitude (a drudge's overhead smash looks like a wiggle), then pops to the base pose in one frame at clip end."

AC animation frames are full-skeleton poses, so the swing clip *does* carry leg tracks — but blended 50/50 against a near-static Ready pose the legs barely move while the arms move halfway, reading as "upper body only, at half strength." The fix attempt is `_suppressBaseCycleForOverlay` (`entities.js:8338`), which `baseAction.setEffectiveWeight(0)` (`:8350`) for the overlay's duration and restores on `finished` (`:8362-8374`) — but it is gated behind `FULL_BODY_ONE_SHOT` (`?fullBodyOneShot`, `entities.js:592`), applied only at `:8299` and `:6130-6141`, and is **default-on but flag-reversible "pending a 1070 eye-test"** (`:584-591`).

**Mechanism 2 — the legacy fallback literally moves one bone.**
`setSwingPose` (`entities.js:5603`) is the fallback whenever the real link can't resolve. It rotates **only `parts[13]` (RIGHT_UPPER_ARM)** (`:5608-5609`) by a 300 ms triangle wave (`:6347-6349` in `_tickSwingTween`). It early-returns on any rig with `< 16` parts (`:5607`), so non-humanoids (monsters) get **nothing**. This is the most literal "only the upper body swings." Because `setSwingMotion` falls back here on every wasm miss (`:6045`), a swing very often renders as this single-bone wiggle rather than the authored clip.

### Why missiles fire with no animation

Per spec §2.1 (`swing-classification-spec-2026-05-19.md:44`), missile stances (`BowCombat 0x8000003F`, `CrossbowCombat`, `ThrownWeaponCombat`, `AtlatlCombat`, `ThrownShieldCombat`) have **zero swing links** — they resolve through `Aim*`/`Reload` cycles. But `classifyMotionCommand` still buckets the fire command as `"attack"` (`entities.js:1782`) → `_tryPlayLink` → null-clip miss at `entities.js:8169` → `console.warn` + silent return (`:8184-8191`). Nothing routes the missile-fire to its `Aim`/`Reload` cycle. Result: the projectile launches with no animation.

## Fragility & workarounds

1. **No single authority — two classifiers, two dispatch sites.** `classifyMotionCommand` (coarse, table-blind, `:1745`) and `classifyMotionCommandTyped` (wasm, `:1914`) coexist, and swings enter through *both* `setMotion` (`:6638`, server echo) and `setSwingMotion` (`:6014`, CMT guess). They can fire the same swing twice; a dedicated dedup band-aid exists (`_lastServerSwingMs` stamp at `entities.js:8297`, guarding the `index.html` `damageTaken`/CMT "guessed-swing" path, comment at `:8279-8291`). Each new motion class needs wiring in multiple places.

2. **Overlay-on-cycle blend is the core defect** (`:584-591`). The whole "swing animates arms while legs keep walking" model (`:6622-6627`) relies on three.js mixer weight-blending, which normalizes co-running clips and halves amplitude. The countermeasure (`_suppressBaseCycleForOverlay`) is gated behind a default-reversible flag and re-implements, by hand, retail's `remove_cyclic_anims`-then-restore (`:589-590`).

3. **Single-bone legacy fallback** (`setSwingPose`, `:5603`) is reached on every link-resolution miss (`:6045`, `:6067`, `:6073`) and on `_swingTween` re-clears scattered through `setMotion` (`:6643`). It moves one arm bone, no-ops on monsters, and races the real clip — the codebase explicitly notes the real clip must "win" by clearing the tween (`:6639-6643`).

4. **Classifier overload.** To reuse the one overlay player, `classifyMotionCommand` shoves *everything* into a handful of buckets: emotes, reactions, interactions, idle-ambients, extended attacks, and even `FallDown` all return `"attack"` (`:1779`, `:1803-1807`) purely so they "ride `_tryPlayLink`" (`:1772`, `:1793`). Stationary/held poses return `"walk"` (`:1808-1809`). The classifier's return value no longer means what it says — `"attack"` means "play as a one-shot overlay," `"walk"` means "play as a repeating cycle."

5. **Flag sprawl, all "pending a 1070 eye-test."** `FULL_BODY_ONE_SHOT` (`:592`), `CAST_SPEED` (`:608`), `CAST_STATE_MACHINE` (`:625`), `CYCLE_OMEGA_ON` (`:645`), `MT_CLASS_FALLBACK_ON` (`:660`), `IDLE_FIDGET_ON` (`:684`). Core motion behavior (full-body swings, cast tempo, recast suppression) is split across optional URL flags rather than being the one true path — so the "correct" behavior only exists in a specific flag combination.

6. **Silent missing-link handling.** A missing swing link is a `console.warn` and a no-op (`:8169-8191`), not a fallback to anything visible. Missile stances (no links by design) hit this every shot.

7. **Spec never fully landed.** The spec proposes `setSwingPoseFromMotion`/`setSpellCastPoseFromMotion` pose appliers (`spec §3.3`, §4 Step 5) and admits "No actual wasm/JS code was written here — this is the spec" (`spec:257`). What shipped instead is the overlay-on-`_tryPlayLink` hack, leaving the procedural tweens (`setSwingPose`/`setCastPose`) as live fallbacks rather than deleted.

## Retail (acclient) comparison

Retail has exactly the single authority this client lacks. `CMotionTable::GetObjectSequence` (`acclient.c:337641`) builds **one** `CSequence` per motion event and that sequence drives the **whole part array uniformly**:

- **`acclient.c:337737`** — `CSequence::remove_cyclic_anims(sequence);` clears the running cycle first (this is exactly what `_suppressBaseCycleForOverlay` re-invents by zeroing a mixer weight).
- **`acclient.c:337738-337741`** — assembles the swing as a serial chain:
  ```c
  add_motion(sequence, pre_link, speed_mod);   // transition into the swing
  add_motion(sequence, motiona,  speed_mod);   // the link (the swing keyframes)
  add_motion(sequence, link2,    speed_mod);   // cross-style link if needed
  add_motion(sequence, link,     speed_mod);   // the post-swing return cycle
  ```
- **`acclient.c:337758`** — `*num_anims = …` sums the anim counts of the whole chain; the sequence is then played as **one queue of full-skeleton frames**, not parallel weighted clips.

Key structural contrasts:

| | Retail (`acclient.c`) | holtburger (`entities.js`) |
|---|---|---|
| Authority | One `CMotionInterp`/`CMotionTable` for every animated object (`acclient.c:7086-7126` lists the full interp API) | Scattered: 2 classifiers + 2 dispatchers + `_tryPlayLink` + procedural tweens |
| Swing assembly | `pre_link + link + cycle` into ONE `CSequence` (`:337738-337741`) | LoopOnce overlay `play()`-ed *concurrently* with the base cycle (`:8261`) |
| Cycle handling during swing | `remove_cyclic_anims` then re-add after (`:337737`) | base cycle keeps running; weight either halved (default) or zeroed by a flag-gated hack (`:8350`) |
| Blend model | Serial frame queue on the whole skeleton → inherently full-body | Parallel mixer weight-blend → ~50/50 normalization → half-amplitude upper-body |
| Missile/cast/emote | Same `GetObjectSequence` path, same sequence machinery | Different code buckets, flag-gated tempos, null-clip no-ops |

The spec already recognized this: it maps "`cycles → loop, links → one-shot transition`" to `GetObjectSequence` (`spec:21`, `spec:258`) — but the implementation translated retail's *serial sequence* into a three.js *parallel weighted overlay*, which is the source of the half-amplitude upper-body symptom.

## Consolidation recommendations

1. **Build one motion authority mirroring `CMotionInterp`/`CMotionTable::GetObjectSequence`.** A single `resolveMotion(entity, command, stance, fromState)` that, for *every* animated object (player, monster, door, missile, NPC), returns an ordered sequence `[pre_link?, link, cycle]` from the MotionTable — replacing `classifyMotionCommand` + `classifyMotionCommandTyped` + the two dispatch branches. The wasm `lookupMotionLinkForSwing` already returns the right envelope; widen it to return the full sequence, not just the swing link.

2. **Replace the parallel-overlay blend with serial sequence playback.** Adopt retail's `remove_cyclic_anims → play sequence → restore cycle` as the *default*, not a flag. Concretely: make full-body suppression (`_suppressBaseCycleForOverlay`, `:8338`) unconditional for Action-class one-shots and retire `FULL_BODY_ONE_SHOT` (`:592`). This eliminates the 50/50 normalization that halves swing amplitude and confines motion to the upper body.

3. **Delete the procedural fallbacks** `setSwingPose` (`:5603`) and `setCastPose` (`:5650`), and the `_swingTween`/`_castTween` tickers (`:6332`, `_tickCastTween`). They are the literal single-bone "upper body only" renderer and the source of clip-vs-tween races (`:6639-6647`). Once every (stance,cmd) resolves through the unified authority, a missing link should fall back to a *visible neutral motion or the cycle*, not a one-bone wiggle that no-ops on monsters.

4. **Route missile/aim/reload through the same authority.** Stop bucketing missile-fire as `"attack"` (which dead-ends at the null-clip warn, `:8182`). The authority should pick the `Aim*`/`Reload` cycle for missile stances (spec §2.1, `spec:44`) so missiles get the reload/fire animation instead of nothing.

5. **Make the classifier mean what it says.** `classifyMotionCommand` currently returns `"attack"` for emotes, falls, eat, and extended attacks (`:1779`, `:1803-1807`) only to reuse the overlay player. Replace the string buckets with the retail notion of *motion class → sequence shape* (cycle vs link vs pre-link), so the dispatcher reads a structural property rather than a misleading category label.

6. **Collapse the flag matrix into the default path.** `CAST_SPEED` (`:608`), `CAST_STATE_MACHINE` (`:625`), `MT_CLASS_FALLBACK_ON` (`:660`) encode behavior that retail does unconditionally inside the interp. Fold the correct settings in as defaults so "retail-correct motion" isn't a specific URL-flag permutation.

**Bottom line:** the upper-body-only symptom is not one bug but the predictable output of the architecture — a serial, full-skeleton retail sequence (`GetObjectSequence`, `acclient.c:337641`) was re-implemented as parallel three.js mixer overlays that normalize to ~50/50 (`entities.js:584-591`), backed by a single-bone procedural fallback (`entities.js:5608`). Consolidating onto one sequence-based authority is the structural fix; the `FULL_BODY_ONE_SHOT` flag and `_suppressBaseCycleForOverlay` are evidence the team already found the seam but stopped at a flag instead of replacing the blend model.
