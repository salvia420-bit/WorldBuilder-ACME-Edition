# holtburger-web flag harness

A three-tier regression gate for the **unified-pipeline** flag work (movement
spine, remote-pose driver, animation, render). Each unified-pipeline URL flag is
covered by at least one tier; the harness classifies every result so it never
cries FAIL for an environmental miss or a rebuild-timing gap.

**One entry point:** [`run-all.mjs`](run-all.mjs).

```sh
# from apps/holtburger-web/
node harness/run-all.mjs              # default: Tier 1 (host JS) — works TODAY
node harness/run-all.mjs --js
node harness/run-all.mjs --rust
node harness/run-all.mjs --playwright
node harness/run-all.mjs --all        # all three + one GREEN/RED gate
node harness/run-all.mjs --list       # show the tier plan + child commands
node harness/run-all.mjs --help
```

There is **no `npm test`, no runner, no `package.json`** anywhere in this tree.
Every test is a bare `node <file>` that self-reports via `process.exit(0|1)`.
`run-all.mjs` just spawns the three sibling runners as children and aggregates
their exit codes into one gate.

---

## The three tiers

| Tier | Runner | Needs rebuild? | Needs server? | What it covers |
|---|---|---|---|---|
| **1 — host JS unit** | `harness/run-js-headless.mjs` | **no** | **no** | Pure-Node unit tests of the JS-side flag logic. **The gate that works today.** |
| **2 — native Rust** | `harness/cargo-tests.mjs` | no (tests run native; flags go *live* in-browser after a rebuild) | no | `cargo test -p <crate> --lib` for the rebuild-coupled flags' Rust coverage. |
| **3 — in-browser** | `harness/playwright/drive.mjs` | **yes** (v4 getters) | **yes** (serve.py + ACE + wsbridge) | Live in-world Playwright descriptors reading wasm getters + diag globals inside `page.evaluate`. |

The exact flag→tier→getter/test mapping is in **[`COVERAGE.md`](COVERAGE.md)**.

### Directory layout

```
harness/
  run-all.mjs            ← single entry point (this README's subject)
  run-js-headless.mjs    ← Tier 1 runner
  cargo-tests.mjs        ← Tier 2 runner
  playwright/
    drive.mjs            ← Tier 3 runner (imports the descriptors below)
    flags.spine.mjs      ← unifiedTick/posePublishPostTick/wireStatePacks/worldLifecycle/maintPrune/unifiedTransition
    flags.remote.mjs     ← remoteInterp/stickyRetail/wasmPursuit
    flags.anim.mjs       ← mtQueue/jumpParity/retailRunKeys/rootMotionObject/getLink/placementId/particleDegrade
    flags.sync.mjs       ← syncPhysicsTick
  lib/
    assert.mjs           ← result()/pass()/fail()/skip()/rebuildPending() + assert* helpers (the 4 statuses)
    boot.mjs             ← launchAndEnter(): headless Playwright boot → in-world, returns the `helpers` object
    schema.md            ← the flags.*.mjs descriptor schema + classification rules (authoritative)
  README.md              ← you are here
  COVERAGE.md            ← every flag × tier × getter/test × compose/const reqs
```

---

## Tier 1 — host JS (`--js`, the default)

**Works today. No wasm rebuild, no server, no browser.** Runs the already-green
unit tests plus the two new Tier-4 tests, each as its own `node <file>` child
(exit 0 = PASS), against the **current** `pkg/`.

```sh
node harness/run-all.mjs --js
# or directly:
node harness/run-js-headless.mjs [--only=substr,…] [--tier=1|4|all] \
                                 [--quiet] [--list] [--strict-missing] \
                                 [--timeout=MS] [--bail]
```

- These are deterministic JS unit tests of flag logic (input funnel, hook
  windows/fire-queue, surface bitfield fold, script-manager queue, particle
  ownership/degrade, pre-create buffer, run-keys, root-motion, pursuit monitor,
  rig module, camera retail math, remote-interp ownership, jump-charge parity)
  plus the two Tier-4 tests (blocking-particle parity, default-script-spawn).
- `.mjs` files import app modules (with three-stub shims where needed); `.cjs`
  files under `tests/` are CommonJS. Children are spawned with cwd =
  `apps/holtburger-web` so relative imports resolve exactly as by hand.
- **MISSING tolerance:** a Tier-4 file authored in a parallel wave that does not
  exist yet is reported as a `MISSING` row and (by default) does **not** fail the
  run. Use `--strict-missing` to make a missing file a FAIL once you want the gate
  to enforce its presence.

This tier should be **GREEN before you commit JS changes** to any unified-pipeline
module.

