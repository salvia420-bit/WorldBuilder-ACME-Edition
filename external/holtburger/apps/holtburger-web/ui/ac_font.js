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

  // Pass 1 — optional drop shadow from the background atlas. Drawn
  // black with reduced opacity so the foreground text reads cleanly
  // against bright backgrounds. The bg atlas in retail mirrors the
  // glyph rects from the fg atlas (same offset_x/y/width/height).
  if (drawShadow) {
    ctx.fillStyle = "rgba(0, 0, 0, 0.85)";
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "destination-in";
    _drawGlyphs(ctx, runtime, runtime.atlasBgCanvas, text, scale, 1, 1);
    ctx.globalCompositeOperation = "source-over";
  }

  // Pass 2 — foreground glyphs in the requested color. Fill the
  // remaining area with the color, then mask to glyph alpha.
  const tmp = document.createElement("canvas");
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext("2d");
  if (!tctx) return null;
  tctx.imageSmoothingEnabled = false;
  tctx.fillStyle = color;
  tctx.fillRect(0, 0, w, h);
  tctx.globalCompositeOperation = "destination-in";
  _drawGlyphs(tctx, runtime, runtime.atlasFgCanvas, text, scale, 0, 0);

  ctx.drawImage(tmp, 0, 0);
  return canvas;
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
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const img = ctx.createImageData(width, height);
  img.data.set(pixels);
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

if (typeof customElements !== "undefined" && !customElements.get("ac-text")) {
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
