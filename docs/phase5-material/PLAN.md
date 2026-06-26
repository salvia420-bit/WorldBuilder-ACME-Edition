# Phase 5 — Material-Detail Bake (LOCAL /loop ledger)

**This is the loop's source of truth.** Each tick: read this file → take the next unchecked step →
implement → run its LOCAL gate → green: `git commit` + check the box here → red: bounded-retry (≤2),
else HALT and report. Stateless between ticks (this ledger + git are the memory).

> "Phase 5" here = the **material/texture-detail bake track** (the renumbered one: `P4=bake, P5=texture,
> P6=classifier`, per `docs/phase4-bake/HANDOFF-2026-06-25.md:12`). NOT the old renderer-roadmap
> `docs/phase-5-thorough.md` / `phase-5.2-manifest-fix.md` — unrelated.

**Branch:** `feat/phase3-particle-2026-06-24` (local). **Mode:** local-only, no buildbox, no 1070 eye-test,
ship **default-ON**. Build OFF everything in Phases 0–4.

---

## 0. Thesis — a bake-migration, not a new feature

The runtime **already** has the whole material system (`scene3d/materials.js`):
- `SURFACE_CATEGORY` (13 cats: Stone/Wood/Metal/Sand/Lava/Cloth/Foliage/Water/Dirt/Snow/Brick/Tile/Generic),
- per-category detail **strength** + detail **pattern** names (`stone-grain`/`wood-grain`/`fabric-weave`),
- per-category `roughness`/`metalness`, a `MaterialCache` keyed by surfaceDid,
- runtime normal-map generation via `holtburger_dat::normal_gen::normal_from_luminance` (called at wasm
  ingest, `apps/holtburger-web/src/lib.rs:7517 / 9151`), gated by `normalMapsEnabled` (**already default-on**).

**Phase 5 = move that generation offline onto the P4.3 per-surface sidecar pipe, and add roughness + AO/cavity
channels.** No new vocabulary, no per-material knobs (strength-only, reusing the existing category tables).

### Why this is provable locally (no 1070)
- The relocated **normal** channel is **byte-identical offline-vs-online by construction** — the bake runs
  the *same Rust* `normal_from_luminance` the runtime runs at ingest. Bit-compare proves it.
- The **new** channels (roughness/AO) get deterministic **golden** tests against real `portal.dat` surfaces.
- `off = byte-identical` firewall + `?material=off` escape (the safety net for default-on).
- Structural boot-smoke under SwiftShader: loads, **0 console errors**, **program count unchanged** (no
  permutation explosion), maps bound — via `window.__diag`.
