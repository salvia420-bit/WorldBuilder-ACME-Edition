I now have everything I need: the exact packer/parser struct layouts, the wire byte order, the client default-anim wiring, the resource-source model, and the player's flattened-animation contract. Here is the plan.

---

## Assignment (Task 09 — AC-native authoring path)

Design the **AC-native authoring path**: emit a synthetic multi-part `SetupModel` 0x02 (segmented parts from task 07) + a dense `Animation` 0x03 (absolute per-part frames from task 08) using `holtburger-dat-write` `pack/setup_model.rs` + `pack/animation.rs`. Confirm the exact struct fields to populate; specify how `default_animation` is wired so the existing client default-anim path plays it; decide **new DAT records vs JSONL sidecars**; state the **absolute-frame** (no-cascade) requirement and the **byte-round-trip** guarantees.

---

## Findings (file:line)

### A. The two writers and their structs

**`SetupModel`** struct — `crates/holtburger-dat/src/file_type/setup_model.rs:327-351`. Fields, in pack order:
- `id: u32`, `flags: u32`
- `parts: Vec<u32>` — GfxObj 0x01 part DIDs (one per part)
- `parent_index: Vec<u32>` — present **iff** `flags & 0x01` (HasParent)
- `default_scale: Vec<Vector3>` — present **iff** `flags & 0x02` (HasDefaultScale)
- `holding_locations / connection_points: HashMap<i32, LocationType>`
- `placement_frames: HashMap<i32, PlacementType>` (a `PlacementType` is an `AnimationFrame` = one `Frame` per part + hooks; `setup_model.rs:310-325, 276-280`)
- `cyl_spheres / spheres`, `height/radius/step_up/step_down: f32`, `sorting_sphere/selection_sphere: Sphere`, `lights: HashMap<i32, LightInfo>`
- **Trailer (5 × u32):** `default_animation, default_script, default_motion_table, default_sound_table, default_script_table : Option<u32>`

**`SetupModel::pack`** — `setup_model.rs:482-565`. Writes `id`, `flags`, `parts.len() as u32` + parts, `parent_index` (only if flag 0x01), `default_scale` (only if flag 0x02), each dict as `len as u32` + **sorted** keys, `placement_frames` count as **`i32`** (`:519`), spheres/scalars, lights, then the trailer where each `Option` is `unwrap_or(0)` (`:553-562`). **HashMap keys are sorted before write** (`:504, :512, :520, :546`) → output is deterministic regardless of insertion order (good for bake determinism, no Date/Random needed).

**`DatPack for SetupModel`** guard — `crates/holtburger-dat-write/src/pack/setup_model.rs:52-106`. `HAS_PARENT (0x01)` ⇒ `parent_index.len()==parts.len()` else empty; `HAS_DEFAULT_SCALE (0x02)` ⇒ `default_scale.len()==parts.len()` else empty. Violations → `WriteError::InvariantViolation` (fail-closed, before bytes).

**`Animation`** struct — `crates/holtburger-dat/src/file_type/animation.rs:15-23`:
- `id: u32`, `flags: AnimationFlags` (only bit defined: `POS_FRAMES = 0x1`, `:8-13`; unknown bits retained via `from_bits_retain`, `:33`)
- `num_parts: u32`, `num_frames: u32`
- `pos_frames: Vec<Frame>` — present iff `POS_FRAMES`; length must == `num_frames`
- `part_frames: Vec<AnimationFrame>` — length must == `num_frames`; **each** `AnimationFrame.frames.len()` must == `num_parts`

**`Animation::write`** — `animation.rs:86-151`. Order: `id`, `flags.bits()`, `num_parts`, `num_frames`, `[pos_frames if POS_FRAMES]`, then per frame `AnimationFrame::write` = `num_parts` Frames + `hook_count u32` + hooks (`setup_model.rs:298-307`). Self-validates the three count invariants (`:92-131`).

**`DatPack for Animation`** guard — `pack/animation.rs:43-94`: same three count checks → `InvariantViolation`.

### B. Wire byte layout of a `Frame` (the atom both writers emit)

`Frame` = `origin: Vector3` then `orientation: Quaternion` (`crates/holtburger-dat/src/graphics.rs:11`). `Vector3 = {x,y,z}` LE f32 (`holtburger-common/src/math.rs:7-11`); `Quaternion = {w,x,y,z}` LE f32 (`math.rs:120-125`). So one Frame on the wire = **28 bytes** = `[ox, oy, oz, qw, qx, qy, qz]` — exactly the order `fetchAnimation` flattens (`apps/holtburger-web/src/lib.rs:43146-43152`) and `buildSceneryAnimationClip` reorders wxyz→xyzw (`scene3d/animated_scenery.js:141-149`). **The authored quaternion must be stored wxyz.**

