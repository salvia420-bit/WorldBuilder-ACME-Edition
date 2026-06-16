# Flag descriptor schema (`flags.*.mjs`)

Every `harness/flags.<flag>.mjs` file MUST default-export (and also named-export)
a `flags` array. The driver imports it, runs each flag's `assertBrowser`, and
aggregates the `{status, detail}` results. One file may carry one or many flag
descriptors.

```js
// harness/flags.<flag>.mjs
export const flags = [
  {
    key,            // string, REQUIRED. URL flag token, e.g. "wasmPursuit".
                    // Stable id used in the run query and the report.
    name,           // string, REQUIRED. Human label, e.g. "WASM pursuit driver".
    tier,           // string, REQUIRED. Maturity bucket from docs/url-flags.md
                    // (e.g. "A2-P2", "movement", "render"). Free-form; report-only.

    query,          // string | object, REQUIRED. The flag's OWN query contribution
                    // merged ON TOP of the base headless+autoLogin query by the
                    // driver before launchAndEnter(). String fragment
                    // ("wasmPursuit=on") or object ({ wasmPursuit: "on" }).
                    // MUST set this flag on; SHOULD also set every composeDep
                    // that IS URL-settable (see composeDeps).

    composeDeps,    // string[], REQUIRED (use [] if none). Other URL flags this
                    // flag's BEHAVIOR needs, per docs/url-flags.md. Each entry is
                    // a URL token the driver can fold into the query (e.g.
                    // remoteInterp needs ["unifiedTick","wireStatePacks"]).
                    // The driver guarantees these are in the query; assertBrowser
                    // then only worries about NON-url preconditions (constReq,
                    // a mob being in view, etc).

    constReq,       // string | undefined, OPTIONAL. A Rust compile-time const the
                    // BEHAVIOR needs that CANNOT be set from a URL (e.g.
                    // "USE_STICKY_MANAGER", "USE_MOVETO_DRIVER"). Its presence is a
                    // signal to assertBrowser: probe whether the const-gated effect
                    // is live; if not, return result('skip', "<constReq> off in
                    // this build") — NEVER 'fail'. Document the exact const name so
                    // the report explains the skip.

    rebuildCoupled, // boolean, REQUIRED. true if assertBrowser reads a wasm
                    // getter/export added in a recent manifest wave (v3/v4). When
                    // true, assertBrowser MUST guard the getter with
                    // helpers.readGetter(...).present and return
                    // result('rebuild-pending', ...) when absent — because the
                    // harness runs AFTER the user's separate wasm rebuild, which
                    // could regress pkg/. false for pure-JS-diag flags.

    rustTests,      // string[], REQUIRED (use [] if none). EXACT cargo test filter
                    // substrings that cover this flag, for a companion native
                    // `cargo test -p <crate> --lib -- <name...>` step (NOT run by
                    // the browser harness). Must be real #[test] names/prefixes —
                    // NOT production fns (a production-fn filter runs ZERO tests).
                    // See the api-spec corrections; [] is valid (some flags have
                    // no named rust tests).

    crate,          // string | undefined, OPTIONAL. The cargo package the rustTests
                    // live in: "holtburger-core" | "holtburger-world" |
                    // "holtburger-dat" | "holtburger-web". Omit when rustTests==[].
                    // NOTE: a flag's tests can live in a DIFFERENT crate than its
                    // nominal subsystem (e.g. jumpParity tests are holtburger-core,
                    // not -world) — set crate to where the test ACTUALLY is.

    async assertBrowser(helpers) {
      // REQUIRED. Runs in Node with a LIVE in-world page (helpers from
      // launchAndEnter). All wasm/DOM reads go through helpers.* (which run
      // inside page.evaluate). MUST return result(status, detail) from
      // harness/lib/assert.mjs. MUST NOT throw for an expected-missing
      // precondition — classify it (see rules below). May throw only on a
      // genuine harness bug; the driver treats an uncaught throw as 'fail'.
      // return result('pass'|'fail'|'skip'|'rebuild-pending', detail);
    },
  },
];

export default flags;
```

