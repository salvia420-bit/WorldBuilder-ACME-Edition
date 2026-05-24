/**
 * AC bitmap-font runtime.
 *
 * Loads a Font record + its two glyph atlases from the wasm side via
 * `fetch_font(id)` and exposes two surfaces:
 *
 *  - `renderAcText(text, opts) -> HTMLCanvasElement` — pixel-perfect
 *    composited text canvas. Caller can `.toDataURL()`, put on a
 *    `<canvas>`, or upload to a `THREE.CanvasTexture`.
 *  - `<ac-text>` custom element — declarative wrapper that renders
 *    its text content into a shadow-DOM canvas, sized inline-block.
 *    Falls through to plain text until the runtime is ready.
 *
 * The Font's foreground atlas is A8 on the wire; wasm pre-expands it
 * to RGBA8 (V,V,V,255) so the same buffer is usable as `ImageData`.
 * We composite using `destination-in` so the canvas takes the caller-
 * supplied color where the atlas has alpha. Colorization is per-text-
 * run rather than per-glyph for cost.
 *
 * Single canonical font is loaded by default (`UI_FONT_ID =
 * 0x40000000`); other Font records can be loaded via
 * `loadAcFont(id)` and accessed by passing `fontId:` to render.
 */

const UI_FONT_ID = 0x40000000;

// Module-scoped per-font runtime cache. Each entry holds the
// HTMLCanvasElement of the decoded foreground atlas and a Map<u32, glyph>.
const runtimes = new Map();
// Promise per pending fetch so concurrent callers share one fetch.
const inFlight = new Map();

/**
 * Load a Font + atlases, build the runtime, cache it. Idempotent —
 * concurrent callers share one wasm fetch_font call.
 *
 * Returns the runtime object once ready, or `null` if wasm is
 * unavailable or fetch failed (caller should fall back to system font).
 *
 * @param {number} fontId — Font DataID (default 0x40000000).
 * @returns {Promise<AcFontRuntime | null>}
 */
export async function loadAcFont(fontId = UI_FONT_ID) {
  registerAcText();
  const cached = runtimes.get(fontId);
  if (cached !== undefined) return cached;

  const pending = inFlight.get(fontId);
  if (pending) return pending;

  const promise = (async () => {
    const wasm = window.__hbWasm ?? window.__wasm ?? null;
    if (!wasm?.fetch_font) {
      runtimes.set(fontId, null);
      return null;
    }
    try {
      const data = await wasm.fetch_font(fontId >>> 0);
      if (!data || !data.numGlyphs) {
        runtimes.set(fontId, null);
        return null;
      }
      const runtime = _buildRuntime(data);
      runtimes.set(fontId, runtime);
      return runtime;
    } catch (err) {
      console.warn(`[ac-font] load failed (font 0x${fontId.toString(16)}):`, err);
      runtimes.set(fontId, null);
      return null;
    } finally {
      inFlight.delete(fontId);
    }
  })();
  inFlight.set(fontId, promise);
  return promise;
}

/**
 * Sync accessor — returns the cached runtime if one was already loaded,
 * else `null`. Useful for code paths that should skip rendering rather
 * than await.
 */
export function getAcFont(fontId = UI_FONT_ID) {
  const v = runtimes.get(fontId);
  return v === undefined ? null : v;
}

/**
 * Compose `text` to an HTMLCanvasElement using the AC font.
 *
 * @param {string} text — UTF-16 string to render.
 * @param {{color?: string, scale?: number, fontId?: number, shadow?: boolean}} opts
 * @returns {HTMLCanvasElement | null} — canvas sized to the rendered
 *   bounds, or null if the font isn't loaded (caller should fall back
 *   to system font). The canvas has transparent background; the text
 *   is filled with `opts.color` (default "#FFFFFF") at integer scale
 *   `opts.scale` (default 1).
 */
