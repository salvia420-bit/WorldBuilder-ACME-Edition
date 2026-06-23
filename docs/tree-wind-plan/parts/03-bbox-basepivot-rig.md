I now have the complete contract. Writing the focused design section for my assignment.

---

## Assignment

**03 — Phase 1b bbox-derived rig.** From `fetchBuildingPlacement` per-part mesh data, compute each part's **base pivot** `(centroidXY, vertex Zmin)`, **height span**, and a **sway weight** (taller/broader/higher → more; narrow full-height trunk → least). Specify the per-part wind transform as a **hinge rotation about the part base** (NOT model origin — the co-located-origin shear is the gotcha), expressed as the exact per-part `Frame` the player consumes, and bake it to a dense per-part keyframe array for `buildSceneryAnimationClip`. State what looks good vs the residual stiffness that motivates Phase 2. **READ-ONLY.**

## Findings (file:line)

**The Frame the player consumes — and where it lands on the part.** `buildSceneryAnimationClip(THREE_, frames, numParts, numFrames, fps)` (`animated_scenery.js:125-157`) reads a flat `Float32Array` laid out **frame-major then part-major, 7 floats per (frame,part)** = `[origin.x, origin.y, origin.z, quat.w, quat.x, quat.y, quat.z]` (docstring `:109-113`; index `base = (f*numParts + p)*7` at `:137`; AC **wxyz → THREE xyzw** reorder at `:141-149`). It emits per part a `VectorKeyframeTrack part${p}.position` + `QuaternionKeyframeTrack part${p}.quaternion` (`:151-152`). **This is exactly the array my rig must synthesize** — no DAT, no `fetchAnimation`.

**The frame is an ABSOLUTE part-local transform, not a delta off the hinge.** `buildOne` initializes each `partGroup` from the wasm hinge frame (`animated_scenery.js:278-282`), but the rAF copy loop **overwrites** `position` *and* `quaternion` wholesale from the animated template every tick (`:421-422`). So frame `f` *is* the part's full local transform under the model node. **Consequence:** my rest frame (θ=0) must reproduce the frozen pose. For trees the hinge is **identity** (see below), so frame0 = identity → the animation departs from and returns to the exact frozen render. This is the "off=frozen, on=continuous-with-rest" guarantee for free.

**The co-located-origin gotcha is real and confirmed in the data path.** `compute_hinge_frames` (`lib.rs:9856-9901`) pulls each part's frame from `setup.placement_frames[0]` (`:9879-9899`); per established ground truth trees have `parent_index=-1`, parts co-located at `(0,0,0)` → these hinge frames are **identity**. So the hinge frames give us **no pivot** — a part's true base must come from its **vertex Zmin**, which only the geometry has.

