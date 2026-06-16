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

/**
 * Compact (10 px tall) variant of the standard UI font — same 1050
 * glyph set as `UI_FONT_ID` but half the vertical footprint. Pass
 * via `setAcText(el, text, {fontId: COMPACT_FONT_ID})` for tooltips
 * and any other crowded contexts where the default 16 px overflows
 * the CSS box.
 */
export const COMPACT_FONT_ID = 0x4000001C;

/**
 * Heading variant — 21 × 22 cell, 1912 glyph set (extended ASCII +
 * symbols). Use for panel chrome titles and other contexts where the
 * default UI font reads too small/light. Per
 * `docs/ac-font-inventory-2026-05-24.md` the 0x40000007–18 family
 * shares the 1912-char extended set; 0x40000019 is the canonical
 * mid-size pick.
 */
export const HEADING_FONT_ID = 0x40000019;

/**
 * Chat-window variant — 16 × 15 cell, 1419 glyph set (Latin extended
 * + smart quotes + symbols). Same height as the canonical UI font but
 * covers the accented/symbolic characters real chat hits (player
 * names with é/ñ, copy-pasted ™/©, smart-quoted dialog). Per
 * `docs/ac-font-inventory-2026-05-24.md` the chat-window pick.
 */
export const CHAT_FONT_ID = 0x40000027;

/**
 * Damage popup floaty font — 30 × 34 cell, 210 glyph set (Latin/digits
 * only). Used by the 3D-world damage popups (`+100`, `-N`) where the
 * larger glyph anchors the value over distance / against busy 3D
 * backgrounds. Per `docs/ac-font-inventory-2026-05-24.md`. 36×39
 * (0x40000010) is the bigger sibling if 30×34 reads small.
 */
export const DAMAGE_POPUP_FONT_ID = 0x4000000F;

/**
 * Scrolling battle-text font — 22 × 13 cell, 1258 glyph set
 * (mid-Latin-extended). The condensed serif retail uses for the
 * combat-log scroller. Per `docs/ac-font-inventory-2026-05-24.md`.
 */
export const BATTLE_TEXT_FONT_ID = 0x40000031;

/**
 * CJK fallback — 14 × 14 cell, 20609 glyph set (Japanese / Chinese /
 * Korean). Smallest of the CJK family; used when the chat font misses
 * a glyph and a fallback is needed. Per
 * `docs/ac-font-inventory-2026-05-24.md`.
 */
export const CJK_FONT_ID = 0x40000017;

/** Primary font IDs the boot path must have ready before first paint
 *  so labels don't flash through the system-font fallback. The CJK +
 *  damage-popup + battle-text fonts are fire-and-forget — they only
 *  show on transient overlays where a brief fallback is unobtrusive. */
const PRIMARY_FONT_IDS = Object.freeze([
  UI_FONT_ID, COMPACT_FONT_ID, HEADING_FONT_ID, CHAT_FONT_ID,
]);

// Module-scoped per-font runtime cache. Each entry holds the
// HTMLCanvasElement of the decoded foreground atlas and a Map<u32, glyph>.
const runtimes = new Map();
// Promise per pending fetch so concurrent callers share one fetch.
const inFlight = new Map();
// Listeners fire on every successful loadAcFont resolve so consumers
// (AcTextElement, layout-driven labels) can re-render after a lazy
// CJK miss triggers loadAcFont(CJK_FONT_ID) in the middle of a paint.
const fontLoadListeners = new Set();
// Latch — fire loadAcFont(CJK_FONT_ID) at most once per session even
// if many high-codepoint misses land before the runtime resolves.
let _cjkPreloadKicked = false;

/**
 * Subscribe to font-load events. Each successful loadAcFont resolve
 * calls every listener with `{fontId}`; AcTextElement uses this to
 * upgrade pre-CJK system-font glyphs once the CJK runtime arrives.
 * Returns an unsubscribe function.
 *
 * @param {(detail: {fontId: number}) => void} cb
 */
export function addFontLoadListener(cb) {
  if (typeof cb !== "function") return () => {};
  fontLoadListeners.add(cb);
  return () => fontLoadListeners.delete(cb);
}

function emitFontLoaded(fontId) {
  for (const cb of fontLoadListeners) {
    try { cb({ fontId }); } catch (_) {}
  }
}

