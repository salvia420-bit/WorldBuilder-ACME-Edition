I now have a complete picture of the seam, the attach contract, eviction, and the bake/dist conventions. Here is my section.

---

## Assignment (02 — statics divert seam + TREE classification)

Map the two `statics.js` divert seams (`~1576-1585` per-LB baker, `~2081-2090` ring driver), specify the exact parallel `windTrees` peel mirroring the `defaultAnimationId` peel, and design the TREE_DID allowlist (storage, offline generation, auditability) — covering interaction with `consolidateStaticSingletons`, `InstancedMesh`, and `userData.landblockId` LRU.

## Findings (file:line)

**Two identical divert seams, both peel by `defaultAnimationId != 0`:**

- Per-LB baker `bakeStaticsForLandblock` — `statics.js:1575-1587`. After `let statics = landblockInfoStatics.concat(sceneryStatics)` (1575), the anim peel runs guarded by `animSceneryEnabled()` (1581), filters `anim = statics.filter(p => (p.defaultAnimationId>>>0||0)!==0)` into `animatedStatics`, then **rebinds** `statics = statics.filter(... === 0)` (1585) so the frozen path never sees them.
- Ring driver `bakeStaticsRing` — `statics.js:2080-2092`. Byte-identical block after `let statics = landblockInfoStatics.concat(sceneryStatics)` (2080).

**Where the peeled set is consumed (attach call sites):**

- Per-LB: `attachAnimatedScenery(scene3d, animatedStatics, wasmExports)` at `statics.js:1830`, inside the `try` that also runs `attachStaticDefaultScripts` (1828).
- Ring: same call at `statics.js:2364`, inside the `try` at 2362.

**Import seam:** `statics.js:89` — `import { attachAnimatedScenery, animSceneryEnabled } from "./animated_scenery.js";`

**The peel happens BEFORE the geometry pipeline in both paths**, which is exactly why it removes placements from every frozen route:
- Per-LB: `uniqueModelIds` is computed at `1600` from `statics` (post-peel); the singleton build loop runs `for (const placement of statics)` at `1694`; `consolidateStaticSingletons(addedNodes, ...)` runs at `1784` over only the nodes that loop built. A peeled DID never becomes an `addedNode` → never enters a `BatchedMesh`.
- Ring: `placementsByModel` is built `for (const placement of statics)` at `2184`; `isInstanced = group.length >= 2` (`2273`) decides `buildInstancedNode` (`2302`) vs `buildSingletonNode` (`2324`). A peeled DID never enters `placementsByModel` → never collapses into an `InstancedMesh`.

**Placement object shape** (what a wind attach receives) — `drainPlacements` (`statics.js:433-463`) and `fetchAndDrainScenery` (`552-567`): `{ landblockId, modelId, objId, x, y, z, qw,qx,qy,qz, rotationZ, isBuilding:false, scale, source:"landblockinfo"|"scenery", defaultScriptId, defaultAnimationId, sourceObjIdx? }`. `objId === modelId`; top byte `0x02` = SetupModel, `0x01` = GfxObj (`statics.js:477`).

**`consolidateStaticSingletons`** (`statics.js:1442-1492`): groups plain `Mesh` nodes by `userData.surfaceDid`, builds one `THREE.BatchedMesh` per surface, stamps `bm.userData = { landblockId, surfaceDid, __staticBatch:true }` (1482). **Only called on the per-LB path** (1784, gated `readStaticBatchFlag()`); the ring path adds `InstancedMesh`/`Mesh` straight to `staticsGroup`.

**LRU eviction** — `landblock_lru.js:241-258`: walks `staticsGroup.children`, kills any child whose `userData.landblockId` masks (`lbKeyOf`, line 33-34) to the evicted `lbKey`; disposes `BatchedMesh` GPU buffers. Cross-LB `InstancedMesh` nodes carry **no** `landblockId` and are skipped (240); they evict via the `coversLbKeys` refcount path (337-367). Animated-scenery nodes added to `staticsGroup` carry `userData.landblockId` (`animated_scenery.js:271`) → evicted by step 3 for free; the rAF then reclaims the orphaned instance slot (`animated_scenery.js:406-415`, `_isOrphaned` at 192-197).

**Sidecar/dist convention** (for allowlist storage option): scenery bakes emit `dist/scenery/0xLLLL.scenery.jsonl` + `.sha256` + `.scenery.materials.json` (`scenery-bake.rs:971-1022`); client fetches via `init_scenery_base_url` → `{base}/{lb_hex}.scenery.jsonl` (`lib.rs:2131, 2174`). There is no existing one-time global JSON manifest fetch in the JS boot path — base-url config is pushed in via `configureBakeWorker` (`bake_worker_client.js:151`).

## Concrete coding steps

### Step 1 — New gate module `scene3d/tree_wind.js` (JS-only, no rebuild)