---

## Tier 2 — Rust (`--rust`)

Native `cargo test` for the rebuild-coupled flags' Rust coverage (tick spine,
transitions, pursuit/auto_run, world lifecycle, sticky managers, getLink resolver,
root-motion fold, placement frames).

```sh
node harness/run-all.mjs --rust [--print-only] [--no-cap] [--cap] [--only=crate]
# or directly:
node harness/cargo-tests.mjs [--print-only] [--no-cap] [--cap] \
                             [--only=holtburger-core,…] [--exact] [--quiet]
```

### OOM rules — how to actually run it

This 8GB laptop's OOM protection stack **FORBIDS** an uncapped `cargo test` or any
`--workspace` build. The two safe ways to execute the commands this runner prints:

- **Buildbox (preferred for a full sweep):** the 18-core GCE box has no cap.
  Run `node harness/cargo-tests.mjs --no-cap` there.
- **Locally, capped:** the runner **auto-prefixes** every cargo invocation with
  `capped-build` (`/usr/local/bin/capped-build` — joins the 3.5G `builds` cgroup,
  `oom.group`, `CARGO_BUILD_JOBS=2`, nice/ionice). It does this automatically when
  cargo is present and the box looks small; force with `--cap` / disable with
  `--no-cap`.

If `cargo` is not resolvable, the runner is **PRINT-ONLY-SAFE**: it prints the
exact commands and exits 0 (never pretends to have run them). `--print-only`
forces that behavior even when cargo is present.

### wasm-crate caveat (`holtburger-web`)

`holtburger-web` is a `crate-type=["cdylib","rlib"]` crate, **but every listed
test is a plain `#[test]` in a `#[cfg(test)]` module** (NOT `wasm_bindgen_test`).
The math/fold helpers under test are `cfg(any(target_arch="wasm32", test))`-gated,
so they run on the **native host target** with plain `cargo test -p holtburger-web
--lib`. **Do NOT use `wasm-pack test` / `--target wasm32` for these.**

### Test-name corrections baked in

The runner carries the **corrected** per-crate test list (several names in the
task spec were production fns that match zero tests, or live in a different crate).
See the comment block at the top of `cargo-tests.mjs` and the per-flag notes in
`COVERAGE.md`. The `flags.*.mjs` descriptors carry the *verbatim* (uncorrected)
`rustTests` for traceability; `cargo-tests.mjs` is the corrected, runnable view.

---

## Tier 3 — Playwright (`--playwright`)

In-browser, in-world descriptors. For each flag, `drive.mjs` builds the boot
query (the flag + every URL-settable `composeDep`), boots a headless in-world
session via `lib/boot.mjs#launchAndEnter`, runs the flag's `assertBrowser(helpers)`
(which reads live wasm getters + diag globals **inside `page.evaluate`**), and
classifies the `{status, detail}`.

```sh
node harness/run-all.mjs --playwright [--smoke]
# or directly:
node harness/playwright/drive.mjs [--smoke] [--only=key1,key2] \
                                  [--timeout=MS] [--no-group] [--list]
```

### Infra it needs (all on `127.0.0.1`)

1. **WASM rebuild** so the v4 additive getters exist (see below). Pre-rebuild,
   getters read absent and those descriptors classify `rebuild-pending` (NOT
   fail).
2. **Dev server:** `python3 scripts/serve.py` (auto-binds `127.0.0.1:8765` over
   the baked dist root; app at `/apps/holtburger-web/`).
3. **wsbridge:** the local ws bridge (`ws://127.0.0.1:8080/`).
4. **ACE server:** the ACEmulator world server (`127.0.0.1:9000`).
5. **Playwright chromium** (see the install note at the bottom).

**If the server/bridge/ACE is unreachable, or Playwright is not installed, the
WHOLE tier SKIPs and exits 0** — it does not hang and it is not a failure. Boot
that stalls before in-world (geometry-only scene, no pose) is also a SKIP, never
a fail (per [`MEMORY`: gate on in-world+pose, NEVER `ready`]).

### `--smoke`

Validates harness **plumbing** on a NON-rebuilt bundle: it tolerates
`rebuild-pending` and `skip` and exits non-zero ONLY on a hard `fail`. (The exit
code is identical without `--smoke` because rebuild-pending/skip are never
failures — `--smoke` is the documented mode for a pre-rebuild plumbing check.)

The login account is `tailnet1`/`tailnet1` (standing automation account,
teleport/Developer privs). `?nullRender=1` is forced by `boot.mjs` (mandatory
headless, else rAF throttles to ~0.2Hz and nothing ticks).

---

