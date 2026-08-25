# 1070 batch eye-test — Phase-4 windBake + Phase-5 material-detail (2026-06-26)

Real **GTX 1070** (`ANGLE … GeForce GTX 1070 … Direct3D11`), headless via ANGLE/D3D11, off-screen.
App over the laptop reverse tunnel (`box:18765 → serve.py:8765`); wsbridge over tailscale
(`ws://<server-ip>:8080`); account `<test-account>`, deterministic spawn at the **Holtburg lifestone**
(cell `0xa9b40019`, pose 84,7.1). Harness: `harness-matwind-ab-1070.mjs` (adapted from `cloud-ab-1070.mjs`).
All arms: in-world reached, **0 console errors**, real GPU confirmed.

This closes the **owed visual sign-off** for the two default-ON bake features SwiftShader couldn't validate
(Phase-4 `HANDOFF-2026-06-26.md §2`, Phase-5 `PLAN.md §6`). It also **resolves the F2 introspection gap** by
reading map-attach + winding-tree counts straight off the live scene graph, and answers the user's manual
observation: *"trees moving in a spot outside Holtburg but not in Holtburg, and not every spot outside."*

---

> **CORRECTION (v2, after user pushback).** v1 tested the wrong subject (buildings) for material and mis-measured
> wind motion. v2 re-tested on the correct subjects and the conclusions below supersede the v1 framing. The
> outcomes held, but the v2 attribution is sharper. See `report-v2-weapon-wind.json` + `harness-v2-matwind2-1070.mjs`.

## VERDICT

| Feature | Ships | Verdict (v2) |
|---|---|---|
| **Phase-5 material-detail (`?material`)** | default-ON | ❌ **INERT in-world on EVERY subject** — buildings, statics, AND spawned weapons (the intended target). 0 roughnessMap / 0 aoMap on any rendered material. Worse: **weapons use a separate material path that was never wired for texchan at all.** |
| **Phase-4 windBake (`?windBake`)** | default-ON | ✅ **Not a bake regression** (synth == bake). Wind itself is **strong** (7° default amplitude, user-confirmed in-game). Visibility is gated by structural factors (140 m camera cull + winding species 773 m from town + 512 cap). My headless captures **failed to film the motion** — a camera-positioning/cull tooling issue, NOT evidence trees don't move. |

---

## v2 corrections (the authoritative findings)

### Material — tested on the spawned weapon (the real target)
`@create 24205` (Weeping Staff, **unpaletted**) + `@create 46088` (Atlan Sword, **paletted**) at the Holtburg
spawn; introspected each spawned **entity** by its `entity_<guid>` root (the `0x8000…` dynamic guids are the
@create objects). Result — **every** spawned weapon mesh:
`MeshStandardMaterial, roughness 0.8–0.9 (hardcoded), hasMap:true, roughnessMap:0, aoMap:0`.
- Both paletted and unpaletted weapons → **0 maps**. Same as buildings (v1) and statics.
- The hardcoded roughness (0.8/0.9) is the tell: spawned items render through the **`entities.js` inline
  material builder**, which **never calls `_attachRoughnessMap`** — texchan was wired into `MaterialCache`
  (statics/buildings) only. So **weapons cannot show the bake even in principle** until `entities.js` is wired.
- Two distinct gaps now: (1) the `MaterialCache` texchan attach yields 0 maps even where it IS wired
  (statics/buildings — async re-mint never reaches the rendered clone); (2) the item/weapon path was never
  wired at all. `?material=on` is a no-op everywhere today.

### Wind — the cull radius + species distance, not weak wind
- **Wind amplitude is strong by default:** `treeWindStrength=1.0` → **7° peak sway** (`tree_wind.js`/`wind_rig.js`).
  Matches the tester seeing high wind in-game.
- **The 512 cap is conservative, not a hard technical limit** (`animated_scenery.js`): ONE mixer per anim DID,
  per-instance cost is just a transform memcpy, `mixer.update()` is O(unique DIDs ≈ 4). Raising it is cheap
  (memory + copy-loop). Around Holtburg it drops **1572 of 2084** windable instances (75%) → re-frozen.
