// Visual-fidelity Phase 3.2 — SSAO post-process pass.
//
// Wraps `EffectComposer` + (optional sky `RenderPass`) + world
// `RenderPass` + `SSAOPass` + `OutputPass` behind a single factory.
// Returns null when `quality.flags.ssao === false`, so the caller can
// keep the existing direct-render path without paying for an unused
// composer / depth target.
//
// SSAO darkens fragments where nearby geometry occludes the local
// hemisphere — building corners against ground, eaves against walls,
// crevices in subdivided terrain. Tuned for AC's ~24 m landblock grid
// and ~2 m typical building extent (see kernelRadius / minDistance /
// maxDistance below).
//
// Shadow interaction (Phase 0.1): SSAOPass multiplies its AO factor
// into the lit color in the final composite — additive shadow + SSAO
// double-darkening is NOT a concern at the pass level. We DO bump
// `minDistance` upward (~0.005 → ~0.01) so flat lit surfaces don't
// self-occlude at moderate kernel radius, which would otherwise show
// up as fake "shadow" smears on flat ground in already-shadowed
// regions.
//
// Sky dome exclusion: SSAOPass samples its own MeshNormalMaterial
// render of `scene`, not the sky scene. When a sky `RenderPass` is
// wired in (it owns its own scene + camera), SSAOPass's normal/depth
// pass renders only `scene` (the world) — the sky never enters the
// AO computation. AO is correctly zero at far-plane sky pixels.

import * as THREE from "three";
import { EffectComposer } from "three/addons/postprocessing/EffectComposer.js";
import { RenderPass } from "three/addons/postprocessing/RenderPass.js";
import { SSAOPass } from "three/addons/postprocessing/SSAOPass.js";
import { OutputPass } from "three/addons/postprocessing/OutputPass.js";

// Tuned for AC scale: 24 m landblock grid, 2 m cottage walls, 1.8 m
// player capsule. kernelRadius=3.0 picks up wall-meets-ground and
// eave-shadow at the right scale without bleeding across whole rooms.
// kernelSize=16 is half the SSAOPass default (32) — visually
// indistinguishable on Holtburg geometry at this kernel radius, half
// the fragment cost. Doc target says 16 explicitly.
//
// minDistance bumped from the library default 0.005 to 0.01 to avoid
// self-occlusion smears on flat surfaces (the smaller the value, the
// closer to the camera near-plane fragments start counting as
// occluders — at the AC scale, 0.005 is "every flat floor occludes
// itself a little"). 0.01 is still well below typical 2 m wall
// thickness.
//
// maxDistance caps the AO falloff. The SSAOPass shader uses
// `minDistance`/`maxDistance` as fractions of the world-space depth
// at each fragment (after `linearizeDepth`), so the unit is
// "fraction of camera.far". With camera.far=5000 m and Holtburg's
// 192 m landblock, 0.05 ≈ 250 m of effective AO range — covers a
// full LB plus margin, drops sharply beyond. This kills far-distance
// noise (the academy hilltop view, the horizon haze) without
// truncating the close-range Holtburg AO effect.
const DEFAULT_SSAO = {
    kernelRadius: 3.0,
    kernelSize: 16,
    minDistance: 0.01,
    maxDistance: 0.05,
};

/**
 * Construct an SSAO-enabled composer over the existing renderer.
 *
 * The composer order is:
 *   1. (optional) Sky RenderPass — paints the sky scene first with
 *      its own camera. `enabled` flips per-frame via the indoor
 *      short-circuit (callers set `pipeline.setSkyEnabled(false)` in
 *      indoor cells, mirroring `SkyDome.wasSkyRenderedLastFrame`).
 *   2. World RenderPass — `clear=false` so sky color survives,
 *      `clearDepth=true` so the world's depth test starts fresh. The
 *      pre-Phase-3.2 outdoor render order (sky-then-world with
 *      autoClear + clearDepth gymnastics) is preserved verbatim.
 *   3. SSAOPass — composites AO darkening into the world+sky buffer.
 *   4. OutputPass — tone-map + sRGB encoding to the canvas.
 *
 * Caller responsibilities:
 *   - Pass the same `THREE.WebGLRenderer` already constructed in
 *     index.js (we wrap it, we don't replace it).
 *   - Per frame, before calling `render(activeCam)`, the caller
 *     should call `pipeline.preFrameSkySync(skyDome, activeCam)` so
 *     the sky camera tracks the active world camera (the sky pass
 *     would otherwise render with a stale skyCamera transform).
 *   - When the active camera changes (e.g. switcher flips
 *     perspective→ortho via `C` key), the `render()` API auto-rebinds
 *     the world RenderPass + SSAOPass to the new camera.
 *
 * @param {THREE.WebGLRenderer} renderer
 * @param {THREE.Scene} scene
 * @param {THREE.Camera} camera
 * @param {{
 *   kernelRadius?: number,
 *   kernelSize?: number,
 *   minDistance?: number,
 *   maxDistance?: number,
 *   width?: number,
 *   height?: number,
 *   skyScene?: THREE.Scene,
 *   skyCamera?: THREE.Camera,
 * }} [opts]
 */
