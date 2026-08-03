// Shared markup/DOM hygiene helpers for HUD panels.
//
// Invariant: any string that reaches an `innerHTML` template and did NOT
// originate in this repo is attacker-controlled markup. Character names,
// allegiance names, chat text, vendor PropertyStrings and item names all
// arrive over the wire and are chosen by other players or by world data —
// none of them may be interpolated raw.
//
// Prefer `textContent` / `createElement` when the surrounding markup is
// trivial; reach for `escapeHtml` only when a row's real markup (nested
// label/value spans, <b>, inline styles) has to be preserved and rebuilding
// it as DOM nodes would be the larger, riskier diff.
//
// Extracted 2026-08-03 from plugins/spell-research-panel.js, which had the
// only copy — allegiance-panel.js needed the same thing and a second private
// definition is how these drift.

/**
 * Escape the five HTML-significant characters so `s` can be safely
 * interpolated into an `innerHTML` template as text.
 *
 * @param {unknown} s
 * @returns {string}
 */
export function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Drop an item cell's placeholder GLYPH without touching its element
 * children.
 *
 * The pattern this exists for: a slot paints a text placeholder ("📦", "✦"),
 * kicks off an async `fetchIconDataUrl`, and then — still synchronously —
 * appends element badges (stack count, UiEffects chips, layer/timer labels).
 * When the icon resolves, `el.textContent = ""` removes ALL children, badges
 * included, so the count silently disappears one frame after it paints.
 * Removing only the text nodes keeps the badges and is correct whether the
 * icon resolves before or after they are appended.
 *
 * @param {Element} el
 */
export function clearPlaceholderGlyph(el) {
  for (const n of [...el.childNodes]) {
    if (n.nodeType === 3 /* Node.TEXT_NODE */) n.remove();
  }
}
