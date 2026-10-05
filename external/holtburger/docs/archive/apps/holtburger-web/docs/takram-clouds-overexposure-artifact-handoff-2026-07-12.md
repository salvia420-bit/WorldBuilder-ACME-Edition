# ✅ RESOLVED (2026-07-12, later same day) — root-caused + fixed

The overexposure wash was **NOT** the atmosphere/aerial/tonemapping layer, and **NOT** any of this doc's original leads (all falsified — see below). It was the **terrain shader's cloud-shadow term**.

## Root cause of the wash
`scene3d/terrain.js` sampled the **wrong channel** of takram's cloud shadow buffer. takram's `shadow.frag` writes `vec4(frontDepth, meanExtinction, maxOpticalDepth, opticalDepthTail)` — so `.r` is a **DISTANCE to the cloud front in metres** (up to `maxRayDistance` ~1e6 when the sky is clear), **not** a density. The terrain fed `.r` into `cloudShadow = max(0.3, exp(-density * uCloudShadowStrength))` (strength **2.0**) with **no upper clamp**. A huge/garbage `.r` sample made `exp()` run **above 1**, multiplying the terrain color into the milky green-white wash.

Why it matched every clue:
- **`clouds=on`-only** — the shadow map only populates when clouds render.
- **real-GPU-only / SwiftShader clean** — SwiftShader zero-bakes the cloud pass → empty shadow map → `exp(0)=1` → no wash. (This is *also* why cloud shadows had literally never been visible — sampling distance-as-density can't ever produce a real shadow.)
- **not lights / not emissive / not additive / not the sky** — it's a pure terrain-`ShaderMaterial` multiply, invisible to every scene-object toggle we tried.
- **"settled, then returned"** — clouds went **default-on** 2026-07-06 (`94945d21`), re-activating the shadow map.

Confirmed live on the R9 290: `window.__setCloudShadowEnabled(false)` cleared the wash cleanly; hiding only the terrain `ShaderMaterial` meshes cleared it; a full lights/emissive/additive/moons/scene sweep did **not**.

## Fixes applied (this session)
1. **`scene3d/terrain.js`** (~L1959) — sample **optical depth `.b + .a`** (takram's own `readShadowOpticalDepth` full-column value) instead of `.r` distance, and `clamp(exp(-max(density,0)*strength), 0.3, 1.0)`. This **fixes the wash AND makes cloud shadows actually render** (clear column → `.b+.a=0` → `exp(0)=1` → lit; cloud overhead → real shadow). Tune with `window.__setCloudShadowStrength(N)` on a real GPU — strength now multiplies a real optical depth (was multiplying a distance), so `2.0` is just a starting guess.
2. **`scene3d/cloud_overlay.js` + `assets/clouds/stbn.bin` (new)** — separate bug: the clouds showed a **~3-second "video loop"**. Cause: the cloud/shadow shaders index a noise texture by `frame % 64` (STBN slice) and `frame % 16` (bayer temporal-upscale) → **lcm = 64-frame cycle** (~3.2s at the R9 290's ~20fps), and holtburger substituted **white noise** for the STBN so the temporal resolve never converged and the deterministic cycle showed through. Fix: bundle takram's **real 128×128×64 blue-noise `stbn.bin`** (downloaded from their pinned asset ref, verified 1,048,576 bytes) and load it via the prebaked-noise path with NearestFilter (blue noise must not be interpolated); white-noise synth kept as instant/failure fallback. **⚠ PENDING LIVE VERIFICATION** — the user still saw looping because the fix was not yet deployed to the R9 290; needs the new asset + JS synced and a reload with **`&nosw=1`**. Watch console for `[clouds] STBN blue-noise load failed` (→ asset not served, fell back to white noise, loop returns).

## Original leads — ALL FALSIFIED (mostly by live test)
- **Adaptive render-scale flurry** (this doc's implicit frame; a later agent's top pick) — REFUTED: `?adaptiveRes=off&renderScale=1` and `window.__adaptiveRenderScale.stop()` did nothing to the wash or the loop.
- **wasm sky-state feed (`lib.rs +2460`)** — DEAD: the in-window `lib.rs` diff has zero sky/sun/exposure/radiance content.
- **torch-immersion (`2853c8c8`)** — OUT OF WINDOW: dated 2026-07-06, before this doc's own `83f88c6b` bracket; `lighting.js` has zero in-window commits. (Doc's "the ONE lighting change in the window" was wrong.)
- **Exposure = 5** — DEAD KNOB: `renderer.toneMapping = NoToneMapping`, so `renderer.toneMappingExposure`/`__setExposure` are inert; the AGX `ToneMappingEffect` takes no exposure. Doc item 4 was a non-test.
- **Additive particles, moons, all 24 scene lights, the sun, self-emissive** — each hidden/zeroed live with **no effect** on the wash.
- **`atmosphere_pipeline.js`** — doc said "unchanged in flurry"; actually `db3f7662` (07-08) changed its depth-texture sizing (not the cause, but the doc was factually wrong).

## ⚠ Separate camera bugs found (NEWLY NOTED — NOT fixed; fix attempt REVERTED)
While investigating, three **pre-existing latent** follow-camera bugs in `scene3d/camera.js` surfaced (they are *not* regressions — `camera.js` is frozen since `2853c8c8`, which only added a read-only `getPlayerWorldPosition` helper):
1. **Camera spawns beside the character, not behind** — `followYaw` is only written at construction (`=0`, due north) and by right-drag; it is **never seeded from the player's spawn/teleport heading** (`getLocalPlayerPose().heading`). Spawn facing any non-north heading → camera off to the side.
2. **"Panning zooms in"** — the follow-mode wheel handler treats *any* `deltaY` as a zoom notch, so a two-finger trackpad pan (`deltaX≈deltaY`) notches the zoom; plus pitch foreshortening (`horizDist = dist·cos(pitch)`, up to ~6× near `FOLLOW_PITCH_MAX`). `_retailZoomOn` is default-ON via a `!== "off"` footgun.
3. **Sticky zoom, no reset** — `_retailZoomNotch` permanently overwrites `followDistance` and can latch `_inHead=true` (first-person) with no reset path; one stray notch stays for the session.

A fix was attempted (seed `followYaw` from heading on first spawn + re-seed on teleport; require `|deltaY|>|deltaX|` for wheel-zoom; add `resetZoom()` fired on teleport) and **REVERTED 2026-07-12** — live, the `followYaw` seed *jutted the camera to the side of the character during normal play* (worse than the original). Suspected causes for the next agent: (a) a **heading-convention mismatch** between `getLocalPlayerPose().heading` and `followYaw` (sign/offset), and/or (b) the **teleport re-seed firing repeatedly** because the `_predPrevLandblockId` vs `target.landblockId` compare in `_smoothToIntegrator` flickers during streaming, re-clearing the latch every frame. Re-attempt only after verifying the heading convention empirically (log `getLocalPlayerPose().heading` vs `followYaw` at a known facing) and debouncing the LB-change edge to a true one-shot. The `|deltaY|>|deltaX|` wheel gate and a `resetZoom()` escape are low-risk and can be re-landed independently of the yaw seed.

## Files changed (committed this session)
`scene3d/terrain.js`, `scene3d/cloud_overlay.js`, `assets/clouds/stbn.bin` (new), this doc. (`scene3d/camera.js` fix was reverted — see above.)

---

# Handoff — takram atmosphere "overexposed wash + bright streaked orbs" artifact (2026-07-12)

## TL;DR
With `?clouds=on` on a **real GPU**, the scene renders **massively overexposed** (milky green-white wash over everything) with **two bright orbs trailing comet-tail "laser" streaks** that move/pulse on a **rhythmic cycle**. Reported as "we broke takram" after a ~3–4 day perf flurry (≈2026-07-08 → 07-11, up to HEAD `f70f3f9f`). User is "pretty sure it worked before the flurry" (tested then on an R9 290 via a cloudflared tunnel).

**Not yet root-caused.** This doc records what's been ruled out so the next agent skips it and goes straight to the open leads (bisect + a few untested toggles).

Reference screenshot (R9 290, clouds on, mid quality): https://i.ibb.co/rhHXKgr/dsgsdgdsg.png — grassy outdoor area (0xE600), whole frame washed milky-green, two blown-out orbs with linear tails.

## Environment / how to reproduce
- **Real GPU required.** Confirmed on the 1070 (ANGLE/GTX-1070/D3D11) *and* the R9 290 (cloudflared). **SwiftShader cannot reproduce it** — it zero-bakes the cloud/atmosphere raymarch, so the sky renders black and the world renders perfectly clean (this cleanly rules out world geometry/materials/lighting; see below).
- **1070 is currently OFFLINE** (tailscale `young@100.127.215.75` down mid-investigation; likely asleep). It's the only local real GPU. R9 290 is the user's box, reachable only by them pasting console (firewall: SSH-to-tailscale only, no inbound to the R9 290).
- Repro URL (R9 290, via their cloudflared): `…/holtburger-web/?renderer=3d&autoLogin=1&account=phase4demo&password=phase4demo&autoSpawn=first&bridge_url=wss://<cf>/wsbridge&server_host=127.0.0.1&server_port=9000&clouds=on&rain=off&lightning=off&snow=off`
- Quality auto-selects **`mid`** on the R9 290 (source: default). At mid: `bloom:true`, `lightShafts:false`, `csm:false`, `lensFlare:false`, `shadows:true`. devicePixelRatio ≈ **1.5** → adaptive-res thrashes pixelRatio ~1.0–1.5.
- Local 1070 (earlier, before it went offline): at high cloud coverage the whole 3D viewport went **uniform white or black, flipping with camera heading**. This is *plausibly the same artifact* (dense cloud sheet + blown atmosphere covering the frame) but was never confirmed identical to the R9 290 look.

## Effect chain (atmosphere_pipeline composer, at mid quality)
`['H2', 'BloomEffect', 'ToneMappingEffect', 'le']`
- **`H2` = AerialPerspectiveEffect** (takram, minified). ⚠ Earlier toggles that matched `/Aerial|Atmosphere/` silently matched nothing — aerial was NOT disabled until we targeted index 0 directly.
- `le` = DitheringEffect (minified).
- Build order in code: `[aerialPerspective, horizonDissolve?, lensFlare?, bloom, vignette?, toneMapping, dithering]` (horizonDissolve/lensFlare/vignette not built at mid).

## RULED OUT (with method + result)
1. **lightShafts** (takram crepuscular/god-rays, `effect.lightShafts`): OFF at mid quality. `window.__setLightShafts(false)` and a `lightShafts=off` reload → **no change**.
2. **Bloom** (`BloomEffect`): `blendMode.opacity.value=0` → **no change**. ⚠ see caveat below.
3. **AerialPerspective** (`H2`, effect index 0): `blendMode.opacity.value=0` → **no change**. ⚠ see caveat below.
4. **Exposure**: `window.__setExposure(1)` (from boot default 5) → no change. `renderer.toneMappingExposure` reads 1; AGX tone-map lives in the composer `ToneMappingEffect`, not the renderer.
5. **Depth-texture mis-size** (the 2026-07-08 `atmosphere_pipeline.js` framebuffer-incomplete fix — prime early suspect because of non-integer pixelRatio): **CLEANLY RULED OUT.** `getSceneDepthTexture()` = `[810,768]` == canvas drawing buffer `[810,768]` at pr 1.01. Depth is correctly sized.
6. **Cloud effect resolution collapse** (1×1 RT → uniform output): ruled out. `effect.resolution.effectiveSize = {x:1195,y:1134}` (full size).
7. **Cloud camera feed**: `cloudsPass.mainCamera === renderCamera` (true). `inverseProjectionMatrix` is a valid perspective inverse (element[5]=0.577=tan30° → rays spread). `inverseViewMatrix` clean rotation+translation. `sunDirection=(-0.853,0.522,0)` valid. All noise textures loaded (shape 128³, shapeDetail 32³, localWeather 512², turbulence 128², stbn 64³).
8. **Camera matrices**: all finite. `camPos ≈ (29089, 22, -23665)` on R9 290 / `(33578, 30, -24826)` on 1070 — **large (~37 km), but by design**: the world is NOT rebased near origin (no recentering in code or in the flurry; `index.js:1857` comment only). Takram maps world→ECEF via `worldToECEFMatrix = translate(0, bottomRadius≈6.36e6, 0)`, so large X/Z is expected and gives only a sub-degree ellipsoid tilt. This is NOT new and NOT the bug.
9. **Lens flare**: default OFF (`lensFlareOpt=false`), not built at mid. User confirmed it's "not lens flare, not the moons."
10. **NaN geometry** in `liveScene3d.scene`: clean. Scanned 8564 objects for non-finite matrixWorld / position attrs / instanceMatrix → **0 bad**.
11. **World geometry / materials / scene lighting**: renders **perfectly clean on local SwiftShader** (grass/trees/character all correct; only sky is black). So the artifact is NOT in the world layer — it's in the **atmosphere/sky/post layer that only a real GPU renders**.
12. **Cloud overlay quad** as the *sole* cause: user hid `cloudOverlay.overlayMesh` and "caught a glimpse" of the artifact **underneath** → the wash/orbs persist under the cloud quad (cloud coverage was just compounding it).

### ⚠ IMPORTANT CAVEAT on items 2 & 3 (bloom, aerial "no change")
The disable method was `effect.blendMode.opacity.value = 0`. It is **unverified whether this actually neutralizes these takram/pmndrs effects.** Disabling AerialPerspective should visibly strip the atmospheric tint; "no change" could mean the disable *didn't take*. **First thing the next agent should do: disable `ToneMappingEffect` the same way (`chain[2].blendMode.opacity.value=0`).** AGX tone-mapping off should make the image change *dramatically*. If it DOESN'T, the opacity-disable method is ineffective for these effects and items 2 & 3 (and any other opacity-based toggles) are **false negatives** that must be re-tested (e.g. by removing the pass from `composer.passes`, or `effect.blendMode.blendFunction = NORMAL/SKIP`).

## OPEN / NOT CLEANLY TESTED (highest-value leads first)
- **Bisect on a real GPU.** Every specific render suspect (clouds_overlay.js, cloud_volume.js, takram vendor, ac_moons.js, atmosphere_pipeline bloom/lensflare/exposure, atmosphere_runtime exposure) is **UNCHANGED across the flurry**. So the regression is almost certainly a **shared** change: `src/lib.rs` (+2460, the wasm sky-state / sun feed), the one lighting change (**torch-immersion, point pool 8→16**, `2853c8c8`, → 63 scene lights), or a global renderer/scene-state change. A git bisect (pre-flurry worktree, its own wasm build, served on an alt port) is the surest path. Pre-flurry candidate: `83f88c6b` (2026-07-07, just before the 07-08 render-scale/framebuffer/sealed work).
- **Moons — never got a clean yes/no.** Two bright orbs == two moon billboards (`liveScene3d.acMoons.albMesh` / `.rezMesh`) is the strongest *visual* match; "rhythmic" fits their orbit + shader (`uScintIntensity` scintillation stepped on `uTime*5`, `uMicroLights` "pulse at their own period", `uCityIntensity`). Moon dump was healthy (tex 1024² loaded, scale (1,1,1), matrix finite, brightness 1.25). ac_moons.js is unchanged in the flurry. **Definitive test still owed:** hide BOTH moons and get a clear "orbs gone / still there".
- **VFX/particles** hide (`Points`/`Sprite`/emitter meshes) — never reported.
- **AGX ToneMapping** — untested (see caveat; also the validity probe).
- **wasm sky-state feed** — `sessionHandle.getSkyState()` → sun direction/intensity into both the atmosphere sun-light and the cloud material. A wasm regression here (lib.rs +2460) could feed a blown sun radiance → overexposure + blown sun/moon. **Not yet inspected.**
- **Scene-light overflow** — 63 lights (39 hidden PointLights + 16 active + 3 DirectionalLights + 2 SpotLights + Hemi + Ambient) after torch-immersion 8→16. Could push texture-unit/uniform limits when the cloud shader's many samplers are also bound. Untested.

## Useful console snippets (developed this session)
Install a toggle panel (note the aerial-by-name bug — use index 0 for aerial):
```js
window.__FX=(()=>{const lp=window.liveScene3d;const ap=window.__atmospherePipeline||lp?.atmospherePipeline;const es=()=>{const o=[];(ap?.composer?.passes||[]).forEach(p=>(p.effects||(p.effect?[p.effect]:[])).forEach(e=>o.push(e)));return o;};return{
  moons:on=>{lp.acMoons.albMesh.visible=on;lp.acMoons.rezMesh.visible=on;},
  clouds:on=>{if(lp.cloudOverlay?.overlayMesh)lp.cloudOverlay.overlayMesh.visible=on;},
  effIdx:(i,on)=>{try{es()[i].blendMode.opacity.value=on?1:0}catch(e){}},   // 0=aerial 1=bloom 2=tonemap 3=dither
  vfx:on=>{let n=0;lp.scene.traverse(o=>{if(o.type==='Points'||o.isSprite){o.visible=on;n++}});return n;},
  list:()=>es().map(e=>e?.constructor?.name)};})();
```
Validity probe (run FIRST): `window.__FX.effIdx(2,false)` — AGX tone-map OFF. If the image barely changes, the opacity-disable is a no-op and re-test everything by pass removal instead.

Moon definitive test: `liveScene3d.acMoons.albMesh.visible=false; liveScene3d.acMoons.rezMesh.visible=false;` → look.

Cloud material / camera dump, noise textures, sky-state, etc.: see conversation; key ones reproduced above.

## Key files
- `apps/holtburger-web/scene3d/atmosphere_pipeline.js` — composer, effect chain, bloom/lensflare/tonemapping, shared depth texture (the 07-08 resize change).
- `apps/holtburger-web/scene3d/cloud_volume.js` / `cloud_overlay.js` — takram cloud effect wiring, world→ECEF, cameraHeight patch (all unchanged in flurry).
- `apps/holtburger-web/scene3d/ac_moons.js` — the two moon billboards + animated shader (unchanged in flurry).
- `apps/holtburger-web/scene3d/quality.js` — preset flags (bloom/lightShafts/csm per tier).
- `apps/holtburger-web/scene3d/lighting.js` + `2853c8c8` — torch-immersion (pool 8→16); the ONE lighting change in the window.
- `apps/holtburger-web/src/lib.rs` — wasm (+2460 in flurry); sky-state/sun feed = prime untested shared suspect.

## Recommended next steps (in order)
1. Run the **tone-map validity probe** to confirm the opacity-disable actually works; if not, re-test bloom + aerial by pass removal.
2. Get the **definitive moon hide** yes/no.
3. If neither: **bisect** on a real GPU (wait for the 1070, or have the user serve a pre-flurry checkout on the R9 290). Bracket first at `83f88c6b`.
4. Inspect the **wasm sky-state** (`getSkyState()` sun direction/intensity) and the torch-immersion light set for a blown value.
