# Wire-mode 13-LB tree tour — findings (2026-05-21)

## Summary

**Tree bug confirmed across all 13 landblocks toured.** None of the screenshots
show recognizable tree silhouettes (cone/sphere canopy + trunk cylinder).
Buildings, NPCs, players, characters all render as wireframes correctly —
scenery (the category that includes trees) is the failure mode.

## Method

`tour-lbs.mjs` (in `/tmp/local-wire-validate/`) drives a single headless
chromium with `?wireframe=1&quality=low&agentic=low`. At each LB:

1. `@teleloc 0x<LB>0001 96.0 96.0 200.0` — teleport to LB-local center,
   200 m altitude (server drops to terrain).
2. Sleep 5.5 s for envcells + PVS streams to settle.
3. `window.__wireCameraAlignBehindPlayer()` — sets cameraSwitcher.followYaw
   to player heading so the screenshot shows what's in front, not the side.
   (New helper added to `scene3d/index.js`.)
4. Sleep 400 ms for the camera tick to apply.
5. Screenshot to this directory.

The 13 LBs are 3×3 inner ring around Holtburg (0xA9B4) + 4 cardinal outer
extensions:

```
                  N2 (A9B2)
                       |
            NW   N   NE
       W2  - W  C   E - E2
            SW   S   SE
                       |
                  S2 (A9B6)
```

## Per-LB verdict

| File | LB | Pos | Mesh count | Verdict |
|---|---|---|---:|---|
| `lb_0xA7B4_W2_no0trees_bug.png` | west outer | z=28 (ocean) | 4401 | bug — NPCs + cottage visible, no trees |
| `lb_0xA9B2_N2_no0trees_bug.png` | north outer | z=94 | 7158 | bug — NPCs + cluster of wire props visible, no trees |
| `lb_0xA9B6_S2_no0trees_bug.png` | south outer | z=28 (ocean) | 7590 | bug — pure ocean, fell to sea level |
| `lb_0xA8B3_NW_no0trees_bug.png` | NW inner | z=58 | 7726 | bug — distant cottage cluster + isolated wire structure, no trees |
| `lb_0xA9B3_N_no0trees_bug.png` | N inner | z=106 | 8616 | bug — row of cottages on hillside, terrain wire grid, no trees |
| `lb_0xAAB3_NE_no0trees_bug.png` | NE inner | z=112 | 8962 | bug — beach + lone cottage, no trees |
| `lb_0xA8B4_W_no0trees_bug.png` | W inner | z=48 | 9100 | bug — flat wire terrain + ocean, no trees |
| `lb_0xA9B4_C-Holtburg_no0trees_bug.png` | Holtburg center | z=80 | 9151 | bug — 16 wire cottages clear, no trees |
| `lb_0xAAB4_E_no0trees_bug.png` | E inner | z=54 | 9214 | bug — wire terrain + ocean + small debris cluster, no trees |
| `lb_0xA8B5_SW_maybe4trunks_bug.png` | SW inner | z=28 (ocean) | 9305 | bug — **4 thin vertical wire columns on distant horizon — possibly tree-trunks-without-canopies** |
| `lb_0xA9B5_S_no0trees_bug.png` | S inner | z=28 (ocean) | 9395 | bug — wire terrain + ocean, no trees |
| `lb_0xAAB5_SE_no0trees_bug.png` | SE inner | z=28 (ocean) | 9469 | bug — NPC + terrain + ocean, no trees |
| `lb_0xABB4_E2_no0trees_bug.png` | east outer | z=28 (ocean) | 9469 | bug — pure ocean, fell to sea level |

## What's working

- Wire mode itself is correct: `[wire-agent] ?wireframe=1 — skipping atmosphere/clouds/skydome/CSM, wireframe materials` fires; render path bypasses
  atmosphere + composer.
- 222 statics + 16 buildings baked at boot (per `phase7.2` logs).
- Buildings render as wire cottages with distinct per-DID HSL color buckets.
- NPCs render with names attached (Greeter, Creeper Mosswart, Drudge Slasher,
  Jonathan, etc.).
- Camera helper aligns behind player on each screenshot — the player is
  consistently centred and the world ahead is visible.

## Diagnostic clues