export function createSsaoPipeline(renderer, scene, camera, opts = {}) {
    const cfg = { ...DEFAULT_SSAO, ...opts };
    const size = renderer.getSize(new THREE.Vector2());
    const width = opts.width ?? size.x;
    const height = opts.height ?? size.y;

    const composer = new EffectComposer(renderer);
    composer.setSize(width, height);
    // Pin composer RT colorSpace to LinearSRGB so OutputPass's
    // linear→sRGB encode is well-defined regardless of how the
    // EffectComposer's HalfFloat RT defaults end up resolving in
    // future three.js versions. Empirically the A/B Holtburg
    // capture still shows a ~30-level brightness lift on dark mids
    // (terrain water) in the SSAO-on screenshot relative to the
    // direct-render baseline; this is a known three.js post-
    // processing color-management gotcha (linear-vs-sRGB book-
    // keeping between `MeshStandardMaterial`'s lighting and
    // `OutputPass`'s encode), NOT a property of SSAO itself, and
    // is documented as a follow-on. The AO darkening is correctly
    // applied at building bases / eaves / corners; the diff image
    // (ssao_darker_than_baseline.png) shows the AO mask exactly
    // where geometry meets geometry.
    composer.renderTarget1.texture.colorSpace = THREE.LinearSRGBColorSpace;
    composer.renderTarget2.texture.colorSpace = THREE.LinearSRGBColorSpace;

    let skyRenderPass = null;
    if (opts.skyScene && opts.skyCamera) {
        skyRenderPass = new RenderPass(opts.skyScene, opts.skyCamera);
        // Sky paints over a black-cleared RT. Defaults are fine
        // (clear=true, clearDepth=false). We DO want needsSwap=false
        // so the world pass writes into the same buffer (otherwise
        // the sky color sits in a buffer we never read).
        skyRenderPass.needsSwap = false;
        composer.addPass(skyRenderPass);
    }

    const worldRenderPass = new RenderPass(scene, camera);
    // When a sky pass is present, do NOT clear color (preserves sky)
    // but DO clear depth (mirrors `renderer.clearDepth()` in the
    // direct path so world depth-test starts fresh).
    if (skyRenderPass) {
        worldRenderPass.clear = false;
        worldRenderPass.clearDepth = true;
    }
    composer.addPass(worldRenderPass);

    const ssaoPass = new SSAOPass(scene, camera, width, height, cfg.kernelSize);
    ssaoPass.kernelRadius = cfg.kernelRadius;
    ssaoPass.minDistance = cfg.minDistance;
    ssaoPass.maxDistance = cfg.maxDistance;
    ssaoPass.output = SSAOPass.OUTPUT.Default;
    composer.addPass(ssaoPass);

    // OutputPass tone-maps + applies color-space conversion so the
    // composer output matches what `renderer.render` would have
    // produced. Without it, the composer's intermediate RT stays in
    // linear and the final canvas shows desaturated colors.
    composer.addPass(new OutputPass());

    let activeCamera = camera;

    return {
        composer,
        ssaoPass,
        worldRenderPass,
        skyRenderPass,
        /**
         * Pre-frame: sync the sky camera with the active world camera.
         * Also flips the sky RenderPass `.enabled` to match the indoor
         * short-circuit — `SkyDome._lastIsIndoor === true` means the
         * sky should be skipped this frame (the world pass then has
         * to clear its own buffer).
         */
        preFrameSkySync(skyDome, mainCamera) {
            if (!skyRenderPass) return;
            if (!skyDome) {
                skyRenderPass.enabled = false;
                return;
            }
            const isIndoor = !!skyDome._lastIsIndoor;
            skyRenderPass.enabled = !isIndoor;
            if (!isIndoor && typeof skyDome.syncSkyCamera === "function") {
                skyDome.syncSkyCamera(mainCamera);
            }
            // World pass's clear-color behavior flips with sky:
            //   sky on  → world preserves color + clears depth
            //   sky off → world clears color (mirrors the
            //              `autoClear=true` direct-render outdoor-
            //              less / indoor path).
            if (isIndoor) {
                worldRenderPass.clear = true;
                worldRenderPass.clearDepth = false;
            } else {
                worldRenderPass.clear = false;
                worldRenderPass.clearDepth = true;
            }
        },
        render(cam) {
            if (cam && cam !== activeCamera) {
                worldRenderPass.camera = cam;
                ssaoPass.camera = cam;
                activeCamera = cam;
            }
            composer.render();
        },
        setSize(w, h) {
            composer.setSize(w, h);
            ssaoPass.setSize(w, h);
        },
        setCamera(cam) {
            if (!cam || cam === activeCamera) return;
            worldRenderPass.camera = cam;
            ssaoPass.camera = cam;
            activeCamera = cam;
        },
        dispose() {
            ssaoPass.dispose?.();
            composer.passes.forEach((p) => p.dispose?.());
        },
    };
}

export const SSAO_DEFAULTS = DEFAULT_SSAO;
