I now have the complete picture: the full player, its test, both statics.js divert seams, the call sites, the cells.js interior `resolveParent` usage, and the placement field shape. Writing my structured deliverable.

---

# Task 01 — Deep-read of `scene3d/animated_scenery.js` + Phase-1a synthetic-clip wiring

## Assignment
Document the exact API/contract of the existing per-part keyframe player (`scene3d/animated_scenery.js`), then specify precisely how to feed a **synthetic** (JS-generated, no `fetchAnimation`/DAT) per-part wind clip through it for Phase 1a — the new entry point, how the shared-DID-group keying generalizes to a synthetic clip id, and how instances keep sharing one mixer.

---

## Findings (file:line)

### Module-level state (the whole player is module-singleton, not per-scene)
- `external/holtburger/apps/holtburger-web/scene3d/animated_scenery.js:101` — `const _didGroups = new Map()`: the **only** keyed registry. Key today = `animId` (a number). Value = `{ mixer, template, parts:[Group], numParts, refCount }`. **`Map` allows any key type — a string synthetic key drops in with zero structural change.**
- `:103` — `const _instances = []`: live instance records `{ node, parts:[Group], animId, key }`. One shared array; **one shared rAF**.
- `:104` — `const _builtKeys = new Set()`: dedupe across ring re-bakes, keyed by `placementKey(p)`.
- `:363-364` — diag counters `_tickCalls`, `_lastDt`. `:369-371` — rAF state `_rafId/_rafLastMs/_rafDisposed`.

### Flag pattern (the template to mirror for `?treeWind`)
- `:70-81` `animSceneryEnabled()`: memoized into `_animSceneryFlag`; reads `URLSearchParams.get("animScenery")`; **default-ON**, `=off` escape (`?.toLowerCase() !== "off"`). Wrapped in try/catch → default `true`.
- `:45-54` `_numFlag(name, def, min)`: generic numeric URL-flag reader. `:56-59` `maxAnimated()` (→`animSceneryMax`, default 512), `:61-67` `tickRadiusSq()` (→`animSceneryRadius`, default 140 m, 0 = no cull → `Infinity`), `:84-96` `animSceneryFps()` (→`animSceneryFps`, default 30).

### `buildSceneryAnimationClip(THREE_, frames, numParts, numFrames, fps)` — `:125-157` (EXPORTED, pure, unit-tested)
- **Input contract:** `frames` = flat `Float32Array`/`number[]`, **frame-major then part-major, 7 floats per (frame,part)**: `[origin.x, origin.y, origin.z, quat.w, quat.x, quat.y, quat.z]`. Index into part `p`, frame `f`: `base = (f*numParts + p) * 7` (`:137`).
- **Validation** (`:126-128`): returns `null` if `!frames || numParts<=0 || numFrames<=0 || frames.length < numParts*numFrames*7`. → soft-degrade to frozen.
- **Output:** one `VectorKeyframeTrack("part{p}.position", times, …)` + one `QuaternionKeyframeTrack("part{p}.quaternion", …)` per part. Times = `f/fps` (`:130-131`). **Quaternion reorder AC wxyz → THREE xyzw** at `:145-149`. Clip name `"scenery-default-anim"`, duration `max(dt,(numFrames-1)*dt)` (`:155-156`).
- **Track targets:** child objects named `part0`, `part1`, … under the mixer root. This naming is the entire coupling between clip and template.
- **This function is format-agnostic** — it does not know or care whether `frames` came from `fetchAnimation` or a JS generator. **It is the reuse linchpin for Phase 1a: a synthetic generator only has to emit the same flat 7-float layout.**

### `getOrCreateDidGroup(animId, wasmExports)` — `:204-237` (the part to fork)
- Cache hit → returns existing (`:205-206`). Else `await wasmExports.fetchAnimation(animId)` (`:209`) → `{numParts, numFrames, frames, free?}`. `anim.free?.()` at `:217`.
- Builds clip (`:219`), a **non-rendered** `template` Group with N child `partI` Groups (`:221-229`), one `AnimationMixer(template)` with `clipAction(clip)` `LoopRepeat/Infinity`, `.play()` (`:230-233`).
- Stores `{ mixer, template, parts, numParts, refCount: 0 }` in `_didGroups` (`:234-235`).
- **The ONLY DAT-specific lines are `:209` (`fetchAnimation`) and `:214-218` (unpack).** Everything from `:219` down is generic and reusable.