## `helpers` contract (from `launchAndEnter`)

`assertBrowser(helpers)` receives the object returned by
`harness/lib/boot.mjs#launchAndEnter`. Read-only (except `close`, which the
DRIVER owns — do not call it inside `assertBrowser`):

| helper | shape | use |
| --- | --- | --- |
| `page` | Playwright `Page` | escape hatch; prefer the wrappers below |
| `url` | string | the exact URL booted (for `detail`) |
| `evalInPage(fn, ...args)` | `Promise<T>` | run a self-contained fn in the page; pass inputs as trailing args (no closures) |
| `readGetter(method, args=[])` | `Promise<{present, value}>` | read a `window.__sessionHandle.<method>(...)`. `present=false` ⇒ getter ABSENT ⇒ classify `rebuild-pending`. Typed arrays/wasm structs are deep-cloned to plain JSON. An in-call throw lands as `value.__error`. |
| `readDiag(globalName)` | `Promise<any\|null>` | JSON-clone of `window.__<globalName>` (dotted paths walked, Maps/Sets handled), or `null` if absent |
| `entityCount()` | `Promise<number>` | live entity count (`window.entityMap.size` → fallbacks); `-1` = unknown |
| `consoleErrors()` | `Array<{t,type,text}>` | console `error`s + uncaught `pageerror`s since nav |
| `waitMs(ms)` | `Promise<void>` | awaited page-clock delay (e.g. let a charge curve rise, or PVS settle) |

The driver also gets `inWorld` from `launchAndEnter` (boolean). If `inWorld` is
false (boot stalled, geometry-only scene, no pose) the driver SKIPs the run — it
must NOT call `assertBrowser` against a world-less page.

## Classification rules (load-bearing)

The four statuses come from `harness/lib/assert.mjs#result`. Get them right —
the whole point of the harness is to never cry FAIL for an environmental or
rebuild-timing miss.

1. **Getter / wasm export absent ⇒ `rebuild-pending`.** If
   `helpers.readGetter(m).present === false` (or `window.__notifyAnimationDone`
   is a no-op, or `__hbWasm.fetch_particle_degrade_distance` is undefined),
   return `result('rebuild-pending', "<method> absent from current pkg")`. This
   is expected when the harness runs before the matching wasm rebuild. As a
   freshness oracle, read the runtime manifest first:
   `helpers.readGetter('wasm_export_manifest_version')` is NOT on the handle —
   call the free fn via `evalInPage` reading the module value the page exposes,
   or simply trust per-getter `present` probes. If a v4 additive getter is
   absent, classify its dependents `rebuild-pending`, never `fail`.

2. **Compose-dep / const-req unmet ⇒ `skip` (with reason), driver still runs.**
   - `composeDeps` are URL-settable, so the DRIVER folds them into the query and
     they should be satisfied. If a composite BEHAVIOR still doesn't manifest
     (e.g. `pollRemotePoses()` returns 0 rows because no moving remote NPC is in
     view; a sticky row never flags because no sticky mob is nearby), return
     `result('skip', "no <X> in view — composite present but unexercised")` and,
     where possible, still assert PRESENCE/callability as a `pass`.
   - `constReq` is a Rust const NOT settable from any URL. If the const-gated
     effect is off in this build (e.g. `pursuitStatus()` fast-fails to state 3
     instead of reaching 2 because `USE_MOVETO_DRIVER` is off;
     `localStickyTarget()` stays 0 because `USE_STICKY_MANAGER` is off), return
     `result('skip', "<constReq> off in this build — presence-only")`. Accepting
     a documented fast-fail/zero is NOT a `fail`.
   - When the flag itself is simply not set (presence-only run), assert that the
     getter is callable and return `pass` for presence; do not assert the gated
     behavior.

3. **`SERVER_DOWN` ⇒ the WHOLE run SKIPs.** `launchAndEnter` throws
   `Error` with `code:'SERVER_DOWN'` when serve.py is unreachable. The DRIVER
   catches this once at the top and marks every flag `skip("SERVER_DOWN")`
   without launching a browser. Individual `assertBrowser` bodies never see it.
   Likewise `code:'PLAYWRIGHT_MISSING'` ⇒ whole run skips with the install hint.

