# Optical Effects — Handoff

Survey of atmospheric / optical effects still available from takram + pmndrs
that we haven't wired yet, ordered by AC-vibe-per-hour, with concrete perf
budgets for two real hardware targets the user owns.

## Current pipeline (as of c93064a)

`scene3d/atmosphere_pipeline.js`, in render order:

1. **skyRenderPass** — sky scene (SkyMaterial + stars + AC moons + cloud overlay quad)
2. **worldRenderPass** — main scene, `clear=false, clearDepth=true`
3. **EffectPass** — `AerialPerspective → LensFlare → ToneMapping(AGX) → Dithering`

Sun disc just got bumped to `sunAngularRadius = 0.03` (default), tunable via
`?sunSize=N` and `window.__setSunSize(N)`. AC moons are billboards on
`skyDome.skyScene` with their own shader (`scene3d/ac_moons.js`).

## Hardware targets

| Target | GPU | Native | Useful render scale | Frame budget |
|---|---|---|---|---|
| R9 290 (work, today) | 2013 GCN1.1, 4GB, ~5.6 TFLOPS | 4K 60Hz | **25%** (= 1080p effective) | 16ms |
| GTX 1070 (home) | 2016 Pascal, 8GB, ~6.5 TFLOPS | 1440p or 4K | 50–100% | 16ms |
| Low-bar laptop | Iris-class | any | 25%, `quality=low` | 16ms |

Render scale already lives in the login dropdown + `?renderScale=N`. Every new
effect MUST cost-scale with render scale (i.e. operate on the composer's
internal RT, not the canvas) so 25% buys back ~4× headroom automatically.

R9 290 driver gotchas: HalfFloat depth sampling with LINEAR filter regressed
in cloud_overlay before — see `INTERACTING_LAYERS_ANALYSIS.md`. New effects
that read depth need NEAREST and a sentinel-aware threshold.

## Priority queue

### 1. BloomEffect — ★★★★★, ~1–3ms @ 1080p

What: soft HDR halo around bright pixels. The Wardiel02 reference sun's glow
is mostly bloom, not LensFlare. Also helps lava, magic spells, lit windows.

Wire: `import { BloomEffect } from 'postprocessing'` and add to the existing
`EffectPass` between LensFlare and ToneMapping in `atmosphere_pipeline.js:166`.
Single instance, share the EffectPass — adding a new pass costs another
fullscreen blit.

```js
const bloom = new BloomEffect({
  intensity: 1.0,
  luminanceThreshold: 0.85,
  luminanceSmoothing: 0.1,
  mipmapBlur: true,    // ~1ms vs 3ms for Gaussian
  radius: 0.85,
});
const fxPass = new EffectPass(camera, aerialPerspective, lensFlare, bloom, toneMapping, dithering);
```

Perf: `mipmapBlur: true` is the cheap path — 5-level downsample chain, ~1-2ms
at 1080p on R9 290. Tunable via `quality.js`:
- `low`: disabled
- `medium`: `intensity 0.6, mipmapBlur true, levels 3`
- `high`/`ultra`: `intensity 1.0, mipmapBlur true, levels 5`

Failure mode to watch: HDR clipping. The composer uses HalfFloat input
buffer (`atmosphere_pipeline.js:83`) so bright sun pixels should be >1.0
and bloom kicks in correctly. If bloom looks weak, log `luminance` at the
sun's screen-space center and confirm it's >>1.

### 2. GodRaysEffect — ★★★★★, ~2–4ms @ 1080p

What: crepuscular rays — radial light shafts from the sun, occluded by
volumetric clouds. The signature "sun breaks through clouds" shot.

Wire: pmndrs `GodRaysEffect` takes a lightSource Object3D and the sun's
screen position drives the radial blur. The occlusion mask comes from
rendering the lightSource (a small sphere at sun direction × far distance)
into a separate pass with everything else as black.

Critical: the cloud overlay needs to participate in occlusion. Today the
overlay paints in the sky pass; for god rays we need clouds visible in the
occlusion mask too. Cheapest path: render the cloud overlay quad into the
occlusion buffer at greyscale via a custom material override (clouds = black,
sun = white). Don't try to derive it from the existing `cloudsBuffer` RT —
its alpha is for compositing, not light extinction.

