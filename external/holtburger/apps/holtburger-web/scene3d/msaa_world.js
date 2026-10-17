// scene3d/msaa_world.js — `?msaaWorldOnly` (2026-10-17, DEFAULT ON, `=off` escape)
//
// MSAA for the WORLD pass only; the post-processing chain runs on plain
// single-sample buffers.
//
// WHY. `?msaa` (default 2, 4 at ultra) used to ask pmndrs for multisampled
// ping-pong buffers (`EffectComposer({ multisampling })`), so EVERY pass that
// writes a composer buffer paid for it — not only the world RenderPass, whose
// geometric edges are the only thing MSAA can improve, but also every
// full-screen post quad (NanScrub, the late NanScrub, LayeredHaze): each wrote
// all N samples and three then resolved the target with a blitFramebuffer
// after the draw. GTX 1070 per-draw timer census, quality=ultra, msaa=4
// (2026-10-17, /mnt/wbterminal1/tmp/fps-agent/gpucensus2.json): MSAA resolves
// 1.95 ms/frame, ~1.2 ms of it from post passes (NanScrub 0.36, late NanScrub
// 0.20, LayeredHaze 0.37 resolve blits, plus their 4x fill). A full-screen
// quad has no geometric edge for MSAA to smooth, so that is pure cost.
//
// WHAT. `MsaaWorldComposer` is an EffectComposer whose ping-pong buffers are
// single-sample, plus ONE extra multisampled target W (the "world target") at
// the drawing-buffer size. Every pass that runs before the first buffer swap —
// the sky pass, the world pass, the indoor split / portal seal / punch slots,
// the cells pass, the camera-mask slots — receives W as its `inputBuffer`, so
// all scene geometry draws multisampled exactly as before. The first swapping
// pass (the NanScrub, or whichever post pass comes first) reads W's resolved
// colour and writes the plain output buffer; from then on the chain ping-pongs
// between the two plain buffers exactly as pmndrs does. Same buffer objects at
// the same steps as before, so the chain's parity (which buffer ends up
// holding what) is unchanged — only the scene buffer moved.
//
// DEPTH. W's depth TEXTURE is the composer's own `composer.depthTexture` —
// the texture pmndrs attaches to its input buffer before every pass and that
// the late particle pass, fxGlow and fxDecals sample. three resolves the
// multisampled depth into it with the colour after every render into W, so
// every reader sees exactly what it saw when the input buffer itself was
// multisampled. The stable depth copy pmndrs blits after RenderPass-style
// passes (`needsDepthBlit`) is blitted FROM W's resolve framebuffer while the
// scene is in W (that framebuffer carries the depth texture), so the effects'
// depth is unchanged too.
//
// THE ANGLE TRAP (see "NO DEPTH RESOLVE" in atmosphere_pipeline.js). A
// multisampled target's depth RENDERBUFFER format is fixed when three first
// sets the target up (from the depth texture attached at that moment). Swap
// in a depth texture of another format later and the resolve blit
// (COLOR | DEPTH) is rejected with GL_INVALID_OPERATION every frame on ANGLE/
// D3D11 — and a rejected blit resolves nothing, colour included. The legacy
// MSAA ping-pong buffers walked into this because pmndrs re-attaches depth
// per pass. W never changes depth texture: it is given composer.depthTexture
// before its first bind, and if that object ever changed identity W would be
// disposed (re-set-up from scratch) rather than re-pointed.
//
// CONSTRUCTION-TIME ONLY. Changing MSAA on a live composer went through a
// black-screen path on the 1070 before; this choice is made once, when the
// atmosphere pipeline builds its composer, and never toggles at runtime.
// `?msaaWorldOnly=off` builds the legacy multisampled ping-pong composer;
// `?msaa=0` builds neither (no MSAA anywhere, byte-identical to before).
//
// Memory: the composer used to hold TWO multisample sets (colour + depth
// renderbuffers at N samples); it now holds one (W's) plus W's single-sample
// colour texture — roughly 40 bytes/pixel less at 4x (≈150 MB at 2560x1440).

