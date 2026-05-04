# Phase 2 — WASM port spike (inventory)

> **Status:** Spike opened 2026-05-04. The contained, non-WASM-specific work
> has landed (`Session::new_with_transport`, RC4 → ISAAC doc fix). The
> empirical wasm32 cross-compile inventory below replaces the design doc's
> §5.2 hand-rolled checklist with what `cargo check --target
> wasm32-unknown-unknown` actually says today, so the next session can pick
> the smallest unblocking step.
>
> **Audience:** anyone picking up Phase 2 implementation. Read §3 (the
> per-crate matrix) first.

---

## 1. What landed in this opener

These three changes ship before the WASM-specific work begins because they're
small, contained, and useful regardless of how Phase 2 plays out.

- **`Session::new_with_transport`**
  ([`crates/holtburger-session/src/session/api.rs`](../external/holtburger/crates/holtburger-session/src/session/api.rs))
  — accepts a caller-built `Box<dyn Transport>` plus a `server_addr`, with
  initial state identical to `Session::new`. `new` and `new_test` now both
  delegate to it. **This is the seam the WASM client will use** to plug in a
  `WsTransport` when the time comes; it's also useful today for any test
  wanting to inject behaviour into the transport. Backwards-compatible — no
  existing call site changes.

- **RC4 → ISAAC doc fix**
  ([`external/holtburger/ARCHITECTURE.md:75`](../external/holtburger/ARCHITECTURE.md),
  [`external/holtburger/crates/holtburger-session/ARCHITECTURE.md:19`](../external/holtburger/crates/holtburger-session/ARCHITECTURE.md))
  — both stale references replaced with what the code actually does:
  per-direction ISAAC streams seeded from the server's `ConnectRequest`, used
  as keyed packet checksums (one ISAAC key consumed per `ENCRYPTED_CHECKSUM`
  packet — see `session/auth.rs` and `session/receive.rs`). **There is no
  RC4. There is no RSA.** The protocol's `crypto.rs` exports only `Hash32`
  and `Isaac`.

- **This document**, replacing the design doc's §5.2 speculative checklist
  with what cargo actually reports below.

## 2. The good news (less than the design doc feared)

Two crates **already cross-compile to `wasm32-unknown-unknown` clean, no
changes required**:

| Crate                 | wasm32 status | Significance |
|-----------------------|---------------|--------------|
| `holtburger-common`   | ✅ clean      | trivial — pure data types and small helpers. |
| `holtburger-protocol` | ✅ clean      | **Big deal.** This is the AC packet codec, opcode tables, ISAAC crypto, and the wire format. The substantive AC-protocol layer is WASM-portable as-is. |

That means the WASM client gets the AC protocol "for free" — the porting
work is contained to the *I/O*, *file*, and *async-runtime* edges, exactly
as the design doc predicted but with one nice surprise: the protocol crate
has no hidden dependencies that pull in WASM-incompatible transitive
crates.

## 3. The per-crate cross-compile matrix

`cargo check --target wasm32-unknown-unknown -p <crate>` from
`external/holtburger/`, run 2026-05-04 against the working tree:

| Crate                  | Builds? | Blocker                                                                         | Fix difficulty |
|------------------------|---------|---------------------------------------------------------------------------------|----------------|
| `holtburger-common`    | ✅      | —                                                                               | —              |
| `holtburger-protocol`  | ✅      | —                                                                               | —              |
| `holtburger-session`   | ❌      | `tokio = ["full"]` pulls in `mio`, which fails on wasm32 with *"This wasm target is unsupported by mio. If using Tokio, disable the net feature."* `socket2` is also unix-only. | Low–medium. Trim Tokio features; cfg-gate the UDP-native code path that already lives in `Session::new`. |
| `holtburger-dat`       | ❌      | `zstd-sys` (transitive C dep, via `zstd = "0.13"` in workspace deps line 47) needs `clang` to cross-compile its bundled C source. Plus `std::fs` usage that needs to route through `ResourceSource`. | Medium. Either (a) install clang + set `CC_wasm32` env, (b) drop the `default` feature on `zstd` and pull only its pure-Rust components, or (c) swap to `ruzstd` (decompression only). DAT files are decompress-only at runtime so (c) is realistic. |
| `holtburger-world`     | ❌      | Cascades from `holtburger-dat` (zstd-sys).                                      | Resolves with `dat`. |
| `holtburger-content`   | ❌      | Cascades from `holtburger-dat` (zstd-sys); also `std::fs::File::open` for HBA.  | Resolves with `dat` + needs the async `ResourceSource` work the design doc §5.2 calls out. |
| `holtburger-scripting` | ❌      | Cascades from `holtburger-dat`; also depends on `reqwest` (almost certainly fails its own wasm32 check, untested here because the cascade fired first). | Medium. `reqwest` has a wasm32 path via `wasm-bindgen` but its features need re-selecting; `holtburger-scripting`'s own surface needs cfg-gating. |
| `holtburger-core`      | ❌      | Cascades from session + content + world.                                        | Last to fall. |

## 4. The two real blockers (everything else cascades from these)

### 4.1 `tokio = ["full"]` → `mio` → wasm32-incompatible

Workspace `Cargo.toml` line 34:

```toml
tokio = { version = "1", features = ["full"] }
```

`features = ["full"]` includes `net`, which depends on `mio`, which needs
POSIX file descriptors that don't exist on `wasm32-unknown-unknown`.

The error message is canonical and points the way: *"This wasm target is
unsupported by mio. If using Tokio, disable the net feature."*

**Recommended approach:**

- Add a workspace-level `wasm-friendly-deps` (or similar) profile / feature
  that strips Tokio to `["rt", "sync", "macros", "time"]` for crates being
  WASM-targeted (session, protocol, dat, content, world, core, scripting).
- The bridge + shim binaries continue using `["full"]` because they're
  native-only and need the `net` (TCP listener, UDP socket) features. The
  workspace dep stays as-is; the WASM crates override it via feature
  selection.

Concretely the simplest mechanism is to **switch workspace `tokio` to no
default features and have each crate declare what it needs**:

```toml
# workspace
tokio = { version = "1", default-features = false }

# holtburger-wsbridge (and similar native-only crates)
tokio = { workspace = true, features = ["full"] }

# holtburger-session
tokio = { workspace = true, features = ["rt", "sync", "macros", "time"] }
# native-only feature gate for the UDP path in api.rs (to be added):
#   [target.'cfg(not(target_arch = "wasm32"))'.dependencies]
#   tokio = { workspace = true, features = ["net"] }
#   socket2 = { workspace = true }
```

Then `Session::new` (the UDP path) becomes `cfg(not(target_arch =
"wasm32"))`, while `Session::new_with_transport` (already landed) stays
unconditionally available.

### 4.2 `zstd-sys` needs C compiler for wasm32

`zstd = "0.13"` (workspace dep line 47) pulls `zstd-sys` which uses
`cc-rs` to compile the bundled C zstd source. For `wasm32-unknown-unknown`
that means `cc` invokes a C compiler with `--target=wasm32`, which only
clang knows how to do (gcc cannot). The tool isn't installed in the dev
environment so the build dies before reaching any actual Rust.

**Three viable paths:**

1. **Install clang + cross-compile zstd C source.** Cheapest path for
   continuing the spike *if* Phase 2 commits to keeping `zstd-sys`. Adds a
   non-Rust dev-environment dependency though.
2. **Replace `zstd` (zstd-sys-backed) with `ruzstd`** — pure-Rust zstd
   *decompression* (no compression). DAT/HBA files are decompress-only at
   client runtime, so this is sufficient. Cleanest end state. Requires
   patching `holtburger-dat`'s decompress path.