4. **`pass` / `fail` only when the path was truly exercised.** Return `pass`
   when the getter/behavior was present, reachable, AND matched expectations.
   Return `fail` ONLY when the getter/behavior was present + reachable but WRONG
   (e.g. a getter that should rise stayed flat under its enabling flag; a render
   `programs` count grew across a cast it must hold flat). Use the `assert*`
   helpers + `runAsserts(fn, detail)` to map assertion throws → `fail`
   automatically.

## Worked classification examples

- **`wasmPursuit`** — `query:"wasmPursuit=on"`, `composeDeps:[]`,
  `constReq:"USE_MOVETO_DRIVER"`, `rebuildCoupled:true`,
  `rustTests:["pursuit_status_lifecycle_and_cancel_restore","second_pursuit_entry_turn_begins_on_first_driver_frame"]`,
  `crate:"holtburger-core"`. assertBrowser: probe `pursuitStatus` presence
  (absent ⇒ rebuild-pending); issue a pursue intent; if status reaches 2
  ⇒ pass; if it fast-fails to 3 ⇒ skip("USE_MOVETO_DRIVER off — fast-fail").

- **`remoteInterp`** — `query:"remoteInterp=on"`,
  `composeDeps:["unifiedTick","wireStatePacks"]` (driver adds
  `unifiedTick=on&wireStatePacks=stage1`), `rebuildCoupled:true`. assertBrowser:
  probe `pollRemotePoses` presence; if 0 rows ⇒ skip("no moving remote in view");
  if rows have stride-7 poses ⇒ pass.

- **`stickyRetail`** — `composeDeps:["unifiedTick","wireStatePacks","remoteInterp"]`,
  `constReq:"USE_STICKY_MANAGER"`. assertBrowser: presence of `localStickyTarget`
  / `RemotePoseFrame.stickyFlags`; nonzero/flagged needs the const ⇒ if zero,
  skip("USE_STICKY_MANAGER off — presence-only").

- **`getLink`** — by DESIGN there is NO browser getter. `rebuildCoupled:false`;
  assertBrowser asserts a clean boot (no `consoleErrors()` about module
  parse/init) and that the page is in-world ⇒ pass. NEVER probe a getter; absence
  is expected, not `rebuild-pending` and not `fail`. Coverage is the rust tests
  (`q4_get_link_*`, crate `holtburger-dat`).

- **`renderDiag` / pure-JS diag flag** — `rebuildCoupled:false`. assertBrowser
  reads `helpers.readDiag('__diag.render')`; if the flag is set and a frame
  ticked, assert the snapshot fields exist ⇒ pass; if the flag wasn't set the
  object is absent by design ⇒ skip (not a fail). NOTE the name collision:
  `__diag.render` (per-frame snapshot) ≠ `__diag.renderer` (eviction ring).

## Driver responsibilities (for the file that imports these descriptors)

1. Call `probeServer()`/`launchAndEnter` ONCE per distinct query (group flags by
   merged query to amortize the ~boot cost). On `SERVER_DOWN` /
   `PLAYWRIGHT_MISSING`: mark all flags `skip` and exit 0.
2. For each descriptor, merge `query` + every `composeDeps` token into the boot
   query. Launch (or reuse a same-query session), check `inWorld`; if false,
   `skip` the descriptor.
3. `await descriptor.assertBrowser(helpers)`; catch uncaught throws as `fail`.
4. Aggregate. Exit 0 when there are no `fail`s (skip/rebuild-pending are NOT
   failures); exit 1 if any `fail`. Print a per-flag line with status + detail,
   matching the existing `[PASS]/[FAIL]` console convention (extend with
   `[SKIP]`/`[PEND]`).
5. Optionally run the native rust step: for descriptors with `rustTests`, emit
   `cargo test -p <crate> --lib -- <rustTests...>` (the rust half is separate
   from the browser half and may be gated behind an env flag, since it requires
   a host toolchain and is subject to this box's OOM rules — never
   `--workspace`).
