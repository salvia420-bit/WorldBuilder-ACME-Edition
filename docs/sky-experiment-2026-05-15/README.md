# Sky Experiment — Phase Sky-K (2026-05-15)

Three screenshots from a single Holtburg outdoor session at time-of-day
`t=0.10` ("moon overhead" window per the existing skybox-demo memo),
camera pitched 30° up + yawing north. The dome material is mutated
in-session for each shot to mirror the URL-flag construction-time
behavior:

| Shot | dome mode | dome.transparent | dome.depthWrite | uOpacity | Equivalent URL |
|------|-----------|------------------|-----------------|----------|----------------|
| 01-baseline.png | default | false | true | 1.0 | `?renderer=3d` |
| 02-experiment-50pct.png | experiment | true | false | 0.5 | `?renderer=3d&skyMode=experiment` |
| 03-experiment-25pct.png | experiment | true | false | 0.25 | `?renderer=3d&skyMode=experiment&skyAlpha=0.25` |

All shots share the SAME camera + spawn / teleport / time-of-day +
celestial-bake state (17 celestial bakes resolved, 30 sub-meshes).
Only the dome material flags differ. Direct material mutation produces
an identical render-graph state to the URL-flag construction-time path
— same `transparent`/`depthWrite`/`uOpacity` values.

## What each shot shows

**01-baseline.png** — purple gradient sky dome, fully opaque. The moon
silhouette is visible in the upper area as a darker shape with what
looks like cloud-band texture painted INSIDE the moon's silhouette.
This is the artifact the user reported as "clouds in moon."

**02-experiment-50pct.png** — sky goes near-black (dome at 50% alpha
blending with the dark framebuffer-clear color in the sky pass).
Buildings + ground geometry remain visible. The moon and other
celestials are NOT visible — three.js's transparent-queue render
moves the dome BELOW the celestials in draw order (dome.renderOrder
= -1 + transparent=true puts it at the front of the transparent
queue, painting OVER celestials that rendered in the opaque queue
beforehand).

**03-experiment-25pct.png** — visually identical to 02 at this
viewing angle. Slightly lighter sky tint expected at 25% alpha but
the difference is dominated by the framebuffer-clear color.

## Honest assessment

The experiment confirms the user-reported issue (shot 01 reproduces
the clouds-in-moon visual). But the simplistic "make dome
transparent + alpha=0.5" implementation does NOT achieve the
user's stated goal of "proper skybox + parametric overlay at 50%".

Reasons:

1. **No real skybox to overlay onto.** The sky pass framebuffer-clear
   is `0x101418` (renderer.clearColor). With the dome translucent at
   50% over a near-black clear, the result is near-black sky — not a
   "proper skybox view."
2. **Celestials get hidden.** With `material.transparent=true`, three.js
   moves the dome to the transparent queue. The dome's bounding sphere
   is camera-centered (distance 0), so it sorts as the CLOSEST
   transparent mesh and paints LAST in the transparent queue. Even
   though renderOrder=-1 should sort it before other transparent meshes,
   three.js's transparent-queue back-to-front sort treats the dome's
   "closer-to-camera" position as authoritative.
3. **The clouds-in-moon is plausibly retail-correct.** The moon at
   t=0.10 has `transparent` lerping toward 1.0 (the moon is on its
   way to invisible mid-day in retail). The "clouds in moon" view
   could literally be the retail-AC translucent-moon-overlaying-
   cloud-cylinder appearance. The user's complaint may be that the
   moon's transparency window is too aggressive, not a renderer bug.

## What a "real" fix would look like

The user's intent ("proper skybox + dome at 50%") requires:

- A genuine sky texture (cubemap or background plane) that paints
  what the user expects to see behind the dome (stars + nebula +
  cloud detail) — NOT just a framebuffer-clear color.
- The parametric dome blends ON TOP of that sky texture, attenuating
  it toward `horizonColor` near the horizon and revealing it at
  the zenith.

That's Option B from the brief (moon-area cubemap) — out of scope
for this 2-hour experiment.

## Source bits

- `external/holtburger/apps/holtburger-web/scene3d/sky_dome.js`:
  - GLSL `uniform float uOpacity` added to `DOME_FRAGMENT_GLSL`.
  - Constructor parses `?skyMode=experiment` + `?skyAlpha=<0..1>`
    from URL, stores `_skyMode`/`_skyOpacity`, flips
    `domeMat.transparent=true + depthWrite=false` when set, threads
    initial `uOpacity` through ShaderMaterial uniforms.
  - `setExperimentOpacity(alpha)` method + `window.__setSkyOpacity`
    runtime setter for capture-driven sweeps.
  - Default mode unchanged — `?skyMode` absent → uOpacity=1.0 +
    transparent=false (pre-Phase-Sky-K pixel parity).
- `external/holtburger/apps/holtburger-web/smoke_test.cjs`:
  - One new "Phase Sky-K" source-pattern check (6 sub-asserts).

## Reproducing

```sh
# Live stack: ACE on :9000, wsbridge on :8080, http on :8765, proxy 7080.
cd /home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web
NODE_PATH=/home/wbterminal/.npm/_npx/e41f203b7505f1fb/node_modules \
  node /mnt/wbterminal1/tmp/claude-scratch/sky-experiment/capture_sky_experiment.cjs
```

Output lands in `docs/sky-experiment-2026-05-15/`.