import * as THREE from "three";
import { ClearMaskPass, EffectComposer, MaskPass } from "postprocessing";

/**
 * `?msaaWorldOnly` — DEFAULT ON; `off`/`0`/`false`/`no` is the escape.
 * @param {string} [search] test seam; defaults to location.search
 */
export function msaaWorldOnlyEnabled(search) {
  try {
    const s = typeof search === "string" ? search : (globalThis.location?.search || "");
    const v = new URLSearchParams(s).get("msaaWorldOnly");
    if (v == null) return true;
    const t = String(v).toLowerCase();
    return !(t === "off" || t === "0" || t === "false" || t === "no");
  } catch (_) {
    return true;
  }
}

/**
 * EffectComposer with single-sample ping-pong buffers and a multisampled
 * world target fed to every pass until the first buffer swap.
 *
 * Options are pmndrs' plus `worldSamples` (the MSAA count for the world
 * target; `multisampling` is forced to 0). Call `attachWorldTarget()` once the
 * passes are added (composer.depthTexture exists then); `render` also does it
 * lazily.
 */
export class MsaaWorldComposer extends EffectComposer {
  constructor(renderer = null, options = {}) {
    super(renderer, { ...options, multisampling: 0 });
    this.worldSamples = Math.max(0, Math.min(8, (options.worldSamples ?? 0) | 0));
    /** @type {THREE.WebGLRenderTarget|null} */
    this.worldTarget = null;
    this.msaaWorldStats = {
      frames: 0,
      // passes handed W as their input in the last frame
      worldPasses: 0,
      // stable-depth blits sourced from W in the last frame
      worldDepthBlits: 0,
      // W re-created because composer.depthTexture changed identity
      depthRebuilds: 0,
      resizes: 0,
    };
  }

  /** The world target's requested sample count (0 = no world target). */
  get worldMultisampling() {
    return this.worldTarget ? this.worldTarget.samples : 0;
  }

  /**
   * Create W (idempotent). Mirrors the ping-pong buffers (createBuffer):
   * same type, filters, depth and stencil, at the same size.
   * @returns {THREE.WebGLRenderTarget|null}
   */
  attachWorldTarget() {
    if (this.worldSamples <= 0) return null;
    if (this.worldTarget) return this.worldTarget;
    const ib = this.inputBuffer;
    const rt = new THREE.WebGLRenderTarget(Math.max(1, ib.width), Math.max(1, ib.height), {
      type: ib.texture.type,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: true,
      stencilBuffer: ib.stencilBuffer === true,
      samples: this.worldSamples,
    });
    rt.texture.name = "MsaaWorld.Buffer";
    rt.texture.generateMipmaps = false;
    if (ib.texture.colorSpace) rt.texture.colorSpace = ib.texture.colorSpace;
    // Before the first bind, so the multisample depth renderbuffer is created
    // in this texture's format (see THE ANGLE TRAP in the header).
    rt.depthTexture = this.depthTexture;
    this.worldTarget = rt;
    return rt;
  }

  /** Keep W at the ping-pong size and on the composer's depth texture. */
  _syncWorldTarget() {
    let rt = this.worldTarget || this.attachWorldTarget();
    if (!rt) return null;
    const ib = this.inputBuffer;
    if (rt.depthTexture !== this.depthTexture) {
      // Never re-point a set-up multisampled target at another depth texture:
      // dispose (three re-creates every attachment on the next bind). Detach
      // first so the dispose does not take the old depth texture with it.
      rt.depthTexture = null;
      rt.dispose();
      rt.depthTexture = this.depthTexture;
      this.msaaWorldStats.depthRebuilds++;
    }
    if (rt.width !== ib.width || rt.height !== ib.height) {
      rt.setSize(ib.width, ib.height);
      this.msaaWorldStats.resizes++;
    }
    return rt;
  }

  setSize(width, height, updateStyle) {
    super.setSize(width, height, updateStyle);
    // super() calls setSize before the constructor body has run.
    if (this.worldTarget) this._syncWorldTarget();
  }