Mirror the `animSceneryEnabled()` pattern (`animated_scenery.js:69-81`) but **default-OFF**. This module also owns the attach entry point (internals are tasks 01/03; this task wires the seam + flag + classification).

```js
// scene3d/tree_wind.js  (NEW)
let _treeWindFlag;
export function treeWindEnabled() {
  if (_treeWindFlag !== undefined) return _treeWindFlag;
  let on = false; // DEFAULT-OFF — non-retail enhancement (?treeWind=on). docs/url-flags.md.
  try {
    if (typeof window !== "undefined" && window.location)
      on = new URLSearchParams(window.location.search).get("treeWind")?.toLowerCase() === "on";
  } catch (_) { on = false; }
  return (_treeWindFlag = on);
}

// Allowlist membership — see Step 4. isTreeDid(modelId>>>0) -> bool.
export { isTreeDid } from "./tree_wind_dids.js";

// Attach entry (signature mirrors attachAnimatedScenery; impl from tasks 01/03).
// Builds per-part synthetic wind clips through the shared-mixer player.
export async function attachWindTrees(scene3d, placements, wasmExports, opts) { /* tasks 01/03 */ }
```

### Step 2 — Add the import (JS-only) — `statics.js:89`

```js
import { attachAnimatedScenery, animSceneryEnabled } from "./animated_scenery.js";
import { attachWindTrees, treeWindEnabled, isTreeDid } from "./tree_wind.js"; // ADD
```

### Step 3 — Parallel `windTrees` peel at BOTH seams (JS-only)

Insert immediately **after** the existing anim peel so the two sets are disjoint (the anim peel at 1585/2090 has already removed `defaultAnimationId != 0` placements — the pre-animated `0x02000493` foliage case is therefore claimed by `attachAnimatedScenery`, not by wind; that DID stays **out** of TREE_DID, no double-peel).

Per-LB — insert after `statics.js:1587`; Ring — after `statics.js:2092`. Identical block both places:

```js
  // Tree-wind (2026-06-23) — peel TREE placements out of the frozen
  // InstancedMesh/BatchedMesh path so attachWindTrees can sway them.
  // Runs AFTER the anim peel: `statics` here is already defaultAnimationId==0,
  // so wind + default-anim sets are disjoint. Flag DEFAULT-OFF → when off this
  // block is a no-op and `statics` is byte-identical to the frozen path.
  let windTrees = null;
  if (treeWindEnabled()) {
    const trees = statics.filter((p) => isTreeDid((p?.modelId >>> 0) || 0));
    if (trees.length > 0) {
      windTrees = trees;
      statics = statics.filter((p) => !isTreeDid((p?.modelId >>> 0) || 0));
    }
  }
```

Because this rebinds `statics` before `uniqueModelIds` (1600 / 2109), peeled tree DIDs never reach `groupsByModel`, `placementsByModel`, `buildInstancedNode`, `buildSingletonNode`, or `consolidateStaticSingletons`. No double-render, no special-casing inside those functions.

### Step 4 — Wire the attach call at BOTH consume sites (JS-only)

Per-LB — extend the `try` at `statics.js:1829-1831`:

```js
    if (animatedStatics) {
      await attachAnimatedScenery(scene3d, animatedStatics, wasmExports);
    }
    if (windTrees) {
      await attachWindTrees(scene3d, windTrees, wasmExports); // ADD
    }
```

Ring — same insert after `statics.js:2364`. `attachWindTrees` must mirror `attachAnimatedScenery`'s contract (`animated_scenery.js:314-360`): fail-soft if flag off / missing wasm exports, dedupe via a `placementKey` (`186`), cap via a `treeWindMax` flag, tag each node `userData = { landblockId: p.landblockId>>>0, isWindTree: true }`, add to `scene3d.staticsGroup` (or `opts.resolveParent`), and register with the shared-mixer rAF. This buys **LRU eviction for free** (step 3 of `landblock_lru.js` kills by `userData.landblockId`) and orphan-slot reclaim via the rAF (copy the `_isOrphaned` pattern, `animated_scenery.js:192-197, 406-415`).

### Step 5 — TREE_DID allowlist data + module (committed JSON, auditable)

**Where it lives:** ship it **in-repo, in the bundle** as `scene3d/tree_wind_dids.js` — a generated ES module exporting a `Set` + an annotated table. Rationale over a fetched/baked sidecar: (1) the set is tiny (tens of DIDs), so a network fetch + the boot-ordering plumbing that `init_scenery_base_url` needs is unjustified; (2) committing it makes every classification decision a **reviewable git diff** (the auditability requirement); (3) JS-only, no wasm rebuild, no dist-symlink dependency. A `?treeWindDids=0x..,0x..` URL override and a future baked-sidecar merge can layer on later without moving the default.