**Per-part vertex data is available JS-only — no new wasm export.** `fetchBuildingPlacement` returns `partCount` + `takePartMeshes(): Vec<ModelMesh>` (`lib.rs:9785-9788`). Each `ModelMesh.positions` is a `Float32Array, len = triCount*9` in **AC object space, Z-up** (`adapter.js:725`; co-located parts, so Zmin is the part's real height above ground). `buildOne` already snapshots `partMeshes[i]` (`animated_scenery.js:283`) — I scan `positions` for the bbox before/instead of building geometry. (A per-part AABB walker already exists Rust-side, `walk_setup_parts_with_geom` `lib.rs:5361-5397`, but it is **not** wasm-exported; the JS-from-`positions` path needs no rebuild — preferred under the 8GB OOM constraint.)

**Node scale is uniform and applied at the node** (`placeNode` `:181-182`), so one object-space clip per DID is valid across placements regardless of per-placement scale/rotation (pivot scales with geometry).

## Concrete coding steps

All steps below are **JS-only (no wasm rebuild, no offline bake)**. New module `scene3d/wind_rig.js` (pure, unit-testable like `buildSceneryAnimationClip`); player wiring is task 01, divert/classification task 02, wind state task 12.

### Step A — per-part bbox from `positions` (JS-only)
New `partBBox(positions)` in `wind_rig.js`. Scans the `triCount*9` object-space stream; uses **bbox center** for the XY pivot (robust to vertex-density bias) and **Zmin** for the base.

```js
// positions: Float32Array len triCount*9, AC object space (z = up)
export function partBBox(positions) {
  let minX=Infinity,minY=Infinity,minZ=Infinity, maxX=-Infinity,maxY=-Infinity,maxZ=-Infinity;
  for (let i = 0; i < positions.length; i += 3) {
    const x=positions[i], y=positions[i+1], z=positions[i+2];
    if(x<minX)minX=x; if(x>maxX)maxX=x;
    if(y<minY)minY=y; if(y>maxY)maxY=y;
    if(z<minZ)minZ=z; if(z>maxZ)maxZ=z;
  }
  if (!Number.isFinite(minZ)) return null; // empty/failed part slot (triCount==0)
  return { minX,maxX,minY,maxY,minZ,maxZ,
           cx:(minX+maxX)*0.5, cy:(minY+maxY)*0.5,    // pivot XY
           z0:minZ,                                    // pivot Z = base
           w: Math.max(maxX-minX, maxY-minY),          // horizontal extent
           h: maxZ-minZ };                             // height span
}
```
Caller (in task 01's `buildOne` variant) does `bboxes[i] = partBBox(partMeshes[i].positions)` **before** `meshToGeometryGroups`, keeping the same `partMeshes[i]` snapshot. Bboxes are identical across all placements of a DID, so compute once per DID (cache under the synthetic clip id, see Step E).

### Step B — sway weight from bbox (JS-only)
Monotone, bbox-only (no skeleton). Trunk = full-height + narrow → near-zero; canopy = high-reach + broad → max.

```js
function swayAmp(b, mZmin, mH, A_MAX) {            // mH = modelZmax-modelZmin
  const reach     = (b.maxZ - mZmin) / mH;                       // 0..1 how high it reaches
  const heightFrac= b.h / mH;                                    // fraction of tree it spans
  const broad     = b.w / Math.max(b.h, 1e-3);                   // aspect: canopy>>1, trunk<<1
  const spread    = Math.min(1, Math.max(0.15, b.w/(0.5*mH)));   // broad sway more, twig floor
  const trunkness = Math.min(1, Math.max(0, heightFrac - Math.min(1, broad))); // full+narrow→~1
  return A_MAX * Math.pow(Math.max(reach,0),1.5) * spread * (1 - 0.85*trunkness);
}
```
- Tall narrow trunk (`heightFrac≈1, broad≈0.1`) → `trunkness≈0.9` → ~15% amp, planted base.
- High broad canopy (`reach≈1, broad>1, heightFrac` small) → `trunkness=0` → full amp.
- Single low foliage part (`heightFrac=1, broad≈1`) → `trunkness=0, reach=1` → full rustle.

### Step C — the hinge Frame: rotation about the part **base**, not origin (the gotcha)
A rotation `R` about pivot `b=(cx,cy,z0)` is `v' = R(v−b)+b = R·v + (b − R·b)`. The player's Frame is `v' = Q·v + O`, so:

> **quat `Q = R`  (the hinge rotation)** **origin `O = b − R·b = (I−R)·b`  (pivot-compensation translation)**

Wind dir `d=(dx,dy,0)` (object space, unit). Hinge axis = horizontal ⟂ `d`: `axis=(−dy, dx, 0)` (unit since `d` is unit). Rotating `+Z` about this axis by `θ>0` tilts the top **toward `d`** (checked: `axis × (0,0,h) = h·d`). Quaternion `Q(θ) = (cos θ/2, sin θ/2·axis)` in wxyz. At θ=0 → `Q=I, O=0` = frozen pose (rest guarantee from Findings).

### Step D — bake the dense per-part keyframe array (JS-only)
`buildTreeWindClip(bboxes, opts)` → `{frames, numParts, numFrames, fps}` in the **exact** `buildSceneryAnimationClip` layout. Loop seamlessness: both sinusoids use **integer cycle counts per loop** (`ω = 2π·cycles/T`). Phase per part from a **golden-ratio hash** (deterministic — `Math.random` is unavailable in the bake sandbox per ground truth).

```js
export function buildTreeWindClip(bboxes, opts = {}) {
  const { fps=30, loopSeconds=4, ampDeg=6, dir=[1,0],
          cycles1=3, cycles2=11, flutter=0.3 } = opts;
  const numParts  = bboxes.length;
  const numFrames = Math.max(2, Math.round(fps*loopSeconds));
  const T = numFrames / fps;
  let dx=dir[0], dy=dir[1]; const dl=Math.hypot(dx,dy)||1; dx/=dl; dy/=dl;
  const ax=-dy, ay=dx, az=0;                                  // hinge axis (unit)
  let mZmin=Infinity,mZmax=-Infinity;
  for (const b of bboxes) if (b){ if(b.minZ<mZmin)mZmin=b.minZ; if(b.maxZ>mZmax)mZmax=b.maxZ; }
  const mH=Math.max(mZmax-mZmin,1e-3), A_MAX=ampDeg*Math.PI/180;
  const amp=[], ph=[], piv=[];
  for (let p=0;p<numParts;p++){
    const b=bboxes[p];
    if(!b){ amp[p]=0; ph[p]=0; piv[p]={x:0,y:0,z:0}; continue; }
    amp[p]=swayAmp(b,mZmin,mH,A_MAX);
    ph[p]=2*Math.PI*((p*0.6180339887)%1);                    // deterministic per-part phase
    piv[p]={x:b.cx,y:b.cy,z:b.z0};                           // base pivot
  }
  const w1=2*Math.PI*cycles1/T, w2=2*Math.PI*cycles2/T;      // integer cycles → seamless
  const frames=new Float32Array(numParts*numFrames*7);
  for (let f=0;f<numFrames;f++){
    const t=f/fps;
    for (let p=0;p<numParts;p++){
      const th=amp[p]*(Math.sin(w1*t+ph[p]) + flutter*Math.sin(w2*t+ph[p]*1.7));
      const h=th*0.5, s=Math.sin(h), c=Math.cos(h);
      const qw=c, qx=s*ax, qy=s*ay, qz=s*az;                 // Q(θ) about axis
      const b=piv[p];                                        // O = b - Q*b
      const rx=b.x, ry=b.y, rz=b.z;
      // rotate (rx,ry,rz) by quaternion (qw,qx,qy,qz):
      const tx=2*(qy*rz-qz*ry), ty=2*(qz*rx-qx*rz), tz=2*(qx*ry-qy*rx);
      const Rbx=rx+qw*tx+(qy*tz-qz*ty), Rby=ry+qw*ty+(qz*tx-qx*tz), Rbz=rz+qw*tz+(qx*ty-qy*tx);
      const base=(f*numParts+p)*7;
      frames[base+0]=b.x-Rbx; frames[base+1]=b.y-Rby; frames[base+2]=b.z-Rbz; // O=(I-R)b
      frames[base+3]=qw; frames[base+4]=qx; frames[base+5]=qy; frames[base+6]=qz; // wxyz
    }
  }
  return { frames, numParts, numFrames, fps };
}
```
`numParts === bboxes.length === partMeshes.length === bundle.partCount`, so the clip's part count matches the instance's `parts[]` and the rAF copy `min(g.parts.length, inst.parts.length)` (`:419-423`) is exact. Cost: `numParts(≤11) × numFrames(120) × few trig` ≈ a few thousand ops per DID — trivial, built once and shared.

### Step E — feed it through the player (cross-ref task 01; JS-only)
`getOrCreateDidGroup` (`animated_scenery.js:204-237`) currently keys on the DAT `animId` and calls `fetchAnimation`. The Phase-1b variant keys on a **synthetic clip id** = the tree `setupId` (or `` `wind:${setupId}` ``) and feeds `buildTreeWindClip(...)` output straight into `buildSceneryAnimationClip(THREE, frames, numParts, numFrames, animSceneryFps())` (`:219`), skipping the fetch. Everything downstream is unchanged: one shared template/mixer per tree DID (`:221-234`), instances copy per-part transforms in the rAF (`:421-422`), 512 cap, LRU/orphan reclaim. The bboxes feeding the clip come from the **same `bundle`** `buildOne` already fetches, so a single `fetchBuildingPlacement(setupId)` serves both geometry and rig.

### Step F — crude live wind, JS-only (optional, defer amplitude to Phase 2/3)
Amplitude is **baked** (can't change a baked quaternion clip live). The rAF advances the shared mixer with `g.mixer.update(dt)` (`:395`); multiply `dt` by a wind-speed factor from task 12's wind module for a cheap **gust = faster sway** cue in storms. `ampDeg`/`dir` read once at load from `?treeWindStrength`/`?treeWindDir` (task 14). True live amplitude/gusts are the shader/VAT route's job.

## What looks good vs residual stiffness (motivating Phase 2)

**Looks good (ship 1b):**
- **Short foliage rustle** (fern `0x02001063`, shrub `0x020007A2`): single low cluster, base pinned at ground, hinge-about-own-base = clean believable rustle, **no seams** (one effective pivot). Immediate "this is wind" read.
- **Canopy hinge** on tall trees: high broad canopy parts hinge from their own base → the crown sways while the trunk stays mostly planted; organic at gentle amplitude.
- Per-placement bend direction varies with node `rotationZ` (object-space `dir`) → forest doesn't lean in robotic lockstep; reads as natural local turbulence for default wind.

**Residual stiffness (Phase 2):**
- **Seam shear** on trunk+canopy splits: parts hinge **independently** (no cascade — AC composition is flat, ground truth). The trunk top displaces ≈ `θ_trunk · seamHeight`, but the canopy base is its own pivot (displacement 0) → a gap of ~6 cm at θ_trunk=0.5°, but ~60 cm under a 5° gust → visible cracking. Caps usable amplitude.
- **Rigid stick lean**: each part is rigid (no vertex skinning in AC) so a tall trunk *leans* rather than *curves*; no intra-part bend.
- **No world-coherent directional wind / no live gust amplitude**: object-space baked clip can't share a world wind vector across rotated placements, and baked amplitude is static-per-session.

Phase 2 (skeleton cascade so the canopy base *follows* the trunk top; VAT/vertex-bend for intra-part curve; world-space wind uniform) is exactly the fix for all three. **Rollback for 1b:** `?treeWind` off → these placements never divert from the frozen `BatchedMesh` path → byte-identical retail render.

## Risks & open questions

- **Pivot-shear is the whole point — easy to get wrong.** If a dev sets `Q=R` but leaves `O=0` (rotation about model origin), every elevated part swings through a huge arc (canopy at Z=20 with a 5° angle moves ~1.7 m laterally). The `O=(I−R)b` term is mandatory; unit-test it (assert frame0 = identity, and a known θ on a known pivot reproduces `v'=R(v−b)+b` for a vertex).
- **Centroid vs bbox-center pivot:** I chose bbox-center XY to avoid vertex-density bias toward dense foliage. If a part's geometry is strongly asymmetric (offset clump), bbox-center may sit off the visual mass — acceptable for 1b; revisit if a specific DID looks like it pivots off-axis.
- **Multi-part clumps that are *not* trunk/canopy** (repeated identical GfxObjs, material splits — ground truth notes these): the bbox heuristic may assign them all similar weights and they'll sway in near-unison (only the golden-ratio phase differentiates). Looks fine but not "structured." Acceptable for 1b; Phase 2 skeleton disambiguates.
- **1-part trees** (`0x02000406`, `0x020007A5`): whole model hinges about its base as one rigid piece = a stiff flagpole lean, the weakest 1b case. Mitigation: lower `ampDeg` for 1-part DIDs, or route them straight to the Phase-2 shader (bend along Z) since there's no part structure to exploit anyway.
- **Loop length vs flutter Nyquist:** `cycles2=11` over `T=4s` = 2.75 Hz, fine at 30 fps. Faster leaf flutter needs more frames (point-snap at 30 fps will alias); that's a Phase-2 VAT concern, not 1b.
- **Open: where does the per-DID bbox/weight cache live** — recomputed in-session per DID (cheap, my recommendation) vs baked into the tree-wind sidecar (task 02/10) for determinism/audit. Task 02 owns the allowlist; if a baked sidecar already ships per-DID metadata, fold the bbox/weights in there and `buildTreeWindClip` reads them instead of scanning `positions` — but the JS scan keeps 1b zero-infra.
