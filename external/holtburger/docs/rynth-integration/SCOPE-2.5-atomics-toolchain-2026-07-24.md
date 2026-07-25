# SCOPE — §2.5 atomics toolchain: **LINKS** (2026-07-24)

> Branch: `perf/wasm-threads-sab`. Settles `HANDOFF-wasm-threads-SAB-2026-07-20.md` §2.5, whose
> stated risk was: *"Dep-graph atomics compat is **unverified until it links** — treat first
> successful link as a milestone. Budget for a dependency that will not build with atomics."*

## Verdict

**No such dependency exists.** The graph checks AND links with atomics + shared memory, first
try, with zero source changes.

| Stage | Result |
|---|---|
| `cargo +nightly check -Z build-std` w/ atomics | **0 errors**, 8m37s |
| `cargo +nightly build -Z build-std` w/ shared-memory link flags | **0 errors**, 6m31s |
| Artifact memory section | `flags=0x03` → **shared=true** |

Verified the artifact rather than trusting the exit code — a clean build does not by itself prove
a *threaded* module. Parsed the wasm memory section directly (no wabt/wasm-tools installed;
throwaway parser in the session scratchpad):

```
MEMORY section: 1 memory (module-defined)
  flags=0x03  shared=true  min=33 pages (~2 MiB)  max=32768 pages (2 GiB)
```

`0x03` = `0x01` has-max | `0x02` **shared**. Max matches the `--max-memory=2147483648` passed in.

## Reproduction

```sh
rustup toolchain install nightly --component rust-src --profile minimal
rustup target add wasm32-unknown-unknown --toolchain nightly

RUSTFLAGS="-C target-feature=+atomics,+bulk-memory,+mutable-globals \
           -C link-arg=--shared-memory -C link-arg=--max-memory=2147483648" \
cargo +nightly build -Z build-std=std,panic_abort \
      -p holtburger-web --target wasm32-unknown-unknown
```

Toolchain installed for this: nightly `1.99.0-nightly (89c61a754 2026-07-23)`. Run it through
`capped-build` on the laptop (OOM jail); `-Z build-std` rebuilds std from source, so the first
build is cold and long.

## Findings

1. **`rayon` is already in the wasm dep graph — and is entirely unused.**
   `crates/holtburger-dat/Cargo.toml:18` declares `rayon.workspace = true`, but there is **not one**
   use site (`par_iter` / `par_bridge` / `par_chunks` / `rayon::`) in ANY crate of the wasm graph
   (dat, content, core, world, manifest, resource-http — all zero). It pulls in `rayon-core` +
   `crossbeam-deque` / `-epoch` / `-utils`. Cuts both ways: dead weight in the wasm build today,
   but it also means `rayon-core` already compiles for wasm32, and `wasm-bindgen-rayon` wants rayon
   present anyway. Do NOT drop it without checking the threads plan first.

2. **The classic atomics landmines are all clear.** `getrandom` 0.4.2 is in the wasm graph with no
   `getrandom_backend` / `wasm_js` configuration anywhere in `Cargo.toml` or `.cargo/config.toml`,
   and `parking_lot` 0.12.5 is present — both compiled clean under atomics.

3. **`wasm-bindgen` is locked at 0.2.108** and `wasm-bindgen-rayon` is **not** in the local cargo
   registry cache, so adding it needs network. Its supported `wasm-bindgen` range is the next
   compatibility question.

4. Unrelated warning surfaced by the nightly build: `binrw v0.15.1` "contains code that will be
   rejected by a future version of Rust" (`cargo report future-incompatibilities --id 1`).

## What this does NOT establish

- **Only the raw `cargo build` link is proven.** The real pipeline is
  `wasm-pack` → `wasm-bindgen` post-processing, which must itself handle a shared-memory module and
  emit thread-aware glue. **Untested.** That is the next gate, not this one.
- **`wasm-bindgen-rayon` is not wired up.** No thread pool exists, nothing was spawned, no
  `SharedArrayBuffer` was handed to a worker. This milestone says the code *compiles and links*
  with threads enabled — not that it runs threaded.
- **Debug profile only** (196 MB artifact). Release is required before any measurement, per the
  ship-RELEASE-wasm rule.
- Nothing was run in a browser. §2.4 separately proved the *page* can be cross-origin isolated;
  the two have not been combined yet.

## Cost note

`target/wasm32-unknown-unknown` is now **15 GB** (build-std duplicates the whole graph per RUSTFLAGS
set). 34 GB free on `/` after. `cargo clean -p holtburger-web` will not reclaim the std artifacts;
delete the target subdir if space is needed.