### `buildOne(p, wasmExports, materialCache, spFetch)` — `:245-303`
- `setupId = p.objId ?? p.obj_id ?? p.modelId` (`:246`); `animId = p.defaultAnimationId` (`:247`). Bails if either 0.
- Calls `getOrCreateDidGroup(animId)` **first** (`:250`) — for the DAT path the clip is independent of the mesh, so anim is fetched before mesh.
- `fetchBuildingPlacement(setupId)` (`:255`) → `bundle` with `partCount`, `takePartMeshes()` (`:262`), `takePartHingeFrames()` (`:263-264`, optional). **Confirms the per-part mesh + per-part rest-hinge surface trees can reuse with zero new exports.**
- Builds instance `node` (Group), tags `node.userData = { landblockId, isAnimatedScenery:true }` (`:271`) — **the LRU evict hook**. `placeNode(node,p)` (`:272`).
- Per part: a `partI` subgroup, sets **rest hinge** local pos/quat from `hinge[i]` (`:278-282`), builds meshes via `meshToGeometryGroups` + `materialCache.get(sid)` (`:286-292`).
- Returns `{ node, parts, animId }`.
- **Critical ordering subtlety:** the synthetic clip depends on the SetupModel's part count (and, for 1b, its bbox), so the wind variant must call `fetchBuildingPlacement` **before** creating its group — the reverse of `buildOne`'s order (`:250` before `:255`).

### `attachAnimatedScenery(scene3d, placements, wasmExports, opts)` — `:314-360` (EXPORTED entry)
- Gates: `animSceneryEnabled()` (`:315`); requires `scene3d.staticsGroup`, array, wasm (`:316`); requires `fetchAnimation` + `fetchBuildingPlacement` exist (`:317-320`) → soft-degrade to frozen on pre-rebuild pkg.
- **Filter:** `placements.filter(p => (p.defaultAnimationId>>>0) !== 0)` (`:321`). This is the divert predicate — trees (`defaultAnimationId === 0`) are invisible to this function.
- `_rafDisposed = false` re-arm (`:323`). `materialCache = getOrCreateMaterialCache(scene3d)` (dynamic import of statics.js, `:326-327`). `spFetch` (`:329`).
- **Cap + dedupe loop** (`:333-354`): skip if `_builtKeys.has(key)` (`:335`); **drop if `_instances.length >= maxAnimated()` (512)** (`:336`); else `buildOne` → on success `resolveParent(p) || scene3d.staticsGroup` `.add(node)`, bump `g.refCount` (`:347`), push instance, `_ensureRaf()` (`:349`). On failure delete the key to allow retry (`:352`).
- `opts.resolveParent(item)` (`:325`) chooses parent Group — cells.js passes the cell container (`scene3d/cells.js:895-896`) so interior props inherit cell visibility + eviction.

### The rAF copy loop — `_ensureRaf()` `:382-428` (the engine; fully clip-source-agnostic)
- Self-clocked off `performance.now()` (`:372-375, 389`), `dt` clamped `0..0.1s`.
- **Advance each shared mixer ONCE** (`:394-396`) — cost = number of `_didGroups`, not number of instances.
- Distance cull: reads camera from `window.liveScene3d` (`:401-404`); instances beyond `tickRadiusSq()` are skipped (frozen) (`:416`).
- **Per-instance copy** (`:418-423`): `inst.parts[j].position/quaternion.copy(g.parts[j]…)` for `j < min(g.parts.length, inst.parts.length)`. **This OVERWRITES the instance part's local transform every frame — the rest hinge set in `buildOne:278-282` is dead once the rAF runs.** ⇒ **the clip's per-part frames must be ABSOLUTE root-relative (hinge already baked in).** (For trees hinge ≈ identity since all parts share origin with parent −1, so synthetic frames = pure sway-about-base.)
- **Orphan reclaim / LRU** (`:408-415`): `_isOrphaned(node)` (`:192-197`, "top ancestor isn't the live Scene") → dispose geometries, drop `_builtKeys` entry, splice, `--g.refCount`, and `_disposeDidGroup` when it hits 0 (`:376-381`). No separate LRU — it piggybacks on staticsGroup/cell-container removal.