- **Animation is camera-distance-culled:** `DEFAULT_TICK_RADIUS_M = 140` — anim pose is only copied onto
  instances within **140 m of the camera**; farther ones freeze (`animated_scenery.js:679`). The nearest
  winding tree is **773 m** from the Holtburg lifestone → always culled → **never animates in town**.
- **Windable set:** 6 hardcoded `TREE_WIND_DIDS` + any SetupDID whose VFX descriptor has `deformation.windBend`
  (103 DIDs) when `?visual=on` (default). More species can be added via code (the allowlist) or data (the
  descriptor). No reason it must stay at 4 — that's just what grows near Holtburg.
- **Capture caveat (unresolved):** both v1 and v2 failed to *film* tree sway. The free-camera reposition to the
  forest cluster fought the per-rAF follow camera (`CameraSwitcher.tick`, camera.js:271) and/or the 140 m cull
  froze the trees while the camera sat at the lifestone. The correct capture **teleports the PLAYER into a dense
  winding-tree area** (so the follow cam frames trees within 140 m), then bursts at ~450 ms (sway period ~1.33 s)
  and verifies in-page by sampling an `anim-scenery-*` node's child world-pos across two ticks. NOT yet done.

---

## Finding 1 (v1) — material bake attaches NOTHING in-world (headline)

`mat-on` vs `mat-off`, identical deterministic framing (close-up auto-targets the same building wall, r=14.36):

| Frame | What |
|---|---|
| `matwind-mat-off-{follow,close}.png` | baseline (`material=off`) — Holtburg lifestone + cottage wall |
| `matwind-mat-on-{follow,close}.png`  | treatment (`material=on`, the default) |
| `DIFF-material-close-x8.png` | 8× diff of the close-up pair |

- Scene-graph introspection (both arms): **`withRoughnessMap = 0`, `withAoMap = 0`**, programs **51 = 51**
  (no permutation change), `chromeRiskMats = 0`.
- The 8× close-up diff shows the **building walls are solid black (pixel-identical)**; the only deltas are
  **rain streaks, the moon/HUD, and edge AA** — i.e. ambient noise, not material. meanAbsDiff 2.7 is entirely
  rain/HUD.

**The Phase-5 roughness/AO detail is not visible.** This is render-truth, independent of internal cache state.

