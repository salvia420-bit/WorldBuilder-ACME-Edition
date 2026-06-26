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

- [x] **S2 — Rust: `texchan` codec** (`crates/holtburger-suite-bake/src/texchan.rs`, mirror `windclip.rs`) ✅
  Named **`texchan`** (the tag pre-reserved by the crate doc + windclip wrong-tag test), NOT `matclip`. Packs
  {normal RGB8, roughness R8, ao R8} for one surface; channel-mask header (optional channels); `encoding`
  field reserved for BC/DXT (raw=0 only). `encode_payload`/`decode_payload` round-trip + container wrap +
  `fingerprint()` (FNV-1a, `.texchan-hash` sidecar). Surface-hash keyed (codec is key-agnostic; key set at S5).
  **Gate:** ✅ `capped-build cargo test -p holtburger-suite-bake` → **20 passed / 0 failed** (8 new texchan;
  windclip + container unchanged).

- [x] **S3 — DROPPED** (user-approved 2026-06-26: "drop s3 and continue"). Premise was false: surface→
  `SURFACE_CATEGORY` is already a wired Rust→wasm→JS path (`surface_classify::classify`+`compute_stats` →
  `sp.category` → materials.js), and `Vfx::BuildResult` is SetupDID/archetype scope, not surfaces. No C#
  change. The category lookup the producer needs is folded into **S5** (Rust classify at bake time). No code.

- [x] **S4 — wasm: extend `suite_fetch` for `texchan`** (`apps/holtburger-web/src/lib.rs:2425`) ✅
  Added a STRING-keyed cache (`SUITE_CACHE_BY_KEY`) + `fetch_suite_artifact_by_key(key, artifact_type)` (URL
  `{base}{key}.{type}.bin`) alongside the untouched DID `(did,type)` path; `suite_cache_size()` now sums both;
  `clear_suite_cache()` clears both. Key stem is caller-owned (S6) so this fn stays agnostic to the hash
  format. Inert (no JS caller). DID path byte-unchanged.
  **Gate:** ✅ `capped-build wasm-pack build --dev` green (53s); `fetch_suite_artifact_by_key` present in
  `pkg/holtburger_web.{js,d.ts}` (correct `(key,type)→Promise<Uint8Array>` sig); zero JS callers (grep).
  Boot-smoke adaptation: live `suite_cache_size()==0` page-smoke **deferred to S6** (no playwright wired in-dir;
  `window.__hbWasm` is a curated literal not the namespace; inert export ⇒ 0-at-boot holds by construction —
  both caches init empty, nothing fetches at boot, DID-path equivalent proven live in P4.0b). S6 does the
  index.html named-import + `?v=` bump + the real-fetch smoke together. (`pkg/` rebuilt, gitignored.)

