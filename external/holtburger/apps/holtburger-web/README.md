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
- `start_session(bridge_url, server_ip, server_port, username, password)
  -> Promise<SessionHandle>` (wasm32-only, Phase 4 step 1) — drives
  the AC login → CharacterList handshake from the wasm bundle through
  `holtburger-wsbridge` to a live ACE. Internally opens a
  `WsTransport`, builds `Session::new_with_transport`, sends
  `LoginRequest`, and pumps `session.recv_message` until
  `GameMessage::CharacterList` lands. The returned `SessionHandle` is
  a wasm-bindgen class with `.poll_events()` (drains a `ClientEvent[]`
  — kind=0 = CharacterListReceived in step 1), `.characterList()`
  (returns `CharacterSummary[]` with `id` / `name` / `deleteTime`
  fields), and `.accountName` (server-echoed). Errors surface as a
  rejected Promise with the AC error string. See
  [`docs/phase-4-renderer.md`](../../../docs/phase-4-renderer.md) for
  the as-built; step-2 wires the actual SelectCharacter / spawn flow.

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

## Verify

Two paths, both useful.

**Node smoke test** — fully programmatic, exits non-zero on regression:

```sh
node smoke_test.cjs
```

Hits `build_info` and `hash32` against deterministic reference values
computed from the Rust impl. A green run confirms wasm-bindgen interop
works and the protocol crate's output matches between native and wasm32.

**Browser** — verifies the actual `--target web` bundle loads via
`fetch`/streaming compile, which is the path the production site will
take. Run the dev server from `external/holtburger/` (one level up
from this crate) so the `dats/assets.hba` fixture is reachable at
`../../dats/assets.hba` from the bundle's URL:

```sh
cd external/holtburger
python3 -m http.server 0 --bind 127.0.0.1
# Note the port; open
# http://127.0.0.1:<port>/apps/holtburger-web/index.html
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
