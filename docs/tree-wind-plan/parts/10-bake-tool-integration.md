I have everything I need. Writing my focused plan section.

---

## Assignment (Task 10): Design the offline `tree-wind-bake` binary

Design the offline bake tool that enumerates the `TREE_DID` set, loads each Setup/GfxObj, runs skeletonize (task 07) + sim (task 08), and emits per-DID wind assets to `dist/`, with the client fetch wiring, determinism, and SHA sidecars matching the existing `scenery-bake` conventions.

## Findings (file:line)

**Existing bake tool — the template to mirror** (`apps/holtburger-tools/src/bin/scenery-bake.rs`):
- CLI surface `struct Cli` with clap, **no defaults** for `--dat-dir`/`--out` by determinism contract (scenery-bake.rs:74-132); `--region-did` passed as hex *string* to survive clap round-trip (scenery-bake.rs:95-96); `--bits` diagnostic mode toggles a process-global `EMIT_BITS` atomic (scenery-bake.rs:63, 1055-1057).
- `preflight_dat_dir()` returns `DatDirCheck { portal_db, cell_db, portal_hash, cell_hash, local_hash }` — opens the three base DATs, rejects sibling modder markers (`custom_textures/`, `iter-*`, `*.wbproj`), scans for modder-allocated record IDs via `first_modder_allocated_id` (top byte `0x01..=0x78` AND second byte `0xFF`), and content-hashes each DAT (scenery-bake.rs:213-369).
- Per-record load helpers I can reuse directly: `gfx_local_mesh()` does `GfxObj::unpack` → `vertex_array.vertices.values().map(|v| v.origin)` (scenery-bake.rs:419-433); `setup_local_mesh()` concats all `setup.parts` GfxObj vertices (scenery-bake.rs:441-458). This is exactly the per-part vertex access tasks 07/08 need.
- `format_f32_six_sig()` is the **determinism keystone**: normalises `-0.0 → 0.0`, emits `{:.6}` (locale-free) or raw `to_bits()` under `--bits` (scenery-bake.rs:881-895).
- Per-LB output convention: `0x{lb_key:04X}.scenery.jsonl` + a `.sha256` sidecar whose **line 1 = sha256(file bytes)**, **line 2 = `placements-hash\t{fnv1a:016x}`** (scenery-bake.rs:971-1009), plus an additive `0x{lb}.scenery.materials.json` (scenery-bake.rs:1020-1024). `sha256_file()` streams 64 KiB chunks (scenery-bake.rs:357-369).
- Top-level `bake-source.sha256` manifest with fixed tab-separated layout incl. tool-version strings `SCENERY_BAKE_CLI_VERSION`/`SCENERY_BAKE_LIB_VERSION` (scenery-bake.rs:51-52, 1144-1199).
- **No `Date`/`Random` anywhere** — caches are pure functions of `obj_id`; the determinism harness `scenery-bake-determinism.rs` bakes the 13×13 ring **twice** and asserts byte-identical output (scenery-bake-determinism.rs:1-21).

**Client fetch wiring** (the convention to mirror):
- `init_scenery_base_url(url)` normalises a trailing slash into a `thread_local BASE_URL` (lib.rs:2131-2139); `fetch_one_lb` builds `{base}{lb_hex}.scenery.jsonl` and 404 → positive-empty cache (lib.rs:2173-2196); the advisory freeze-hash gate fetches `…jsonl.sha256` and reads the `placements-hash` line (lib.rs:2333-2349).
- JS side: `SCENERY_BASE_URL = "../../dist/scenery/"` (statics.js:305), pushed once via idempotent `ensureSceneryInit()` → `wasmExports.init_scenery_base_url(...)` (statics.js:316-344). `spawns.js:37` shows the parallel `SPAWNS_BASE_URL = "../../dist/spawns/"`.
- **dist symlink confirmed**: `apps/holtburger-web/dist -> /mnt/wbterminal2/holtburger-dist` (the in-app symlink); the scene3d-relative `../../dist` resolves to `/home/wbterminal/holtburger-dist` (served root). The dev server maps `/dist/...` to the staged dist (spawns.js:33-36).