3. **Use `zstd` with custom features that skip `cc` build** — `zstd` has a
   `pkg-config` feature that links against system zstd instead of building
   it. Doesn't help wasm32 (no system zstd in the browser).

**Recommendation:** path (2). It's the right end state for a browser
target, and `ruzstd` is mature. Path (1) is a fine intermediate if path
(2) reveals API friction.

## 5. The path through Phase 2 the spike narrows to

Given §4, the order of operations that minimizes wasted work:

1. **Land the workspace Tokio split** (workspace `default-features = false`,
   per-crate feature opt-in). Verify *native* builds + tests still all
   green — the bridge, shim, cli, tools, tests must be untouched. ~½ day.
2. **Cfg-gate `Session::new` (UDP path) and `socket2` import** to
   `cfg(not(target_arch = "wasm32"))`, so `holtburger-session` cross-compiles
   to wasm32 successfully. With the Tokio split done, this should be the
   only remaining `holtburger-session` blocker. ~½ day.
3. **Spike `holtburger-dat` on the `ruzstd` swap.** Read what `zstd::Decoder`
   API surface holtburger-dat actually uses; map to `ruzstd`'s API; either
   adapter-shim or feature-flag the decoder choice. ~1 day.
4. **Cascade-recheck** `holtburger-world`, `holtburger-content`,
   `holtburger-core`, `holtburger-scripting` for wasm32. New blockers
   surfaced here are the next backlog (and likely smaller than 4.1 / 4.2).
5. **Now** start the actual WASM build pipeline: pick `wasm-pack` or `trunk`
   (design doc §7.4 leans `wasm-pack`); write the `WsTransport` impl in a
   new `holtburger-transport-ws` crate (so non-WASM consumers don't pull
   `web-sys`); write `HttpResourceSource` for DAT-over-HTTP.

Steps 1–4 establish the *cross-compile floor*. They should land before any
of the design doc §5.2's "WS transport impl" / "HTTP resource source"
content is attempted, because those depend on the ported crates being
WASM-compilable in the first place.

## 6. Open questions the spike does **not** resolve

These remain exactly as the design doc framed them; the spike just narrowed
the surface.

- **`getrandom` `js` feature.** Untested here because the spike never
  reached the layer that pulls `getrandom` (ISAAC doesn't need entropy at
  init — seeds come from the server's `ConnectRequest`, see
  `session/auth.rs:33-66`). The login flow's password-handling path may.
  Re-check after step 2 succeeds.
- **`tokio::spawn` Send/Sync audit (§5.2).** WASM has only `LocalSet`-style
  execution. None of the cross-compile errors above would surface this —
  it's a runtime-shape concern that bites only when actual async work runs.
  Audit when the WASM runtime is wired up.
- **`wasm-pack` vs `trunk`** (§7.4 in the design doc). Decide when step 5
  starts.

## 7. References

- Design doc: [`docs/emit-dynamic-site.md`](emit-dynamic-site.md), §3.1, §4.1, §5.2, §7.4
- Bridge / shim ARCHITECTURE: [`external/holtburger/apps/holtburger-wsbridge/ARCHITECTURE.md`](../external/holtburger/apps/holtburger-wsbridge/ARCHITECTURE.md)
- Transport trait: [`external/holtburger/crates/holtburger-session/src/session/types.rs:17-21`](../external/holtburger/crates/holtburger-session/src/session/types.rs)
- Session constructors (post-refactor): [`external/holtburger/crates/holtburger-session/src/session/api.rs`](../external/holtburger/crates/holtburger-session/src/session/api.rs)
- Workspace deps with the `tokio["full"]` pin: [`external/holtburger/Cargo.toml:34`](../external/holtburger/Cargo.toml)
- Workspace deps with the `zstd` pin: [`external/holtburger/Cargo.toml:47`](../external/holtburger/Cargo.toml)
