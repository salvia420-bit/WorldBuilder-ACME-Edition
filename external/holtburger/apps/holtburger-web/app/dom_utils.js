// app/dom_utils.js — DOM/string helpers shared by the inline boot script and
// the other app/ modules. Extracted verbatim from index.html (2026-10-05).

export function escapeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Unmissable in-world "session dead" banner (login-boot diagnosis
// 2026-06-11 fix 9: the zombie state — world rendered, dead socket —
// was indistinguishable from connected because loginStatus is hidden
// in agent mode). Shared by the kind-4 Disconnected handler and the
// wasm panic hook in index.html.
export function showDisconnectBanner(text, onReconnect) {
  try {
    if (window.__bootState === "in-world" || window.__bootState === "ready" || typeof document !== "undefined") {
      let b = document.getElementById("hbDisconnectBanner");
      if (!b) {
        b = document.createElement("div");
        b.id = "hbDisconnectBanner";
        b.style.cssText =
          "position:fixed;top:0;left:0;right:0;z-index:99999;" +
          "background:#a00;color:#fff;font:bold 16px/1.6 monospace;" +
          "text-align:center;padding:6px;";
        document.body.appendChild(b);
      }
      b.textContent = text + " ";
      let btn = document.getElementById("hbBannerReconnectBtn");
      if (!btn) {
        btn = document.createElement("button");
        btn.id = "hbBannerReconnectBtn";
        btn.textContent = "Reconnect";
        btn.style.cssText = "margin-left:12px;padding:2px 10px;font:bold 13px sans-serif;cursor:pointer;";
        btn.addEventListener("click", () => {
          if (typeof onReconnect === "function") onReconnect();
          else location.reload();
        });
        b.appendChild(btn);
      }
    }
  } catch (_) { /* banner is best-effort */ }
}