  /**
   * pmndrs EffectComposer.render (postprocessing 6.39.1) with one change: the
   * buffer handed to a pass as `inputBuffer` is W until the first swapping
   * pass has run, and the depth blit for a `needsDepthBlit` pass reads from
   * the same buffer the pass drew into. Everything else — the depth texture
   * hand-off, the swap, the stencil copy and mask bookkeeping — is the
   * library loop verbatim.
   */
  render(deltaTime) {
    const world = this._syncWorldTarget();
    if (!world) {
      super.render(deltaTime);
      return;
    }
    const renderer = this.renderer;
    const copyPass = this.copyPass;
    const stats = this.msaaWorldStats;
    let inputBuffer = this.inputBuffer;
    let outputBuffer = this.outputBuffer;
    let buffer;
    let stencilTest = false;
    // The buffer that holds the frame so far: W until a swapping pass has
    // read it into a plain buffer, then the ordinary ping-pong input.
    let scene = world;
    let worldPasses = 0;
    let worldDepthBlits = 0;
    if (deltaTime === undefined) {
      this.timer.update();
      deltaTime = this.timer.getDelta();
    }
    for (const pass of this.passes) {
      if (!pass.enabled) {
        continue;
      }
      inputBuffer.depthTexture = this.depthTexture;
      outputBuffer.depthTexture = null;
      const source = scene !== null ? scene : inputBuffer;
      if (scene !== null) worldPasses++;
      pass.render(renderer, source, outputBuffer, deltaTime, stencilTest);
      if (pass.needsDepthBlit) {
        if (this.depthRenderTarget !== null) {
          this.blitDepthBuffer(source);
          if (scene !== null) worldDepthBlits++;
        }
      }
      if (pass.needsSwap) {
        if (stencilTest) {
          copyPass.renderToScreen = pass.renderToScreen;
          const context = renderer.getContext();
          const stencil = renderer.state.buffers.stencil;
          stencil.setFunc(context.NOTEQUAL, 1, 4294967295);
          copyPass.render(renderer, source, outputBuffer, deltaTime, stencilTest);
          stencil.setFunc(context.EQUAL, 1, 4294967295);
        }
        buffer = inputBuffer;
        inputBuffer = outputBuffer;
        outputBuffer = buffer;
        scene = null;
      }
      if (pass instanceof MaskPass) {
        stencilTest = true;
      } else if (pass instanceof ClearMaskPass) {
        stencilTest = false;
      }
    }
    stats.frames++;
    stats.worldPasses = worldPasses;
    stats.worldDepthBlits = worldDepthBlits;
  }

  /**
   * Free W and stop using it (the composer falls back to the plain pmndrs
   * loop). For owners that dispose the passes but not the composer.
   */
  disposeWorldTarget() {
    const rt = this.worldTarget;
    this.worldSamples = 0;
    if (!rt) return;
    // composer.depthTexture is the composer's to dispose (deleteDepthTexture).
    rt.depthTexture = null;
    rt.dispose();
    this.worldTarget = null;
  }

  dispose() {
    this.disposeWorldTarget();
    super.dispose();
  }
}

/**
 * Diag snapshot for `window.__msaaWorld` (read-only; there is deliberately no
 * runtime toggle — see CONSTRUCTION-TIME ONLY in the header).
 * @param {EffectComposer} composer
 * @param {{requested?: number, flag?: boolean, maxSamples?: number}} [info]
 */
export function msaaWorldSnapshot(composer, info = {}) {
  const rt = composer && composer.worldTarget ? composer.worldTarget : null;
  return {
    flag: info.flag ?? null,
    requested: info.requested ?? null,
    maxSamples: info.maxSamples ?? null,
    active: !!rt,
    worldSamples: rt ? rt.samples : 0,
    composerSamples: composer ? composer.multisampling : null,
    target: rt ? `${rt.width}x${rt.height}` : null,
    depthIsComposers: rt ? rt.depthTexture === composer.depthTexture : null,
    ...(composer && composer.msaaWorldStats ? composer.msaaWorldStats : {}),
  };
}
