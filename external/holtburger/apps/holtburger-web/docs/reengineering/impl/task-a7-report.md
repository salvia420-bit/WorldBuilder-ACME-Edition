# task a7 — SCRIPTMGR-RATE: per-guid ScriptManager runs ~17 Hz instead of its loop cadence

**Verdict: DIAGNOSED + FIXED.** Root cause is unambiguous, reproduces to the digit from
code, and the fix is two lines behind `?scriptHookTime` (DEFAULT-ON, `=off` escape).
Not a clock, not a scheduling policy, not multiple managers, not the 2.7 s pause read as
zero — a **field-name gap across the A11-S1 seam**.

---

## What landed (commits)

| Commit | What |
|---|---|
| `24c0ce4e` | **The fix.** `?scriptHookTime` (DEFAULT ON, `=off` restores the collapsed arm) + `_decodePhysicsScriptHookEntry` carries `startTime`; `docs/url-flags.md` row + reader-index row + default-ON roster; `harness/test_script_hook_time.mjs` (47 checks); registered in `run-js-headless` TIER1. |
| `0b8b5def` | **Comment-only.** `script_manager.js` header: retail's `PhysicsScript::length` **IS** `max(start_time)` — the "known JS-side approximation" note was wrong and the wasm getter it asked for is not owed. Also records the entry contract the defect walked through. |
| `04849caa` | **This report** + re-anchoring the `script_manager.js` citations in `entities.js` / `url-flags.md` on symbol names. `24c0ce4e` cited `:134`/`:140`/`:183`, correct when written and stale one commit later once `0b8b5def` rewrote that file's header — self-inflicted, and exactly the "anchor symbols, never line numbers" rule. No behaviour change. |
| `<this commit>` | Report table completed with the two commits that postdate its first draft. |

Files touched (5): `scene3d/entities.js`, `scene3d/script_manager.js`,
`docs/url-flags.md`, `harness/test_script_hook_time.mjs` (new),
`harness/run-js-headless.mjs` (one plan entry), plus this report. Nothing in the
particles / owner-registry lane; no wasm rebuild (JS-only, live on reload).

---

## Root cause

`entities.js#_decodePhysicsScriptHookEntry` produces the `AnimationHookJs`-shaped object
`_fireHook` consumes. Its hook-offset field is named **`time`**:

```js
const h = { hookType, time, direction: 0 };   // entities.js:13679 — no `startTime`
```

`ScriptManager` keys its **entire** schedule off **`entry.startTime`** — three reads, all
verified this session:

| `script_manager.js` — symbol anchors; the line numbers moved when `0b8b5def` corrected that file's header | Read |
|---|---|
| `addScript` sort comparator | `sorted` comparator `(+a.startTime \|\| 0) - (+b.startTime \|\| 0)` |
| `addScript` `length` derivation | `length = Math.max(0, +sorted[last].startTime \|\| 0)` |
| `_armNextHook` | `_armNextHook`: `nextHookTime = cur.startTime + (+entries[i].startTime \|\| 0)` |

Nothing bridged the two names. `+undefined || 0` ⇒ **0**, so on the `?scriptQueue` path
(DEFAULT-ON since the flip waves) **every** decoded entry carried offset 0:

* each script's derived `length` collapsed to **0** ⇒ back-to-back chaining stacked
  queued scripts onto the same instant;
* **every** hook armed at `script.startTime + 0` ⇒ a 0x33 chain fired *all* its hooks in
  the first `update()` that reached it;
* a CallPES self-loop therefore re-armed with **zero delay** — one full loop iteration
  **per frame**, so `scriptsCompleted` tracked the **frame rate**.

The legacy `?scriptQueue=off` walker was never affected: it delays per hook with
`setTimeout(…, e.startTime * 1000)` reading the wire entry directly (`entities.js:13212`, `:13301`, `:13356`). So this is an on-path-only divergence — exactly what that flag's
"byte-identical / no drift" contract forbids.

### The arithmetic, from real DAT bytes