```js
import { GodRaysEffect } from 'postprocessing';

const sunMesh = new THREE.Mesh(  // invisible to main render
  new THREE.SphereGeometry(50, 8, 8),
  new THREE.MeshBasicMaterial({ color: 0xffffff }),
);
sunMesh.layers.set(GODRAYS_LAYER);
scene.add(sunMesh);
// per-frame: sunMesh.position = camera.position + sunDir * 1000

const godRays = new GodRaysEffect(camera, sunMesh, {
  samples: 60,        // R9 290: 30, GTX 1070: 60
  density: 0.96,
  decay: 0.93,
  weight: 0.4,
  exposure: 0.6,
  clampMax: 1.0,
  blur: true,
});
```

Perf: samples count is the main knob. 30 on R9 290 ≈ 2ms; 60 ≈ 4ms.
Quality presets:
- `low`: disabled
- `medium`: 20 samples (sub-1ms)
- `high`: 40 samples
- `ultra`: 60 samples

Failure mode: GodRays needs the sun to actually be in (or near) the
screen-space frame to do anything. When sun is behind camera, the effect
contributes nothing — that's fine, but the depth sample / occlusion render
still costs. Add a "sun above horizon AND in FOV" early-out that skips the
extra pass entirely.

### 3. moonAngularRadius bump on SkyMaterial — ★★, ~0ms

What: same trick we just did for the sun. Takram's underlying moon is
real-world tiny. Today we paint AC billboard moons on top, but if the
billboards ever turn off (or for the `atmosphere=on&moons=off` debug
path) the bare takram moon would read as a pinpoint.

Wire: `scene3d/atmosphere_sky.js`, right after the sun bump (~line 110).
Add `moonAngularRadius` setter — verify the property exists on
`SkyMaterial` by grepping the takram CDN bundle (sun has it, moon
should too, but they may share `ATMOSPHERE.value.moon_angular_radius`).

```js
if ('moonAngularRadius' in this.skyMaterial) {
  this.skyMaterial.moonAngularRadius = 0.025;  // matches Rez billboard-ish
}
```

Perf: free.

### 4. Cloud shadows on terrain — ★★★★, ~1–3ms

What: the cloud volume occludes the directional sunlight on the ground.
Today our terrain is lit by an unoccluded SunDirectionalLight, so a sky
full of clouds still casts hard 1.0 light on grass.

Wire: takram-three-clouds has a `shadowBuffer` capability — a low-res
view-from-sun render of cloud extinction. The terrain shader needs to
sample that buffer at the world position, projected through the
sun-view matrix. Code path is in
`vendor/takram-three-clouds/src/CloudsEffect.ts`; look for
`shadowLength`, `shadowMatrix`, `shadowBuffer` exports.

The terrain material chain (`scene3d/terrain_material.js` or wherever
the surface classifier output ends up) needs a `uCloudShadowMap` +
`uCloudShadowMatrix` uniform pair, and a single texture lookup in
the fragment shader, multiplied into the direct-light term.

Perf: shadow buffer is typically 512×512, ~0.3ms to render. Terrain
fragment cost: one extra texture sample. ~1-3ms total depending on
terrain pixel coverage.

Failure mode: shadow-map projection bugs (shadow drifts as camera
moves), shadow boundary aliasing. Mitigate with a 1-2 texel softening
in the terrain shader.

### 5. VignetteEffect — ★, <0.5ms

What: subtle dark frame edges. Free atmosphere. AC didn't have this
canonically (low-poly, no postprocess) but the takram sky already
breaks that frame so adding vignette is consistent.

Wire: `EffectPass(camera, ..., vignette, toneMapping, dithering)` —
must come BEFORE tonemapping so the darkened pixels are still in
HDR space. pmndrs `VignetteEffect({ offset: 0.4, darkness: 0.4 })`.

Perf: single fullscreen mul. Negligible.

Quality:
- `low`/`medium`: disabled
- `high`/`ultra`: on, intensity 0.3

## NOT in takram — would need custom work

Listed for the user's sidequest queue, in case they ask. None of these
should be defaults; all should be opt-in via URL.

### Aurora borealis — ★★★ (user is a weather fan, mentioned by name)

Not in any atmosphere library. Reference: Shadertoy
`https://www.shadertoy.com/view/XtGGRt` (nimitz aurora) — port the
fragment shader onto a sky-dome shell sphere at high latitude
(takram's getECIToECEFRotationMatrix already gives us a "north pole"
direction in world space).