**Crucial distinction — two output transports** (decides the whole design):
- `fetchAnimation(animId)` / `fetchBuildingPlacement(setupId)` are **wasm exports** that read DATs through the manifest/resource source (animated_scenery.js:209, 255) — NOT sidecar fetches. So an AC-native synthetic `Animation 0x03` only reaches the client through the `dat-shard` manifest/overlay pipeline (dat-shard.rs:93-131).
- The scenery JSONL route is a **plain static-asset fetch** (`init_scenery_base_url` + HTTP). VAT textures and flat-keyframe JSON ride this transport with **zero wasm rebuild** — the OOM-friendly path.

**Packers available for the AC-native (secondary) route** (`crates/holtburger-dat-write/src/pack/`):
- `animation.rs`: `impl DatPack for Animation` → `Animation::pack`, validates `part_frames.len()==num_frames`, every `part_frame.frames.len()==num_parts`, `POS_FRAMES` flag gates `pos_frames` (animation.rs:26-72).
- `setup_model.rs`: `impl DatPack for SetupModel`, validates `HAS_PARENT(0x01)` gates `parent_index.len()==parts.len()`, `HasDefaultScale` gates `default_scale` (setup_model.rs:32-108).
- `holtburger-scenery-bake` is a reusable lib crate (`aabb.rs/height.rs/noise.rs/lib.rs`) declared in the workspace (Cargo.toml:13,43) — the model for a new `holtburger-tree-wind` lib crate hosting skeletonize+sim.

## Concrete coding steps (ordered)

