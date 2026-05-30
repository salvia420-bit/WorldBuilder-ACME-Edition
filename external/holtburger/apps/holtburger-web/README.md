# holtburger-web

Browser-loadable WASM bundle for `emit-dynamic-site`. Started as the
smallest possible consumer of the wasm32 cross-compile floor; now hosts
the Phase 3 renderer entry points and the Phase 4 step 1
wasm-driven AC login driver. See
[`docs/phase-2-wasm-spike.md`](../../../../docs/phase-2-wasm-spike.md)
§8 step 1,
[`docs/phase-3-renderer.md`](../../../../docs/phase-3-renderer.md), and
[`docs/phase-4-renderer.md`](../../../../docs/phase-4-renderer.md) for
context.

## What it does

Exposes a small `wasm-bindgen` surface over `holtburger-protocol` +
`holtburger-session` so a plain `index.html` can prove the bundle loads
and executes in a browser:

- `start()` — installs `console_error_panic_hook` so panics surface in
  the browser console.
- `build_info() -> string` — round-trips a static identification string
  through `wasm-bindgen`'s string interop.
- `hash32(data: Uint8Array) -> u32` — runs AC's stateless 32-bit packet
  header checksum (`holtburger_protocol::crypto::Hash32::compute`),
  proving the packet codec works in a `cdylib` bundle.
- `session_smoke_test_packet_sequence() -> u32` — constructs
  `Session::new_test()` and returns its initial `packet_sequence`.
  Verifies the `web_time::Instant` swap (spike doc §8 step 3) lets
  `Session::new_with_transport` run on wasm32 without tripping
  `std::time::Instant::now()`'s panic.
- `try_ws_handshake_smoke(bridge_url, server_ip, server_port) ->
  Promise<u32>` (wasm32-only, §8 step 2) — opens a `WsTransport`
  against `bridge_url`, plugs it into `Session::new_with_transport`,
  returns the session's initial `packet_sequence`. Browser-side
  validation against a live `holtburger-wsbridge` is the path; the
  Node smoke test only confirms the symbol is exported.
- `try_http_resource_source_smoke(asset_url, namespace, file_id) ->
  Promise<u32>` (wasm32-only, §8 step 4) — fetches an HBA bundle from
  `asset_url`, parses it through `HbaReader::<Vec<u8>>::from_bytes`,
  looks up the named entry, and returns the decompressed byte length.
  The Node smoke test runs this end-to-end against an in-process
  `http.createServer` serving `dats/assets.hba`.
- `fetch_landblock_heightmap(asset_url, cell_id) -> Promise<LandblockMesh>`
  (wasm32-only, Phase 3 step 1) — fetches an HBA, looks up
  `eor/cell:cell_id` (typically `XXYYFFFF` for landblock terrain),
  parses it as a `CellLandblock`, and hands the 9×9 height grid back
  as a triangle mesh: `positions` (`Float32Array`, 243 floats — 81
  verts × 3D), `indices` (`Uint16Array`, 384 — 64 quads × 6),
  `heightMin` / `heightMax` (metres). Browser-side
  `index.html` feeds this into PixiJS to draw the Holtburg terrain.
- `start_session(bridge_url, server_ip, server_port, username,
  password, asset_url) -> Promise<SessionHandle>` (wasm32-only,
  Phase 4 steps 1 + 2a + 2a.5) — drives the AC login →
  CharacterList handshake from the wasm bundle through
  `holtburger-wsbridge` to a live ACE. Internally opens a
  `WsTransport`, builds `Session::new_with_transport`, sends
  `LoginRequest`, and `wasm_bindgen_futures::spawn_local`s a
  persistent recv loop that owns the Session for the rest of the
  page's lifetime. Returns once the loop signals the initial
  `CharacterList`. If `asset_url` is non-empty, also fetches the
  HBA bundle, parses `CharGen` (`0x0E000002`) + `SkillTable`
  (`0x0E000004`), and builds a `CharacterGenCatalog` for offline
  character-creation validation (failures here are non-fatal —
  `canCreateCharacter` reports false). The recv loop's
  `tokio::select!` races `session.recv_message().await` against
  an internal command channel driven by JS (currently
  `selectCharacter` and `createTestCharacter`).
