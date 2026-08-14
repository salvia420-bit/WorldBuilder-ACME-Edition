# LANE D — PORTAL-PASS2 (`?portalPass2`, default OFF) — 2026-08-14

Branch `lane/portal-pass2-20260814`, worktree `/mnt/wbterminal2/lanes/d-portal-pass2`.
Handoff O-P1. Nothing pushed. No background automation started.

---

## 1. What the decomp actually says (read first, before any code)

Source: `$DECOMP/acclient.c` (`/home/wbterminal/ac-headers`), anchored on symbols.

### 1a. The outdoor path is PER PORTAL POLYGON, inside ONE BUILDING'S OWN BSP walk

`BSPNODE::build_draw_portals_only` / `BSPPORTAL::portal_draw_portals_only`
(**acclient.c:364428-364520**) walk a single building's BSP tree, taking the camera's
sidedness against each splitting plane (`dot(FrameCurrent, N) + d` with the ±0.0002
on-plane band) and recursing **far subtree → this node's own portals → near subtree**.
That is a per-building back-to-front portal order, and per portal it calls
`RenderDevice::DrawPortal` → `PView::DrawPortal` (**:462565**).

`PView::DrawPortal` → `PView::ConstructView(CBldPortal*, CPolygon*, check, mode)`
(**:462507-462562**), which returns 0 — no punch, no interior — unless all of:

* **(a) sidedness**: signed camera distance to the portal plane vs the DAT-authored
  `outside_portal->portal_side` (**:462513-462543**);
* **(b) clip**: `PView::GetClip` against the *accumulated* portal view volume; empty → 0
  (**:462545**);
* **(c) destination**: `CEnvCell::GetVisible(other_cell_id)` plus `Render::copy_view`
  intersecting the destination cell's own portal view (**:462551-462558**).

Only then does it stamp the poly (`D3DPolyRender::DrawPortalPolyInternal`, **:462560**)
and recurse inward (`ConstructView(cell, other_portal_id)`), and only then does
`DrawPortal` call `PView::DrawCells(this, /*from_outside=*/1)` (**:462588**) — so **that
portal's interior is drawn immediately, nested inside that building's walk**, before the
next portal is even considered.

`PView::ConstructView(CEnvCell*, portal_in)` (**:462423-462462**) is the flood: seed
`cell_todo_list` from ONE cell, grow it only through `PView::ClipPortals` (**:462460**).
A cell is reached solely by a chain of non-empty clipped apertures. That is the
reachability we do not have.

### 1b. DECOMP CORRECTION — the Z-wipe is the INDOOR branch, not the outdoor one

The lane card lists the Z-wipe at `acclient.c:461484` as one of the three things retail
uses to earn `DEPTHTEST_ALWAYS` on the outdoor punch. It reads otherwise. In
`PView::DrawCells` (**:461450**) the `LScape::draw` + `FlushAlphaList` + `Clear(4, …,
1.0)` block (**:461473-461487**) is entirely inside `if (this->outside_view.view_count)`.
`outside_view` is populated by the **indoor-looking-out** entry: `PView::DrawInside`
(**:462590**) → `DrawCells(this, /*from_outside=*/0)` — draw the landscape seen through
the doorways, wipe Z, re-stamp the exterior portal planes
(`DrawPortalPolyInternal(portal, 0)` over `cell_draw_list`, **:461525-461545**), then draw
the cells. The outdoor entry (`DrawPortal` → `DrawCells(this, 1)`) has `view_count == 0`:
**no landscape draw and no wipe**.

So the outdoor punch earns `DEPTHTEST_ALWAYS` from (a)+(b)+(c) plus the per-building
nesting — never from a wipe. **This lane therefore implements no Z-wipe**, and asserts
that (`gates.zWipe === false`, pinned by a test). Our wipe stays where it belongs, on the
indoor split (`?indoorDepthSplit` / `tickPortalSeal`).

---

## 2. What I implemented

**New:** `scene3d/portal_pass2.js` — a pure, DOM-free transform from the wasm aperture
stream to a **strict subset** of that same stream (identical v1/v2/v3 wire shape), plus a
diag. Stages, in retail's own order:

0. **sidedness seed** — retail's (a), applied FIRST so grouping/ordering never see an
   aperture a viewer could not face. Uses the exported
   `apertureFacesAwayWithSide` (real `portal_side`) with the v2 AABB-centre inference as
   fallback; both already live in `portal_clip.js`, so there is one implementation.
1. **per-BUILDING grouping** — union-find over the owning cell's AABB centre within
   `BUILDING_GROUP_RADIUS_M` = 24 m, transitive so a long building stays one group.
   This is a **proxy**: the wire format carries no building id, and adding one is
   `src/lib.rs`, which is Lane B's this session.
