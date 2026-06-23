I now have the full picture: the function body (adapter.js:707-830), the non-indexed buffer layout, the write loop, the `setAttribute` calls, the coordinate space (AC Z-up object-local, confirmed by adapter.js:1281-1283 / statics.js:102-103), and the downstream BatchedMesh merge that fail-softs on attribute-layout mismatch (statics.js:1460-1478). Here is my deliverable.

---

## Assignment (Task 04 — adapter vertex attribute)

Read `scene3d/adapter.js meshToGeometryGroups` fully and specify exactly how to add a per-vertex `windWeight` float attribute (and optional `segmentId`/`aVertexId`): the buffer allocation, the per-tri-vertex write, and the `geom.setAttribute` call. Decide JS-post-pass vs a wasm-side field, give the JS-only version (preferred — no rebuild). Note how `vertexId` (`gl_VertexID` over the non-indexed stream) is available for the VAT route. This attribute feeds the shader (task 05) and VAT (task 06) routes.

## Findings (file:line)

- **`meshToGeometryGroups(wasmMesh, opts)`** is `adapter.js:707-830`. It is the single chokepoint both bulk-forest and per-part-tree geometry flows through:
  - Statics/forest path: `statics.js:655` (`const { groups } = meshToGeometryGroups(m)`) and `statics.js:817`.
  - Per-part animated-scenery path: `statics.js:3017` (`const { groups, surfaceDids } = meshToGeometryGroups(wasmMesh)`), feeding `fetchBuildingPlacement` → `attachAnimatedScenery`.
  - So **one edit here lights up both the shader route (task 05) and the VAT/per-part routes (tasks 03/06).**
- **Source layout (non-indexed triangle soup)** — `adapter.js:725-729`:
  - `positions` `Float32Array`, `len = triCount * 9` (x,y,z × 3 verts).
  - `uvs` `Float32Array`, `len = triCount * 6`.
  - `normals` `Float32Array`, `len = triCount * 9` (per-vertex since T6).
  - `surfaceIndices` `Uint8Array`, `len = triCount`.
- **Bucketing** by `surfaceIndex` (or `(surfaceIndex,cullMode)` under `?perPolyCull`) at `adapter.js:755-766` — note this **reorders/partitions vertices per surface group**, which is the key gotcha for a global `vertexId` (see VAT note).
- **Per-group allocation** — `adapter.js:779-781`: `groupPositions = new Float32Array(n*9)`, `groupUvs = new Float32Array(n*6)`, `groupNormals = new Float32Array(n*9)` where `n = triIndices.length`.
- **Per-tri-vertex write loop** — `adapter.js:783-799`. Inner `d`-loop reads source vertex `sv = order[d]`, where `order` is `[0,1,2]` (double-sided) or `[0,2,1]` (single-sided winding reverse, `adapter.js:777`). **Any new per-vertex attribute must be written inside this same `d`-loop using the same `sv` reorder**, or it desyncs from position on single-sided groups.
- **`setAttribute` calls** — `adapter.js:802-813`: `position` (itemSize 3), `uv` (2), `normal` (3), then `computeBoundingSphere()` at 814.
- **Coordinate space**: positions are AC **object-local, Z-up** (height = component index 2). Confirmed by `adapter.js:1281-1283` ("authored in AC coords (Z-up, +Y north)", rotated to Y-up only at render via `worldRoot.rotation.x = -π/2`) and `statics.js:102-103`. So `windWeight` derived from the **Z component (`*3 + 2`)** is the correct height axis, computed in the same frame the buffer already lives in.
- **Downstream BatchedMesh merge gotcha** — `statics.js:1455-1478`: `consolidateStaticSingletons` builds one `THREE.BatchedMesh` per `surfaceDid` and calls `bm.addGeometry(m.geometry)` (1470). BatchedMesh locks an attribute layout from the first geometry; a geometry whose attribute set differs **throws and fail-softs to a standalone Mesh** (1474-1477). Implication: `windWeight` must be present **consistently across every geometry in a given batch** — which is why it should be gated to the *wind* path (peeled out by task 02) and applied uniformly there, never sprinkled onto a subset of an existing forest batch.
- **Buffer-copy invariant** — `adapter.js:3-8`: never hand a wasm view to a BufferAttribute. The new attribute is computed JS-side into a fresh `Float32Array`, so it's safe by construction; reading `positions` for the bbox pre-pass is fine because it stays inside this synchronous function (no wasm allocation between the read and use).

## Concrete coding steps

### Step 1 — JS-only `windWeight` attribute in `meshToGeometryGroups` *(JS-only, no rebuild — PREFERRED)*

