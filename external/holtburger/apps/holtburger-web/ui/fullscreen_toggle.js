// Fullscreen toggle control — shared by the F10 Options→Graphics tab and
// the dev bar's gear popover (both render via ui/graphics_settings.js).
//
// Ported from the ad-hoc sidebar bar slot (index.html AD_HOC_BAR_SLOTS
// "fullscreen", PR-NN 2026-05-23) so it's reachable from the real Options
// menu instead of only the deprecated plugin bar. The sidebar slot is left
// in place as a redundant shortcut.
//
// Targets document.documentElement (NOT #canvas-column) so it works in
// BOTH agent-mode (canvas-column may be 0x0 because the body>* whitelist
// hides it; #stage is the visible carrier) AND normal 3D-render mode. The
// html:fullscreen CSS (index.html:190-204) expands #stage/#canvas-column/
// #canvas to 100vw/100vh in either mode.

export function mountFullscreenControl(containerEl) {
  const status = document.createElement("div");
  status.style.cssText = "margin-bottom:8px;color:var(--hb-text-cream,#fff);";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.style.cssText = "padding:6px 12px;background:rgba(120,84,32,0.5);color:#fff;border:1px solid #8a7544;border-radius:3px;cursor:pointer;font-family:inherit;";
  const note = document.createElement("div");
  note.style.cssText = "margin-top:8px;font-size:10px;color:rgba(255,255,255,0.55);font-style:italic;";
  note.textContent = "Press Esc to exit fullscreen.";

  function refresh() {
    const on = !!document.fullscreenElement;
    status.textContent = on
      ? "Currently fullscreen — canvas at screen resolution."
      : "Currently windowed.";
    btn.textContent = on ? "Exit Fullscreen" : "Enter Fullscreen";
  }

  function onClick() {
    if (document.fullscreenElement) {
      document.exitFullscreen?.();
    } else {
      document.documentElement.requestFullscreen?.()
        .then(() => {
          // Three.js needs a resize to pick up the new viewport. Some
          // renderers auto-resize via ResizeObserver; many don't. Dispatch
          // a resize event so listeners (scene3d/index.js handleResize)
          // re-compute camera projection + renderer drawing buffer at
          // native res.
          setTimeout(() => {
            window.dispatchEvent(new Event("resize"));
          }, 50);
        })
        .catch((e) => console.warn("[fullscreen] request failed:", e));
    }
    setTimeout(refresh, 100);
  }

  const onChange = () => refresh();
  btn.addEventListener("click", onClick);
  document.addEventListener("fullscreenchange", onChange);

  containerEl.appendChild(status);
  containerEl.appendChild(btn);
  containerEl.appendChild(note);
  refresh();

  return function dispose() {
    document.removeEventListener("fullscreenchange", onChange);
  };
}