### Manual driver + diag + dispose
- `:432-446` `tickAnimatedScenery(dt)` — EXPORTED; advances all mixers + copies onto **all** instances (no dist cull). **Source-agnostic → drives synthetic groups in headless unit tests too.**
- `:449-460` `animatedSceneryDiag()` — `{instances, didGroups, tickCalls, lastDt, maxMixerTime, rafArmed}`.
- `:463-481` `disposeAnimatedScenery()` — tears down rAF, all instances, all groups, clears the 3 collections.

### Hook points outside the player
- Divert seams: `scene3d/statics.js:1581-1587` (per-LB) and `:2086-2092` (ring) peel `defaultAnimationId != 0` out of `statics`; attach calls at `:1830` and `:2364`. Interior: `scene3d/cells.js:895`.
- Placement shape (from `drainPlacements`/scenery drain, `statics.js:435-461, 547-566`): `modelId` (= SetupModel DID, top byte 0x02 for trees), `objId` (alias), `defaultAnimationId`, `landblockId`, `x/y/z`, `qw/qx/qy/qz`, `rotationZ`, `scale`, `sourceObjIdx`, `worldFrame`. **A tree filter keys on `p.modelId`.**

---

## Concrete coding steps (Phase 1a — all **JS-only, no wasm rebuild**)

The design: **reuse the player core verbatim** (`_didGroups`, `_instances`, `_builtKeys`, `_ensureRaf`, the rAF copy loop, orphan reclaim, dist cull, dispose, and `buildSceneryAnimationClip` unchanged). Add only a second **front door** that (a) builds synthetic groups and (b) builds tree instance nodes. The rAF loop is already source-agnostic, so it animates synthetic groups for free.