1. **Statics-bake reports 222 placements** — that's the full radius=1 scenery
   count. The placements ARE getting loaded into the scene; they're just not
   rendering as visible tree silhouettes.

2. **SW's "4 distant vertical columns"** are the most suspicious — they look
   like thin obelisks / tree-trunk cylinders without any canopy. Could be:
   - Tree TRUNK part rendered, CANOPY part skipped
   - Tree canopy uses `ClipMap` (binary alpha) surface flag that the wire
     `MeshBasicMaterial({wireframe:true})` swap doesn't handle correctly
   - Tree canopy is built as a billboard sprite, not a mesh — wire mode
     skips billboards

3. **z=28 across 8 of 13 LBs** is sea-level, suggesting many of these areas
   have water terrain at the LB center. The 200 m teleport altitude dropped
   the character into the sea. Most of Holtburg's wilderness IS coastal,
   though — that's geography, not a bug.

4. **Mesh count grows monotonically** 4401 → 9469 across the tour. PVS keeps
   accumulating geometry. If 222 statics × 13 LBs = ~2886 placements were
   added cumulatively, end-state should show all of them in scene-graph
   counts. The mesh growth (9469 − 4401 = 5068) is in that ballpark.

## Likely root causes (hypotheses, not verified)

1. **Tree canopy = ClipMap material** — in non-wire modes the alpha-test
   reveals the leaf cutouts. In wire mode the wireframe MeshBasicMaterial
   has no alpha-test, so the canopy renders as a solid wire box (often hard
   to see at distance). Or the swap path skips ClipMap materials entirely.
2. **Multi-part tree models** — AC tree models can have multiple part
   meshes (trunk + canopy). The bake might only process part 0.
3. **Scenery filter** — `holtburger-scenery-bake` may filter wcids before
   placement. If trees are filtered as "decorative-only" they'd never reach
   the runtime.

## How to verify in the running session

In the page console:

```js
// Count statics by name pattern. Trees usually have wcid starting with
// 0x0AC* or have names like "Pine", "Oak", "Sapling", etc.
let staticsGroup = window.liveScene3d?.staticsGroup;
let trees = [];
staticsGroup?.traverse((o) => {
  if (o.isMesh && o.name?.toLowerCase().includes("tree")) trees.push(o);
});
console.log("scene tree meshes:", trees.length);

// Or count statics by modelId from the bake summary
console.log("staticsBakedLbs:", [...(window.liveScene3d?.staticsBakedLbs || [])].map(k => "0x"+k.toString(16)));
```

## Follow-up — lazy-terrain wire bypass FIXED 2026-05-22

Pre-fix screenshots are archived in `before_lazy_fix/`. Current 13 PNGs
are post-fix. Diff is night-and-day for the outer-ring LBs (S2, E2, W2,
N2, and the inner-but-low-altitude SW/S/SE/E):

- **Before**: textured dark-blue water + brown hill horizons (the
  terrain ShaderMaterial path was running because lazy-loaded LBs went
  through `liveScene3d.loadTerrainForLandblock` where `wireframeMode`
  was undefined).
- **After**: pure wireframe — character + wire terrain grid + distant
  wire ridges. No textured water, no textured hills.

Root cause: `liveScene3d` didn't include `wireframeMode` in its field
spread from `scene3dForBuilders`. The alias precedent at L1441-1443
(terrainOpts/buildingsOpts/staticsOpts) explicitly forwards similar
fields and called out exactly this risk in its comment: "without the
aliasing, `this.terrainOpts` was undefined inside the load* hooks →
bakeTerrainForLandblock threw."

Same pattern, different field. Fix: add
`wireframeMode: !!scene3dForBuilders.wireframeMode` to the liveScene3d
alias block.

Also fixed: hello-cube (Phase 7.0 debug artifact) was the lone
remaining non-wire mesh after the terrain fix. Now uses
MeshBasicMaterial wire when wireframeMode set.

See `VISUAL_FEATURES_AUDIT.md` for a comprehensive survey of which
features are active vs stripped in wire mode.

## Reproduction

```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger
node /tmp/local-wire-validate/tour-lbs.mjs
# Screenshots regenerate in docs/wiretree/
```