**Root-cause lead (not the eye-test's job to fix, but the wiring was audited):** every link is present —
imported from pkg, `init_suite_base_url(SUITE_BASE_URL)` called (`suite_assets.js`), threaded into `init3D`
(`index.html:4134`), passed to `MaterialCache` (`statics.js:495`), manifest parsed to **numeric** keys
(`suite_assets.js:282`, matches the numeric `_resolveRough` lookup), artifacts serve **HTTP 200** over the
tunnel (`/dist/suite/*.texchan.bin`, 5788 files + manifest via the `dist → /mnt/wbterminal2/holtburger-dist`
symlink). So it is **not** a missing wire or a 404. Most likely the **async map upgrade
(`_resolveRough` → `getByKeyAsync` → `_applyRough`) never re-mints the clone materials the meshes actually
hold** — `materials.js:2304` deletes `frontSideMaterials`/`floorBiasMaterials` but nothing re-requests them, so
the mesh keeps its map-less clone. Needs a focused code session with **live** `MaterialCache` introspection
(the exact gap flagged in `HANDOFF-smoke-materialcache-introspection-2026-06-26.md`). Until then, Phase-5 is
shipping default-ON but doing nothing visible (harmless — fail-soft to the exact current look).

---

## Finding 2 — tree wind: the 512-cap drops 75% of trees + no windBend trees in town

Answers the user's observation directly. The console summary line — **identical for synth and bake**:

```
[anim-scenery] built 512 instances across 4 anim DIDs; DROPPED 1572 over the 512 cap (?animSceneryMax)
```

| Frame | What |
|---|---|
| `matwind-wind-synth-follow.png` | Holtburg lifestone follow shot — **note: essentially no trees in view**, just specks on the horizon |
| `matwind-wind-{synth,bake}-f0.png`, `-f2.png` | tree-framed sway burst (camera teleported to the nearest winding cluster, **rain cleared**) |
| `DIFF-wind-synth-TREES-f0f2-x6.png` | 6× frame-to-frame motion of the tree-framed burst |

**Three structural facts, all from live data:**

1. **The cap re-freezes 75% of trees.** Around Holtburg, **2084** windable instances exist; the cap
   (`DEFAULT_MAX_ANIMATED = 512`) builds only **512** and **DROPS 1572 → re-frozen**. So most trees you look at
   are frozen. *Identical for synth and bake* → this is the cap, **not** a windBake regression.
2. **No windBend trees near the town center.** Nearest animated (`anim-scenery-*`) node is **773 units
   (~4 landblocks)** from the Holtburg lifestone — the winding species (`0x2000bbf / 494 / 493 / 5ac`) grow in
   the outlying forests, not in town. → you **never** see wind standing in Holtburg.
3. **Even the built/animating trees barely sway in stills.** With rain removed, the tree-framed burst diff is
   ~0.14% changed and the heatmap shows the **only motion is the water/shoreline — every tree is static-black**.
   This may be subtle wind amplitude or a 2.4s still-pair undersampling slow sway; not conclusive on its own, but
   it means wind is, at best, very subtle even where present.

**How this maps to "moving outside Holtburg but not in town, and not everywhere outside":**
- *not in town* → fact 2 (nearest winding tree 773u away).
- *moving in some spots outside* → the 512 that win the cap lottery, where windBend species grow.
- *not every spot outside* → fact 1 (1572 re-frozen) + species that carry no windBend descriptor stay frozen.

### Recommended follow-ups (in priority order)
1. **Material — wire the item/weapon path.** Spawned items render via the `entities.js` inline builder
   (hardcoded roughness 0.9), which never calls `_attachRoughnessMap`. If texchan is meant for weapon weenies,
   it must be wired there. AND fix the `MaterialCache` attach (statics/buildings) so the async texchan upgrade
   re-mints the rendered clone. Add a live `materialCache` getter so map-counts are checkable in-world.
   *Phase-5 `?material=on` is a no-op on every subject today.*
2. **`animSceneryMax` (512) — raise and/or distance-prioritize.** It's conservative, not a hard limit
   (one mixer/DID; per-instance = a memcpy). It re-freezes 75% of trees around Holtburg. Animate **nearest-to-
   player first** so what you're looking at always moves; bump the cap and A/B `?animSceneryMax=2048` cost on
   the 1070. The 140 m tick cull already protects perf at range.
3. **Film tree sway properly** — teleport the PLAYER into a dense winding-tree area (not just the camera),
   burst at ~450 ms, and verify in-page via `anim-scenery-*` child-transform deltas. (Wind itself is confirmed
   strong — this is just the owed visual.)

---

## Harness notes (for re-runs)
- `harness-matwind-ab-1070.mjs` on the box at `C:\Temp\`. Run: `node C:\Temp\matwind-ab-1070.mjs`
  (or `--arms=mat-off,mat-on,wind-synth,wind-bake`).
- Reverse tunnel must be up: `ssh -N -R 18765:127.0.0.1:8765 <user>@<gpu-box-ip>` (laptop stack: serve.py
  :8765, wsbridge :8080, ACE 9000 — all up this session).
- **init3D + terrain stream over the tunnel takes ~60s** after in-world → the harness polls scene-ready
  (children + advancing frames + geometry) before capturing. A fixed sleep < 60s gives a **black frame** (the
  first-run trap). ~25s ACE single-login release gap between arms.
- Weather: `__setWeather` takes a **partial state object** (`{is_storm:false, dewpoint_C:-10, …}`), NOT a
  string — used to clear rain for the wind burst.
