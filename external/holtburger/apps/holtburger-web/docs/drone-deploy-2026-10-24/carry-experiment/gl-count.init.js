// gl-count.init.js — page init script (hb-carry runner, plan.initScript): count WebGL calls by method in the
// page's main world, so a ?nullRender session can show what still reaches the GPU process.
(() => {
  const counts = Object.create(null);
  window.__glCount = { counts, reset() { for (const k of Object.keys(counts)) delete counts[k]; } };
  const names = ["drawElements", "drawArrays", "drawElementsInstanced", "drawArraysInstanced", "drawRangeElements",
    "compileShader", "linkProgram", "texImage2D", "texSubImage2D", "compressedTexImage2D", "compressedTexSubImage2D",
    "texImage3D", "texSubImage3D", "texStorage2D", "bufferData", "bufferSubData", "readPixels", "clear", "blitFramebuffer",
    "getProgramParameter", "getShaderParameter", "fenceSync", "clientWaitSync", "getSyncParameter", "generateMipmap"];
  const wrap = (proto, tag) => {
    if (!proto) return;
    for (const n of names) {
      const f = proto[n];
      if (typeof f !== "function") continue;
      proto[n] = function () { const k = tag + "." + n; counts[k] = (counts[k] || 0) + 1; return f.apply(this, arguments); };
    }
  };
  wrap(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype, "gl2");
  wrap(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype, "gl1");
  const ctxs = [];
  window.__glCount.contexts = ctxs;
  const gc = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const c = gc.call(this, type, attrs);
    try { if (c && !ctxs.some((e) => e.ctx === c)) ctxs.push({ type, w: this.width, h: this.height, id: this.id || this.className || "", ctx: c }); } catch (_) { /* */ }
    return c;
  };
  if (window.OffscreenCanvas) {
    const og = OffscreenCanvas.prototype.getContext;
    OffscreenCanvas.prototype.getContext = function (type, attrs) {
      const c = og.call(this, type, attrs);
      try { ctxs.push({ type: "offscreen-" + type, w: this.width, h: this.height, id: "", ctx: c }); } catch (_) { /* */ }
      return c;
    };
  }
})();
