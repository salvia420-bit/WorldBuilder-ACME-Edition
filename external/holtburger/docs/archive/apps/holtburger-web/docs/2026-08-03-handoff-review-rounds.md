# Handoff — random-spot review, rounds 1-10 (2026-08-03)

Ten rounds of random-spot code review across holtburger-web (JS/three.js), the
Rust crates, `index.html`, and the test harness. Run as 3-way parallel work:
me plus two Opus agents on disjoint file sets each round.

Detail per round lives in **`docs/2026-08-03-random-review-fixes.md`** (790
lines). This file is the state-of-play: what is fixed, what is left, and the
traps that will bite whoever picks it up.

---

## 1. Tally

| Round | Surface | Findings | State |
|---|---|---|---|
| 1 | `scene3d/` random spots | 18 | 20 fixes |
| 2 | materials, lighting, particles, buildings, atlas | 21 | 21 fixes, 1 deferred |
| 3 | boot/adapter/worker, body-sim/HUD/shadows | 18 | 18 fixes, 1 deferred |
| 4 | sky/atmosphere + **first Rust review** | 21 | 21 fixes, 2 deferred |
| 5 | `index.html` + plugins/ui (both never reviewed) | 20 | 20 fixes, 2 deferred |
| 6 | **test integrity** — make suites/tools able to FAIL | 17 | 14 fixed (#104-#120) |
| 7 | VFX leaf modules + terrain shader/batch | 16 | 15 fixed (#121-#136) |
| 8 | combat/gore + boot infrastructure | 16 | 16 fixed (#137-#152) |
| 9 | `plugins/`, `ui/`, harness | 25 | fixed (#153 + doc) |
| 10 | `index.html`, Rust world/session, remaining plugins | 16 | fixed (#163) |

**~188 findings across 10 rounds. 27 review commits, all pushed to `master`.**
Rounds 6-10 are tracked as tasks **#104-#169**: **47 completed, 19 open**.

Rounds 1-5 predate the task list; their deferred items were folded into the
round 6-7 task IDs.

### The five that mattered most

1. **Service worker could brick returning clients** (#145) — cached `boot.hba`
   and catalog files cache-first. Neither is content-addressed; only
   `shards/{sha}/` is. A re-bake fed every returning client a stale boot pack
   into a hard hash-mismatch. Unbootable, and `?nosw=1` is the only escape.
2. **25 of 54 skill formulas wrong** (round 10) — a hand-copied table
   contradicting portal.dat's SkillTable, which `WorldState` already loads.
3. **`combat-hud` reset your swing power to 100% every second** (round 9) —
   set the slider to 30%, swing at full power a second later.
4. **Server-supplied `ServerName` into `innerHTML` unescaped** (round 10) —
   the server picker is fed from a public community list, so an untrusted shard
   is the normal case.
5. **169 of 212 test suites ran in no runner** (round 9) — see §2.

---

## 2. The test gate — the biggest structural change

**43 → 250 registered suites.** Four out of five suites in the tree were
written, passing, and protecting nothing. Found while looking for somewhere to
register *one* new suite and noticing that round 8's own service-worker
regression test was unregistered too.

`harness/run-js-headless.mjs` now carries:

- **TIER5** — every previously-unregistered suite that was verified to pass.
- **QUARANTINE** — 41 known-failing suites, **printed** as `QUARANTINED` rows.
  An omitted failure is indistinguishable from a test that was never written,
  which is how several were lost. Clearing this list is **#156**.
- **COVERAGE GUARD** — fails the run on any suite in neither list, across all
  three naming conventions in the tree (`test_*.mjs` at app-root and `rynth/`;
  `*.test.mjs`/`*.test.cjs` and `test_*.mjs`/`.cjs` under `tests/`).

**The guard's own first bug is the lesson**: it originally scanned one
convention, leaving 39 suites under `tests/` invisible to the very check
written to make invisible suites impossible. Another reviewer caught it.

Current full run: **240 passed, 5 failed, 2 SKIP, 0 unregistered.** All 5
failures are pre-existing (registered at HEAD, failing standalone). The 2 SKIPs
are the hollow-pass class — exit 0 having asserted nothing (**#157**).

```
node harness/run-js-headless.mjs --quiet        # full gate
node harness/run-js-headless.mjs --list         # resolved plan
node harness/run-js-headless.mjs --only=substr  # one suite
```

---

## 3. Remaining work

### Correctness — do these first

| # | What | Why it matters |
|---|---|---|
| **#168** | `WorldObjectExt::structure()/stack_size()` unguarded `i32→u32` | Round 10 fixed ONE call site (a 4.29e9-iteration loop). **Every other caller is still exposed.** Root cause is in `holtburger-common`. |
| **#167** | `teleport_arrival_pending` promised a `Reset` upgrade that does not exist | Comments corrected; the real question is unanswered. `Reset` and `Snapshot` are materially different syncs — either the comment was aspirational or this is a live teleport bug. |
| **#119** | `wielder_index` staleness on guid reuse + `SETUP_BSP_ATTEMPTED` not cleared on re-init | Same guid-recycling family as #105/#150, which were real. |
| **#158** | Loader does not skip dependents when a dependency fails at LOAD time | Latent today (the tree's only dependency is optional), fires on the first required one. |
| **#161** | `powerMeterSwingDuration` catch returns the *disabled* state for a default-ON flag | Fail-closed polarity. Check whether other default-ON readers share the shape. |

### Cleanup / hygiene

**#104** plugin wasm-box ownership contract (8 sites needing caller changes) ·
**#162** ~10 more unfreed box sites, hottest is `inventory.js:2187` (~3× per
inventory delta) · **#136** `setTerrainWaterCodes` has zero call sites ·
**#154** `trail_map.dispose()` has no non-test caller · **#159** caret range
wrong for `0.x` (one version bump from live) · **#160** two eatable-event
implementations drifted · **#164** "Stop polling" comment that does not stop
polling · **#165** flat EnvCell gate on the `?unifiedDispatch=off` escape path ·
**#166** make `derive_skill_value` DAT-driven · **#120** WorldBuilder.Terminal
texture-parity `records`.

### Test debt

**#156** classify the 41 quarantined suites — 8 are classified against the
R7/R8 records; **33 are unclassified because nothing has ever run them**. Each
needs the same adjudication: is the TEST stale, or is the PRODUCT wrong?
`docs/url-flags.md`'s **default column** is the authority (its prose is not —
round 9 found two rows contradicting their own column). · **#157** two
hollow-pass suites · **#155** `retailRunKeys` test vs shipped default ·
**#169** four lower-confidence Rust leads, deliberately unproven.

### Blocked on hardware — the 1070 eye-test queue

`harness/vistest-1070-round1-7.mjs` is **staged and unrun** (5 arms; the box
was offline all day — tailscale last seen 36→59 min). Read
`memory/fleet-runbooks.md` before driving it: **a person uses that machine**,
so off-screen/headless only, `--mute-audio` mandatory, never `browser.close()`,
kill test Chrome by `--user-data-dir` match only.

Owed a real GPU: terrain_batch A-channel gate · cross-family trail behaviour ·
tarnish per-instance variation · gemSparkle anchor · ragdoll_env indoor/outdoor
floor · ceiling spatter tracking the blow · less-canned kills · **chat-panel
corner-drag feel** (round 9 corrected the direction — correct, but different) ·
**nearby-entity widening** (round 10: same-cell → landblock+8 neighbours,
changes what feeds the active-solve radius) · **sticky-target replacement**
(#169, changes live movement).

---

## 4. How this was run — keep these rules

They were learned the expensive way; the detail is in the tracking doc.

- **Prove every behavioural fix red-then-green.** Revert the source, watch it
  FAIL, restore, watch it PASS. An unproven fix is a guess.
- **Write the negative control** where a plausible-but-wrong fix exists. The
  identity-guard convention is `inst._disposed || map.get(guid) !== inst`; a
  bare `.has(guid)` *looks* right and is wrong (same-guid respawn passes). Good
  tests are red for the wrong fix too.
- **Agent findings are hypotheses.** Verify every `file:line` yourself. Round 10
  proved this both ways: one agent's headline was confirmed exactly against the
  DAT, and another's proposed fix would have **broken indoor collision** if
  applied as written.
- **Stage by path when agents run concurrently.** A `git add -A` in round 8 swept
  another agent's in-progress files into the wrong commit. A half-written file
  would have been worse than mis-attribution.
- **Never change a shipped default** to make a test pass. Fix the test, or
  escalate. `url-flags.md`'s default column is the authority.
- **A verified-clean rule port is worth as much as a defect** — it tells you
  where not to look again. Round 9 diffed 174 `PLAY_SCRIPT` values and four
  combat formulas against retail/ACE: zero drift.

## 5. Traps that will bite you

- **`?nosw=1` on every dev URL.** The service worker caches `index.html` across
  browser restarts; Ctrl+Shift+R does **not** clear it.
- **`rg -r` is `--replace`.** `rg -rn 'x'` mangles output. Use plain `rg -n`.
- **8 GB laptop.** Never `cargo build/test --workspace`, never bare
  `wasm-pack`. Per-crate under `capped-build` (3.5 G cap, 2 jobs); a full
  `cargo test -p holtburger-world` needs `CARGO_BUILD_JOBS=1`. Kill
  `rust-analyzer` first (~2.4 G back); **never** kill `earlyoom`.
- **`pkg/` wasm ships `--dev` silently** (~18 MB dev vs ~4.5 MB release) — a ~4×
  tax. Check `ls -la pkg/*.wasm` before measuring anything.
- **Keep ACE vanilla.** Never edit or rebuild `~/ace-server`.
- **`scene3d.frameTime.tsSec` freezes** under `?renderOnDemand=1`. Throttles
  need a live monotonic clock — found at five sites across rounds 1/3/4/7.
- **A comment stating a rule is not evidence the rule is implemented.** Round 9
  found a queue-drop comment with no code behind it; round 10 found a `Reset`
  upgrade that never existed. Round 10 also found two comments that *appeared*
  to contradict each other and simply had different dates — check `git log`
  before concluding a contradiction.