**Decision: JS-post-pass, not a wasm field.** `windWeight` is a pure function of vertex Z over the model bbox — no DAT data is needed, so a wasm-side field would force a gated rebuild on the 8GB OOM box for zero benefit. The wasm side already emits everything required (`positions`). Keep it JS.

**1a. Gate + bbox pre-pass.** After the snapshot block (`adapter.js:725-729`), before bucketing (before line 755), insert:

```js
// Task 04: optional per-vertex wind weight (JS-only; default off so the
// frozen forest path pays nothing). Normalized vertex height over the
// model bbox, optionally curved. Z is component index 2 (AC Z-up).
const wantWind =
  (opts && opts.windWeight) ||
  (typeof globalThis !== "undefined" && globalThis.__treeWind === true);
let zMin = Infinity, zMax = -Infinity;
if (wantWind) {
  // Prefer a caller-supplied MODEL-WIDE bbox so per-part calls (statics.js
  // :3017) normalize against the whole tree, not the part. Co-located part
  // origins mean a canopy part's local Zmin is NOT 0 — using its own bbox
  // would zero-out its weight. Fall back to this stream's bbox.
  if (opts && opts.windBBox) {
    zMin = opts.windBBox.zMin; zMax = opts.windBBox.zMax;
  } else {
    for (let k = 2; k < triCount * 9; k += 3) {
      const z = positions[k];
      if (z < zMin) zMin = z;
      if (z > zMax) zMax = z;
    }
  }
}
const zSpan = zMax - zMin > 1e-6 ? zMax - zMin : 1;
```

**1b. Allocate the per-group buffer** alongside the existing three at `adapter.js:781`:

```js
const groupWind = wantWind ? new Float32Array(n) : null; // itemSize 1, per-vertex
```

**1c. Write inside the same `d`-loop** (`adapter.js:788-798`), using the same reordered source vertex `sv` so it stays in lockstep with position on single-sided groups:

```js
if (groupWind) {
  const z = positions[pSrc + sv * 3 + 2];        // AC Z-up height
  let w = (z - zMin) / zSpan;                      // 0 at trunk base → 1 at canopy top
  if (w < 0) w = 0; else if (w > 1) w = 1;
  // Curve so the base is stiff and the canopy bends most (task 05 wants
  // ~quadratic). Keep it here so the shader stays a plain multiply.
  groupWind[i * 3 + d] = w * w;
}
```

(Index is `i*3 + d` because there are 3 verts per tri and itemSize is 1 — distinct from the `i*9 + d*3` stride used for the 3-wide position/normal buffers.)

**1d. `setAttribute`** after the existing three at `adapter.js:813`:

```js
if (groupWind) {
  geom.setAttribute("windWeight", new THREE.BufferAttribute(groupWind, 1, false));
}
```

The shader (task 05) reads it as `attribute float windWeight;`. No change to `position`/`uv`/`normal` or to the FALLBACK / per-poly-cull branches — `windWeight` is orthogonal to surface and winding.

### Step 2 — caller wires `opts.windWeight` + model bbox on the wind path *(JS-only)*

In the wind peel (task 02's `attachWindTrees` / wind-batch builder), call `meshToGeometryGroups(m, { windWeight: true, windBBox })`. Compute `windBBox` once per model from the full `positions` stream (or reuse the bbox task 03 already derives for the base-pivot rig — they want the same Zmin/Zmax, so compute once and pass to both). For the per-part call at `statics.js:3017`, pass the **model-wide** `windBBox` (not the part's), per the co-located-origin caveat in the ESTABLISHED facts.

Because task 02 peels wind trees into their **own** batch, every geometry in that batch carries `windWeight` uniformly → `consolidateStaticSingletons` (`statics.js:1464-1478`) merges them without the layout-mismatch fail-soft. Do **not** set `windWeight` on the frozen forest path (flag-off must be byte-identical to today).

### Step 3 — optional `segmentId` for the bbox rig / coarse bone bands *(JS-only)*

For Phase 1b (task 03) a cheap Z-band segment id is computable in the same loop without any skeleton lib — useful if task 05/06 want per-band phase offsets:

```js
// Optional: 0..(BANDS-1) height band, JS-only proxy for a bone index.
if (opts && opts.windSegments) {
  const BANDS = opts.windSegments | 0;            // e.g. 4
  const seg = Math.min(BANDS - 1, ((z - zMin) / zSpan * BANDS) | 0);
  groupSeg[i * 3 + d] = seg;                       // Float32Array(n), itemSize 1
}
```

with a matching `geom.setAttribute("segmentId", new THREE.BufferAttribute(groupSeg, 1, false))`. The *true* per-vertex `boneIndex`/weight from offline skeletonization (task 07) is **not** JS-computable here — it arrives as a sidecar `vertexId→bone` map and must be written using a stable `vertexId` (Step 4), not this band proxy.