### Step 1 — Add the `?treeWind` flag (JS-only) — mirror `animSceneryEnabled`
File: `scene3d/animated_scenery.js`, insert after `:81`.
```js
let _treeWindFlag;
export function treeWindEnabled() {
  if (_treeWindFlag !== undefined) return _treeWindFlag;
  let on = false; // default-OFF — NON-RETAIL enhancement (?treeWind=on to enable).
  try {
    if (typeof window !== "undefined" && window.location) {
      on = new URLSearchParams(window.location.search)
        .get("treeWind")?.toLowerCase() === "on";
    }
  } catch (_) { on = false; }
  _treeWindFlag = on;
  return on;
}
```
Note the inversion vs `animScenery`: default-OFF, opt-in `=on`. (Tuning flags `?treeWindStrength`/`?treeWindDir` via `_numFlag` are task 12's surface; reuse `_numFlag` as-is.)

### Step 2 — Synthetic per-part wind clip generator (JS-only, pure, unit-testable)
File: `scene3d/animated_scenery.js` (new exported pure fn, near `buildSceneryAnimationClip`).
```js
// Produce the SAME flat layout buildSceneryAnimationClip consumes
// (frame-major, part-major, 7 floats [ox,oy,oz, qw,qx,qy,qz]) — ABSOLUTE
// root-relative per-part frames (hinge baked in; for trees hinge≈identity).
// rig[p] = { pivot:{x,y,z}, weight, axis:{x,y,z} } from task 03 (Phase 1b).
// For Phase 1a (SHORT foliage) pivot may be omitted → rotate about origin
// (z=0 ground ≈ the part base for low shrubs/ferns, so shear is negligible).
export function buildProceduralWindClip(numParts, rig, windParams, numFrames, fps) {
  const { dir = {x:1,y:0}, strength = 0.12, freq = 0.6, flutter = 3.0 } = windParams || {};
  const out = new Float32Array(numParts * numFrames * 7);
  const _q = new THREE.Quaternion(), _axis = new THREE.Vector3();
  const _o = new THREE.Vector3(), _piv = new THREE.Vector3(), _rp = new THREE.Vector3();
  for (let f = 0; f < numFrames; f++) {
    const t = f / fps;
    for (let p = 0; p < numParts; p++) {
      const r = rig?.[p] || {};
      const w = (r.weight ?? 1);
      // sway angle: low-freq bend + high-freq canopy flutter (task 08 supplies the real engine)
      const ang = strength * w * (Math.sin(2*Math.PI*freq*t + p*1.7)
                                  + 0.25*Math.sin(2*Math.PI*flutter*t + p*0.9));
      // hinge axis ⟂ wind dir, in ground plane (Z-up): axis = (-dir.y, dir.x, 0)
      _axis.set(r.axis?.x ?? -dir.y, r.axis?.y ?? dir.x, r.axis?.z ?? 0).normalize();
      _q.setFromAxisAngle(_axis, ang);
      // rotation about base pivot → root-relative Frame: origin = pivot - R*pivot
      _piv.set(r.pivot?.x ?? 0, r.pivot?.y ?? 0, r.pivot?.z ?? 0);
      _rp.copy(_piv).applyQuaternion(_q);
      _o.copy(_piv).sub(_rp);
      const b = (f * numParts + p) * 7;
      out[b]=_o.x; out[b+1]=_o.y; out[b+2]=_o.z;
      out[b+3]=_q.w; out[b+4]=_q.x; out[b+5]=_q.y; out[b+6]=_q.z; // AC wxyz layout
    }
  }
  return out;
}
```
The `pivot - R*pivot` translate-rotate-translate-back is the canonical fix for the **co-located-origin shear gotcha**; task 03 supplies the real `rig[p]` (bbox Zmin pivot + height/width weight). For 1a the rig can be `null` (origin pivot) since short foliage sits at the ground.

### Step 3 — Synthetic group constructor (JS-only) — fork `getOrCreateDidGroup`
File: `scene3d/animated_scenery.js`, add beside `:204-237`. Stores into the **same** `_didGroups` Map under a **string** key.
```js
function getOrCreateSyntheticGroup(groupKey, numParts, rig, windParams) {
  const existing = _didGroups.get(groupKey);
  if (existing) return existing;
  const numFrames = Math.max(2, Math.round(windParams.loopSec * animSceneryFps()));
  const frames = buildProceduralWindClip(numParts, rig, windParams, numFrames, animSceneryFps());
  const clip = buildSceneryAnimationClip(THREE, frames, numParts, numFrames, animSceneryFps());
  if (!clip) return null;
  // ----- identical to getOrCreateDidGroup :221-235 from here down -----
  const template = new THREE.Group();
  template.name = `wind-template-${groupKey}`;
  const parts = [];
  for (let i = 0; i < numParts; i++) { const g = new THREE.Group(); g.name = `part${i}`; template.add(g); parts.push(g); }
  const mixer = new THREE.AnimationMixer(template);
  const action = mixer.clipAction(clip);
  action.setLoop(THREE.LoopRepeat, Infinity); action.play();
  const group = { mixer, template, parts, numParts, refCount: 0 };
  _didGroups.set(groupKey, group);
  return group;
}
```
**Keying:** `groupKey = "wind:0x" + setupId.toString(16) + ":" + phaseBucket`. All placements of the same tree DID (sharing the same `windParams`) → **one** synthetic group → **one** mixer, advanced once per frame at `:394-396`. This is exactly the existing "every placement waves identically in object space" rationale (header `:14-21`). For per-instance variety (the forest must not sway in lockstep) bake K=3–4 phase-bucketed groups per DID and round-robin instances across them by `instanceIndex % K` (multiplies mixer count by a small constant — still a handful). *(True per-instance phase needs the shader/VAT routes — tasks 05/06 read phase from `instanceMatrix`; the per-part-node player structurally cannot, since instances copy one shared template. Flag this as the Phase-1a ceiling.)*

### Step 4 — Tree instance builder (JS-only) — fork `buildOne` with reversed order
File: `scene3d/animated_scenery.js`, add beside `:245-303`.
```js
async function buildOneWind(p, wasmExports, materialCache, spFetch, windParams, instIdx) {
  const setupId = (p.objId ?? p.obj_id ?? p.modelId ?? 0) >>> 0;
  if (setupId === 0) return null;
  // fetchBuildingPlacement FIRST — synthetic clip needs partCount (+ bbox for 1b).
  let bundle;
  try { bundle = await wasmExports.fetchBuildingPlacement(setupId); }
  catch (e) { console.warn(`[tree-wind] fetchBuildingPlacement(0x${setupId.toString(16)}) failed:`, e); return null; }
  const partCount = bundle.partCount | 0;
  if (partCount === 0) { bundle.free?.(); return null; }
  const partMeshes = bundle.takePartMeshes();
  const hinge = (typeof bundle.takePartHingeFrames === "function") ? bundle.takePartHingeFrames() : [];
  bundle.free?.();
  const rig = buildBboxRig?.(setupId, partMeshes) || null;     // task 03; null in pure 1a
  const K = windParams.phaseBuckets ?? 1;
  const groupKey = `wind:0x${setupId.toString(16)}:${instIdx % K}`;
  const g = getOrCreateSyntheticGroup(groupKey, partCount, rig, windParams);
  if (!g) return null;
  // ----- node/part build is byte-identical to buildOne :267-301 -----
  const node = new THREE.Group();
  node.name = `tree-wind-0x${setupId.toString(16)}`;
  node.userData = { landblockId: (p.landblockId >>> 0), isAnimatedScenery: true, isTreeWind: true };
  placeNode(node, p);
  const parts = [];
  for (let i = 0; i < partCount; i++) {
    const partGroup = new THREE.Group(); partGroup.name = `part${i}`;
    const h = hinge[i]; if (h) { partGroup.position.set(h.x,h.y,h.z); partGroup.quaternion.set(h.qx,h.qy,h.qz,h.qw); }
    const wasmMesh = partMeshes[i];
    if (wasmMesh) {
      try {
        const { groups, surfaceDids } = meshToGeometryGroups(wasmMesh);
        for (let gi = 0; gi < (groups?.length||0); gi++) {
          const grp = groups[gi]; const sid = grp.surfaceDid || surfaceDids?.[gi] || 0;
          const mat = await materialCache.get(sid, spFetch);
          if (grp.geometry && mat) partGroup.add(new THREE.Mesh(grp.geometry, mat));
        }
      } catch (e) { console.warn(`[tree-wind] part ${i} mesh build failed:`, e); }
      wasmMesh.free?.();
    }
    node.add(partGroup); parts.push(partGroup);
  }
  return { node, parts, animId: groupKey };  // animId slot = generic group key
}
```
The instance record's `animId` field is **already used as an opaque `_didGroups` key** (`:347, 413, 417`) — a string drops in with no change to the rAF loop, refcount, or disposal. `userData.landblockId` keeps the existing LRU evict working unchanged.

### Step 5 — New exported entry `attachWindTrees` (JS-only) — fork `attachAnimatedScenery`
File: `scene3d/animated_scenery.js`, add beside `:314-360`.
```js
export async function attachWindTrees(scene3d, placements, wasmExports, opts) {
  if (!treeWindEnabled()) return 0;
  if (!scene3d?.staticsGroup || !Array.isArray(placements) || !wasmExports) return 0;
  if (typeof wasmExports.fetchBuildingPlacement !== "function") return 0; // fetchAnimation NOT needed
  // caller pre-filters by TREE_DIDS (task 02); accept the list as-is.
  if (placements.length === 0) return 0;
  _rafDisposed = false;
  const windParams = currentWindParams();            // task 12; static defaults for 1a
  const resolveParent = (typeof opts?.resolveParent === "function") ? opts.resolveParent : null;
  const { getOrCreateMaterialCache } = await import("./statics.js");
  const materialCache = getOrCreateMaterialCache(scene3d); if (!materialCache) return 0;
  const spFetch = surfacePixelsFetcher(wasmExports);
  let built = 0, dropped = 0, idx = 0;
  for (const p of placements) {
    const key = placementKey(p);
    if (_builtKeys.has(key)) continue;
    if (_instances.length >= maxAnimated()) { dropped += 1; continue; }   // shared 512 cap
    _builtKeys.add(key);
    const r = await buildOneWind(p, wasmExports, materialCache, spFetch, windParams, idx++).catch(() => null);
    if (r) {
      const parent = (resolveParent && resolveParent(p)) || scene3d.staticsGroup;
      parent.add(r.node);
      const g = _didGroups.get(r.animId); if (g) g.refCount += 1;
      _instances.push({ node: r.node, parts: r.parts, animId: r.animId, key });
      _ensureRaf(); built += 1;
    } else { _builtKeys.delete(key); }
  }
  if (built || dropped) console.log(`[tree-wind] built ${built} across ${_didGroups.size} groups` + (dropped?`; DROPPED ${dropped} over cap`:""));
  return built;
}
```
**Shared pool decision:** reuse `_instances`/`_builtKeys`/`maxAnimated()` so the rAF, orphan reclaim, dist cull, and dispose handle wind trees and animated scenery uniformly with **zero new infra**. The 512 cap is therefore shared and **near-field only** — this is exactly why Phase 1a targets a small near-field set; forest scale is tasks 06/13 (VAT/shader). If a separate budget is wanted, add `?treeWindMax` via `_numFlag` and gate on `_instances.filter(i=>i.node.userData.isTreeWind).length`.

### Step 6 — Hook into the statics divert (JS-only) — task 02 owns the filter; this is the call
File: `scene3d/statics.js`. After the existing `defaultAnimationId` peel at `:1585` (and mirror at `:2090`), add a parallel `windTrees = statics.filter(p => TREE_DIDS.has(p.modelId>>>0))` peel and remove them from `statics`. Then at the attach site `:1830` (mirror `:2364`):
```js
if (animatedStatics) await attachAnimatedScenery(scene3d, animatedStatics, wasmExports);
if (windTrees)       await attachWindTrees(scene3d, windTrees, wasmExports);   // import added at :89
```
Add `attachWindTrees, treeWindEnabled` to the existing import at `scene3d/statics.js:89`. (Interior trees are rare; cells.js wiring optional, mirroring `:895`.)

### Step 7 — Unit test (JS-only, node `--test` style like `test_animated_scenery.mjs`)
New `test_tree_wind_clip.mjs`: assert `buildProceduralWindClip` returns the correct length (`numParts*numFrames*7`), that frame 0 origin = `0` and quat = identity when `strength=0`, that a non-zero strength about a non-origin pivot yields `origin = pivot - R*pivot` (the shear-fix invariant), and that `buildSceneryAnimationClip` accepts the output and a mixer plays it (mirror `test_animated_scenery.mjs:77-89`). Drive a synthetic group headlessly via the exported `tickAnimatedScenery(dt)` (`:432`) — it is source-agnostic. (Task 15 owns the broader suite.)

---

## Risks & open questions
- **Rest-hinge overwrite (verified `:419-423`).** The rAF copies the template pose over the instance's local transform every frame, so synthetic frames **must** be absolute root-relative (hinge baked in). For trees hinge ≈ identity (parent −1, co-located origin), so frames = pure sway; but if any tree part carries a non-identity hinge, `buildProceduralWindClip` must compose `hinge ∘ sway`. Mitigation: pass `hinge[]` into the generator and pre-multiply. Cross-ref task 03.
- **Co-located-origin shear.** Rotating a high canopy part about model origin swings it through a huge arc. Phase 1a sidesteps this by targeting **short foliage only** (origin ≈ ground ≈ part base). Tall trees require task 03's bbox-Zmin pivot (`pivot − R*pivot`) before they look right — do **not** ship tall trees on 1a.
- **No per-instance phase in the per-part-node player.** All instances of a DID share one template → lockstep sway. Phase-bucketed groups (K≈3–4) mask it cheaply; true variety needs the shader/VAT routes (tasks 05/06). Open question: is K=3–4 visually sufficient on the 1070, or does the forest read as "rippling in waves"? Defer to the batched eye-test (task 14).
- **Shared 512 cap vs forest scale.** Reusing `_instances` means wind trees compete with flags/banners for 512 slots and are near-field only. Acceptable for 1a (first-visible-motion); tasks 06/13 carry the bulk forest. Risk: a dense near-field grove exhausts the cap and drops trees silently — `dropped` is logged (`:357`), surface it in a diag counter (task 15).
- **`maxAnimated`/`tickRadiusSq`/`animSceneryFps` are memoized at first read (`:57, 62, 85`).** Changing `?treeWind*` flags requires a reload — consistent with existing behavior; document in url-flags.md (task 14).
- **Double-render guard.** Trees have `defaultAnimationId === 0` (established), so `attachAnimatedScenery`'s filter (`:321`) never claims them and the new `TREE_DIDS` peel never claims animated scenery — no overlap. But the statics divert **must** remove `windTrees` from `statics` (Step 6) or trees render both frozen and animated. Verify with the off=frozen regression guard (task 15): with `?treeWind` absent, `attachWindTrees` returns 0 at `:gate` and `statics` is byte-identical to today.
- **Open: does `fetchBuildingPlacement` expose per-part vertex bbox for the 1b rig, or must JS compute it from `takePartMeshes()` positions?** Out of scope here — task 11 decides export-vs-JS; task 03 owns the rig math. Phase 1a needs neither (rig = `null`).