export function renderAcText(text, opts = {}) {
  registerAcText();
  const fontId = opts.fontId ?? UI_FONT_ID;
  const runtime = getAcFont(fontId);
  if (!runtime) return null;
  if (typeof text !== "string" || text.length === 0) {
    // Return a 1×1 transparent canvas — callers can size their layout
    // without branching on empty-string.
    const c = document.createElement("canvas");
    c.width = 1;
    c.height = 1;
    return c;
  }

  const color = opts.color ?? "#FFFFFF";
  const scale = Math.max(1, Math.floor(opts.scale ?? 1));
  const drawShadow = opts.shadow !== false && runtime.atlasBgCanvas !== null;

  const measured = _measure(runtime, text);
  const w = Math.max(1, measured.width * scale);
  const h = Math.max(1, measured.height * scale);

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return null;
  // Sharp pixel scaling — bitmap fonts look bad with bilinear.
  ctx.imageSmoothingEnabled = false;

  // Multi-glyph bitmap rendering: draw ALL glyphs first (source-over,
  // default) onto a tmp canvas, then colorize the resulting alpha
  // mask with a single `source-in` fill. Per-glyph `destination-in`
  // doesn't work — each `drawImage` clears the destination outside
  // its source rect, wiping prior glyphs. The atlas (post-_atlasToCanvas
  // remap) carries the mask in alpha so drawing it accumulates the
  // correct alpha-mask shape across the canvas.

  // Optional drop shadow first, behind the foreground.
  if (drawShadow) {
    const tmpBg = document.createElement("canvas");
    tmpBg.width = w;
    tmpBg.height = h;
    const tbg = tmpBg.getContext("2d");
    if (tbg) {
      tbg.imageSmoothingEnabled = false;
      _drawGlyphs(tbg, runtime, runtime.atlasBgCanvas, text, scale, 1, 1);
      tbg.globalCompositeOperation = "source-in";
      tbg.fillStyle = "rgba(0, 0, 0, 0.85)";
      tbg.fillRect(0, 0, w, h);
      ctx.drawImage(tmpBg, 0, 0);
    }
  }

  // Foreground glyphs in the requested color.
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  if (!tctx) return null;
  tctx.imageSmoothingEnabled = false;
  _drawGlyphs(tctx, runtime, runtime.atlasFgCanvas, text, scale, 0, 0);
  tctx.globalCompositeOperation = "source-in";
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, w, h);

  ctx.drawImage(tmp, 0, 0);
  return canvas;
}

/**
 * Drop-in replacement for `el.textContent = text` that routes through
 * `<ac-text>` for retail-font rendering. Reuses an inner `<ac-text>`
 * element when one already exists so subsequent updates re-render the
 * canvas in place; creates one on first call.
 *
 * Designed for buttons and other interactive elements where the text
 * is wrapped inside the host element rather than swapping the host's
 * tag name. For pure text containers (`<span>`, `<div>`), just declare
 * them as `<ac-text>` directly.
 *
 * @param {HTMLElement} el — host element (button, span, div, …).
 * @param {string} text — new text content.
 * @param {{color?: string, scale?: number}} [opts] — optional per-call
 *   styling. `color` forwards to the inner ac-text's `color` attribute
 *   (CSS color string — defaults to white). `scale` forwards to `scale`.
 *   Set color when the host element's CSS color is critical (e.g.
 *   chat-line per-category text, journal-panel parchment ink, spellbook
 *   school tags). Otherwise the canvas renders white by default.
 */
export function setAcText(el, text, opts) {
  if (!el) return;
  // DO NOT call registerAcText() here — triggers customElements.define
  // mid-mount-sequence which hangs the page (see registerAcText comment).
  // setAcText is fire-and-forget during mount: we put `<ac-text>` in the
  // DOM with text fallback. Registration happens via loadAcFont's path
  // (the dynamic import in index.html after init_resource_source).
  let inner = null;
  for (const child of el.children) {
    if (child.tagName === "AC-TEXT") {
      inner = child;
      break;
    }
  }
  if (!inner) {
    el.textContent = "";
    inner = el.ownerDocument.createElement("ac-text");
    el.appendChild(inner);
  }
  if (opts) {
    if (opts.color !== undefined) inner.setAttribute("color", String(opts.color));
    if (opts.scale !== undefined) inner.setAttribute("scale", String(opts.scale));
  }
  inner.textContent = String(text ?? "");
}

/**
 * Measure `text` in the given font at scale=1. Returns 1-unit pixel
 * dimensions (multiply by `opts.scale` for the actual canvas size).
 *
 * @returns {{width: number, height: number}}
 */
export function measureAcText(text, opts = {}) {
  const fontId = opts.fontId ?? UI_FONT_ID;
  const runtime = getAcFont(fontId);
  if (!runtime || typeof text !== "string" || text.length === 0) {
    return { width: 0, height: 0 };
  }
  return _measure(runtime, text);
}

// ---------------------------------------------------------------------
// Internal helpers

