// scene3d/vehicle/osd.js — the vehicle OSD: flight (speed, altitude above ground, heading, throttle, mode), the armament
// (quarrels left, the six lightning rails, the bomb stations), a gunsight reticle at the guns' convergence point, a bomb
// pipper at the predicted impact, and the board / event prompt. Plain DOM, fixed elements; hidden with H.
// Writes the DOM only when a value changed (every frame rewrote the panel and forced a style pass). After dispose()
// nothing re-creates the elements (a late prompt timer used to append orphan nodes).
// Page module: {document} injected.

import { MODE_NAMES } from "./flight_model.js";

export const OSD_ID = "hb-vehicle-osd";
export const PROMPT_ID = "hb-vehicle-prompt";
export const RETICLE_ID = "hb-vehicle-reticle";
export const PIPPER_ID = "hb-vehicle-pipper";
const STYLE_ID = "hb-vehicle-osd-style";

const CSS = `
#${OSD_ID}{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:60;pointer-events:none;
  font:600 13px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#d8f5d0;background:rgba(6,14,10,.55);
  border:1px solid rgba(160,230,150,.35);border-radius:6px;padding:6px 12px;white-space:pre;text-shadow:0 1px 1px #000}
#${OSD_ID}.warn{color:#ffd27a;border-color:rgba(255,210,120,.5)}
#${PROMPT_ID}{position:fixed;left:50%;bottom:170px;transform:translateX(-50%);z-index:60;pointer-events:none;
  font:600 14px/1.3 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.6);border-radius:6px;padding:6px 14px}
#${RETICLE_ID},#${PIPPER_ID}{position:fixed;left:0;top:0;z-index:59;pointer-events:none;will-change:transform}
#${RETICLE_ID}{width:34px;height:34px;margin:-17px 0 0 -17px;border:2px solid rgba(255,214,120,.85);border-radius:50%;
  box-shadow:0 0 2px #000}
#${RETICLE_ID}::before,#${RETICLE_ID}::after{content:"";position:absolute;background:rgba(255,214,120,.9)}
#${RETICLE_ID}::before{left:15px;top:-9px;width:2px;height:50px}
#${RETICLE_ID}::after{top:15px;left:-9px;height:2px;width:50px}
#${PIPPER_ID}{width:26px;height:26px;margin:-13px 0 0 -13px;border:2px dashed rgba(255,120,90,.95);border-radius:50%;
  box-shadow:0 0 2px #000}
#${PIPPER_ID}::after{content:attr(data-label);position:absolute;left:30px;top:3px;white-space:nowrap;
  font:600 11px ui-monospace,Menlo,Consolas,monospace;color:#ffb39a;text-shadow:0 1px 1px #000}
`;

export function compass(rad) {
  const deg = ((rad * 180) / Math.PI + 360) % 360;
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return `${String(Math.round(deg)).padStart(3, "0")}° ${names[Math.round(deg / 45) % 8]}`;
}

/** "◆◆◇◆◆◆": one mark per rail / station, filled while loaded (bit i of `mask`). */
export function maskMarks(mask, n, full = "◆", empty = "◇") {
  let s = "";
  for (let i = 0; i < n; i++) s += ((mask >>> i) & 1) ? full : empty;
  return s;
}

/** The armament line: quarrels, rails, bombs (lb per station). */
export function armamentLine(a) {
  if (!a) return "";
  const parts = [];
  if (a.guns > 0) parts.push(`QUARRELS ${String(a.quarrels ?? 0).padStart(4)}`);
  if (a.rails > 0) parts.push(`BOLTS ${maskMarks(a.missileMask ?? 0, a.rails)}`);
  if (Array.isArray(a.bombs) && a.bombs.length) {
    parts.push("BOMBS " + a.bombs.map((lb, i) => (((a.bombMask ?? 0) >>> i) & 1) ? `[${lb}]` : `[${"-".repeat(String(lb).length)}]`).join(""));
  }
  return parts.join("   ");
}