Decoded straight out of `~/ac_base_dats/client_portal.dat` this session (btree walk;
`[u32 id][u32 count][{f64 start_time, u32 hook_type, i32 direction, payload}]`, payload
length per hook type from `crates/holtburger-dat/src/file_type/setup_model.rs:72-116`):

```
0x3300067A  (176 B, 4 entries)   — Setup 0x020001B3 default_script, the town portal
  t=0.0    CreateParticle  emitterInfo=0x320002CD      <- the swirl
  t=0.0    CreateParticle  emitterInfo=0x320002D6      <- inert in retail too (hw GfxObj 0)
  t=0.0    SoundTweaked    wave=0x0A00038E prob=1.0 vol=0.05
  t=2.7    CallPES         -> 0x330006DA  pause=0.0
0x330006DA  (64 B, 2 entries)    — the sound-only SELF-loop
  t=0.0    SoundTweaked    wave=0x0A00038E prob=1.0 vol=0.05
  t=2.7    CallPES         -> 0x330006DA (itself)  pause=0.0
```

`pause = 0.0 < 0.0002` ⇒ `randPause = 0` (`entities.js:13891`, retail
`CPhysicsObj::CallPES` acclient.c:318984-318987), so the **only** thing spacing the loop
is the CallPES hook's own `start_time = 2.7` — precisely the field that was reading 0.

Driving the **real** `ScriptManager` with the **real** decoder over these entries
(`harness/test_script_hook_time.mjs`):

| arm | 400 s @ 17.5 fps | 400 s @ 60 fps |
|---|---|---|
| pre-fix (`=off`) | `scriptsCompleted` = **7,000** = frames | **24,000** = frames |
| fixed (default) | **145** | **147** |
| ideal 400/2.7 | 148.1 | 148.1 |

**7,000 in a ~400 s session is the reported figure to the digit**, and it identifies the
observer's frame rate as ~17.5 fps — the rate was never 17 Hz *by design*, it *was* the
frame rate. The loop also replayed its `SoundTweaked` ~17×/s.

The fixed count sits 1–3 below the 148.1 ideal because the realised period is 2.7 s
**rounded up to a frame**: `update()` fires the CallPES at the first tick at/after
`next_hook_time`, and the sub-script anchors its own t=0 on that fire time
(`subStart = currentTime()`), so the quantisation carries forward instead of being
absorbed. **Retail quantises identically** — `UpdateScripts` compares against
`Timer::cur_time` on the physics tick and `AddScriptInternal` seeds a fresh chain from the
same `Timer::cur_time` (acclient.c:329089-329093, :329195) — so this is parity, not drift
we introduced. Mean realised period measures **2.70417 s** at 240 fps (asserted).

### Candidates ruled out (each traced, not assumed)

* **re-tick per frame instead of per pause-elapsed** — no; `update()` is called once per
  frame from one site (`entities.js:15260`, `if (mgr.active) mgr.update()`) and its
  `while (t >= nextHookTime)` is correct. The *arming* was wrong, not the ticking.
* **completion counted per hook not per script** — no; `_scriptsCompleted` increments only
  in `_popCurrent()`, and `hooksFired` (14,002) is exactly `2 × scriptsCompleted` on the
  pre-fix arm, i.e. the counter is honest and the loop really ran 7,000 times.
* **multiple managers per guid** — no; exactly **one** `new ScriptManager` site
  (`entities.js:13775`) keyed per guid, one `addScript` caller, one update site.
  `play_effect_vfx.js` and `hook_windows.js` only *mention* ScriptManager in comments.