function _buildRuntime(data) {
  const atlasFgCanvas = _atlasToCanvas(data.pixelsFg, data.atlasWidth, data.atlasHeight);
  const atlasBgCanvas =
    data.pixelsBg && data.pixelsBg.length > 0
      ? _atlasToCanvas(data.pixelsBg, data.atlasWidth, data.atlasHeight)
      : null;

  const glyphMap = new Map();
  const dv = new DataView(
    data.charDescsPacked.buffer,
    data.charDescsPacked.byteOffset,
    data.charDescsPacked.byteLength,
  );
  for (let i = 0; i < data.numGlyphs; i++) {
    const base = i * 11;
    const codepoint = dv.getUint16(base, true);
    glyphMap.set(codepoint, {
      offset_x: dv.getUint16(base + 2, true),
      offset_y: dv.getUint16(base + 4, true),
      width: dv.getUint8(base + 6),
      height: dv.getUint8(base + 7),
      h_off_before: dv.getInt8(base + 8),
      h_off_after: dv.getInt8(base + 9),
      v_off_before: dv.getInt8(base + 10),
    });
  }

  return {
    id: data.id,
    glyphMap,
    atlasFgCanvas,
    atlasBgCanvas,
    maxCharHeight: data.maxCharHeight,
    maxCharWidth: data.maxCharWidth,
    baselineOffset: data.baselineOffset,
  };
}

function _atlasToCanvas(pixels, width, height) {
  // The wasm side decodes the A8 atlas to RGBA8 as (V,V,V,255) — the
  // mask value lives in the R/G/B channels and alpha is always opaque.
  // For canvas compositing (we use `destination-in` to mask a color
  // fill to the glyph shape) the mask MUST live in the alpha channel.
  // Re-pack here: (255,255,255,V). Pre-multiplied alpha not needed
  // because we only mask against opaque solids.
  //
  // The pre-fix layout (V,V,V,255) caused multi-char text to render
  // as an all-zero canvas: the first `drawImage atlas-region` with
  // destination-in clears every pixel outside the source-rect, and
  // because source-alpha was 255 EVERYWHERE inside the source-rect
  // (no shape mask), subsequent drawImage calls progressively wiped
  // out earlier work. Hotbar (single-char) coincidentally produced
  // a usable single-glyph canvas; everything else came out blank.
  const remapped = new Uint8ClampedArray(pixels.length);
  for (let i = 0; i < pixels.length; i += 4) {
    // Either R or G or B carries the original mask byte (all equal).
    const v = pixels[i];
    remapped[i] = 255;
    remapped[i + 1] = 255;
    remapped[i + 2] = 255;
    remapped[i + 3] = v;
  }

  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const img = ctx.createImageData(width, height);
  img.data.set(remapped);
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function _measure(runtime, text) {
  let penX = 0;
  let maxY = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const g = runtime.glyphMap.get(cp);
    if (!g) {
      // Missing glyph — advance one max-char-width so the rest of the
      // string still renders rather than collapsing.
      penX += runtime.maxCharWidth;
      continue;
    }
    penX += g.h_off_before;
    const right = penX + g.width;
    penX = right + g.h_off_after;
    const bottom = g.v_off_before + g.height;
    if (bottom > maxY) maxY = bottom;
  }
  return {
    width: Math.max(1, penX),
    height: Math.max(runtime.maxCharHeight, maxY),
  };
}

function _drawGlyphs(ctx, runtime, atlasCanvas, text, scale, ox, oy) {
  let penX = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const g = runtime.glyphMap.get(cp);
    if (!g) {
      penX += runtime.maxCharWidth;
      continue;
    }
    penX += g.h_off_before;
    if (g.width > 0 && g.height > 0) {
      ctx.drawImage(
        atlasCanvas,
        g.offset_x,
        g.offset_y,
        g.width,
        g.height,
        (penX + ox) * scale,
        (g.v_off_before + oy) * scale,
        g.width * scale,
        g.height * scale,
      );
    }
    penX += g.width + g.h_off_after;
  }
}

// ---------------------------------------------------------------------
// <ac-text> custom element
//
// Usage: `<ac-text>Some retail text</ac-text>` renders the textContent
// in the AC UI font once the runtime is loaded. Attributes:
//   color="#FFFFFF"  — text color (default white)
//   scale="2"        — integer scale (default 1)
//   font-id="..."    — alternative Font DataID (default 0x40000000)
//   shadow="off"     — disable drop shadow