// Resolve a codepoint against the primary runtime first, then the
// CJK runtime (if the codepoint is non-Latin and the CJK font has
// been loaded). On CJK miss, lazily kicks off loadAcFont(CJK_FONT_ID)
// so subsequent paints upgrade from system-font fallback.
function _resolveGlyph(primary, cp) {
  const g = primary.glyphMap.get(cp);
  if (g) return { runtime: primary, glyph: g };
  // High codepoint — Cyrillic + everything above (0x0400 onward). The
  // ASCII / Latin-1 / Latin Extended ranges below this threshold are
  // already in the primary atlas so the CJK lookup is skipped to keep
  // the per-glyph hot path cheap.
  if (cp >= 0x0400) {
    const cjk = runtimes.get(CJK_FONT_ID);
    if (cjk) {
      const cjkG = cjk.glyphMap.get(cp);
      if (cjkG) return { runtime: cjk, glyph: cjkG };
    } else if (!_cjkPreloadKicked) {
      _cjkPreloadKicked = true;
      // Fire-and-forget; once it lands every listener is notified.
      void loadAcFont(CJK_FONT_ID);
    }
  }
  return null;
}

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
        try { window.__diag?.fonts?.onLoadFailed?.({ fontId, error: "empty data", source: "empty" }); } catch (_) {}
        runtimes.set(fontId, null);
        return null;
      }
      const runtime = _buildRuntime(data);
      runtimes.set(fontId, runtime);
      try {
        window.__diag?.fonts?.onLoadSucceeded?.({
          fontId,
          glyphCount: data.numGlyphs,
          atlasWidth: data.atlasWidth,
          atlasHeight: data.atlasHeight,
        });
      } catch (_) {}
      emitFontLoaded(fontId);
      return runtime;
    } catch (err) {
      console.warn(`[ac-font] load failed (font 0x${fontId.toString(16)}):`, err);
      try { window.__diag?.fonts?.onLoadFailed?.({ fontId, error: err, source: "fetch" }); } catch (_) {}
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
 * P0-25 (cross-find gap-030): preload all primary fonts in parallel
 * and resolve when the set is ready. Boot path should `await` this
 * before mounting plugins so labels don't flash through the system-
 * font fallback. Failures resolve to `null` for that font (caller
 * still gets a useful result for the fonts that did load).
 *
 * @returns {Promise<Array<AcFontRuntime|null>>}
 */
export function loadPrimaryFonts() {
  return Promise.all(PRIMARY_FONT_IDS.map((id) => loadAcFont(id)));
}

/** Singleton promise the boot path can await for "first paint OK to
 *  render labels". Resolves once all 4 primary fonts have a runtime
 *  (or each individual load has settled — `null` results are tolerated
 *  so a missing font doesn't deadlock the boot). */
let _primaryFontsReady = null;
export function whenPrimaryFontsReady() {
  if (_primaryFontsReady) return _primaryFontsReady;
  _primaryFontsReady = loadPrimaryFonts().then(() => undefined);
  return _primaryFontsReady;
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
 * @param {{color?: string, scale?: number, fontId?: number, shadow?: boolean, shadowColor?: string, shadowOffsetX?: number, shadowOffsetY?: number, align?: string, vAlign?: string, boxWidth?: number, boxHeight?: number, flags?: number}} opts
 * @returns {HTMLCanvasElement | null} — canvas sized to the rendered
 *   bounds, or null if the font isn't loaded (caller should fall back
 *   to system font). The canvas has transparent background; the text
 *   is filled with `opts.color` (default "#FFFFFF") at integer scale
 *   `opts.scale` (default 1).
 *
 * HUD rec #117 — retail's Font::DrawString signature carries alignment
 * via a single bitmask flags argument (acclient_2013.bndb_pseudo_c.txt
 * around line 668400). The mapping:
 *   flags &  0x08 → right-align horizontal
 *   flags &  0x10 → center horizontal
 *   flags &  0x40 → bottom-align vertical
 *   flags <  0    → vCenter (sign-bit flag, encoded as int)
 *
 * HUD rec #151 — when `opts.boxWidth` and/or `opts.boxHeight` are
 * provided the canvas is grown to that size and the glyphs are aligned
 * within the box via `opts.align` ("left" | "center" | "right") +
 * `opts.vAlign` ("top" | "middle" | "bottom"). `opts.flags` (retail
 * bitmask) is decoded into the same align/vAlign axes. Without a box
 * the canvas still hugs the text (legacy alignment-agnostic behaviour;
 * callers position via CSS) — adding alignment opts without a box is
 * a no-op.
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
  // Rec #185 — drop-shadow tint + offset are now caller-configurable.
  // Defaults match the previous hardcoded rgba(0,0,0,0.85) at +1,+1px,
  // so existing callers see no visual change.
  const shadowColor = opts.shadowColor ?? "rgba(0, 0, 0, 0.85)";
  const shadowOffsetX = Number.isFinite(opts.shadowOffsetX) ? Math.floor(opts.shadowOffsetX) : 1;
  const shadowOffsetY = Number.isFinite(opts.shadowOffsetY) ? Math.floor(opts.shadowOffsetY) : 1;

  const measured = _measure(runtime, text);
  const textW = measured.width * scale;
  const textH = measured.height * scale;

  // Alignment box. boxWidth/boxHeight grow the canvas beyond the text;
  // align/vAlign control where the glyphs sit inside. `flags` is the
  // retail Font::DrawString bitmask (see the doc above) and is folded
  // into align/vAlign before the offset is computed.
  let align = opts.align ?? "left";
  let vAlign = opts.vAlign ?? "top";
  if (typeof opts.flags === "number" && opts.flags !== 0) {
    const f = opts.flags >>> 0;
    if (f & 0x10) align = "center";
    else if (f & 0x08) align = "right";
    if (f & 0x40) vAlign = "bottom";
    if (opts.flags < 0) vAlign = "middle";
  }
  const boxW = Math.max(textW, Math.floor(opts.boxWidth ?? textW));
  const boxH = Math.max(textH, Math.floor(opts.boxHeight ?? textH));
  let offsetX = 0;
  let offsetY = 0;
  if (align === "center") offsetX = Math.floor((boxW - textW) / 2);
  else if (align === "right") offsetX = Math.floor(boxW - textW);
  if (vAlign === "middle") offsetY = Math.floor((boxH - textH) / 2);
  else if (vAlign === "bottom") offsetY = Math.floor(boxH - textH);

  const w = Math.max(1, Math.floor(boxW));
  const h = Math.max(1, Math.floor(boxH));

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
      tbg.save();
      if (offsetX !== 0 || offsetY !== 0) tbg.translate(offsetX, offsetY);
      _drawGlyphs(tbg, runtime, runtime.atlasBgCanvas, text, scale, shadowOffsetX, shadowOffsetY, "bg");
      tbg.restore();
      tbg.globalCompositeOperation = "source-in";
      tbg.fillStyle = shadowColor;
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
  tctx.save();
  if (offsetX !== 0 || offsetY !== 0) tctx.translate(offsetX, offsetY);
  _drawGlyphs(tctx, runtime, runtime.atlasFgCanvas, text, scale, 0, 0, "fg");
  tctx.restore();
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
    if (opts.fontId !== undefined) inner.setAttribute("font-id", String(opts.fontId));
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
  // Lazy fallback-measure canvas for codepoints not in the AC font
  // OR the CJK font (em-dashes, curly quotes, etc.). Set up once.
  let fallbackCtx = null;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const resolved = _resolveGlyph(runtime, cp);
    if (!resolved) {
      // Missing in both primary and CJK — measure the system-font
      // fallback so the canvas reservation matches what `_drawGlyphs`
      // will draw.
      if (!fallbackCtx) {
        const c = document.createElement("canvas");
        fallbackCtx = c.getContext("2d");
        if (fallbackCtx) fallbackCtx.font = `${runtime.maxCharHeight}px sans-serif`;
      }
      const w = fallbackCtx
        ? Math.ceil(fallbackCtx.measureText(ch).width)
        : runtime.maxCharWidth;
      penX += Math.max(1, w);
      if (runtime.maxCharHeight > maxY) maxY = runtime.maxCharHeight;
      continue;
    }
    const { runtime: gRuntime, glyph: g } = resolved;
    penX += g.h_off_before;
    const right = penX + g.width;
    penX = right + g.h_off_after;
    // Rec #63 — per-font baselineOffset shifts the glyph's vertical
    // origin so descenders + ascenders don't get cropped. Applied
    // identically in _drawGlyphs so the canvas reservation matches
    // what gets painted. Border pixels (num_horizontal/vertical_border)
    // aren't surfaced from the wasm side yet — a follow-on would
    // inset the atlas sample rect by those values; here we conservatively
    // assume zero so the shadow render at oy=1 doesn't bleed past
    // the foreground.
    const baseY = (gRuntime.baselineOffset >>> 0) || 0;
    const bottom = baseY + g.v_off_before + g.height;
    if (bottom > maxY) maxY = bottom;
    if ((gRuntime.maxCharHeight + baseY) > maxY) maxY = gRuntime.maxCharHeight + baseY;
  }
  return {
    width: Math.max(1, penX),
    height: Math.max(runtime.maxCharHeight + ((runtime.baselineOffset >>> 0) || 0), maxY),
  };
}