* **the 2.7 s pause read as 0 somewhere** — the `pause` field is genuinely `0.0` on disk
  and is handled correctly; the 2.7 s lives in the CallPES hook's `start_time`, and *that*
  is what was lost. (Close to the card's guess, but the opposite field.)
* **clock mismatch** — no; `update()` and the CallPES arm both read `currentTime()` from
  the same `time_rng.js` hook.
* **per-frame chain re-attach** — no; every `_attachParticleChainForEntity` call site is
  guarded by the `_particleChainsAttached` set and is spawn-time.

---

## Affected-script census (the card's explicit question)

Over **all 4,248** PhysicsScripts in `client_portal.dat` (4,248 parsed, 0 parse failures):

| class | count | consequence of the defect |
|---|---:|---|
| >1 distinct `start_time` (schedule collapsible) | **416** (9.8%) | whole chain fired in one instant |
| any `start_time > 0` | **427** (10.1%) | at least one hook fired early |
| carry CallPES(19) | 348 | — |
| on a CallPES **cycle** (can reach themselves) | 152 | looped |
| ↳ cycle edge with `pause < 0.0002` ⇒ **HOT** | **68** | **one iteration per frame** (the CPU class) |
| ↳ cycle edges all `pause ≥ 0.0002` | 83 | not hot, but the period lost its `start_time` term |
| ↳ mixed | 1 | — |

**So: no, not all 4,248 tick hot — 68 do** (and only the subset of those actually played by
a live entity; statics run `statics.js`'s own walker, untouched by this). The other 84
looped scripts still ran at the wrong *period*, because under the defect the spacing came
only from the random pause window:

```
0x33000D4A -> self : retail 60.0-70.0 s  vs defect 0-10.0 s     (~9x too fast)
0x33000450 -> 0x33000451 : retail 20.0-44.0 s  vs defect 0-24.0 s
0x33000A57 -> self : retail 13.1-48.1 s  vs defect 0-35.0 s
0x33000784 -> self : retail 10.0-51.0 s  vs defect 0-41.0 s
```

And the 416 staged non-looping scripts were a pure correctness loss — the largest
`start_time` anywhere is **60 s** (`0x33000D4A`), a script that fired in its entirety at
attach.

The portal swirl itself was never at risk, which is why PORTAL-SWIRL-RENDER correctly read
the visual as fixed: `0x3300067A`'s two CreateParticle hooks sit at t=0 either way.

---

## Tests run + results

From `apps/holtburger-web/`, `node <file>`:

```
harness/test_script_hook_time.mjs   47 passed,  0 failed   (NEW)
test_script_manager.mjs             42 passed,  0 failed
test_particle_owner.mjs             48 passed,  0 failed   (the neighbour suite, still green)
test_hook_windows.mjs               11 passed,  0 failed
test_vfx_flags.mjs                  86 passed,  0 failed
harness/run-js-headless.mjs --only=scriptHookTime
                                     1 passed,  0 failed,  0 missing  (of 1 run)
```

From `external/holtburger/`:

```
node scripts/lint-url-flags.mjs           631 documented flags (was 630), 368 distinct JS
                                          readers (was 367), 0 undocumented readers owed
                                          docs rows; --strict identical. The 3
                                          PRESENCE-GUARD findings (envcellRing, fogRingCap,
                                          stableDepthShare) are byte-identical to baseline.
node scripts/audit-flag-defaults.mjs      DEFAULT-POLARITY mismatches 0 · UNDOCUMENTED
                                          readers 0 · in-code COMMENT vs reader mismatches 0
node scripts/lint-harness-params.mjs      FAIL — 3 DEAD-PARAMs (flag, kickDance, other).
                                          PRE-EXISTING: re-run with all my changes stashed
                                          and the new harness file moved aside gives the
                                          identical 3. `scriptHookTime` is not among them.
```

**One pre-existing red, reported as red:** `node test_particle_clock.mjs` dies with
`ERR_MODULE_NOT_FOUND: Cannot find package 'three'` imported from `scene3d/statics.js` —
no `node_modules` on this box. Confirmed pre-existing by `git stash`-ing `entities.js` to
HEAD and re-running: identical failure, before any of my code is reached.

No browser was spent (none available on the box); no wasm rebuild was needed or done.

---

## Read-verified anchors

Retail decomp (`~/ac-headers/acclient.c`, `acclient.h`, `rg -a`):

* `ScriptManager::AddScriptInternal` **acclient.c:329069-329121** — `last_data` ⇒
  `start = last_data->script->length + last_data->start_time`, else `Timer::cur_time`.
* `ScriptManager::NextHook` **acclient.c:329142-329187** — per-hook arming; the
  no-next-script sentinel writes `next_hook_time = -1.0` (`HIDWORD = -1074790400`), which
  is what forces the immediate pop after a script's final hook.
* `ScriptManager::UpdateScripts` **acclient.c:329189-329234** — `while (curr_data)`,
  `break` on `Timer::cur_time < next_hook_time`.
* `PhysicsScript::UnPack` **acclient.c:336452-336528** — reads entries, `_qsort` by
  `PhysicsScriptData::Sort`, then copies the **last** entry's `start_time` into the two
  dwords at `v4+18`/`v4+19`. Cross-checked against `struct PhysicsScript`
  **acclient.h:31801-31805** (`OldSmartArray<PhysicsScriptData *> script_data;` then
  `long double length;`) and `OldSmartArray` **acclient.h:31792-31798** (`data`,
  `grow_size`, `mem_size`, `num_in_array` — so `v4+14..17` is the array and `v4+18/19` is
  `length`). ⇒ **retail's `length` IS `max(start_time)`.**
* `CPhysicsObj::CallPES` **acclient.c:318973-319005** — `delta >= 0.00019999999` ⇒
  `FPHook` at `Random::RollDice(0.0, delta)`, else immediate `play_script_internal`. No
  depth counter anywhere (corroborates the 2026-08-04 `?callPesLoop` finding).
* `struct ScriptData` **acclient.h:31206-31211**, `struct PhysicsScriptData`
  **acclient.h:31992-31996**.

In-repo:

* `scene3d/script_manager.js` — the three `.startTime` reads: the `addScript` sort
  comparator, the `addScript` `length` derivation, and `_armNextHook`. (They were
  `:134`/`:140`/`:183` at `24c0ce4e` and are `:152`/`:158`/`:201` after `0b8b5def`
  rewrote that file's header — hence the symbol anchors here and in the code comments.)
* `scene3d/entities.js:13679` — `const h = { hookType, time, direction: 0 }` (the gap).
* `scene3d/entities.js:13775` — the only `new ScriptManager`; `:13821` the only
  `addScript` caller; `:15260` the only `update()` site.
* `scene3d/entities.js:13891-13905` — the CallPES arm (`randPause`, `subStart`, the async
  `.then` re-queue).
* `scene3d/entities.js:13212` (Sound/SoundTweaked), `:13301` (SoundTable/Scale) and `:13356`
  (CallPES) — the legacy off-path's per-hook `setTimeout` delays, each reading
  `e.startTime` straight off the wire entry (proof the off-path never had this defect).
* `crates/holtburger-dat/src/file_type/physics_script.rs:16-21` and
  `.../setup_model.rs:52-116` — the wire layout used to decode the DAT.
* `test_script_manager.mjs:33-35` — `entries()` hand-builds `{startTime, marker}`, which is
  why 42 green checks never saw this.

**Citation correction (I4).** The card and `script_manager.js`'s header both cite
`UpdateScripts` as **acclient.c:329189-329246**; the function body actually ends at
**:329234** (`:329235` blank, `:329236` the IDA separator comment, `:329237` the
`ScriptManager::~ScriptManager` signature). Cosmetic; left as-is in the existing text I
did not own, corrected in everything I wrote.

---

## DEVIATION blocks

**DEVIATION-1 — the fix lives in `entities.js`, not `script_manager.js`.**
The card scopes a landing to "`script_manager.js` + one test" and says to stop at a dossier
if the blast radius exceeds that. The defect is a *producer* bug: `script_manager.js` is
correct (it is a faithful port and its contract is `startTime`), and the caller emits the
wrong field name. `entities.js` is explicitly inside my declared scope ("+ its direct
callers in `scene3d/entities.js`"), and the change there is **two lines** (a flag reader
and `if (SCRIPT_HOOK_TIME_ON) h.startTime = time;`). Fixing it inside `script_manager.js`
instead — accepting `entry.time` as a fallback — was rejected: it would blur the module's
one documented contract and paper over the next owner (statics / PlayEffect) making the
same mistake. I judged the *intent* of the scope rule (small, contained, one owner) met and
landed; the honest alternative reading is that this exceeded scope and should have been a
dossier. Flagging it rather than burying it.

**DEVIATION-2 — two extra files beyond the fix + test.**
`docs/url-flags.md` (required by I7 — row, reader index, default-ON roster) and one plan
entry in `harness/run-js-headless.mjs`. The latter is not strictly required (the precedent
landing `30b8cd4b` touched 3 files and its suite was already registered), but an
unregistered suite is a suite nobody runs. Additive; the runner's pre-existing RED is
unchanged.

**DEVIATION-3 — the acceptance bound "N seconds → scriptsCompleted ≈ N/2.7 ± 1" does not
hold literally at realistic frame rates**, and the test does not pretend it does. Frame
quantisation costs up to one frame per iteration and the tail iteration is truncated, so
400 s reads 145 @17.5 fps and 147 @60/240 fps against 148.1. The test asserts (a) the
frame-quantised band, (b) `|completed − 400/2.7| ≤ 2` with the truncation named, and
(c) the **mean realised period = 2.7 s ± 1 frame**, which is the acceptance criterion's
exact form. Retail carries the same quantisation (anchors above), so tightening this
further would mean deviating *from* retail.

---

## Remainder / follow-ups

1. **LIVE VERIFICATION IS OWED — nothing here was run in a browser.** No browser exists on
   this box and the laptop capture dir (`/mnt/wbterminal2/portal-swirl-2026-08-10/`) is not
   mounted here, so the original 7,000 reading could not be re-read directly; it was
   reproduced *arithmetically* from the shipped code and the real DAT. Proposed rider on
   the existing PORTAL-SWIRL-RENDER `followUp1070` eyetest (same vantage, no extra trip):
   park at the Yaraq town portal for 120 s and read the per-guid manager. **PASS =
   `scriptsCompleted` ≈ 44 ± 2** (120/2.7); the `?scriptHookTime=off` A/B arm should read
   ≈ `120 × fps`. The swirl must be unchanged on both arms.
2. **Behaviour change to watch on the default arm, beyond the portal.** 416 scripts (9.8%)
   now stage instead of firing at once, and 152 looped scripts change period — including
   `0x33000D4A` going from a 0–10 s loop to a 60–70 s one. That is retail-correct and
   matches the `?scriptQueue=off` walker, but it is a *visible* change to ambient VFX
   timing across the world, not a portal-local one. `?scriptHookTime=off` is the one-param
   kill path if an eye judges any of it wrong.
3. **A staged script now holds its manager `active` for the script's full duration**
   (up to 60 s) instead of draining in one tick, so `mgr.update()` runs a numeric compare
   per frame per live scripted entity. That is far cheaper than the 17 Hz hook churn it
   replaces, but it is a real (tiny) change in the idle-manager population.
4. **The same seam is unfixed for future owners.** `script_manager.js`'s header comment
   promises "the PlayEffect / statics owners supply their own thin callbacks over the same
   shape" — neither exists yet (`play_effect_vfx.js` and `statics.js` still run their own
   walkers). When they fold in, they must map their hook offset onto `startTime`; the
   contract is now documented in the module header (`0b8b5def`) and an entry that omits it
   still fails **silently**. A defensive `startTime ?? time` in `addScript` was deliberately
   *not* added — it would make the `=off` arm non-identical and re-hide the class of bug.
5. **`test_script_manager.mjs` remains blind to the seam by construction** (it hand-builds
   entries). `harness/test_script_hook_time.mjs` covers the seam by lifting the shipped
   decoder out of `entities.js` by text; if that method is ever renamed or its brace shape
   changes, the lift throws loudly rather than silently passing.
6. **Not investigated (out of scope, flagged):** whether the 68 hot-tick scripts were also
   driving audible sound spam elsewhere in the world. The portal's `SoundTweaked` is
   `vol=0.05`, so ~17 plays/s was probably inaudible — louder members of that set may not
   have been.
