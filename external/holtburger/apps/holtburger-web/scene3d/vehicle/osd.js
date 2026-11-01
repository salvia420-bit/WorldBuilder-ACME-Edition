// scene3d/vehicle/osd.js — the vehicle OSD (speed, altitude above ground, heading, throttle, mode, ammo) and the
// board prompt. Plain DOM, one fixed panel; hidden with H. Page module: {document} injected.

import { MODE_NAMES } from "./flight_model.js";

export const OSD_ID = "hb-vehicle-osd";
export const PROMPT_ID = "hb-vehicle-prompt";
const STYLE_ID = "hb-vehicle-osd-style";

const CSS = `
#${OSD_ID}{position:fixed;left:50%;bottom:96px;transform:translateX(-50%);z-index:60;pointer-events:none;
  font:600 13px/1.35 ui-monospace,Menlo,Consolas,monospace;color:#d8f5d0;background:rgba(6,14,10,.55);
  border:1px solid rgba(160,230,150,.35);border-radius:6px;padding:6px 12px;white-space:pre;text-shadow:0 1px 1px #000}
#${OSD_ID}.warn{color:#ffd27a;border-color:rgba(255,210,120,.5)}
#${PROMPT_ID}{position:fixed;left:50%;bottom:150px;transform:translateX(-50%);z-index:60;pointer-events:none;
  font:600 14px/1.3 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.6);border-radius:6px;padding:6px 14px}
`;

export function compass(rad) {
  const deg = ((rad * 180) / Math.PI + 360) % 360;
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return `${String(Math.round(deg)).padStart(3, "0")}° ${names[Math.round(deg / 45) % 8]}`;
}

export function createVehicleOsd(deps = {}) {
  const doc = deps.document ?? (typeof document !== "undefined" ? document : null);
  let el = null;
  let prompt = null;
  let hidden = false;

  function ensure() {
    if (!doc || el) return;
    if (!doc.getElementById(STYLE_ID)) {
      const st = doc.createElement("style");
      st.id = STYLE_ID;
      st.textContent = CSS;
      doc.head.appendChild(st);
    }
    el = doc.createElement("div");
    el.id = OSD_ID;
    el.style.display = "none";
    doc.body.appendChild(el);
    prompt = doc.createElement("div");
    prompt.id = PROMPT_ID;
    prompt.style.display = "none";
    doc.body.appendChild(prompt);
  }

  return {
    /** @param {{name, speed, agl, heading, throttle, mode, ammo, vCap, boost, land, corr, warn}} s */
    update(s) {
      ensure();
      if (!el) return;
      if (!s || hidden) {
        el.style.display = "none";
        return;
      }
      const kmh = Math.round((s.speed || 0) * 3.6);
      const cap = Math.round((s.vCap || 0) * 3.6);
      const lines = [
        `${s.name || "Vehicle"}  ${MODE_NAMES[s.mode] ?? s.mode}${s.land ? "  LAND" : ""}${s.boost ? "  BOOST" : ""}`,
        `SPD ${String(kmh).padStart(3)} km/h (cap ${cap})   ALT ${Math.round(s.agl ?? 0)} m AGL   HDG ${compass(s.heading || 0)}`,
        `THR ${String(Math.round((s.throttle || 0) * 100)).padStart(3)}%   AMMO ${s.ammo ?? "-"}   ${s.corr ?? ""}`,
      ];
      el.textContent = lines.join("\n");
      el.className = s.warn ? "warn" : "";
      el.style.display = "block";
    },
    prompt(text) {
      ensure();
      if (!prompt) return;
      if (!text) {
        prompt.style.display = "none";
        return;
      }
      prompt.textContent = text;
      prompt.style.display = "block";
    },
    toggleHidden() { hidden = !hidden; return hidden; },
    hide() { if (el) el.style.display = "none"; if (prompt) prompt.style.display = "none"; },
    dispose() {
      try { el?.remove(); prompt?.remove(); } catch (_) { /* gone */ }
      el = null; prompt = null;
    },
  };
}