## Soft-degrade semantics — the four outcomes

The whole point of the harness is to **never report FAIL for a non-defect**. The
four statuses (from `lib/assert.mjs`):

| Status | Meaning | Counts as gate failure? |
|---|---|---|
| **pass** | The behavior/getter was present, reachable, AND matched expectations. | no |
| **fail** | The behavior/getter was present + reachable but **WRONG** (a getter that should rise stayed flat under its flag; a render `programs` count grew across a cast it must hold flat; a JS unit assertion threw). | **YES** |
| **skip** | A precondition that **cannot be set from a URL** was unmet: a Rust **const** is off (`USE_STICKY_MANAGER`, `USE_MOVETO_DRIVER`, `USE_MOTION_TABLE_QUEUE`), a compose-dep **mob/NPC was not in view**, or the run had **no world**. Presence is still asserted where possible. | no |
| **rebuild-pending** | A wasm export/getter the assert needs is **ABSENT from the current `pkg/`** — the user's separate rebuild is expected to add it. | no |

Tier-specific framing of the same idea:

- **Tier 1:** `MISSING` (a Tier-4 file not yet authored) is tolerated by default,
  not a fail (use `--strict-missing` to enforce).
- **Tier 2:** `cargo` absent ⇒ PRINT-ONLY (exit 0). A real test failure ⇒ fail.
- **Tier 3:** `SERVER_DOWN` / `PLAYWRIGHT_MISSING` / boot-stall ⇒ skip (exit 0).
  An absent v4 getter ⇒ rebuild-pending. A const-gated behavior that fast-fails /
  reads zero (e.g. `pursuitStatus()` fast-fails to state 3 because
  `USE_MOVETO_DRIVER` is off) ⇒ skip. A getter present + flag set but **wrong** ⇒
  fail.

### The gate (`run-all.mjs` exit code)

- **GREEN (exit 0)** when every selected tier that ran exited 0. skip /
  rebuild-pending / print-only are folded into exit 0 by the child runners, so a
  tier exiting 0 means "no hard failure".
- **RED (exit 1)** if any selected tier exited non-zero, or a tier's runner file
  is missing.

---

## The WASM rebuild (the user's separate step)

The harness is written to run **AFTER** the user's rebuild. Tier 1 needs nothing;
Tier 3 needs the rebuild for the v4 additive getters (and the Tier-2 Rust flags
only go *live in the browser* after it). Mirror of
`docs/url-flags.md:339` + `pkg-node/README.md`:

```sh
# Local, OOM-jailed (fast --dev; ~seconds):
export PATH="$HOME/.cargo/bin:$PATH" \
  && capped-build wasm-pack build --target web --out-dir pkg --dev

# Buildbox, uncapped (--release runs wasm-opt; ~1m30s):
export PATH="$HOME/.cargo/bin:$PATH" \
  && wasm-pack build --target web --out-dir pkg --release
```

Then **bump the `?v=wave-…` cache-bust in `index.html`** (2 spots, ~lines 947 +
1234) so the browser fetches the fresh bundle. JS-only changes are already live on
reload; only the Rust-side exports/emissions are inert until this rebuild.

The current `pkg/` (timestamped today, `WASM_EXPORT_MANIFEST_VERSION = 4`) already
ships all the probed v4 getters, so **nothing is rebuild-pending right now** — but
the harness still guards every getter probe (`readGetter(...).present`) so that if
a future rebuild regresses `pkg/`, those descriptors classify `rebuild-pending`,
never `fail`. Use the runtime `wasm_export_manifest_version()` (==4 now), NOT
index.html's deliberately-pinned `EXPECTED_WASM_MANIFEST_VERSION=1`, as the
freshness oracle.

> `pkg/` is a separate build artifact from `pkg-node/` (the `--target nodejs`
> build). Tier 2's tests run on the **native host target** and need *neither* —
> they only need the cargo toolchain.

---

## Typical workflows

```sh
# Daily JS regression gate (no infra):
node harness/run-all.mjs --js

# Pre-commit on a Rust change, on the buildbox:
node harness/run-all.mjs --rust --no-cap

# After a wasm rebuild + serve.py/ACE/wsbridge are up, full sweep:
node harness/run-all.mjs --all

# Plumbing check before a rebuild (tolerate rebuild-pending in the browser tier):
node harness/run-all.mjs --playwright --smoke

# Just see what each tier would do:
node harness/run-all.mjs --all --list
```

`run-all.mjs` forwards any unrecognized arg to the selected child runner(s), e.g.
`--all --quiet`, `--js --only=surface`, `--rust --print-only`,
`--playwright --only=jumpParity --timeout=90000`.