2. **back-to-front group order** — the observable output of the BSP walk; sort on
   camera→group-centroid distance, descending. Group ids are re-stamped so the diag reads
   in draw order.
3. **nearer-building occluder** — the screen-space stand-in for (b)/(c): a farther group's
   aperture is dropped when its screen rect is fully contained in a nearer group's
   aperture screen span and the two groups are ≥ `OCCLUDER_MIN_SEPARATION_M` = 8 m apart.

Output preserves the original stream order (the punch draws every aperture with
`depthFunc=Always`, so their order among themselves is not observable, and preserving it
makes the armed arm trivially diffable against the unarmed one).

**Flag reader:** `=== "on" || === "1"`. Deliberately *not* `!== "off"` — that idiom is the
documented default footgun that has six cast flags silently live.

### Retail mechanisms NOT reproduced (and why)

* `PView::GetClip` against the **accumulated** portal view volume — needs a real `PView`
  port with per-cell `portal_view` stacks.
* The inward flood to nested rooms (`ConstructView(cell, portal_in)`) — the wasm export is
  depth-1 by construction (`_max_depth` is unused in
  `visible_portal_apertures_flat`), and that export is Lane B's file.
* `CEnvCell::GetVisible` + `Render::copy_view` view intersection.
* The per-portal **interleaving** of punch and interior draw. We still run one punch pass
  then one cells pass; grouping changes *which* apertures survive, not how many passes
  there are. Doing the real thing is N nested passes per frame and a composer change —
  out of scope for a default-OFF gate that must not touch the default path.
* The Z-wipe — deliberately, §1b.
* Retail's occluder is the nearer building's own **opaque BSP geometry**, drawn in the
  same walk. We have only that building's apertures, so stage 3 is strictly weaker and
  strictly conservative.

---

## 3. Shared lines touched (for hand-merge with LANE A)

Only `scene3d/cells.js`. Four hunks, all additive; the only pre-existing lines *modified*
are two, both marked ✱. Line numbers are post-edit.

| Hunk | Lines | What |
|---|---|---|
| 1 | 51-54, immediately after the `} from "./portal_clip.js";` import | 3 comment/import lines + `const PORTAL_PASS2 = readPortalPass2Flag(null);` |
| 2 | 382-385, just before the `// Boot banner + flag mirror (round 7).` comment | `let _portalPass2Last = null;` + its docblock |
| 3 | 402-417, inside the existing `try { globalThis.__portalPunch = {…}; … }` block, after the `};` that closes `__portalPunch` and before `if (PORTAL_PUNCH_FLAG_ON)` | stamps `globalThis.__portalPass2` + an ARMED-only console line |
| 4 | 2923-2939 in `tickPortalPunch`, between `if (!nearPlane) _punchDiag(…)` and `if (nearPlane) {` | the `let feedFlat = flat; if (PORTAL_PASS2) {…}` block |
| 4 ✱ | 2941 | `clipAperturesForPunch(flat, …)` → `clipAperturesForPunch(feedFlat, …)` |
| 4 ✱ | 2968 | `_portalPunchDiag.offered` now reads `feedFlat`, and one field `pass2:` is added below it |

I touched **neither** `scene3d/portal_punch.js` nor `scene3d/atmosphere_pipeline.js`
(Lane A's surface), and neither `src/lib.rs` nor `pkg/` (Lane B's). If Lane A's gate
rewrites the `clipAperturesForPunch` call, the merge is: keep their call, feed it
`feedFlat`.

Other files, all lane-private or append-only: `scene3d/portal_pass2.js` (new),
`tests/portal_pass2.test.mjs` (new), `harness/run-js-headless.mjs` (**one** registration
line), `docs/url-flags.md` (**one** new row), `docs/reengineering/impl/ACTIVE-LANES.md`
(appended block).

---

## 4. ALLOCATION COST OF THE GATE ON THE DEFAULT PATH — **zero**

Mandatory statement, in the terms the 2026-08-13 stencil regression demands:

* **No render pass** is added or registered. The composer's pass list is byte-identical.
* **No framebuffer attachment**: no stencil is requested, so the shared depth texture is
  not flipped to packed depth-stencil. This gate cannot reproduce the 08-13 failure shape
  because it never touches `EffectComposer` construction at all.
* **No GPU object**: no material, geometry, buffer, render target or texture is created,
  armed or not — the module renders nothing.
* **No wasm call**: no new export, and the existing aperture export is called exactly as
  before.
* **No per-frame allocation when OFF**: `feedFlat = flat` is an identity binding;
  `portalPass2Filter` is never invoked; the only OFF-path write is one
  `scene3d._portalPass2Diag = portalPass2DisarmedDiag()` on the **first** tick (guarded by
  `=== undefined`), i.e. one small object for the lifetime of the scene.