### Step 4 — `aVertexId` for the VAT route *(JS-only, but order-critical)*

For VAT (task 06), the shader samples a texture row at `texelX = vertexId`. **`gl_VertexID` alone is unsafe here**: the bucketing at `adapter.js:755-766` partitions and (under single-sided) reverses vertices per surface group, so `gl_VertexID` within a group does **not** equal a stable model-global index, and per-group `gl_VertexID` resets to 0 each group. Two options:

- **Single-group case** (VAT bakes per whole-tree fused mesh, one material): `gl_VertexID` over the non-indexed stream is dense `0..(n*3-1)` and maps 1:1 to the VAT texel X — usable directly, no attribute needed.
- **Multi-surface case** (the real trees): assign an explicit **model-global vertex id BEFORE bucketing** so the VAT bake and the runtime agree. Add a counter keyed off the source triangle/vertex:

```js
// Stable, bake-matching vertex id. The VAT bake (task 06/10) MUST emit
// rows in this exact (sourceTri, vertexSlot) order: vid = t*3 + sv.
if (opts && opts.windVertexId) {
  groupVid[i * 3 + d] = t * 3 + sv;   // t = source tri index, sv = reordered slot
}
```

`geom.setAttribute("aVertexId", new THREE.BufferAttribute(groupVid, 1, false))`. The bake tool (task 10) iterates `for t in triCount { for sv in 0..3 { vid = t*3+sv } }` over the **same wasm `positions` stream**, guaranteeing texel alignment. Document this `vid = t*3 + sv` contract in both adapter.js and the bake tool so they can't drift.

### Step 5 — (do NOT do) wasm-side field *(needs-wasm-rebuild — rejected)*

A `wind_weight` field on the wasm `ModelMesh` would require editing `lib.rs` mesh emission and a gated `cargo build` (OOM risk per the 8GB constraint) for a value that is a trivial function of data already exported. **Skip.** Only revisit if a future need requires a weight that depends on DAT topology the JS side can't see (e.g. true skeleton bone weights baked into the model record) — and even then, prefer a sidecar over a wasm field.

## Risks & open questions

- **BatchedMesh layout consistency (highest risk).** If `windWeight` lands on only *some* geometries in a surface batch, `addGeometry` throws and fail-softs those props to standalone meshes (`statics.js:1474-1477`) — silent draw-call regression, not a crash. Mitigation: only ever set `windWeight` on the task-02-peeled wind batch, where it's uniform; never on the frozen forest. Verify in task 15's smoke that the wind batch count == expected and no unexpected standalone fallbacks appear in `__diag`.
- **Per-part vs per-model normalization (the co-located-origin shear, restated).** Parts share the ground origin but a canopy part's local Zmin ≠ 0. Normalizing per-stream at `statics.js:3017` would make every part bend from its own base → trunk and canopy bend identically (wrong). Mitigation: always pass `opts.windBBox` = model-wide Zmin/Zmax on the per-part path. Open question: do we want a *single* whole-tree weight, or per-part weight blended with the task-03 hinge? Recommend whole-tree `windWeight` for the shader route and let the player-route hinge (task 03) own per-part motion.
- **`vertexId` order drift between adapter and bake (VAT correctness).** The `vid = t*3 + sv` contract is fragile: any future change to the triangulation order in `lib.rs`, to the bucketing in `adapter.js:755-766`, or to the single-sided `order` reversal silently corrupts VAT sampling (verts read the wrong animation row → geometry explodes). Mitigation: pin the contract in a shared comment, and have the bake emit a small checksum (e.g. count + first/last position) the runtime asserts. Open question for task 06: bake per-fused-mesh (lets us use raw `gl_VertexID`, no attribute, no drift) vs per-surface (needs `aVertexId`) — the fused route is materially safer; flag the tradeoff to task 06.
- **Curve choice (`w*w`) is hard-coded.** The base-stiffness curve is baked into the attribute, so retuning means recomputing on the JS side. Cheap (no rebuild), but if task 05 wants a runtime-tunable exponent, store the **raw** `(z-zMin)/zSpan` in the attribute and move the curve into the shader. Recommend raw-in-attribute, curve-in-shader for tuning flexibility (`?treeWindStrength` etc.).
- **Extra memory per wind vert.** `windWeight` adds 4 bytes/vert; `segmentId`/`aVertexId` add 4 each. Negligible vs position+uv+normal (32 B/vert) and only on peeled wind geometry, but note it in the LOD budget (task 13).
- **Flag plumbing.** `globalThis.__treeWind` mirrors the existing `globalThis.__perPolyCull` pattern (`adapter.js:742`) — confirm task 14 sets it from `?treeWind` the same way `?perPolyCull` is wired, so the attribute is genuinely zero-cost when the flag is off.