- **OWED & DEFERRED (the only thing the loop can't prove):** visual quality ("does it look authored"). Ships
  default-on anyway by USER decision; reversible per-load via `?material=off` (guaranteed byte-identical).
  Any future 1070 session A/Bs `?material=on` vs `?material=off`.

---

## 1. Decisions (frozen — don't reopen mid-loop)
- **Vocabulary:** reuse `SURFACE_CATEGORY` as-is. No new classes.
- **Channels:** normal (relocate) + roughness + AO/cavity (new). Palette-aware (don't emboss palette-index
  seams). Deterministic.
- **Key:** **surface content-hash**, not DID (surfaces are shared across DIDs → dedup). Differs from windclip.
- **Encoding:** raw RGBA8 first. Measure size at Step 5; defer BC/DXT unless VRAM forces it (don't add a
  codec before it's needed).
- **Producer:** the deterministic **Rust bake** run via a WB.Terminal command (NO headless-chromium — unlike
  windclip; the math is Rust, not in-page JS synth).
- **Strength-only:** per-category strength via the existing `materials.js` tables; never per-material.
- **Gate philosophy:** "no NEW test failures", never "all green" (pre-existing baseline fails exist; see P4).

---

## 2. Worklist (each row = ONE tick = ONE gated commit)

- [x] **S1 — Rust: extend `normal_gen.rs`** (`crates/holtburger-dat/src/normal_gen.rs`) ✅
  Added `roughness_from_luminance` (per-texel 3x3 σ → micro-roughness) + `ao_from_luminance` (lum vs local
  mean → cavity AO). Per-pixel (crop-stable for the dedup key), palette-safe (decoded RGBA only), inert (no
  caller). Existing `normal_from_luminance`/`height_from_luminance` left byte-frozen (own inline lum copies);
  shared `build_luminance` helper used by the new fns only. Re-exported in `lib.rs`.
  **Gate:** ✅ `capped-build cargo test -p holtburger-dat --lib` → **351 passed / 0 failed** (12 new tests; all
  prior normal_gen goldens unchanged). Golden adaptation: exact-byte goldens are the hermetic predictable
  cases (uniform→roughness all-0, AO all-255); the **real-`portal.dat` byte golden is deferred to S5** (DAT
  access lives there, not in a hermetic unit test).

- [ ] **S2 — Rust: `matclip` codec** (`crates/holtburger-suite-bake/src/matclip.rs`, mirror `windclip.rs`)
  Pack {normal, roughness, ao} for one surface; **surface-hash** keyed; deterministic fingerprint via
  `holtburger_common::bake_fingerprint`. `encode_payload`/`decode_payload` (raw RGBA8 LE), reencode_eq test.
  **Gate:** `PATH="$HOME/.cargo/bin:$PATH" capped-build cargo test -p holtburger-suite-bake`.

- [ ] **S3 — C#: classifier emits material-class per surface** (`WorldBuilder.Terminal/CommandEngine.Vfx.cs`
  + `WorldBuilder.Shared/Lib/VisualDescriptor.cs`)
  Emit the `SURFACE_CATEGORY` tag per DID/surface into `visual_descriptors.jsonl` via `BuildResult` (the
  Bucket-A enrichment). WB.Terminal = **Opus-4.8 only**.
  **Gate:** `DOTNET_ROLL_FORWARD=LatestMajor dotnet test WorldBuilder.Tests -c Release` (memory-safe;
  single-project) — extend `VisualDescriptorRoundTripTests`.

- [ ] **S4 — wasm: extend `suite_fetch` for `matclip`** (`apps/holtburger-web/src/lib.rs:2425`)
  Allow a surface-hash-keyed `matclip` artifact type alongside the `(did,type)` path. Keep inert until S6.
  **Gate:** `PATH="$HOME/.cargo/bin:$PATH" capped-build wasm-pack build --target web --out-dir pkg --dev` +
  boot-smoke `suite_cache_size()==0` when unreferenced. (Rebuild clobbers `pkg/`; it's gitignored.)

- [ ] **S5 — Producer: WB.Terminal bake command** → `${HOLTBURGER_DIST}/suite/<surfacehash>.matclip.bin`
  (+ `.sha256` + `.matclip-hash`, `matclip-coverage.json`, `bake-source.sha256`). Runs `normal_gen` offline
  over real `portal.dat` surfaces. **base dats only** (`~/ac_base_dats/`; reject `0x__FFxxxx`).
  **Gate:** re-run → **byte-identical sha256** (determinism) + coverage report (N baked / 0 skipped).

- [ ] **S6 — JS consumer: fetch-not-generate** (`scene3d/materials.js`, behind `?material=`)
  In `MaterialCache`, branch on `suite.get(surfaceHash,"matclip")` → use baked maps; **miss → current
  runtime path** (fallback firewall). Keep the ONE existing material path (no new program permutations).
  `?material=off` → exact current rendering.
  **Gate:** harness (`harness/test_*`) + boot-smoke 0 errors + program-count + maps-bound (`__diag`) +
  **bit-compare baked normal == runtime `normal_from_luminance`** for ≥1 surface.

- [ ] **S7 — Default-on flip** (`scene3d/vfx_flags.js` reader, mirror `windBakeEnabled`)
  Add `materialBakeEnabled()` default **true**, `?material=off` escape. Update `docs/url-flags.md`.
  **Gate:** harness + boot-smoke.

- [ ] **S8 — Simplify: delete dead runtime normal-gen** (`apps/holtburger-web/src/lib.rs:7517 / 9151`)
  Once baked-default-on, the ingest-time `normal_from_luminance` calls are dead. Remove + rebuild wasm.
  **Gate:** `?material=off` still byte-identical (fallback re-generates) + builds green. *(If OFF needs the
  runtime gen, KEEP it and mark S8 N/A — note here.)*

- [ ] **S9 — (STRETCH, only if S1–S8 all green) anti-tiling / richer detail tiles**
  Macro-variation to break obvious repetition; strength-only per category. Skip if any earlier step is shaky.
  **Gate:** golden + boot-smoke.

---

## 3. Boot-smoke recipe (local SwiftShader — structural only)
Laptop stack must be up: `serve.py` :8765, wsbridge :8080, ACE 9000/9001 (ACE flaky → reload-retry).
Headless chromium (≤3 instances, SwiftShader):
`http://127.0.0.1:8765/apps/holtburger-web/index.html?nosw=1&autoLogin=1&account=phase4demo&password=phase4demo&autoSpawn=first&nullRender=1&netDrainHz=30&material=on`
→ poll `window.__bootState=='in-world'` → read `/console?n=500` for **0 errors** → assert `__diag` surfaces
(program count, maps bound, `suite_cache_size`). **NOT** pixel fidelity — that's the owed 1070 eye-test.

## 4. Stop conditions
HALT + report if: a gate stays red after ≤2 retries · a step needs a decision not in §1 · S1–S8 all checked
(core done, default-on, eye-test owed-but-deferred). **Never push** (separate explicit call). **Never** run
`cargo build/test --workspace` or bare `wasm-pack` (OOM); capped single-crate only; `dotnet` single-project only.

## 5. Progress log (loop appends one line per committed step)
- S0 (this file) — committed.
- S1 — roughness + AO channels in normal_gen.rs; `cargo test -p holtburger-dat --lib` 351/0. Real-portal.dat golden deferred to S5.
