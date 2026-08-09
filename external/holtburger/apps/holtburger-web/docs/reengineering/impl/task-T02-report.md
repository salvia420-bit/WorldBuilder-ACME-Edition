# T02 report — reader/caller sweeps (manifest strictness + private fetch census)

## Shipped

- `apps/holtburger-web/docs/reengineering/impl/task-T02-findings.md` — the findings
  doc (two read-verified tables + 4 sweep-1 findings S-0…S-3 + 4 sweep-2 findings
  F-A…F-D), filed as T12 inputs per SPEC §3 T02.
- This report + the T02 status row in `IMPLEMENTATION.md`.
- Commit: see `git log` — single commit staging exactly these three files.
- No code was touched (information task; file scope respected).

## Spec conformance

SPEC §3 T02 acceptance: **"findings filed as T12 inputs" — MET.**

- `rg manifest.json` sweep over harness/tools/proxy (+ the wasm parse path, serve
  tooling, tests, capture/probe scripts): 16 dist-manifest reader rows classified
  strict/tolerant, each with file:line evidence read this session. Result: **zero
  strict parsers of the dist manifest**; additive v2+ fields are safe repo-wide;
  `deny_unknown_fields` is used nowhere in the workspace. The only version-strict
  site is the intended `UnsupportedVersion` guard
  (`crates/holtburger-resource-http/src/manifest_source.rs:364`). Seven distinct
  manifest classes disambiguated so the sweep can't be false-positived later.
- `rg "fetch\("` sweep over `scene3d/` + `index.html` (+ `fetch_bytes` over the wasm
  crate, TextureLoader/Image/worker loads, both worker JS files): 20 fetch-caller
  rows with URL pattern, bytes class, and T12 disposition. Result: **the F-11.6
  class has six world-data members beyond terrain** (scenery JSONL, spawns JSONL,
  events JSONL, suite bins, vfx catalog, wcid_to_setup.json), one external-origin
  bare-default fetch (stars.bin, F-B), and a static-asset/diagnostic tail that
  should stay outside the controller.
- T10-owned files (`apps/holtburger-tools/**`, `crates/holtburger-manifest/**`,
  `scripts/serve.py`) were swept at COMMITTED state via `git show HEAD:` per the
  task brief; their live-tree WIP was not read as evidence.

## Deviations

None (no code changed; SPEC not edited). Two findings are flagged as candidate
DEVIATION *inputs for T12's brief* — recorded in the findings doc, not applied:

- **F-A**: the suite-artifact fetch track has a SPEC §1.4 residency budget but no
  §1.1 fetch-lane assignment — T12 must assign one or except it.
- **F-C**: SPEC §1.1's "wasm instances never fetch packs" invariant meets three
  wasm-side direct-fetch tracks (scenery/spawns/suite) that live until ST10 — T12
  must route or explicitly except them.

## Tests run

Information task — no build or test suite applies. Evidence-gathering commands
(all rerunnable): `rg -ln 'manifest\.json'` repo-wide (110 files → classified);
`rg -n 'deny_unknown_fields' -g '*.rs'` (0 uses); `rg -n 'fetch\(|XMLHttpRequest'`
over `scene3d/` + `index.html`; `rg -n 'TextureLoader|new Image\(|loadAsync'`;
`rg -n 'fetch_bytes' apps/holtburger-web/src/lib.rs` (7 sites, enclosing fns
identified); `git show HEAD:<path>` for the four T10-dirty files. Every table row
in the findings doc was verified by opening the file at the cited lines.

## Handoffs & risks

- **T12** (primary consumer): findings doc tables 2.1/2.3 + findings F-A…F-D are the
  fetch-controller work list; table 1 + S-0/S-3 close pass 9 Q3 (additive fields
  safe; SW gate degrade path documented).
- **T10**: S-1 (sharding.rs < 5 KB emitted-manifest assert) and S-2 (terrain_bc7.js
  exact-33-layer strict manifest check — the only strict manifest parser found — sits
  on the loader D-12.6 replaces).
- **T11/T14**: F-15 — the basis transcoder js+wasm pair is stable-named; the texture
  worker will need its own copy and ST-SHELL should decide its naming/header class.
- **Risk**: line numbers into T10-owned files cite HEAD as of fecc7021 and may drift
  as T10 lands; the classifications (writer-only, presence-only, no-parse) are
  structural and unlikely to flip, but T12 should re-check `serve.py` and
  `dat_shard.rs` rows against T10's landed state.