// Custom-element registration is guarded AND deferred. When `ac_font.js`
// ends up in the page-init static-import graph (e.g. via `plugins/
// chat-panel.js`), running `customElements.define` synchronously — at
// module-load OR during a plugin's `mount()` call — blocks the page
// from reaching DOMContentLoaded. Even though the spec says define is
// synchronous, the upgrade-existing-elements flow + each upgrade's
// connectedCallback + each connectedCallback's MutationObserver-attach
// must interact badly with Firefox/Playwright during the page's
// deferred-script execution window. Pushing the define to a microtask
// after the current task settles avoids it. Validated on Firefox 150
// (Playwright + real-GPU 1070) — pre-fix: hang at DCL; post-fix: page
// loads cleanly with all HUD plugins migrated.
let _acTextRegistered = false;
let _acTextRegisterScheduled = false;
export function registerAcText() {
  if (_acTextRegistered) return;
  if (typeof customElements === "undefined") return;
  if (customElements.get("ac-text")) {
    _acTextRegistered = true;
    return;
  }
  if (_acTextRegisterScheduled) return;
  _acTextRegisterScheduled = true;
  // setTimeout(0) escapes the current task entirely (microtasks aren't
  // enough — they still run inside the deferred-script execution
  // window where the DCL hang originates).
  setTimeout(() => {
    if (_acTextRegistered) return;
    if (customElements.get("ac-text")) {
      _acTextRegistered = true;
      return;
    }
    _registerAcTextImpl();
    _acTextRegistered = true;
  }, 0);
}

function _registerAcTextImpl() {
  class AcTextElement extends HTMLElement {
    static get observedAttributes() {
      return ["color", "scale", "font-id", "shadow"];
    }
    constructor() {
      super();
      this._canvas = null;
      this._sourceText = "";
      // Watch for textContent mutations so callers using the natural
      // `el.textContent = X` update API see the canvas re-render.
      this._observer = new MutationObserver(() => this._render());
    }
    connectedCallback() {
      this.style.display = this.style.display || "inline-block";
      // Capture the initial text before the first render strips it out.
      this._sourceText = (this.textContent ?? "").trim();
      this._render();
      this._observer.observe(this, { childList: true, characterData: true, subtree: true });
    }
    disconnectedCallback() {
      this._observer.disconnect();
    }
    attributeChangedCallback() {
      this._render();
    }
    _render() {
      // Read text from a) explicit `data-text` attribute (callers that
      // want to bypass mutation re-entry can use this), b) the current
      // textContent if it differs from the canvas we already drew, or
      // c) the captured source text.
      const explicit = this.getAttribute("data-text");
      const currentText = (this.textContent ?? "").trim();
      // If textContent already equals the last-rendered text, no work.
      // This is the re-entry guard: when _render() replaces children
      // with a canvas, textContent becomes "" and the mutation observer
      // fires; without this check we'd recurse.
      const text = explicit ?? (currentText.length > 0 ? currentText : this._sourceText);
      if (this._canvas && text === this._sourceText && !explicit) {
        // Either the observer fired on our own canvas append (textContent
        // is now "") or nothing changed. Skip.
        if (currentText.length === 0) return;
      }
      this._sourceText = text;

      const opts = {
        color: this.getAttribute("color") ?? undefined,
        scale: this.hasAttribute("scale")
          ? Number(this.getAttribute("scale"))
          : 1,
        fontId: this.hasAttribute("font-id")
          ? Number(this.getAttribute("font-id"))
          : undefined,
        shadow: this.getAttribute("shadow") !== "off",
      };
      const runtime = getAcFont(opts.fontId ?? UI_FONT_ID);
      if (!runtime) {
        loadAcFont(opts.fontId ?? UI_FONT_ID).then(() => this._render());
        return;
      }
      const canvas = renderAcText(text, opts);
      if (!canvas) return;

      // Pause observation while we mutate children so our own DOM ops
      // don't re-trigger _render().
      this._observer.disconnect();
      if (this._canvas) {
        this._canvas.replaceWith(canvas);
      } else {
        for (const node of [...this.childNodes]) {
          if (node.nodeType === Node.TEXT_NODE) node.remove();
        }
        this.appendChild(canvas);
      }
      this._canvas = canvas;
      // Resume observation in the next microtask so the in-progress DOM
      // mutation has settled.
      queueMicrotask(() => {
        if (this.isConnected) {
          this._observer.observe(this, { childList: true, characterData: true, subtree: true });
        }
      });
    }
  }
  customElements.define("ac-text", AcTextElement);
}