Render: separate Mesh on `skyDome.skyScene`, renderOrder between
moons (800) and clouds (999), depthTest off. ~1-2ms cost (it's a
small portion of the sky, near the polar direction).

Toggle: `?aurora=on`. Default off (AC has no aurora canon, but the
weather-fan user will love it).

Triggering: in a future weather system, tie probability to
"night + clear + high latitude" — the existing `weather_state.js`
already routes a `?weather=N` knob through cloud uniforms.

### Halos (22° ring, sun dogs, sun pillars), rainbows, mirages

Niche. Skip until specifically asked. Halos need ice-crystal optics
in a sky-shader; rainbows need rain particles + Mie-scattering shader;
mirages need a heatmap-driven distortion postprocess.

### Lightning

Trivial as a flash overlay (single fullscreen white-flash with
exponential fade). Pairs with a future storm/weather system, not
worth wiring before that exists.

## Quality preset integration

`scene3d/quality.js` is the central knob registry. For each new effect
above, add a flag:

```js
// scene3d/quality.js
const PRESETS = {
  low:    { bloom: false, godRays: false, cloudShadows: false, vignette: false },
  medium: { bloom: {mipmapBlur:true, intensity:0.6, levels:3}, godRays: false, cloudShadows: false, vignette: false },
  high:   { bloom: {intensity:1.0, levels:5}, godRays: {samples:40}, cloudShadows: true, vignette: true },
  ultra:  { bloom: {intensity:1.0, levels:5}, godRays: {samples:60}, cloudShadows: true, vignette: true },
};
```

Each effect respects `?bloom=N`, `?godRays=N`, `?vignette=N` overrides
(see `?sunSize=N` and `?moonSpeed=N` for the existing pattern). The
URL override beats the quality preset.

### Recommended R9 290 @ 25% defaults

`?quality=high&renderScale=0.25` should get bloom + god rays + vignette
+ cloud shadows enabled, with target ~12ms/frame total. That leaves
4ms of headroom for the existing atmosphere + cloud passes which fluctuate.

If frame pacing janks, drop in this order:
1. `cloudShadows` off
2. `godRays.samples` → 20
3. `bloom.levels` → 3

### Recommended GTX 1070 @ 100% defaults

`?quality=ultra` everything on, full samples. ~10–14ms/frame budget.

## Failure modes / things to watch

- **HalfFloat depth + R9 290 driver** — see prior cloud_overlay incident
  (sentinel default 0.0). Any new effect that reads `composer.depthTexture`
  needs NEAREST filtering and sentinel-aware threshold.
- **EffectPass shares depth ownership** — adding effects to the same EffectPass
  shares one depth sample; adding separate EffectPass instances re-samples
  depth per pass. Prefer combining when possible.
- **Render scale + screen-space passes** — bloom's `mipmapBlur` derives levels
  from the composer RT size. At 25% scale, level-5 = 8×8 lowest mip, which
  is fine. Watch out below 25%.
- **Aerial perspective writes to bright sky pixels too** — bloom's luminance
  threshold should be ≥0.85 to avoid blooming the whole sky.

## Test plan

For each effect ship:
1. Wire it gated on a `?<flag>=on` URL param (don't touch quality presets yet).
2. Smoke: `EffectComposer` builds without error, render-loop ticks.
3. R9 290 sanity: at `?renderScale=0.25&<flag>=on`, frame time stays under
   16ms in Holtburg square (camera at the fountain, 60° FOV, midday).
4. Eye-test against an AC reference screenshot if applicable.
5. Wire into `quality.js` presets per the table above.
6. Push to master, user verifies on R9 290 via tunnel.

## Pointers

- Pipeline: `scene3d/atmosphere_pipeline.js`
- Sky: `scene3d/atmosphere_sky.js` (SkyMaterial uniforms)
- Quality: `scene3d/quality.js`
- Cloud overlay: `scene3d/cloud_overlay.js`
- Cloud volume / shadow buffer: `vendor/takram-three-clouds/src/CloudsEffect.ts`
- Existing URL knob pattern: `?sunSize=`, `?moonSpeed=`, `?renderScale=`, `?clouds=on`
- Existing devtools knobs: `window.__setSunSize`, `window.__setRenderScale`, `window.__setCloudCoverage`

## Suggested first ship

**BloomEffect alone.** Lowest risk, highest ratio of "looks better" to "lines
of code." Then GodRays once Bloom is bedded in. Cloud shadows last because
it touches the terrain shader and could regress the surface classifier work.