function _drawGlyphs(ctx, runtime, atlasCanvas, text, scale, ox, oy, atlasKind) {
  let penX = 0;
  // Per-glyph atlas selection so CJK glyphs (sourced from the CJK
  // runtime cached in `runtimes.get(CJK_FONT_ID)`) draw from the CJK
  // atlas, not the primary atlas the caller passed. The legacy
  // atlasCanvas argument is the PRIMARY atlas; atlasKind ("fg" | "bg")
  // tells us which to pick from non-primary runtimes.
  let fallbackConfigured = false;
  const pickAtlas = (gRuntime) => {
    if (gRuntime === runtime) return atlasCanvas;
    return atlasKind === "bg" ? gRuntime.atlasBgCanvas : gRuntime.atlasFgCanvas;
  };
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    const resolved = _resolveGlyph(runtime, cp);
    if (!resolved) {
      try { window.__diag?.fonts?.onFallbackGlyph?.({ codepoint: cp }); } catch (_) {}
      if (!fallbackConfigured) {
        ctx.font = `${runtime.maxCharHeight * scale}px sans-serif`;
        ctx.textBaseline = "top";
        ctx.fillStyle = "#FFFFFF";
        fallbackConfigured = true;
      }
      ctx.fillText(ch, (penX + ox) * scale, oy * scale);
      const w = Math.max(1, Math.ceil(ctx.measureText(ch).width / scale));
      penX += w;
      continue;
    }
    const { runtime: gRuntime, glyph: g } = resolved;
    const atlas = pickAtlas(gRuntime);
    penX += g.h_off_before;
    if (g.width > 0 && g.height > 0 && atlas) {
      // Rec #63 — same baselineOffset shift _measure applies. The
      // shadow render path uses oy=1 (and the fg path oy=0) so the
      // shadow ends up exactly one pixel below the foreground at the
      // baseline-adjusted y, matching retail bitmap-font output. The
      // num_horizontal/vertical_border_pixels atlas inset isn't
      // wired (defer-wasm: not surfaced from FontData yet) — when it
      // lands, subtract from offset_x/y and width/height to skip
      // border padding.
      const baseY = (gRuntime.baselineOffset >>> 0) || 0;
      ctx.drawImage(
        atlas,
        g.offset_x,
        g.offset_y,
        g.width,
        g.height,
        (penX + ox) * scale,
        (baseY + g.v_off_before + oy) * scale,
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
//   shadow-color="rgba(0,0,0,0.85)" — drop shadow tint (rec #185)
//   shadow-offset-x="1" — drop shadow X offset in source-space px (rec #185)
//   shadow-offset-y="1" — drop shadow Y offset in source-space px (rec #185)

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
      return [
        "color", "scale", "font-id", "shadow", "align", "v-align",
        "box-width", "box-height",
        "shadow-color", "shadow-offset-x", "shadow-offset-y",
      ];
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
      // Re-render when a new font (e.g. CJK) lands — upgrades any
      // system-font fallback glyphs to their AC-font equivalents.
      this._unsubFontLoad = addFontLoadListener(() => this._render());
    }
    disconnectedCallback() {
      this._observer.disconnect();
      if (typeof this._unsubFontLoad === "function") {
        try { this._unsubFontLoad(); } catch (_) {}
        this._unsubFontLoad = null;
      }
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
      if (this.hasAttribute("align")) opts.align = this.getAttribute("align");
      if (this.hasAttribute("v-align")) opts.vAlign = this.getAttribute("v-align");
      if (this.hasAttribute("box-width")) {
        const n = Number(this.getAttribute("box-width"));
        if (Number.isFinite(n) && n > 0) opts.boxWidth = n;
      }
      if (this.hasAttribute("box-height")) {
        const n = Number(this.getAttribute("box-height"));
        if (Number.isFinite(n) && n > 0) opts.boxHeight = n;
      }
      // Rec #185 — drop shadow tint + offset attrs. Any subset is fine;
      // unset attrs fall through to renderAcText's defaults.
      if (this.hasAttribute("shadow-color")) {
        opts.shadowColor = this.getAttribute("shadow-color");
      }
      if (this.hasAttribute("shadow-offset-x")) {
        const n = Number(this.getAttribute("shadow-offset-x"));
        if (Number.isFinite(n)) opts.shadowOffsetX = n;
      }
      if (this.hasAttribute("shadow-offset-y")) {
        const n = Number(this.getAttribute("shadow-offset-y"));
        if (Number.isFinite(n)) opts.shadowOffsetY = n;
      }
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