```js
// scene3d/tree_wind_dids.js  (GENERATED — do not hand-edit; see tools/tree-wind-classify)
// Each row is auditable: did, placements (scenery freq), parts, bboxH (m), reason.
export const TREE_WIND_DIDS = [
  { did: 0x02001063, placements: 317000, parts: 3, bboxH: 1.25, reason: "fern/shrub: top freq, low cluster" },
  { did: 0x020007A2, placements: 236000, parts: 6, bboxH: 1.30, reason: "shrub: multi-part low cluster" },
  { did: 0x02000246, placements: 232000, parts: 5, bboxH: 22.0, reason: "tree: tall multi-part" },
  // 0x02000406 / 0x02000407 → evaluated, EXCLUDED (1-part, no canopy) — kept in audit log, not here.
  // 0x02000493 → EXCLUDED: has default_animation, already handled by attachAnimatedScenery.
  // ...
];
const _set = new Set(TREE_WIND_DIDS.map((r) => r.did >>> 0));
export function isTreeDid(modelId) { return _set.has((modelId >>> 0)); }
```

**Generated offline (OFFLINE-BAKE)** by a small classifier — a subcommand of the scenery bake or a standalone `tools/tree-wind-classify` reading `client_portal.dat` (it runs on the buildbox, not the 8GB laptop — coordinate with task 10's bake tool). Two-signal rule, both already in ESTABLISHED facts so no new DAT parsing is invented:

1. **Frequency:** count scenery placements per `objId` across all landblocks (the same enumeration `scenery-bake.rs` already walks, `scenery-bake.rs:1053+`). Keep only DIDs above a placement threshold (forest-scale only).
2. **Shape:** load the SetupModel (`0x02`), require it be a SetupModel (not a `0x01` GfxObj), then use the **per-part vertex bbox** (the Phase-0 finding) — classify as `tree` when it is multi-part with a vertical span (canopy/trunk parts) OR a low broad multi-part cluster (shrub/fern). Exclude 1-part flat models with no vertical extent (rocks) and exclude any DID with non-zero `default_animation` (already animated).

Emit both `tree_wind_dids.js` (consumed) and `tree-wind-classify.audit.json` (full per-DID metrics + accept/reject reason + threshold used) committed alongside, plus a `.sha256` matching the existing bake convention (`scenery-bake.rs:984-994`). The audit JSON is the human-review artifact; a reviewer reads the diff, not the binary.

**Maintenance loop:** re-run classifier when DATs change → regenerate both files → PR diff shows exactly which DIDs entered/left the forest-wind set and why.

### Step 6 — Diag counter (JS-only)

Add `windTreesDiag()` to `tree_wind.js` mirroring `animatedSceneryDiag()` (`animated_scenery.js:449-460`): `{ instances, didGroups, peeledPerLb, droppedOverCap }`, surfaced on `window.__diag` for the batched 1070 eye-test (task 15).

## Risks & open questions

- **Double-peel / disjointness.** Ordering is load-bearing: the wind peel must run *after* the anim peel (so `statics` is already `defaultAnimationId==0`) and TREE_DID must exclude any default-anim DID (e.g. `0x02000493`). Mitigation: keep both invariants encoded in the classifier (exclude non-zero `default_animation`) and assert disjointness in a unit test (task 15). Rollback: flag off → both peels gone → frozen path byte-identical.
- **Forest scale vs the 512 cap.** The per-part player caps at 512 (`animated_scenery.js:43, 336`); one tree DID has 317k placements. The peel as written hands the *full* ring's tree placements to `attachWindTrees`, which will silently drop everything over cap. Mitigation: `attachWindTrees` must apply the near-field distance gate at peel/attach time (LOD — task 13) and **`log()` the dropped count** (no silent truncation). Phase 1 is explicitly near-field only; the bulk forest is the VAT/shader route (tasks 05/06) which does **not** go through this peel. Open question: should the peel itself be distance-filtered, or should attach own the cull? Recommend attach owns it (keeps the seam dumb).
- **Ring re-bake duplication.** Tree DIDs recur across many LBs and across ring re-bakes; `attachWindTrees` must dedupe by `placementKey` (`animated_scenery.js:185-187, 335`) exactly like the anim path or it will rebuild duplicates after each LRU churn.
- **LRU correctness.** Confirmed wind nodes get evicted *only if* each carries `userData.landblockId` (per-placement, not the model's). Risk: if a future "merge all trees in an LB into one node" optimization lands, the single node needs a `coversLbKeys` set instead (the `InstancedMesh` pattern, `statics.js:1216-1218`). For Phase 1 (one node per placement) the simple `landblockId` tag is correct.
- **Allowlist staleness.** A committed list can drift from the DATs. Mitigation: the `.sha256` over the source DATs in the audit file flags "DATs changed, reclassify needed" (same guard as `scenery-bake.rs:1001-1003`).
- **Classifier threshold tuning.** The frequency cutoff and bbox shape rule are heuristics; first pass may admit a rock or miss a rare tree. Mitigation: the audit JSON makes every borderline call visible for manual override before merge; a `?treeWindDids=` URL flag lets eye-testers spot-add a DID without a rebuild.