export function createVehicleOsd(deps = {}) {
  const doc = deps.document ?? (typeof document !== "undefined" ? document : null);
  let el = null, prompt = null, reticle = null, pipper = null;
  let hidden = false;
  let disposed = false;
  const last = { text: null, cls: null, shown: null, prompt: null, promptShown: null, ret: null, pip: null, pipLabel: null };

  function ensure() {
    if (disposed || !doc || el) return;
    if (!doc.getElementById(STYLE_ID)) {
      const st = doc.createElement("style");
      st.id = STYLE_ID;
      st.textContent = CSS;
      doc.head.appendChild(st);
    }
    const mk = (id) => { const d = doc.createElement("div"); d.id = id; d.style.display = "none"; doc.body.appendChild(d); return d; };
    el = mk(OSD_ID);
    prompt = mk(PROMPT_ID);
    reticle = mk(RETICLE_ID);
    pipper = mk(PIPPER_ID);
  }

  function show(node, key, on) {
    if (last[key] === on) return;
    last[key] = on;
    node.style.display = on ? "block" : "none";
  }

  function place(node, key, p) {
    const on = !!p && !hidden;
    const k = on ? `${Math.round(p.x)},${Math.round(p.y)}` : "off";
    if (last[key] === k) return;
    last[key] = k;
    if (!on) { node.style.display = "none"; return; }
    node.style.display = "block";
    node.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
  }

  return {
    /** @param {{name, speed, agl, heading, throttle, mode, vCap, boost, land, corr, warn, arms}} s (null hides) */
    update(s) {
      ensure();
      if (!el) return;
      if (!s || hidden) {
        show(el, "shown", false);
        return;
      }
      const kmh = Math.round((s.speed || 0) * 3.6);
      const cap = Math.round((s.vCap || 0) * 3.6);
      const lines = [
        `${s.name || "Vehicle"}  ${MODE_NAMES[s.mode] ?? s.mode}${s.land ? "  LAND" : ""}${s.boost ? "  BOOST" : ""}`,
        `SPD ${String(kmh).padStart(3)} km/h (cap ${cap})   ALT ${Math.round(s.agl ?? 0)} m AGL   HDG ${compass(s.heading || 0)}`,
        `THR ${String(Math.round((s.throttle || 0) * 100)).padStart(3)}%   ${s.corr ?? ""}`,
      ];
      const arms = armamentLine(s.arms);
      if (arms) lines.push(arms);
      if (s.arms) lines.push("Space guns   G bolts   V bomb   Tab view   X exit/bail");
      const text = lines.join("\n");
      if (text !== last.text) { last.text = text; el.textContent = text; }
      const cls = s.warn ? "warn" : "";
      if (cls !== last.cls) { last.cls = cls; el.className = cls; }
      show(el, "shown", true);
    },
    /** Screen positions (CSS px) of the gun convergence point and the bomb impact, or null to hide each. */
    sights(ret, pip, pipLabel) {
      ensure();
      if (!reticle) return;
      place(reticle, "ret", ret);
      place(pipper, "pip", pip);
      const lbl = pip ? (pipLabel || "") : "";
      if (lbl !== last.pipLabel) { last.pipLabel = lbl; pipper.setAttribute("data-label", lbl); }
    },
    prompt(text) {
      ensure();
      if (!prompt) return;
      const t = text || null;
      if (t === last.prompt) return;
      last.prompt = t;
      if (!t) { prompt.style.display = "none"; return; }
      prompt.textContent = t;
      prompt.style.display = "block";
    },
    get promptText() { return last.prompt; },
    toggleHidden() {
      hidden = !hidden;
      if (hidden && el) { show(el, "shown", false); place(reticle, "ret", null); place(pipper, "pip", null); }
      return hidden;
    },
    hide() {
      if (el) show(el, "shown", false);
      if (prompt) { prompt.style.display = "none"; last.prompt = null; }
      if (reticle) { place(reticle, "ret", null); place(pipper, "pip", null); }
    },
    dispose() {
      disposed = true;
      try { el?.remove(); prompt?.remove(); reticle?.remove(); pipper?.remove(); } catch (_) { /* gone */ }
      el = null; prompt = null; reticle = null; pipper = null;
    },
  };
}