- `SessionHandle` (wasm-bindgen class) is the JS-facing surface over
  the recv loop. Methods: `.poll_events()` drains a `ClientEvent[]`
  (active kinds: 0 CharacterListReceived re-fire, 1 PlayerSpawned,
  4 Disconnected, 5 CharacterCreated, 6 CharacterCreateFailed,
  7 EnteredWorld); `.characterList()` returns `CharacterSummary[]`
  (`id` / `name` / `deleteTime`); `.accountName` getter;
  `.canCreateCharacter` getter (true if catalog loaded);
  `.selectCharacter(guid)` (Phase 4 step 2a) which drives the
  spawn handshake — wasm sends `CharacterEnterWorldRequest`,
  auto-chains `CharacterEnterWorld` on
  `CharacterEnterWorldServerReady`, and surfaces `PlayerCreate(guid)`
  as a `kind=1 PlayerSpawned` event + sends `LoginComplete` back
  to ACE + transitions to InWorld surfacing `kind=7 EnteredWorld`;
  `.createTestCharacter(name)` (Phase 4 step 2a.5) which builds
  an Aluvian / Male / Adventurer / Holtburg
  `CharacterCreateRequestData` via
  `holtburger_core::CharacterGenBuilder::build_request` (validating
  attribute budget + skill slots client-side) and dispatches
  `GameMessage::CharacterCreate`; result lands as a
  `kind=5 CharacterCreated` (success) or `kind=6
  CharacterCreateFailed` event; and `.sendChat(message)`
  (Phase 4 step 2a.6) which dispatches
  `GameAction::Talk(TalkActionData { message })` to ACE — used
  by the JS Teleport-to-Holtburg button to send `@telepoi
  Holtburg`, requires the test account to have `accessLevel ≥ 4
  (Developer)`. See
  [`docs/phase-4-renderer.md`](../../../docs/phase-4-renderer.md) for
  the as-built; step 2b adds position-driven rendering + multi-entity
  buffer + character switching mid-session.

## Frontend dependencies

