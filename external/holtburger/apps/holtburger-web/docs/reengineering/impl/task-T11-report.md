# T11 — ST-SHELL: bundle + hash the app shell: implementation report

Agent: T11 implementation agent. Date: 2026-08-09. Scope: `scripts/build-shell.mjs` (new),
`scripts/deploy-shell.mjs` (new), `scripts/serve.py` (shell header row), `scripts/README.md`
(esbuild note), `.gitignore` (build-output rows), `harness/test_build_shell.mjs` (new),
`docs/RESULTS-shell-requests-2026-08-09.json`. `index.html` NOT edited (see Shipped — the
loader is a generated variant; the unbundled arm is byte-untouched).

## Shipped

| commit | what |
|---|---|
| `85a50065` | **Build** — `scripts/build-shell.mjs`: esbuild (standalone binary, no npm — `$ESBUILD_BIN`, default `/mnt/wbterminal2/reeng/T11/bin/esbuild`; **0.28.2**, binary sha256 `e1698a3d5c6c0798fee4fd3b5cc816651f460c63d390a7a26ea4beb0b1884100`, tarball shasum `268b36211c146ca54f8fe12c578a8d6ef8979485`, recipe in `scripts/README.md`) bundles main + 4 workers into content-hashed `shell/<name>-<sha256_8>.js` + external maps + `shell-manifest.json` + the generated loader `index-bundled.html` (all gitignored). Entries verified on HEAD: the inline `<script type="module">` (index.html:1250–11663, extracted at build time) + the 4 file-backed `new Worker(new URL(...))` sites — bake_worker_client.js:795, net_worker_client.js:136, keepalive_worker_client.js:66, xu7_textures.js:780; a coverage scan fails the build on drift. Externals: `pkg/*` (gitignored wasm output, per task directive; imports re-based `./pkg/`→`../pkg/`) + every importmap key (browser-resolved via the loader's retained importmap; a metafile guard proves worker graphs import nothing but `../pkg/*`). Staging transforms on build-time copies only: `?v=` strip on relative non-pkg specifiers, worker-site placeholders, scene3d `import.meta.url` re-base `./X`→`../scene3d/X`; output guard fails on any unhandled `./` URL site. Hashing is workers-first with substitution into app BEFORE app is hashed (worker change ⇒ app renames). `service-worker.js` untouched. |
| `14cb0671` | **Serve rules** — `scripts/serve.py`: `SHELL_PREFIXES = ("/apps/holtburger-web/shell/", "/dist/shell/")` joins the packs/index tier — 200-gated `public, max-age=31536000, immutable, no-transform` AND excluded from the compression negotiator (CAS = identity encoding per SPEC §1.1 / pass-3 S6.1 extended by D-12.2). Verified live: immutable + no `Content-Encoding` under `Accept-Encoding: gzip, zstd`; shell 404 → no-cache; scene3d/*.js no-cache and /dist/manifest.json no-store unchanged. |
| (third commit — carries this report) | **Deploy + tests + docs** — `scripts/deploy-shell.mjs` (stages `shell/` into `<dist>/shell/` with pack CAS discipline: identical-bytes skip, differing-bytes hard fail; pointers `shell-manifest.json` + `index-bundled.html` land at the dist ROOT, deliberately outside the immutable path; `--dist` mandatory, `--dry-run`); `harness/test_build_shell.mjs` (56 checks, 6 parts — coverage, determinism, output contract, loader page, request arithmetic incl. the RESULTS-v2 writer, live serve.py tier probe); `docs/RESULTS-shell-requests-2026-08-09.json`; this report; IMPLEMENTATION.md row. |

**The arm is dist-level (no runtime flag):** bundled arm = open `index-bundled.html`
(same directory as index.html, so every relative URL resolves identically);
unbundled arm = `index.html`, byte-untouched. Kill = point back at `index.html`
(K3-class). `docs/url-flags.md` unchanged — no runtime toggle exists.

## Spec conformance

SPEC §3 T11: *"esbuild build step (entries: main + 4 workers), content-hashed `shell/`
output on the immutable tier, `index.html` loader, `service-worker.js` untouched; deploy
tooling + serve.py header row; `__hbFetch.byComponent.code` wired to the CDP network log.
Acceptance: uniform floor (T2 bot + 1070 headless boot, 0 console errors); BOOT-666 shell
component ≈ 8 requests cold / ≈ 1 warm."*

- **esbuild build, entries main + 4 workers** — **MET.** Verified worker count on HEAD = 4
  (D-12.2's list exactly; the T14 texture worker included). Deterministic: two builds into
  fresh out-roots byte-identical (test P2). Zero esbuild warnings; all outputs re-parse.
- **Content-hashed `shell/` on the immutable tier** — **MET.** sha256-8 names; serve.py tier
  verified live (immutable + identity); worker-hash changes propagate into the app filename.
- **`index.html` loader** — **MET as a generated variant.** `index-bundled.html` = index.html
  with the inline module script → one `<script type=module src=./shell/app-<hash8>.js>` and
  the 263-link modulepreload block → 2 pkg passthroughs + the app preload; importmap, agent-mode
  script, body, SW registration semantics retained (register("./service-worker.js") resolves
  against the DOCUMENT base, so root scope is preserved from inside the bundle). index.html
  itself byte-untouched (test-pinned) — maximal kill-safety.
- **`service-worker.js` untouched** — **MET.** Not bundled, not edited; the current SW (v2 arm,
  and T12's dormant v3) intercepts only shards/packs/index + scene3d/assets SWR — it can never
  capture `shell/` or the loader (read-verified service-worker.js:197–213, 343–345).
- **Deploy tooling** — **MET.** `deploy-shell.mjs`, pack-style CAS discipline (tested incl. the
  corruption guard). Note (R-10): the dist copy is CAS retention/hosting prep; the bundled arm
  serves from the live app dir until the production origin shape is decided.
- **`__hbFetch.byComponent.code` wired to the CDP network log** — **PARTIAL, recorded.** The
  shell count is taken from the browser-side network log (CDP `list_network_requests` /
  performance resource entries — this session's live census used exactly that), never from
  controller-issued fetches, and the classification recipe is codified in test P5 + this
  report. No committed bench-driver change lands here — the BOOT-666 driver row is T30 batch
  prep (handoff below).
- **BOOT-666 shell component ≈ 8 cold / ≈ 1 warm** — **MET on static arithmetic + partial live
  confirmation; the full comparative browser run DEFERRED (RAM).**
  Cold (enumerated from artifacts, test-pinned against the *Enabled() readers):
  `index-bundled.html` + `shell/app` + pkg glue + pkg snippet + pkg wasm + `service-worker.js`
  + `shell/bake_worker` = **7 bare** / **8 login** (+keepalive) / **9 agent-login** (+net worker
  — netWorker forces ON under `agent=1|bot=1`, net_worker_client.js:97) — **D-12.2's ≈8 holds
  (7..9)** vs enumerated **267 unbundled** (263 modulepreload links + html + wasm + SW + bake
  worker). Live (before the shared browser died): bundled arm under `?nullRender=1&nosw=1`
  reached `form-shown` with **0 console errors**; shell-class requests observed = html + app +
  glue + snippet + bake_worker (5; wasm on the uncaptured page but implied by successful init;
  SW skipped by design under nosw) — matches the arithmetic.
  Warm (arithmetic): `shell/*` immutable ⇒ **0 refetches**; the dev no-cache tier leaves **5
  conditional 304s** (loader html, SW, pkg glue, snippet, wasm; ~0 bytes body). ≈1-with-body
  holds; D-12.2's ≈2-total needs pkg deploy-hashing (handoff). B2/B5 absolutes bind at ST5
  (SPEC §2.2) — nothing is scored against them here.
- **Uniform floor (T2 bot + 1070 headless boot, 0 console errors)** — **DEFERRED.** 1070 half
  DEFERRED-TO-BATCH per the task. T2 bot: the box sat at 0.4–1.7 GB available all session with
  T20's bot pages live in the one shared chromium; the shared browser died mid-census
  (available memory hit 625 MB → "Target closed"), which is precisely the contention case the
  RAM gate names. The light bundled-arm leg that did run (login screen, no world) was
  0-console-errors; the in-world floor was not simulated. Runbook: serve.py (post-14cb0671),
  `index-bundled.html?nullRender=1&nosw=1&autoLogin=1&...` vs same on `index.html`, count via
  CDP log, RESULTS-v2 comparative arms.

## Deviations

- **D1 — DEVIATION: D-12.2 "266 modulepreload links [M]" because** the 266 was a
  `grep -c modulepreload` LINE count; actual `<link rel=modulepreload>` elements on HEAD = 263
  (the other 3 are the BEGIN/END markers + an in-JS comment). Same ~270 class, no design
  impact; test P5 pins 263.
- **D2 — DEVIATION: D-12.2 cold-shell ledger omits the pkg snippet because** (read-verified)
  the pkg glue imports `pkg/snippets/holtburger-web-*/inline0.js` (it is the 2nd pkg
  modulepreload in index.html:986) — a 3rd pkg request the "html + app + wasm + glue + 4
  worker/SW" table didn't row. Enumerated cold is 7/8/9 by boot shape; ≈8 stands.
- **D3 — DEVIATION: D-12.2 warm "index.html revalidate (1) ≈ 2 total" because** pkg cannot be
  content-hashed from a clean tree (task directive — it is gitignored build output), so on the
  dev server the warm shell is 5 conditional 304s (3 of them the pkg residue, plus SW + html)
  with ~0 bytes body. Closing to ≈2: deploy-time hashing of pkg glue/wasm into `shell/` (or a
  `?v=`-aware immutable rule for pkg) — handoff, owner call.
- **D4 — DEVIATION (finding): the plugin dynamic-import lane escapes the bundle and D-12.2's
  request model because** (live-measured this session + read-verified plugins/loader.js:698–719,
  905–913, index.html:1935–1945) ~30 bar-slot plugins load at runtime via ABSOLUTE
  `modulePath` URLs + ~37 `*.manifest.json` + `plugins/index.json`, and those unbundled plugin
  modules then import their deps per-file: the live bundled-arm census showed ~26 `ui/*.js` +
  `scene3d/adapter.js` + `scene3d/vfx/ui_effects_registry.js` fetched unbundled. Two
  consequences, both recorded, neither fixed here (out of D-12.2's stated mechanics; orchestrator
  call): (a) ~95 arms-invariant code/manifest requests that neither the old B2 ledger nor
  D-12.2's ≈52 recount rows — the shell component itself is still ≈8, but preview-complete
  request totals will carry this class on BOTH arms; (b) on the bundled arm the plugin-shared
  deps double-instance (one copy in `app-<hash>.js`, one unbundled) — module-level registries/
  caches in those files exist twice. 0 console errors to form-shown; the in-world leg is the
  deferred floor. Follow-up options priced in Handoffs.
- **D5 — DEVIATION (recorded semantic delta): query-forked duplicate module instances collapse
  because** esbuild resolves by file: on HEAD the browser loads `statics.js` twice
  (`./statics.js` in loop.js:69/cells.js:64 vs `./statics.js?v=phase7-par` in index.js:46; same
  for buildings.js, and scene3d/index.js from the entry), and the bundle necessarily merges
  each pair to ONE instance. Direction-of-correctness (true singletons), bundler-inherent, but
  it is a real bundled-arm behavioral difference — flagged for the E-item eye pass.
- **D6 — note:** SPEC §1.1 names the D-12.2 output set as including `holtburger_web-<hash>.wasm`
  under `shell/`; per the T11 task directive pkg stays external at its live path (see D3).

## Tests run

```
node harness/test_build_shell.mjs            56 passed, 0 failed   BUILD-SHELL ✅
  P1 coverage: 4 worker sites exact; arithmetic premises pinned against readers
     (bakeWorker default-ON opt-out; NET_WORKER_DEFAULT=false + agent/bot force-ON;
      texWorkers absent⇒0) — a default flip breaks the test, forcing re-derivation
  P2 determinism: 2 fresh out-roots byte-identical (shell/, manifest, loader);
     index.html untouched by the build
  P3 output contract: 5 hashed entries + maps; manifest shas match tree; app
     references all 4 hashed workers; keepalive classic-safe; workers pkg-only
  P4 loader: 1 module script → shell/app; preloads = 2 pkg + app; importmap kept;
     SW not bundled
  P5 arithmetic: cold 7/9, unbundled 267, warm 5×304 + 0 immutable refetches;
     RESULTS-v2 written via harness/lib/report.mjs (EXPLORATORY, taint
     static-arithmetic; "requests@wire" keys) → docs/RESULTS-shell-requests-2026-08-09.json
  P6 serve tier (live spawn): shell immutable+identity; scene3d no-cache; 404 no-cache
node harness/test_diag_schema.mjs            DIAG-SCHEMA ✅ (unchanged by T11)
node scripts/lint-url-flags.mjs --strict     exit 1 PRE-EXISTING+CONCURRENT (the 2 known
                                             presence-guard rows + an UNDOCUMENTED slotGrid
                                             row from T20's in-flight residency_grid.js —
                                             not T11's; T11 adds 0 findings, 0 flags)
scripts/deploy-shell.mjs                     staged 10 files to a scratch dist; re-run = 10
                                             CAS hits, 0 copies; corruption guard fails loud
live serve.py :8792/:8829                    header matrix as in commit 14cb0671
live browser (shared MCP chromium, before it died):  bundled arm ?nullRender=1&nosw=1 →
  form-shown, 0 console errors; 236 requests total @wire (login screen; includes the D4
  plugin lane, CDN/vendor importmap externals, data/assets, dist world-data); shell-class
  rows observed = the enumerated set.   @scale: wire, cold, login-screen (NOT preview-complete)
```

## Handoffs & risks

- **T30 batch prep (1070):** BOOT-666 shell-component comparative arms are ready to queue —
  URL pair `index.html` vs `index-bundled.html`, same flags; count via CDP network log
  classified by the test-P5 recipe; RESULTS-v2 arms cold/warm × bundled/unbundled. The T2-BOT
  in-world floor needs a quiet box (≥1.7 GB, no concurrent bot pages).
- **D4 follow-up (owner/orchestrator):** options — (a) accept the plugin lane as a permanent
  per-file class (record it in the B2 ledger; validate double-instancing at the E-item/bot
  floor); (b) add the ~30 dynamic plugins as esbuild entries WITH `--splitting` (true sharing,
  no double instances, but shared-chunk topology grows the cold count and reshapes D-12.2's
  arithmetic); (c) a loader-map that resolves `modulePath` ids into the bundle. (b)/(c) are
  build-side only — no plugin source edits needed.
- **Warm ≈2 closure:** deploy-time pkg hashing into `shell/` (deploy-shell.mjs is the natural
  home once a bake/deploy cycle carries pkg), or an immutable rule for `?v=`-stamped pkg URLs.
- **Hosting shape (R-10):** `<dist>/shell/` is CAS storage; serving the bundled arm needs the
  app-dir mount (today: open `/apps/holtburger-web/index-bundled.html`). serve.py covers both
  prefixes already.
- **Rebuild staleness:** `shell/` is a BUILD ARTIFACT of the committed tree — after pulling
  scene3d/plugins/ui/rynth/index.html changes, re-run `node scripts/build-shell.mjs` or the
  bundled arm serves the old app (hash-named, so it never silently mixes). Same class as the
  pkg/ trap; noted in build-shell.mjs's header.
- **Shared-browser incident:** the box's single test chromium (carrying T20's pages and my
  census tab) died when available memory collapsed to ~625 MB mid-session. My footprint was one
  login-screen tab in an isolated context; no relaunch was attempted under the failed gate.
  Other agents' runs in that browser were lost with it — orchestrator should expect T20 to
  re-run whatever was in flight.
- **Unrelated dirty state:** `apps/holtburger-tools/src/pack_bake.rs` (T10's follow-on work)
  left unstaged/untouched; the untracked SPEC/pass docs left alone.
