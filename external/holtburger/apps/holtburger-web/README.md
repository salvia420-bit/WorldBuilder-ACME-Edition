# holtburger-web

Browser-loadable WASM bundle for Phase 2 of `emit-dynamic-site` — the
smallest possible consumer of the wasm32 cross-compile floor. See
[`docs/phase-2-wasm-spike.md`](../../../../docs/phase-2-wasm-spike.md)
§8 step 1 for context.

## What it does

Exposes three `wasm-bindgen` functions over `holtburger-protocol` +
`holtburger-session` so a plain `index.html` can prove the bundle loads
and executes in a browser:

- `start()` — installs `console_error_panic_hook` so panics surface in
  the browser console.
- `build_info() -> string` — round-trips a static identification string
  through `wasm-bindgen`'s string interop.
- `hash32(data: Uint8Array) -> u32` — runs AC's stateless 32-bit packet
  header checksum (`holtburger_protocol::crypto::Hash32::compute`),
  proving the packet codec works in a `cdylib` bundle.

What it deliberately does **not** do: construct a `Session` (its
`std::time::Instant::now()` panics on `wasm32-unknown-unknown`; spike
doc §8 step 3) or wire any transport (steps 2 / 4).

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
take:

```sh
python3 -m http.server 0 --bind 127.0.0.1
# Note the port from the server's startup line, then open
# http://127.0.0.1:<port>/index.html
```

`index.html` runs the same three checks as the Node smoke test and
reports OK/FAIL inline. Browser verification is manual — there's no
headless-browser harness wired up here.
