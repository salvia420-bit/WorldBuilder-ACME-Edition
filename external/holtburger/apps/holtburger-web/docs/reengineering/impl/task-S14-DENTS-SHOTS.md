# S14 — five in-game frames of "dents follow the art"

Owner's ask: *"are these dents follow arts etc live? can i see shots of them
ingame?"* — the frames are the deliverable, not this note.

All five taken from **ONE login** (`agentp08`), one live browser held open across
every arm, on the BUILDBOX T4. Renderer asserted from inside the page:
`ANGLE (NVIDIA Corporation, Tesla T4/PCIe/SSE2, OpenGL ES 3.2)`. Boot reached
`__bootState === 'ready'`. `?quality=mid` pinned explicitly, `?renderScale=1`,
`?nosw=1`, `?skytime=9`, `?camDebug=on`. Capture is readPixels inside the final
present pass (`page.screenshot()` photographs a black world).

No wasm rebuild. The served `pkg/holtburger_web_bg.wasm` (Aug 11 23:34) postdates
the last `height_seam.rs` commit (`2776b5e4`, Aug 3); the only later Rust commit
is `relief_v2_probe`, an offline example. serve.py's "predates" banner is a false
alarm here. The v2 class table is `include_str!`-compiled into the wasm
(`data/tex-relief-classes.compact.json`, 20 684 entries), so it cannot be stale
relative to the bake.

## The five files sent

| file | what it shows |
| --- | --- |
| `s14-1-stone-joints-ONvsOFF.png` | Stone `0x06003EC4` (class **S**), 3.4 m, grazing. OFF / ON / `|ON−OFF|`×8. The relief response traces the block joints and carving. 41.9 % of pixels move. |
| `s14-2-stone-ZOOM-dents-in-joints.png` | Same wall, 2× zoom, OFF / ON / **CRANKED ×3 (labelled EXAGGERATED, not shipped)**. Follow one mortar/moss line: paint only → shaded lip → unmistakable groove. |
| `s14-3-painted-control-no-emboss.png` | Painted surface `0x06003948` (class **F**, Flush), 2.9 m, torch-lit. Diff panel is near-black — the safety control. |
| `s14-4-DISCRIMINATION-stone-vs-painted.png` | The whole claim in one frame: stone diff (traces joints) beside painted diff (near-nil), **same ×8 gain**. This is what "discriminating, not just adding bumps everywhere" looks like. |
| `s14-5-second-stone-texture-follows-veining.png` | Different textures `0x06003DCB` / `0x06003DCF` (class **S**) — not one lucky texture. Response follows the rock's own dark veining. 65.4 % of pixels, mean \|Δ\| 16.9/255. |

## What the A/B lever actually was — read this before trusting the frames

**I did not use `window.__statPom`.** Measured live: of 1 697 static meshes in
the Holtburg scene, only **28** (the `stat-atlas-x-*` cross-LB atlas buckets)
carry `_statPomUniforms`. Every building surface I could compose on is a
singleton / `THREE.BatchedMesh` `static-*` mesh on the **legacy normal-map +
per-surface POM** path. `__statPom` would have been a no-op on all five frames.

That is not a problem for the claim, because both vehicles are fed by the *same*
v2 chain — `lib.rs:12238 relief_height_classed(pixels, w, h, class, rs_id)` is
the choke point for the singleton `normalMap`, the atlas `nra` R,G **and** POM's
height. The lever I used is `material.normalScale` (a genuine live uniform):
`0` = the v2 height field contributes no shading, shipped = it does.

Consequences, stated plainly:

- The **crank** arm is `normalScale ×3`, **not** `?statPomDepth`. Labelled
  EXAGGERATED on the frame.
- The **OFF arm is conservative**: `pomUniforms` are compile-time config, not
  live uniforms, so legacy POM is still running in the OFF frames. The measured
  differences are therefore a **lower bound** on what v2 contributes.
- **statPom's own on-screen contribution is NOT verified here.** The one place I
  A/B'd it live (Cragstone flagstone road, `__statPom({on:false})`, 15 buckets
  touched) the diff was animation only — that road is terrain, not an atlased
  static.

## Honest caveats

- **Light and view dependence is large.** Same rock, same build: the sun-facing
  face moved 8.5/255 mean, the grazing-lit face 16.9/255. Head-on with frontal
  light it nearly vanishes. 5/5 says so on the frame.
- `window.__skyTimePin` exists but does **not** re-light live (day-group baked);
  the sun stayed at pitch 41.6°, heading 90 for every frame. I did not fake the
  lighting — I moved the camera to faces the existing sun rakes.
- Subjects are a carved stone monument and a rock mass, not a tidy brick wall.
  Only 1 483 of 20 684 classified surfaces are architectural (S/B/T/P/H);
  17 500 are Flush. Architectural surfaces near a reachable vantage were scarce.
  `0x06003E69` is class **B** but renders as a green crystal pillar — a
  classifier mislabel; I dropped it rather than caption a crystal as "brick".
- Avoided `0x06004381` (Shoushi shingle) per brief — the known worst-of-148.

## What the owner would see on his own laptop

His machine probes to `low`. On `low`: `statPom: false` and `pom: false` — **but
`normalMaps: true` and `gfxRelief: true` on all four tiers**. The vehicle these
five frames demonstrate is the normal-map one, so the dents-follow-the-art
shading *is* live for him; what he loses at `low` is the parallax depth, not the
content-following.

## Rig

Persistent-CDP rig in `docs/evidence/s14-shots/` — a one-shot step program cannot
be steered by what the previous frame showed, and the 3-min per-account login
cooldown makes rebooting per arm untenable. `s14boot.mjs` leaves Chrome alive;
`s14x.mjs` / `s14shot.mjs` re-attach. Capture and the `preserveDrawingBuffer`
fix are lifted from `~/eyetest/arm.mjs`.