* **The only default-path cost is parsing one pure-JS module at import time** (~400 lines,
  no dependencies beyond four functions already imported by `cells.js`'s neighbour).

Armed, it is O(n²) in the aperture count for grouping and occlusion (n = tens in a town,
not thousands) and allocates per frame; that cost lands only under `?portalPass2=on`.

Safety property: the output is a **subset** of the input in the same wire shape, so armed
it can only ever punch *fewer* apertures — it cannot make an interior appear where none
was. On malformed input it hands the caller its own stream back and names the reason
(`parse-shape-mismatch` / `no-apertures`); it **fails open**, never to a truncated punch
set (a truncated set is the 2026-08-12 "every interior vanishes" shape).

---

## 5. Diag surface

Stamped at MODULE LOAD, so absent === STALE BUNDLE and nothing else:

```js
window.__portalPass2.enabled          // did the flag arm?
window.__portalPass2.last()           // last armed verdict (module-scoped stamp,
                                      // NOT liveScene3d — that is an init snapshot)
```

`last()` returns:

```js
{ armed, reason,                       // ok | all-apertures-dropped | parse-shape-mismatch
                                       // | no-apertures | flag-off(?portalPass2)
  offered, kept,
  dropped: { sidedness, occluded },
  groups: [ { id, order, dist, offered, kept, droppedOccluded } ],  // PER BUILDING,
                                                                    // in draw order
  gates: { sidedness, grouping, backToFront, occluder, zWipe:false } }
```

Also mirrored at `liveScene3d._portalPunchDiag.pass2` so one existing paste carries both.
`groups[]` is the armed-vs-unarmed tell the lane card asked for: an unarmed session has
`enabled:false` and `last() === null`; an armed one that gated nothing still shows every
building with `offered === kept`.

---

## 6. Tests

Runner: `node harness/run-js-headless.mjs` in `apps/holtburger-web`.

* **Before** (this worktree, pre-change): `243 passed, 12 failed, 1 missing (of 256 run)`
  — exactly the `origin/master` baseline.
* **After**: `244 passed, 12 failed, 1 missing (of 259 run)` — **the same 12 failures, no
  new one**; the delta is my new file passing.

Named failures, identical before and after:

```
test_move_telemetry.mjs
test_a14_i3_run_keys.mjs
test_a5_p3_root_motion.mjs
test_a14_i2_pursuit_monitor.mjs
test_motion_sequence.mjs
test_a11_s5_default_script_spawn.mjs
test_materials_paletted_lru.mjs
test_sky_birds.mjs
test_visfid_c4_program_cache_key.mjs
test_visfid_p02_detail_material.mjs
test_visfid_p11_normal_gate.mjs
test_visfid_p33_csm.mjs
MISSING: test_p1_alias_split.mjs
```

New: `tests/portal_pass2.test.mjs` — **19 cases, all passing**, registered in the harness
as tier 5 / flag `portalPass2`. It pins: the flag is OFF for absent / empty / bare /
`=off` / `=true` and ON only for `on`/`1`; parse+encode round-trips the v3 shape
byte-for-byte and a truncated stream stops short; grouping separates buildings, is
transitive along a long one, and orders groups farthest-first; the filter never mutates or
adds; the sidedness seed rejects the far-side door; the per-building diag sums to `kept`
and is in draw order; the occluder drops a far door fully behind a nearer span and is
switchable off; `gates.zWipe === false`; and the whole thing fails open on empty /
malformed / null input.

No Rust changed, so no cargo run was needed (and `src/lib.rs` is Lane B's this session).

---

## 7. What I could NOT prove

* **Anything visual.** This laptop is SwiftShader; the lane card forbids me real-GPU eyes.
  Whether pass2 removes the reported see-through-a-wall doorways *without* closing a
  doorway a player can genuinely see is a real-GPU question. One matched pair submitted:
  **`D-portalpass2-holtburg-daylight`** in `/mnt/wbterminal2/eyeq/queue.jsonl` — arms
  `on`/`off` (identical URLs but for `&portalPass2=on`), Holtburg daylight, town distance,
  armed with an assertion that the punch diag exists and offered > 0, so an unarmed run
  cannot read as evidence.
* **That the 24 m grouping radius is right for real AC town geometry.** It is a proxy for a
  building id the wire format does not carry; the queue pair's `groups[]` output is the
  first real data on it. If groups come back at 1 building for a whole town block, the
  radius is too large — or, better, `src/lib.rs` should emit a building id once that file
  is free.
* **That the screen-rect occluder is not too weak.** It only fires on full containment; a
  doorway half-behind a wall still punches. Retail's occluder is real geometry.

## 8. Not landed, and not mine to land

The flag stays **OFF**. Landing default-ON is the owner's call on the real-GPU pair.
No existing default-OFF flag was flipped.