- [x] **S5 — Producer: Rust bake example** (`crates/holtburger-dat/examples/bake_texchan.rs`) ✅
  Implemented as a **pure-Rust example** (not a WB.Terminal C# command): byte-identity *requires* running the
  same Rust `normal_from_luminance` the runtime runs, so the producer replicates the runtime ingest chain
  exactly (Surface→SurfaceTexture.highest_res→Texture.actual_dimensions→to_rgba8(palette)→`normal_from_luminance(_,1.0)`).
  **All three channels baked at strength 1.0** — per-category strength stays a runtime JS concern
  (materials.js normalScale/detail tables), exactly as the runtime already applies `normalScale`; nothing
  per-category is baked into pixels ⇒ **the dropped-S3 classify is unnecessary at bake time** (simplification).
  Dedup by content-hash (`texchan::fingerprint` = filename stem); `texchan-manifest.json` maps surfaceDid→stem
  for S6. Skips LUMINOUS / solid-1x1 / untextured (matches runtime). base-dats rule: rejects `0x__FFxxxx`.
  Adaptations: `sha2` (in-producer `bake-source.sha256`, streamed over the 926MB dat); per-file `.sha256` +
  `.texchan-hash` sidecars **dropped** (filename IS the content-hash). Real-`portal.dat` golden (deferred from
  S1) = this real bake.
  **Gate:** ✅ **determinism** — two `--limit 300` runs byte-identical (dir digest `816db22e…`). ✅ **full bake**
  (release) — scanned **6152** / baked **5999** / **5475 unique** / 524 dedup / **0 errors** (parse/chain/
  decode/empty all 0; 153 solid-untextured skipped). ⚠ **sizing: 1.1 GB raw RGBA8** → motivates the reserved
  `encoding` field (BC/DXT) as a follow-up; fine for local default-on (on-demand fetch from external drive).
  Artifacts in `/mnt/wbterminal2/holtburger-dist/suite/` (not git). Re-run full bake: `cargo build --release
  -p holtburger-dat --example bake_texchan && target/release/examples/bake_texchan`.

- [x] **S6a — byte-faithfulness verifier** (`crates/holtburger-dat/examples/verify_texchan.rs`) ✅
  Independently re-derives each sampled surface's normal from real `portal.dat` and bit-compares to the
  on-disk `.texchan.bin` normal channel (resolved via `texchan-manifest.json`); checks dims + rough/ao
  presence/length. Proves the codec+manifest+dedup pipeline faithfully stores `normal_from_luminance` output
  (the real-`portal.dat` golden deferred from S1) and that dedup merges are content-correct.
  **Gate:** ✅ `verify_texchan --limit 800` → **checked=800 ok=800, 0 mismatches** (normal/dim/channel/missing/
  rederive all 0). BYTE-FAITHFUL.

  **S6b approach: PRE-WARM + SYNC ATTACH** (user-chosen 2026-06-26). The sync cache lives in **JS** (prefetch
  promises populate the `SuiteAssetSource` cache; the material build reads it synchronously) → **JS-only, no
  wasm rebuild**.

- [x] **S6b-1 — JS decoder + by-key transport + manifest loader** (`scene3d/suite_assets.js`, inert) ✅
  Added `SuiteAssetSource.getByKey(stem,type)` (routes through wasm `fetch_suite_artifact_by_key`),
  `decodeTexchanBytes` (parses the SuiteBlob "HSB1" CONTAINER — texchan writes `encode()`, unlike windclip's raw
  payload — then the w/h/mask/encoding payload → zero-copy channel views) registered as the `"texchan"` decoder,
  and `loadTexchanManifest()` (surfaceDid→stem, fail-soft). Inert: no materials.js caller yet.
  **Gate:** ✅ `node harness/test_texchan_decode.mjs` → **ok=60 fail=0** (52 unique stems; negative inputs
  fail-soft to null). Cross-language Rust-`encode()` → JS-decode validated on real on-disk artifacts.

- [ ] **S6b-2 — materials.js wiring + index.html** (behind `?material=`, default-OFF; S7 flips on)
  **SCOPED (execution map, ready to implement):**
  - `_materialFromFlags` lacks `surfaceDid` → attach at the **two caller sites** (materials.js:2681 build path,
    :3318 twin) where `did` is in scope, right after `mat` is built + `this.materials.set(did,mat)`.
  - **attach-on-resolve is REQUIRED** (a material is built once then cached; sync-attach-only would never
    attach on a cold first visit). Need a promise accessor `getByKeyAsync(key,type)` on `SuiteAssetSource`.
    On resolve: `_applyTexchan(mat,tc)` + `mat.needsUpdate=true` + invalidate `frontSideMaterials.delete(did)` /
    `floorBiasMaterials.delete(did)` (clones re-mint with the maps). Sync `getByKey` hit path covers warm.
  - `_applyTexchan(mat,tc)`: build **R8 `RedFormat` DataTextures** for `tc.roughness` + `tc.ao` →
    `mat.roughnessMap` / `mat.aoMap`. Normal left as-is (byte-identical). No new program permutations.
  - MaterialCache ctor already takes wasm getters via `opts` (e.g. `opts.animFramesFetch`) → add
    `opts.texchanFetch`/`wasmExports`; thread from the **3 call sites** (statics.js, buildings.js, index.js).
    Lazy-build the `SuiteAssetSource` + `loadTexchanManifest()` on first gated use.
  - `materialBakeEnabled()` flag (default **false** until S7), mirror `windBakeEnabled` (in vfx_flags.js).
  - index.html: add `fetch_suite_artifact_by_key` to BOTH wasm named-import sites (:1152, :4131) + bump `?v=`.
  **Gate:** node attach unit test (real `.bin` → stub material → `roughnessMap`/`aoMap` set, correct dims) +
  in-world boot-smoke via `harness/ln/drive.mjs` (playwright in `~/.npm/_npx/…`; ACE flaky → reload-retry):
  0 console errors + program-count unchanged + maps-bound + the deferred S4 `suite_cache_size()>0`. Lands
  default-OFF; the live boot-smoke is also S7's gate. (Runtime-vs-bake normal proven S6a; decode S6b-1.)

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
- S2 — texchan codec in holtburger-suite-bake (name was pre-reserved); `cargo test -p holtburger-suite-bake` 20/0. Renamed matclip→texchan across §2.
- S3 — HALTED then DROPPED (user-approved). Surface→category already wired in Rust; folded the producer's classify need into S5. Loop re-armed; next live step S4.
- S4 — wasm fetch_suite_artifact_by_key (string/surface-hash keyed) + dual-cache suite_cache_size; capped wasm-pack --dev green, export in pkg js/dts, inert. Live boot-smoke deferred to S6.
- S5 — Rust bake_texchan example; determinism 300-subset byte-identical; full release bake 6152→5999 baked/5475 unique/524 dedup/0 errors; 1.1GB raw (BC follow-up flagged). normal@1.0 = byte-identity preserved; S3-classify confirmed unnecessary at bake.
- S6a — verify_texchan example; 800/800 byte-faithful (baked normal == fresh normal_from_luminance, rough/ao ok), 0 mismatches. S1 real-portal golden landed.
- S6b — DECISION: user chose pre-warm+sync-attach; refined to JS-owned cache (JS-only, no wasm rebuild). Loop re-armed to implement.
- S6b-1 — JS decoder (HSB1 container→texchan payload) + getByKey + loadTexchanManifest in suite_assets.js (inert); test_texchan_decode.mjs ok=60/0. Rust-encode→JS-decode validated.