[PixiJS 8](https://pixijs.com/) is loaded as an ESM module from
jsdelivr in `index.html`:

```html
<script type="importmap">
  { "imports": {
    "pixi.js": "https://cdn.jsdelivr.net/npm/pixi.js@8.18.1/dist/pixi.min.mjs"
  } }
</script>
```

The pin is `8.18.1` — bump that and the URL together. No npm/bundler
in this crate; the import map keeps the tree dependency-free. If a
future renderer step grows enough JS to want a bundler, that's the
right time to introduce one.

## Build

```sh
# Browser bundle (ES modules, native fetch).
wasm-pack build --target web --out-dir pkg --release

# Optional: Node bundle for the smoke test (CommonJS, sync init).
wasm-pack build --target nodejs --out-dir pkg-node --release
```

Both `pkg/` and `pkg-node/` are git-ignored — they're build outputs.

### `--release` vs `--dev` for iteration

`--release` runs `wasm-opt` on the bundle (~50 s on this crate). For
inner-loop iteration, swap to `--dev`:

```sh
wasm-pack build --target nodejs --out-dir pkg-node --dev   # ~3 s
```

Behavior is identical to `--release` for both `--fast` and full
smoke runs (the smoke's HTTP server explicitly disables keepalive,
which closes a Node 18 fetch ECONNRESET race that `--release`
timing happened to mask).

| Build flavour | Wall time (incremental) | Use when |
|---|---|---|
| `--release` | ~60 s | CI, browser screenshots, perf testing, shipping |
| `--dev` | ~3 s | Inner-loop iteration |

## Verify

Two paths, both useful.

**Node smoke test** — fully programmatic, exits non-zero on regression:

```sh
node smoke_test.cjs              # full coverage (~10 s on cache hit, ~5 min on first miss)
node smoke_test.cjs --fast       # skip the bake + dispatch tests (~0.4 s; covers ~58% of assertions)
```

The full smoke bakes the `dats/assets.hba` fixture into v1 + v2
manifest+shards trees (~6.5 GB), serves them over a local HTTP
server, and verifies init_resource_source / prefetch / manifest
dispatch end-to-end. The bake is **hash-cached** under
`$HOLTBURGER_SMOKE_DIST_DIR/holtburger-smoke-cache/<hash>/` keyed on
the fixture and dat-shard binary stat tuples — first run takes
~5 min; every subsequent run that doesn't change either input
reuses the cache and finishes in ~10 s. Wipe the cache manually if
disk pressure is an issue: `rm -rf $HOLTBURGER_SMOKE_DIST_DIR/holtburger-smoke-cache`.

`--fast` keeps the symbol-presence + closed-port assertions and
skips the bake-dependent dispatch tests with a single SKIP line.
Right for inner-loop iteration; CI runs without `--fast` for full
coverage.

A green run confirms wasm-bindgen interop works and the protocol
crate's output matches between native and wasm32.

**Browser** — verifies the actual `--target web` bundle loads via
`fetch`/streaming compile, which is the path the production site will
take. Run the dev server from `external/holtburger/` (one level up
from this crate) so the `dats/assets.hba` fixture is reachable at
`../../dats/assets.hba` from the bundle's URL:

```sh
# Recommended: the committed launcher validates every baked data layer is
# present (fail-loud — no more silently-empty world), auto-creates the single
# `dist` symlink (works on a fresh checkout / worktree), writes
# `dist/_health.json` for the in-app health banner, and threads (the bare
# single-thread http.server wedges on the 3.6 MB wasm). Runs from any cwd.
python3 scripts/serve.py            # :8765 by default; --port N to override
# open http://127.0.0.1:8765/apps/holtburger-web/index.html

# Bare fallback still works (tree is all real dirs now) but skips validation:
#   cd external/holtburger && python3 -m http.server 8765 --bind 127.0.0.1
```

`index.html` runs the wasm symbol-presence checks and then renders
the Holtburg landblock terrain (Phase 3 step 1) into the on-page
`<canvas>`. Browser verification is manual — there's no
headless-browser harness wired up here. The deliverable artefact for
Phase 3 step 1 is a screenshot of the rendered landblock at
`docs/images/phase-3-step-1-landblock.png`.

## HTTP-source fixture (§8 step 4 / Phase 3 step 1)

Both the §8-step-4 round-trip and the Phase 3 step 1 render need a
fixture at `../../dats/assets.hba` (i.e.
`external/holtburger/dats/assets.hba`). Generated from the canonical
retail dats with `dat2hba`:

```sh
cd ../..  # back to external/holtburger/
cargo run --release -p holtburger-tools --bin dat2hba -- \
    --profile pruned \
    eor/portal=$HOME/ac_base_dats/client_portal.dat \
    eor/cell=$HOME/ac_base_dats/client_cell_1.dat \
    dats/assets.hba
```

`--profile pruned` is the right baseline for Phase 3 — it includes the
`eor/cell` namespace, so landblock terrain (`XXYYFFFF`) and
`LandblockInfo` (`XXYYFFFE`) records are reachable. Output is ~230 MB
with both retail dats. The smaller `--profile micro` (~353 KB,
`eor/portal`-only) keeps the §8-step-4 fetch round-trip green but
excludes everything the renderer needs. The fixture is git-ignored —
never commit retail-derived bytes. If the fixture is absent the smoke
test SKIPs (not FAILs) the round-trip and falls back to symbol-presence
checks; the browser render shows an inline error linking back to this
section.