### C. Byte-round-trip guarantees (already tested)

- SetupModel idempotence + with parent/scale: `pack/setup_model.rs:156-198` (`pack→unpack→pack` byte-equal).
- Animation idempotence: `pack/animation.rs:150-186`.
- Animation **exact inverse of retail bytes**: `animation.rs:257-269` (`pack(unpack(bytes)) == bytes`), incl. unknown-flag-bit preservation (`:271-291`).

⇒ An authored record, once written, re-parses to itself, and any record *derived from* retail bytes reproduces them exactly. **An authored `Animation` 0x03 is a first-class AC DAT record** — it could be injected into a real `client_portal.dat` and a retail/desktop client would play it.

### D. How the client default-anim path consumes this today

1. **Setup parse stamps the placement** — `lib.rs:1756-1782` (landblock objects) and `lib.rs:2506-2564` (scenery path): live `SetupModel::unpack`, and `if let Some(da) = setup.default_animation { p.default_animation_id = da }`. **This is the only thing that turns the path on** — `default_animation_id != 0`.
2. **statics.js peels** placements with `defaultAnimationId != 0` out of the frozen BatchedMesh and calls `attachAnimatedScenery` (`animated_scenery.js:307-321`).
3. **Player** — `getOrCreateDidGroup(animId)` keys the shared mixer/template by `animId` and calls `wasmExports.fetchAnimation(animId)` (`animated_scenery.js:204-237`); `buildOne` uses `setupId` (`p.objId`) + `animId` and `fetchBuildingPlacement(setupId)` for the per-part meshes (`:245-259`).
4. **`fetchAnimation`** — `lib.rs:43127-43161`: resolves the 0x03 from `ResourceKey::new("eor/portal", did)`, flattens to `numParts*numFrames*7` floats `[oxyz, qwxyz]`. `AnimationJs` carries `numParts/numFrames/flags/frames` — **no fps** (`lib.rs:43090` comment: JS picks `animSceneryFps()`).
5. **`fetchBuildingPlacement`** — `lib.rs:9818-9846`: triangulates `setup.parts` GfxObjs into per-part meshes and reads `compute_hinge_frames` from `placement_frames[0]` (`:9840, 9848-9877`). ⇒ **the authored SetupModel's `parts` must reference real tree GfxObj DIDs and its `num_parts` must equal the Animation's `num_parts`.**

### E. The delivery substrate

The client resource source is a **manifest-based `ManifestResourceSource`** (`apps/holtburger-web/src/global_source.rs:1-70`), built offline by `dat2hba` (`apps/holtburger-tools/src/bin/dat2hba.rs`). `fetchAnimation`/`fetchBuildingPlacement` read only from this **single, global, init-time** source — there is **no runtime overlay-DAT layering**, and it is fetched by `init_resource_source` *before* any `?treeWind` flag is known. Sidecars are delivered through a **separate** HTTP base set by `init_scenery_base_url` (`lib.rs:2131`), with `.sha256` siblings (`lib.rs:2334`) — the established convention for non-manifest bake artifacts.

There is **no** existing raw-bytes Animation parse export (`grep parseAnimation/from_bytes` → none for Animation). fetchAnimation is the only 0x03 entry point.

---

## The delivery decision: **sidecar + client-side `defaultAnimationId` override** (not manifest injection)

Injecting authored records into the manifest ("true new DAT records") is the *wrong* substrate for a flag-gated enhancement:

- The manifest is **global and not flag-gated** (loaded at `init_resource_source` before `?treeWind`). **Replacing** the retail tree DID's SetupModel so `default_animation` is set would alter retail-faithful frozen rendering for *everyone* — violates "off = frozen".
- **Adding** the synthetic setup under a *new* DID doesn't help: baked placements still reference the *retail* tree DID, so nothing wires up without a client-side DID remap anyway.
- Re-baking the whole manifest (`dat2hba`) for a wind feature couples to the boot/manifest pipeline and is heavy.

**Recommended:** keep the retail manifest untouched; author the records offline (dat-write is the **authoring + validation engine**), deliver via a sidecar under `dist/`, and wire on the client **only when `?treeWind=on`**:

- **Phase-1 (JS-only, no rebuild):** the bake emits a **flattened JSON** mirroring `AnimationJs` (`{numParts, numFrames, fps, frames:[oxyz,qwxyz...]}`). The client, for `model_id ∈ TREE_DIDS` (task 02), feeds that JSON straight to `buildSceneryAnimationClip` (task 01's synthetic-clip entry point) — **bypassing `fetchAnimation`/the manifest entirely**. The authored `.anim.bin` (DatPack bytes) is produced alongside as the source-of-truth + portability artifact, validated by round-trip.
- **Phase-2 (optional, one gated rebuild):** add a `parseAnimationBytes(Uint8Array) -> AnimationJs` wasm export that reuses the *exact* `Animation::read` + flatten of `lib.rs:43127-43161`, so the web client consumes the authored `.anim.bin` directly (proves parser parity).
- **Phase-3 (optional, full desktop AC-native):** inject `.setup.bin`/`.anim.bin` into a `client_portal.dat` via dat-write + re-`dat2hba` for a zero-code retail/desktop build.

This keeps the AC-native **authoring** path (your assignment) intact and DAT-portable, while the **web delivery** stays flag-gated and rebuild-free.

---

## Concrete coding steps

### Step 1 — Author the synthetic `Animation` 0x03 (OFFLINE-BAKE, Rust)

New module e.g. `apps/holtburger-tools/src/treewind/author.rs`, consumed by the task-10 bake binary. Takes task-08's **absolute, root-relative** per-(frame,part) frames.

```rust
use holtburger_common::{Quaternion, Vector3};
use holtburger_dat::file_type::{Animation, animation::AnimationFlags};
use holtburger_dat::file_type::setup_model::AnimationFrame;
use holtburger_dat::graphics::Frame;
use holtburger_dat_write::DatPack;

/// `abs[f][p]` = ABSOLUTE root-relative Frame of part p at frame f
/// (task 08 has ALREADY flattened the parent→child cascade — see §below).
fn build_wind_animation(anim_did: u32, num_parts: u32, abs: &[Vec<Frame>]) -> Animation {
    let num_frames = abs.len() as u32;
    let part_frames = abs.iter().map(|per_part| AnimationFrame {
        frames: per_part.clone(),   // length MUST == num_parts
        hooks: vec![],              // no sound/particle hooks for wind
    }).collect();
    Animation {
        id: anim_did,
        flags: AnimationFlags::empty(), // NO POS_FRAMES → base stays planted (no root motion)
        num_parts,
        num_frames,
        pos_frames: vec![],             // empty REQUIRED when POS_FRAMES clear (guard enforces)
        part_frames,
    }
}

// bytes for the .anim.bin DAT record (validated, byte-round-trippable):
let anim = build_wind_animation(anim_did, num_parts, &abs);
let anim_bytes = DatPack::pack(&anim).expect("count invariants hold"); // pack/animation.rs:26-32
```

- **`flags = empty()`** (not `POS_FRAMES`): trees must not translate; the base is planted. `pos_frames` empty is *required* by the guard (`pack/animation.rs:47-64`).
- **`num_parts` must equal the SetupModel `parts.len()`** and each `AnimationFrame.frames.len()` must equal `num_parts` (`pack/animation.rs:78-91`) — assert in the bake.
- Quaternions stored **wxyz** (`Quaternion{w,x,y,z}`), matching §B.
- **Dense sampling:** `num_frames` = `loop_seconds * fps` (e.g. 2–4 s × 30 fps = 60–120 frames). AC native playback floor-snaps (no interp) so density = smoothness; the JS player slerps so it tolerates fewer keys, but emit dense so the *same* record serves both. Make frame 0 == frame N (seamless loop) — task 08 owns the seam.

### Step 2 — Author the synthetic `SetupModel` 0x02 (OFFLINE-BAKE, Rust)

Clone the **retail** tree SetupModel, set only the `default_animation` trailer. For Phase-1b (retail part split, no re-segmentation) this is the minimal faithful authoring:

```rust
use holtburger_dat::file_type::SetupModel;

fn build_wind_setup(retail: &SetupModel, anim_did: u32) -> SetupModel {
    let mut s = retail.clone();
    s.default_animation = Some(anim_did);  // the ONLY change; trailer writes it (setup_model.rs:553-562)
    // flags untouched: trees are flag=0 (no parent_index, no default_scale) per ESTABLISHED facts,
    // so the guard's "empty when flag clear" holds (pack/setup_model.rs:70-103).
    // parts / placement_frames / spheres copied verbatim → fetchBuildingPlacement renders
    // identical geometry + identical hinge frames (placement_frames[0], lib.rs:9848-9877).
    s
}
let setup_bytes = DatPack::pack(&build_wind_setup(&retail, anim_did)).unwrap(); // pack/setup_model.rs:32-41
```

- **If task 07 re-segments** into *more* parts than retail, this clone is insufficient: you must also author new GfxObj 0x01 records and rebuild `parts` (and matching `placement_frames`/`default_scale`). That is a heavier path (new GfxObj packer + new DIDs); **scope Phase-1b to the retail part count** so `parts` is copied as-is and only the Animation is new. Flag the re-segmentation case as Phase-2.
- **Synthetic DID scheme** (deterministic, collision-free, documented non-retail): `anim_did = 0x03FE_0000 | (tree_did & 0x0000_FFFF)`, `setup_did = 0x02FE_0000 | (tree_did & 0x0000_FFFF)`. Reserve the `0x__FE____` band, document in `docs/url-flags.md` / a bake README, and have the bake assert no collision against the manifest catalog.
- For the **web** path the authored SetupModel is a validation/portability artifact only (the client keeps the retail setup and overrides `defaultAnimationId` in JS, Step 4). For the **desktop/manifest** path (Step 6) it is the live record.

### Step 3 — Emit bake outputs (OFFLINE-BAKE; coordinates with task 10)

Per tree DID under `dist/treewind/`:
- `0x03FExxxx.anim.bin` (+ `.sha256`) — `DatPack::pack(&anim)` bytes (AC-native, portable).
- `0x03FExxxx.anim.json` — `{ "animDid":…, "numParts":N, "numFrames":M, "fps":F, "frames":[…7*N*M…] }`, the **same flat `[oxyz,qwxyz]` layout** `fetchAnimation` produces (`lib.rs:43142-43154`) so `buildSceneryAnimationClip` consumes it unchanged. `fps` lives here because `AnimationJs` carries none.
- `0x02FExxxx.setup.bin` (+ `.sha256`) — for the desktop/manifest route (Step 6); not fetched by the web client.
- `treewind-manifest.json` — `{ treeDid → {animDid, setupDid, animUrl, numParts, fps} }` allowlist join (task 02 owns the allowlist; this adds the anim binding).

Determinism: packers sort dict keys (§A); task-08 phases derive from a hash of bone index, not `Math.random`/`Date` — so byte output is reproducible (mirrors `scenery-bake-determinism.rs`).

### Step 4 — Client wiring, Phase-1 (JS-ONLY, no rebuild)

In the statics.js wind peel (task 02), for `model_id ∈ TREE_DIDS` set `defaultAnimationId = treewind[treeDid].animDid` **client-side** (do **not** touch `setup.default_animation` in wasm — that keeps off==frozen). Then add a synthetic-clip entry in `animated_scenery.js` (task 01) that builds the DID group from the **JSON sidecar** instead of `fetchAnimation`:

```js
// animated_scenery.js — new path parallel to getOrCreateDidGroup (~:204)
async function getOrCreateWindDidGroup(animId, windClipJson) {
  const existing = _didGroups.get(animId);
  if (existing) return existing;
  const { numParts, numFrames, fps, frames } = windClipJson;     // from dist/treewind/*.anim.json
  const clip = buildSceneryAnimationClip(THREE, frames, numParts, numFrames, fps); // :125, unchanged
  // …identical template/mixer/clipAction setup as :221-235; one shared mixer per animId.
}
```

The DID-group key generalizes cleanly because it is just `animId` (`_didGroups` Map, `:101`) — synthetic `0x03FExxxx` keys never collide with retail keys, and all instances of one tree DID still share one mixer. **No wasm rebuild** — `frames` come from JSON, `meshes` still come from the existing `fetchBuildingPlacement(setupId)` over the retail setup.

### Step 5 — Optional AC-native consume on web (NEEDS-WASM-REBUILD, ~25 LOC)

Add next to `fetch_animation` (`lib.rs:43127`):

```rust
#[wasm_bindgen(js_name = parseAnimationBytes)]
pub fn parse_animation_bytes(bytes: Vec<u8>) -> Result<AnimationJs, JsValue> {
    use holtburger_dat::file_type::Animation;
    let anim = Animation::read(&mut std::io::Cursor::new(&bytes))
        .map_err(|e| JsValue::from_str(&format!("parseAnimationBytes: {e:?}")))?;
    // …identical flatten loop to lib.rs:43142-43160…
}
```

Lets the client fetch `0x03FExxxx.anim.bin` and run the **exact** parser → proves the authored record is valid AC. Gated rebuild (8 GB OOM ⇒ buildbox). Phase-1 does **not** need this.

### Step 6 — Optional full desktop AC-native (OFFLINE-BAKE)

Inject `.setup.bin` (with `default_animation` set) + `.anim.bin` into a `client_portal.dat` via dat-write, re-run `dat2hba` to a separate manifest, and serve that manifest only to a "treewind-native" build. Zero client code; the existing default-anim path (§D) fires unchanged. Byte-round-trip (§C) guarantees the injected records are retail-valid.

---

## The absolute-frame (no-cascade) requirement — restated for the writer

`CPartArray::UpdateParts` composes each part **flat**: `part_world = combine(model_root_frame, animframe[i])` — it does **not** walk `parent_index`. Therefore every `AnimationFrame.frames[p]` must be the **absolute, root-relative** transform of part `p`, with task-08's trunk→branch→twig cascade **already flattened** before it reaches `build_wind_animation`. Consequences for this writer:

- The authored `SetupModel.parent_index` can stay **flat / absent** (`flags=0`) — it is irrelevant to animation composition; copying retail (which is `-1`/absent) is correct.
- Do **not** store deltas-from-parent in `part_frames`; store world-of-root absolutes (origin = `parentR*childOrigin + parentOrigin`, `q = parentQ * childQ`, composed offline).
- Sanity assert in the bake: trunk/base parts show near-identity rotation, high-canopy parts show the largest; pivot is each part's vertex-Zmin base, not the shared origin (the co-located-origin shear gotcha lives in task 03/08, but a bad flatten surfaces here as a part swinging through a huge arc).

---

## Risks & open questions

| # | Risk | Mitigation / Rollback |
|---|------|----------------------|
| 1 | **`num_parts` mismatch.** `Animation.num_parts` ≠ `SetupModel.parts.len()` (or per-frame `frames.len()` ≠ `num_parts`) → `InvariantViolation` at pack, or wrong per-part track mapping in the player. | Bake asserts `anim.num_parts == setup.parts.len()` and every frame width. Phase-1b uses the **retail part count** (clone setup) so they can't drift. |
| 2 | **Re-segmentation needs new GfxObjs.** If task 07 splits a tree into more parts, cloning the retail setup is invalid — you must author GfxObj 0x01 records + rebuild `parts`/`placement_frames`. | Scope Phase-1b to retail part split (Animation-only). Defer geometry re-segmentation to Phase-2 (adds a GfxObj packer dependency). |
| 3 | **Accidental `POS_FRAMES`.** Setting the flag (or non-empty `pos_frames`) makes the whole tree translate / slide. | `flags = AnimationFlags::empty()`, `pos_frames = vec![]`; the guard (`pack/animation.rs:47-64`) fails closed if inconsistent. |
| 4 | **Quaternion order.** Storing xyzw instead of wxyz silently corrupts rotation. | `Quaternion{w,x,y,z}` (§B); the flat JSON keeps the `fetchAnimation` `[oxyz,qwxyz]` order so `buildSceneryAnimationClip`'s reorder (`animated_scenery.js:141-149`) is correct for both routes. |
| 5 | **Manifest injection breaks off==frozen.** Replacing retail records globally is not flag-gated. | Do **not** inject into the live manifest for web; override `defaultAnimationId` client-side under `?treeWind` (Step 4). Rollback = flag off → retail setup, `default_animation_id=0`, frozen. |
| 6 | **DID collision.** Synthetic `0x03FE/0x02FE` band colliding with retail. | Reserve + document the band; bake asserts absence in the manifest catalog. |
| 7 | **OOM on local pack.** `cargo build` of dat-write/tools on the 8 GB laptop. | The pack/author/bake runs on the **buildbox** (Step 1-3, 5, 6 all offline); Phase-1 client side is JS-only. |

**Open questions (hand to tasks 01/03):**
1. **Rest-pose composition.** Does the player combine `compute_hinge_frames` (= `placement_frames[0]`, `lib.rs:9848-9877`) with the per-frame anim transform additively, or does the anim frame fully replace it? This decides whether task-08's absolute frames must already fold in the rest pose or be relative to it. The authored `placement_frames` are copied verbatim from retail, so whichever convention the player uses, the rest pose is consistent — but task 08's frame space must match it. **Needs confirmation from the rAF copy loop.**
2. **fps source.** `AnimationJs` carries no fps (`lib.rs:43090`); the JSON sidecar must carry `fps` and the player must honor it (vs `animSceneryFps()` default). Confirm task 01's entry point reads `fps` from the JSON rather than the global flag, so AC floor-snap density and JS playback rate agree.