### Step 1 — New lib crate `holtburger-tree-wind` (OFFLINE-BAKE)
Create `crates/holtburger-tree-wind/` mirroring `holtburger-scenery-bake`, hosting the pure logic from tasks 07 (`skeletonize.rs`) and 08 (`sim.rs`) plus a VAT encoder (`vat.rs`). Keeps the binary thin (matches how `scenery-bake.rs` delegates to `bake_landblock`). Add to `Cargo.toml:13` members and `:43` workspace deps. **All functions must be deterministic** — phases derived from `fnv1a(bone_index)` not `Math.random`, no `Date` (mirrors scenery-bake's no-Date/Random posture).

Public surface:
```rust
// vat.rs
pub struct WindClip { pub fps: u32, pub num_frames: u32, pub num_parts: u32,
                      pub part_frames: Vec<PartFrame> }  // absolute root-relative frames
pub struct VatTexture { pub width: u32 /*=vertexCount*/, pub height: u32 /*=num_frames*/,
                        pub rgba16f: Vec<u16>, pub bbox_min: Vector3, pub bbox_max: Vector3 }
pub fn bake_tree_wind(verts_per_part: &[Vec<Vector3>], cfg: &WindCfg)
    -> (WindClip, VatTexture);   // 07→08→encode, pure
```

### Step 2 — New binary `apps/holtburger-tools/src/bin/tree-wind-bake.rs` (OFFLINE-BAKE)
Clone the `scenery-bake.rs` skeleton: reuse `parse_hex_u32`, `preflight_dat_dir` (returns `DatDirCheck`), `gfx_local_mesh`/`setup_local_mesh`, `format_f32_six_sig`, `sha256_file` (lift them into a shared `holtburger-tools` lib module so both bins share one copy rather than fork). CLI:
```rust
#[derive(Parser)]
struct Cli {
    #[arg(long)] dat_dir: PathBuf,          // preflight-hardened, base-DATs-only
    #[arg(long)] out: PathBuf,              // dist/treewind staging dir
    #[arg(long, value_name="DID|@file")] tree_dids: String, // allowlist (task 02)
    #[arg(long, default_value="vat,anim")] emit: String,    // vat | anim | dat
    #[arg(long, default_value_t=30u32)] fps: u32,
    #[arg(long, default_value_t=60u32)] frames: u32,        // loop length (Nyquist, task 08)
    #[arg(long, default_value_t=1.0f32)] strength: f32,
    #[arg(long)] bits: bool,                // same EMIT_BITS determinism diag
}
```
`--tree-dids` parses like `--landblocks` (`@file` list or comma/`0x` ids). Main loop: `preflight_dat_dir` → for each DID, `setup_local_mesh`/per-part vertex lists via `gfx_local_mesh` over `setup.parts` → `holtburger_tree_wind::bake_tree_wind(...)` → emit per chosen `--emit` mode. Per-DID throttle + verbose progress like scenery-bake.rs:1114-1141.

### Step 3 — Output format + path convention under `dist/` (OFFLINE-BAKE)
Stage into `--out` = the `treewind/` subtree of the same dist root `init_scenery_base_url` serves (i.e. `/mnt/wbterminal2/holtburger-dist/treewind/` via the in-app symlink, or the served `../../dist/treewind/`). Per-DID filenames keyed by the **hex DID** (mirrors `0x{lb:04X}.scenery.*`):

| File | Route | Contents |
|---|---|---|
| `0x{DID:08X}.windvat.bin` | VAT (forest) | Raw RGBA16F, row-major `Y=frame, X=vertexId`; header = `{width,height,bbox_min,bbox_max,encoding}` in a sibling `.windvat.json`. `.bin` not `.png` — RGBA16F survives no lossy PNG path. |
| `0x{DID:08X}.windvat.json` | VAT meta | bbox min/max (delta decode), `vertexCount`, `numFrames`, `fps`, encoding tag. |
| `0x{DID:08X}.windclip.json` | flat keyframe (hero) | `{numParts,numFrames,fps,frames:[…flat Float32 …]}` — **identical shape to `fetchAnimation`'s flat array** (animated_scenery.js:109) so `buildSceneryAnimationClip` consumes it unchanged. |
| `0x{DID:08X}.windvat.bin.sha256` / `.windclip.json.sha256` | integrity | **Two lines**, exactly like scenery: line 1 `sha256(bytes)`, line 2 `content-hash\t{fnv1a:016x}` over the pre-serialization sample stream (the analog of `placements-hash`). |
| `tree-wind-manifest.json` | index/audit | TREE_DID list + per-DID `{numParts,numFrames,vertexCount,emit-modes}` + the `bake-source.sha256`-style base-DAT content hashes + tool-version string. Lets the client enumerate without probing 404s, and keeps the allowlist auditable (task 02). |

VAT `vertexId` MUST be assigned in **the same order `adapter.js meshToGeometryGroups` emits non-indexed triangle verts** (task 04/06) — the bake walks parts/polys in the identical order so `gl_VertexID` ↔ texture column align. Document this ordering invariant in a header comment in both `vat.rs` and `adapter.js`.

### Step 4 — Determinism + SHA sidecars (OFFLINE-BAKE)
- Reuse `format_f32_six_sig` for every emitted float (JSON clip) and `to_bits()`/`--bits` for bit-exact VAT diffs. VAT RGBA16F is already integer bits — inherently byte-stable.
- Per-bone phase = `fnv1a64(bone_index).wrapping_mul(...) as f32 / u64::MAX` — **no `Math.random`/`Date`** (the established sandbox constraint; matches scenery-bake's pure-of-`obj_id` caches).
- Add `apps/holtburger-tools/src/bin/tree-wind-bake-determinism.rs` cloning `scenery-bake-determinism.rs`: bake the TREE_DID set **twice**, assert byte-identical `.windvat.bin` + `.windclip.json`. Wire a `tests/tree_wind_bake_preflight.rs` mirroring `scenery_bake_preflight.rs`.

### Step 5 — Client fetch wiring (JS-ONLY for VAT + clip routes; **no wasm rebuild**)
Because VAT `.bin`/`.json` and `.windclip.json` are **plain static assets**, fetch them directly in JS — no new wasm export needed (the OOM win):
- New module-local const in the wind attach path (task 01/05): `const TREEWIND_BASE_URL = "../../dist/treewind/";` (mirrors statics.js:305 `SCENERY_BASE_URL`).
- A `fetchWindClip(did)` helper: `fetch(`${TREEWIND_BASE_URL}0x${did.toString(16).padStart(8,'0').toUpperCase()}.windclip.json`)` → feed the flat `frames` array straight into `buildSceneryAnimationClip` (animated_scenery.js:219) — bypasses `fetchAnimation` entirely.
- A `fetchWindVat(did)` helper for task 06: fetch `.windvat.bin` as `ArrayBuffer` → `THREE.DataTexture(Uint16Array, w, h, RGBAFormat, HalfFloatType)` + the `.windvat.json` bbox uniforms.
- **Manifest-driven enumeration**: fetch `tree-wind-manifest.json` once at init (parallel to `ensureSceneryInit`) so the client knows the TREE_DID allowlist + per-DID frame/vertex counts before any sway attach.

### Step 6 — AC-native DAT route is OPTIONAL / secondary (OFFLINE-BAKE + needs dat-shard manifest re-pack)
If `--emit dat` is requested, author synthetic `SetupModel 0x02` (segmented parts, `parent_index = -1` flat, `default_animation` → new Animation DID) + dense `Animation 0x03` (absolute per-part frames) via the `DatPack` packers (animation.rs:26, setup_model.rs:32, task 09), write into an **overlay HBA/shard** consumed by the `dat-shard` manifest pipeline (dat-shard.rs:93-131) so the existing `fetchAnimation`/`fetchBuildingPlacement` wasm path serves them with **no client-code change**. Flag this as heavier (touches the manifest/CDN deploy) and gate it behind `--emit dat`; the default `--emit vat,anim` ships the JS-only sidecars. Do NOT make this the critical path.

## Risks & open questions
- **VAT vertex-order drift** (highest risk): if `adapter.js` triangulation order ever changes, every baked `.windvat.bin` silently mis-maps. Mitigation: bake a `vertexCount` + a cheap `positions-hash` into `.windvat.json`; the client compares against the live geometry's vertex count at bind time and falls back to frozen on mismatch (rollback = flag-off → static). Pin the ordering with a golden test in both crates.
- **Which physical dist dir is authoritative**: there are two symlinks (`apps/holtburger-web/dist → /mnt/wbterminal2/...` vs scene3d-relative `../../dist → /home/wbterminal/holtburger-dist`). Open question for the laptop dev: confirm which one the running dev server serves and stage `treewind/` there (the `--out` arg keeps the bake agnostic). I default the doc to `/mnt/wbterminal2/holtburger-dist/treewind/` per the assignment.
- **RGBA16F over HTTP**: `.bin` avoids PNG's 8-bit/lossy trap, but costs ~`vertexCount × numFrames × 8` bytes/DID (e.g. 200 verts × 60 frames ≈ 96 KB). Acceptable per-DID; note the total in the manifest so the client can budget. Could add delta-from-rest + per-model bbox quantization (task 06) to halve it.
- **Build cost on the 8 GB laptop**: the new crate + two bins add compile units → risk of OOM on `cargo build -p holtburger-tools`. Mitigation: build **per-bin** (`--bin tree-wind-bake`) on the buildbox, never `--workspace`; the bake itself runs offline, not on the laptop. The client side (Step 5) is JS-only and needs no rebuild.
- **TREE_DID source of truth**: the allowlist (task 02) must reach the bake; I take `--tree-dids @file` so the same JSON the client fetches (`tree-wind-manifest.json`) is generated from the same list — single auditable source. Open question: does it live in-repo (checked-in JSON) or get derived from a placement-frequency census (`landblock-census.rs`)? Recommend checked-in seed list + a census cross-check assertion in the determinism test.
- **Determinism of `f16` rounding**: ensure the f32→f16 path uses a single deterministic round-to-nearest-even helper (e.g. `half::f16::from_f32`), not a platform intrinsic, so two bakes byte-match (the determinism harness will catch regressions).
