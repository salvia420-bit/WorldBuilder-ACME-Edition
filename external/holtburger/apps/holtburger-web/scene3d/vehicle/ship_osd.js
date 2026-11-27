// scene3d/vehicle/ship_osd.js — Zero-Canvas2D Nautical Bridge DOM HUD (`#hb-ship-osd`)
//
// Lightweight DOM + CSS-transform marine bridge instrumentation overlay:
//   - Compass heading tape + 3-digit digital heading
//   - Mode badge (MANUAL HELM / AUTONOMOUS CAPTAIN / MOORED) + view mode pill
//   - SOG (kt & m/s), ROT (°/min), UKC depth with shoal caution/warning cues
//   - 7-notch Engine Order Telegraph (EOT: -3 Full Astern .. 0 Stop .. +3 Full Ahead)
//   - Rudder angle indicator (±35° port red / stbd green)
//   - Bow & Stern lateral tunnel thruster bars (-100%..+100%)
//   - Berth Alignment guide (target berth, fender gap m, fore/aft offset m, heading err °, READY TO MOOR cue)
//   - Compact helm keybind strip
//
// Uses `id="hb-ship-osd"` and `hb-*` classes so `[id^=hb-]` hides it cleanly in screenshots when desired,
// while remaining crisp and legible at 1920x1080 in manual-helm bridge shots.
// Zero Canvas2D, zero innerHTML, dirty-checked DOM updates, guaranteed 0 DOM writes after dispose().

import { SHIP_SPECS, SHIP_EOT_NOTCHES } from "./port_specs.js";

export const SHIP_OSD_ID = "hb-ship-osd";
export const SHIP_PROMPT_ID = "hb-ship-prompt";
const STYLE_ID = "hb-ship-osd-style";

export const SHIP_KEYBIND_TEXT =
  "W/S EOT · Space All Stop · A/D Rudder · C Center · Q/E Crab · Shift+A/D Pivot · M Moor · P Auto/Man · 1/2 Berth · H Foghorn · Tab Cam · X Exit";

export const EOT_NOTCHES = Object.freeze(
  [...SHIP_EOT_NOTCHES].reverse().map((n) => Object.freeze({
    notch: n.notch,
    code: n.notch > 0 ? `+${n.notch}` : (n.notch === 0 ? " 0" : String(n.notch)),
    label: n.label,
  }))
);

const KTS_PER_MPS = 1.94384449;
const DEG_PER_RAD = 180 / Math.PI;
const MAX_RUDDER_DEG = Math.round(SHIP_SPECS.maxRudderRad * DEG_PER_RAD);

const CSS = `
#${SHIP_OSD_ID}{position:fixed;inset:0;z-index:62;pointer-events:none;
  font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#d6f4ff;
  text-shadow:0 1px 2px rgba(0,0,0,.92)}
#${SHIP_OSD_ID} .hb-ship-panel{background:rgba(7,16,26,.80);border:1.5px solid rgba(92,196,238,.48);
  border-radius:8px;padding:8px 12px;box-shadow:0 6px 18px rgba(0,0,0,.55)}
#${SHIP_OSD_ID} .hb-ship-top{position:fixed;left:50%;top:18px;transform:translateX(-50%);
  display:flex;flex-direction:column;align-items:center;gap:5px}
#${SHIP_OSD_ID} .hb-ship-top-row{display:flex;align-items:center;gap:8px}
#${SHIP_OSD_ID} .hb-ship-title{font-size:11px;letter-spacing:.10em;color:#8ed8f8;font-weight:800;text-transform:uppercase}
#${SHIP_OSD_ID} .hb-ship-mode{padding:2px 9px;border-radius:4px;font-size:11px;font-weight:800;letter-spacing:.06em;
  border:1px solid rgba(92,196,238,.5);background:rgba(14,42,64,.85);color:#ccf4ff}
#${SHIP_OSD_ID} .hb-ship-mode.manual{background:rgba(12,72,54,.88);border-color:#44e59c;color:#eafff4}
#${SHIP_OSD_ID} .hb-ship-mode.auto{background:rgba(78,52,12,.88);border-color:#ffb84d;color:#fff3d6}
#${SHIP_OSD_ID} .hb-ship-mode.moored{background:rgba(14,68,78,.90);border-color:#4de8e8;color:#e6ffff}
#${SHIP_OSD_ID} .hb-ship-view{padding:2px 7px;border-radius:4px;font-size:10.5px;font-weight:700;
  border:1px solid rgba(150,210,240,.35);background:rgba(8,22,36,.78);color:#a8ddf5}
#${SHIP_OSD_ID} .hb-ship-hdg-box{padding:2px 12px;background:rgba(5,14,24,.88);border:1.5px solid rgba(92,196,238,.65);
  border-radius:5px;font-size:15px;font-weight:800;letter-spacing:.08em;color:#f0fbff}
#${SHIP_OSD_ID} .hb-ship-hdg-win{width:280px;height:18px;overflow:hidden;position:relative;
  background:rgba(5,14,24,.68);border:1px solid rgba(92,196,238,.36);border-radius:4px}
#${SHIP_OSD_ID} .hb-ship-hdg-tape{position:absolute;left:50%;top:1px;white-space:nowrap;font-size:10.5px;
  color:rgba(195,235,252,.88);will-change:transform}
#${SHIP_OSD_ID} .hb-ship-hdg-caret{position:absolute;left:50%;top:0;bottom:0;width:2px;margin-left:-1px;background:#ffd25a}
#${SHIP_OSD_ID} .hb-ship-left{position:fixed;left:24px;bottom:64px;display:flex;gap:10px;align-items:flex-end}
#${SHIP_OSD_ID} .hb-ship-eot{display:flex;flex-direction:column;gap:2px;min-width:106px}
#${SHIP_OSD_ID} .hb-ship-section{font-size:10px;font-weight:800;letter-spacing:.09em;color:#7ec8e8;margin-bottom:4px;text-transform:uppercase}
#${SHIP_OSD_ID} .hb-ship-eot-row{display:flex;justify-content:space-between;padding:2px 6px;border-radius:3px;font-size:10.5px;
  color:rgba(180,215,232,.52);background:rgba(12,24,36,.55);border:1px solid transparent}
#${SHIP_OSD_ID} .hb-ship-eot-row.active-ahead{background:rgba(18,98,62,.88);border-color:#4ae598;color:#f0fff6;font-weight:800}
#${SHIP_OSD_ID} .hb-ship-eot-row.active-stop{background:rgba(34,62,84,.90);border-color:#78d2f8;color:#f0fbff;font-weight:800}
#${SHIP_OSD_ID} .hb-ship-eot-row.active-astern{background:rgba(130,36,28,.90);border-color:#ff7262;color:#fff2f0;font-weight:800}
#${SHIP_OSD_ID} .hb-ship-nav{min-width:176px;display:flex;flex-direction:column;gap:6px}
#${SHIP_OSD_ID} .hb-ship-sog-big{font-size:26px;font-weight:800;color:#f2fcff;line-height:1.05}
#${SHIP_OSD_ID} .hb-ship-unit{font-size:12px;font-weight:700;color:#7fd2f4;margin-left:4px}
#${SHIP_OSD_ID} .hb-ship-kv{display:flex;justify-content:space-between;gap:12px;font-size:11.5px;color:#bde6f8}
#${SHIP_OSD_ID} .hb-ship-kv-val{font-weight:800;color:#f0fbff}
#${SHIP_OSD_ID} .hb-ship-kv-val.warn{color:#ffc452}
#${SHIP_OSD_ID} .hb-ship-kv-val.crit{color:#ff6e60}
#${SHIP_OSD_ID} .hb-ship-right{position:fixed;right:24px;bottom:64px;display:flex;flex-direction:column;gap:10px;min-width:236px}
#${SHIP_OSD_ID} .hb-ship-bar-wrap{margin-top:4px;margin-bottom:6px}
#${SHIP_OSD_ID} .hb-ship-bar-hdr{display:flex;justify-content:space-between;font-size:10.5px;color:#b4e0f4;margin-bottom:2px}
#${SHIP_OSD_ID} .hb-ship-bar-track{position:relative;height:10px;background:rgba(6,14,22,.85);
  border:1px solid rgba(92,196,238,.4);border-radius:3px;overflow:hidden}
#${SHIP_OSD_ID} .hb-ship-bar-mid{position:absolute;left:50%;top:0;bottom:0;width:1.5px;background:rgba(220,245,255,.55)}
#${SHIP_OSD_ID} .hb-ship-bar-fill{position:absolute;top:0;bottom:0;left:50%;width:0%;background:#44e59c}
#${SHIP_OSD_ID} .hb-ship-bar-fill.port{background:#ff6658}
#${SHIP_OSD_ID} .hb-ship-bar-fill.stbd{background:#3ee68a}
#${SHIP_OSD_ID} .hb-ship-bar-fill.thr{background:#48d6ff}
#${SHIP_OSD_ID} .hb-ship-berth-cue{margin-top:6px;padding:4px 8px;border-radius:4px;text-align:center;font-size:11px;font-weight:800;
  background:rgba(16,32,46,.8);border:1px solid rgba(92,196,238,.35);color:#9ad0e8}
#${SHIP_OSD_ID} .hb-ship-berth-cue.ready{background:rgba(14,96,62,.92);border-color:#4ef29c;color:#ecfff4;box-shadow:0 0 10px rgba(78,242,156,.35)}
#${SHIP_OSD_ID} .hb-ship-berth-cue.moored{background:rgba(14,82,96,.92);border-color:#56f0f0;color:#eaffff}
#${SHIP_OSD_ID} .hb-ship-bottom{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);
  background:rgba(6,15,24,.82);border:1px solid rgba(92,196,238,.42);border-radius:6px;
  padding:5px 14px;font-size:11px;color:#bce8fa;white-space:nowrap;text-align:center}
#${SHIP_PROMPT_ID}{position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:63;pointer-events:none;
  font:600 13.5px/1.3 system-ui,sans-serif;color:#f0fbff;background:rgba(6,16,28,.82);
  border:1px solid rgba(92,196,238,.55);border-radius:6px;padding:6px 14px}
`;

const COMPASS_TAPE_TEXT =
  "W · 300 · 330 · N · 030 · 060 · E · 120 · 150 · S · 210 · 240 · W · 300 · 330 · N · 030 · 060 · E · 120 · 150 · S";

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function fin(v) {
  return typeof v === "number" && Number.isFinite(v);
}

function mkEl(doc, tag, cls = "", id = "") {
  const n = doc.createElement(tag);
  if (!n.style) n.style = {};
  if (cls) n.className = cls;
  if (id) n.id = id;
  return n;
}

function append(parent, child) {
  if (parent && child && typeof parent.appendChild === "function") parent.appendChild(child);
  return child;
}

export function formatCompassHeading(rad) {
  const deg = (((fin(rad) ? rad : 0) * DEG_PER_RAD) % 360 + 360) % 360;
  const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  const rounded = Math.round(deg) % 360;
  return `${String(rounded).padStart(3, "0")}° ${dirs[Math.round(deg / 45) % 8]}`;
}

export function formatSignedMeters(v, decimals = 1) {
  const n = fin(v) ? v : 0;
  const sign = n > 0.05 ? "+" : (n < -0.05 ? "-" : " ");
  return `${sign}${Math.abs(n).toFixed(decimals)} m`;
}

/**
 * Create the nautical bridge HUD controller (`#hb-ship-osd`).
 * @param {{document?: object|null}} [deps]
 */
export function createShipOsd(deps = {}) {
  const doc = deps.document ?? (typeof document !== "undefined" ? document : null);

  let rootEl = null;
  let styleEl = null;
  let promptEl = null;

  // Top compass & mode badges
  let titleEl = null;
  let modeEl = null;
  let viewEl = null;
  let hdgBoxEl = null;
  let hdgTapeEl = null;

  // Left EOT & nav metrics
  let eotRowEls = [];
  let sogKtEl = null;
  let sogMpsEl = null;
  let rotValEl = null;
  let ukcValEl = null;
  let trimValEl = null;

  // Right rudder, thrusters & berth alignment
  let rudderValEl = null;
  let rudderFillEl = null;
  let bowThrValEl = null;
  let bowThrFillEl = null;
  let sternThrValEl = null;
  let sternThrFillEl = null;
  let berthNameEl = null;
  let fenderGapEl = null;
  let foreAftEl = null;
  let hdgErrEl = null;
  let berthCueEl = null;
  let keysEl = null;

  let hidden = false;
  let disposed = false;
  let visible = false;

  const cache = Object.create(null);

  function setTxt(node, key, val) {
    if (!node || cache[key] === val) return;
    cache[key] = val;
    node.textContent = val;
  }

  function setCls(node, key, val) {
    if (!node || cache[key] === val) return;
    cache[key] = val;
    node.className = val;
  }

  function setStyle(node, prop, key, val) {
    if (!node || !node.style || cache[key] === val) return;
    cache[key] = val;
    node.style[prop] = val;
  }

  function setCenteredBar(fillEl, prefix, normVal, posCls, negCls) {
    if (!fillEl) return;
    const v = clamp(fin(normVal) ? normVal : 0, -1, 1);
    const pct = Math.round(Math.abs(v) * 50);
    const leftPct = v >= 0 ? 50 : 50 - pct;
    const cls = v < -0.01 ? `hb-ship-bar-fill ${negCls}` : (v > 0.01 ? `hb-ship-bar-fill ${posCls}` : "hb-ship-bar-fill");
    setCls(fillEl, `${prefix}_cls`, cls);
    setStyle(fillEl, "left", `${prefix}_l`, `${leftPct}%`);
    setStyle(fillEl, "width", `${prefix}_w`, `${pct}%`);
  }

  function ensure() {
    if (disposed || !doc || rootEl) return;
    if (typeof doc.getElementById === "function" && !doc.getElementById(STYLE_ID) && doc.head) {
      styleEl = mkEl(doc, "style", "", STYLE_ID);
      styleEl.textContent = CSS;
      append(doc.head, styleEl);
    }

    rootEl = mkEl(doc, "div", "", SHIP_OSD_ID);
    rootEl.style.display = "none";
    append(doc.body, rootEl);

    promptEl = mkEl(doc, "div", "", SHIP_PROMPT_ID);
    promptEl.style.display = "none";
    append(doc.body, promptEl);

    // 1. Top center: Vessel title, Mode badge, View pill, Compass readout + sliding tape
    const topWrap = append(rootEl, mkEl(doc, "div", "hb-ship-top"));
    const topRow = append(topWrap, mkEl(doc, "div", "hb-ship-top-row"));
    titleEl = append(topRow, mkEl(doc, "span", "hb-ship-title"));
    titleEl.textContent = "M/V DERETH FEEDER";
    modeEl = append(topRow, mkEl(doc, "span", "hb-ship-mode manual"));
    modeEl.textContent = "MANUAL HELM";
    viewEl = append(topRow, mkEl(doc, "span", "hb-ship-view"));
    viewEl.textContent = "CAM: BRIDGE";

    hdgBoxEl = append(topWrap, mkEl(doc, "div", "hb-ship-hdg-box"));
    hdgBoxEl.textContent = "000° N";
    const hdgWin = append(topWrap, mkEl(doc, "div", "hb-ship-hdg-win"));
    hdgTapeEl = append(hdgWin, mkEl(doc, "div", "hb-ship-hdg-tape"));
    hdgTapeEl.textContent = COMPASS_TAPE_TEXT;
    append(hdgWin, mkEl(doc, "div", "hb-ship-hdg-caret"));

    // 2. Bottom-left: 7-notch EOT + SOG / ROT / UKC
    const leftWrap = append(rootEl, mkEl(doc, "div", "hb-ship-left"));
    const eotPanel = append(leftWrap, mkEl(doc, "div", "hb-ship-panel hb-ship-eot"));
    const eotTitle = append(eotPanel, mkEl(doc, "div", "hb-ship-section"));
    eotTitle.textContent = "ENGINE TELEGRAPH";
    eotRowEls = [];
    for (let i = 0; i < EOT_NOTCHES.length; i++) {
      const n = EOT_NOTCHES[i];
      const row = append(eotPanel, mkEl(doc, "div", "hb-ship-eot-row"));
      const codeSp = append(row, mkEl(doc, "span"));
      codeSp.textContent = n.code;
      const lblSp = append(row, mkEl(doc, "span"));
      lblSp.textContent = n.label;
      eotRowEls.push({ notch: n.notch, el: row });
    }

    const navPanel = append(leftWrap, mkEl(doc, "div", "hb-ship-panel hb-ship-nav"));
    const navTitle = append(navPanel, mkEl(doc, "div", "hb-ship-section"));
    navTitle.textContent = "NAVIGATION";
    const sogLine = append(navPanel, mkEl(doc, "div"));
    sogKtEl = append(sogLine, mkEl(doc, "span", "hb-ship-sog-big"));
    sogKtEl.textContent = "0.0";
    const sogUnit = append(sogLine, mkEl(doc, "span", "hb-ship-unit"));
    sogUnit.textContent = "KT";

    const mkKv = (parent, label, init) => {
      const row = append(parent, mkEl(doc, "div", "hb-ship-kv"));
      const k = append(row, mkEl(doc, "span"));
      k.textContent = label;
      const v = append(row, mkEl(doc, "span", "hb-ship-kv-val"));
      v.textContent = init;
      return v;
    };
    sogMpsEl = mkKv(navPanel, "SOG", "0.00 m/s");
    rotValEl = mkKv(navPanel, "ROT", "0.0 °/min");
    ukcValEl = mkKv(navPanel, "UKC DEPTH", "14.0 m");
    trimValEl = mkKv(navPanel, "CARGO", "0 TEU");

    // 3. Bottom-right: Rudder + Bow/Stern Thrusters + Berth Alignment Guide
    const rightWrap = append(rootEl, mkEl(doc, "div", "hb-ship-right"));
    const helmPanel = append(rightWrap, mkEl(doc, "div", "hb-ship-panel"));
    const helmTitle = append(helmPanel, mkEl(doc, "div", "hb-ship-section"));
    helmTitle.textContent = "HELM & THRUSTERS";

    const mkBar = (parent, label, initVal) => {
      const wrap = append(parent, mkEl(doc, "div", "hb-ship-bar-wrap"));
      const hdr = append(wrap, mkEl(doc, "div", "hb-ship-bar-hdr"));
      const l = append(hdr, mkEl(doc, "span"));
      l.textContent = label;
      const v = append(hdr, mkEl(doc, "span", "hb-ship-kv-val"));
      v.textContent = initVal;
      const track = append(wrap, mkEl(doc, "div", "hb-ship-bar-track"));
      const fill = append(track, mkEl(doc, "div", "hb-ship-bar-fill"));
      append(track, mkEl(doc, "div", "hb-ship-bar-mid"));
      return { valEl: v, fillEl: fill };
    };

    const rudBar = mkBar(helmPanel, "RUDDER (P/S)", "MIDSHIPS");
    rudderValEl = rudBar.valEl;
    rudderFillEl = rudBar.fillEl;

    const bowBar = mkBar(helmPanel, "BOW THRUSTER", "0%");
    bowThrValEl = bowBar.valEl;
    bowThrFillEl = bowBar.fillEl;

    const sternBar = mkBar(helmPanel, "STERN THRUSTER", "0%");
    sternThrValEl = sternBar.valEl;
    sternThrFillEl = sternBar.fillEl;

    const berthPanel = append(rightWrap, mkEl(doc, "div", "hb-ship-panel"));
    const berthTitle = append(berthPanel, mkEl(doc, "div", "hb-ship-section"));
    berthTitle.textContent = "BERTH ALIGNMENT";
    berthNameEl = mkKv(berthPanel, "TARGET BERTH", "B1");
    fenderGapEl = mkKv(berthPanel, "FENDER GAP", "-- m");
    foreAftEl = mkKv(berthPanel, "FORE/AFT", "-- m");
    hdgErrEl = mkKv(berthPanel, "HDG ERR", "--°");
    berthCueEl = append(berthPanel, mkEl(doc, "div", "hb-ship-berth-cue"));
    berthCueEl.textContent = "APPROACH";

    // 4. Bottom-center keybind strip
    keysEl = append(rootEl, mkEl(doc, "div", "hb-ship-bottom"));
    keysEl.textContent = SHIP_KEYBIND_TEXT;
  }

  function update(state) {
    if (disposed) return;
    ensure();
    if (!rootEl) return;

    if (!state || hidden) {
      visible = false;
      setStyle(rootEl, "display", "root_disp", "none");
      return;
    }

    visible = true;
    setStyle(rootEl, "display", "root_disp", "block");

    const s = state;
    // Title & Mode badge (supports both ship_kinematics state & custom HUD objects)
    const rawName = (typeof s.vesselName === "string" && s.vesselName) ? s.vesselName : s.name;
    const vesselName = typeof rawName === "string" && rawName ? rawName.toUpperCase() : SHIP_SPECS.defaultName.toUpperCase();
    setTxt(titleEl, "title", vesselName);

    const phase = typeof s.phase === "string" ? s.phase : (typeof s.captainState === "string" ? s.captainState : "");
    const modeLower = typeof s.mode === "string" ? s.mode.toLowerCase() : "";
    const isAuto = Boolean(s.autopilot || s.controlMode === "auto" || modeLower === "autonomous");
    const moored = Boolean(s.moored || modeLower === "moored" || phase === "MOORING" || phase === "CARGO_OPS");
    let modeText = "MANUAL HELM";
    let modeCls = "hb-ship-mode manual";
    if (s.moored) {
      modeText = phase === "CARGO_OPS" ? "MOORED · CARGO OPS" : "MOORED";
      modeCls = "hb-ship-mode moored";
    } else if (isAuto) {
      const ph = phase && phase !== "IDLE" ? ` · ${phase.replace(/_/g, " ")}` : "";
      modeText = `AUTONOMOUS CAPTAIN${ph}`;
      modeCls = "hb-ship-mode auto";
    } else if (moored) {
      modeText = "MOORED";
      modeCls = "hb-ship-mode moored";
    }
    setTxt(modeEl, "mode_txt", modeText);
    setCls(modeEl, "mode_cls", modeCls);

    const viewLabel = typeof s.viewMode === "string" && s.viewMode ? s.viewMode.toUpperCase() : "CHASE";
    setTxt(viewEl, "view_txt", `CAM: ${viewLabel}`);

    // Heading & Compass Tape
    const hdgRad = fin(s.heading) ? s.heading : 0;
    const hdgDeg = ((hdgRad * DEG_PER_RAD) % 360 + 360) % 360;
    setTxt(hdgBoxEl, "hdg_box", formatCompassHeading(hdgRad));
    // Slide compass tape smoothly (approx 1.55 px per degree centered around 180)
    const tapePx = -Math.round((hdgDeg - 180) * 1.55);
    setStyle(hdgTapeEl, "transform", "hdg_tape_tx", `translateX(${tapePx}px)`);

    // 7-Notch EOT Telegraph
    const rawEot = fin(s.eotNotch) ? s.eotNotch : (fin(s.eot) ? s.eot : 0);
    const eot = clamp(Math.round(rawEot), -3, 3);
    for (let i = 0; i < eotRowEls.length; i++) {
      const item = eotRowEls[i];
      let cls = "hb-ship-eot-row";
      if (item.notch === eot) {
        cls = eot > 0
          ? "hb-ship-eot-row active-ahead"
          : (eot < 0 ? "hb-ship-eot-row active-astern" : "hb-ship-eot-row active-stop");
      }
      setCls(item.el, `eot_${i}`, cls);
    }

    // SOG (kt & m/s)
    const surge = fin(s.surgeU) ? s.surgeU : (fin(s.surgeSpeed) ? s.surgeSpeed : (fin(s.speed) ? s.speed : 0));
    const sway = fin(s.swayV) ? s.swayV : (fin(s.swaySpeed) ? s.swaySpeed : 0);
    const sogMps = fin(s.sogMps) ? Math.abs(s.sogMps) : (fin(s.speed) ? Math.abs(s.speed) : Math.hypot(surge, sway));
    const sogKt = fin(s.sogKnots) ? Math.abs(s.sogKnots) : sogMps * KTS_PER_MPS;
    setTxt(sogKtEl, "sog_kt", sogKt.toFixed(1));
    setTxt(sogMpsEl, "sog_mps", `${sogMps.toFixed(2)} m/s`);

    // Rate of Turn (°/min)
    const yawRateRadS = fin(s.yawRateR) ? s.yawRateR : (fin(s.yawRate) ? s.yawRate : (fin(s.rotRadS) ? s.rotRadS : 0));
    const rotDegMin = fin(s.rotDegPerMin) ? s.rotDegPerMin : (fin(s.rotDegMin) ? s.rotDegMin : yawRateRadS * DEG_PER_RAD * 60);
    const rotSign = rotDegMin > 0.2 ? "+" : (rotDegMin < -0.2 ? "-" : " ");
    const rotSide = rotDegMin > 0.5 ? " S" : (rotDegMin < -0.5 ? " P" : "");
    setTxt(rotValEl, "rot_val", `${rotSign}${Math.abs(rotDegMin).toFixed(1)} °/m${rotSide}`);

    // UKC Depth
    const rawDepth = fin(s.waterDepthM) ? s.waterDepthM : (fin(s.chartDepthM) ? s.chartDepthM : null);
    const ukcM = fin(s.ukcM) ? s.ukcM : (rawDepth !== null ? Math.max(0, rawDepth - SHIP_SPECS.draftM) : 14.0);
    setTxt(ukcValEl, "ukc_val", `${ukcM.toFixed(1)} m`);
    const ukcCls = ukcM < 1.0 ? "hb-ship-kv-val crit" : (ukcM < 3.0 ? "hb-ship-kv-val warn" : "hb-ship-kv-val");
    setCls(ukcValEl, "ukc_cls", ukcCls);

    // Cargo TEU / container count
    const teu = fin(s.teuCount)
      ? Math.round(s.teuCount)
      : (fin(s.containerCount) ? Math.round(s.containerCount) : (fin(s.cargoCount) ? Math.round(s.cargoCount) : 0));
    setTxt(trimValEl, "cargo_teu", `${teu} BOX`);

    // Rudder Angle (±35° or normalized -1..+1)
    let rudderDeg = 0;
    if (fin(s.rudderDeg)) rudderDeg = clamp(s.rudderDeg, -MAX_RUDDER_DEG, MAX_RUDDER_DEG);
    else if (fin(s.rudderRad)) rudderDeg = clamp(s.rudderRad * DEG_PER_RAD, -MAX_RUDDER_DEG, MAX_RUDDER_DEG);
    else if (fin(s.rudderAngleRad)) rudderDeg = clamp(s.rudderAngleRad * DEG_PER_RAD, -MAX_RUDDER_DEG, MAX_RUDDER_DEG);
    else if (fin(s.rudder)) rudderDeg = clamp(s.rudder, -1, 1) * MAX_RUDDER_DEG;
    const rudNorm = clamp(rudderDeg / MAX_RUDDER_DEG, -1, 1);
    const rudLabel = Math.abs(rudderDeg) < 0.8
      ? "MIDSHIPS"
      : `${Math.round(Math.abs(rudderDeg))}° ${rudderDeg > 0 ? "STBD" : "PORT"}`;
    setTxt(rudderValEl, "rud_txt", rudLabel);
    setCenteredBar(rudderFillEl, "rud", rudNorm, "stbd", "port");

    // Bow & Stern Thrusters (-1..+1)
    const bowThr = clamp(fin(s.bowThruster) ? s.bowThruster : 0, -1, 1);
    const sternThr = clamp(fin(s.sternThruster) ? s.sternThruster : 0, -1, 1);
    const fmtThr = (v) => (Math.abs(v) < 0.02 ? "0%" : `${Math.round(Math.abs(v) * 100)}% ${v > 0 ? "STBD" : "PORT"}`);
    setTxt(bowThrValEl, "bow_txt", fmtThr(bowThr));
    setCenteredBar(bowThrFillEl, "bow", bowThr, "thr", "thr");
    setTxt(sternThrValEl, "stern_txt", fmtThr(sternThr));
    setCenteredBar(sternThrFillEl, "stern", sternThr, "thr", "thr");

    // Berth Alignment Guide
    const b = s.berthAlignment && typeof s.berthAlignment === "object" ? s.berthAlignment : s;
    const rawBerth = b.berthId || s.targetBerthId || s.targetBerth || s.mooredBerthId || "B1";
    const berthId = String(rawBerth).toUpperCase();
    setTxt(berthNameEl, "berth_id", berthId);

    const fenderGap = fin(b.fenderGapM) ? b.fenderGapM : (fin(b.fenderGap) ? b.fenderGap : null);
    const foreAft = fin(b.foreAftOffsetM)
      ? b.foreAftOffsetM
      : (fin(b.longErrM) ? b.longErrM : (fin(b.longitudinalOffsetM) ? b.longitudinalOffsetM : null));
    const hdgErrDeg = fin(b.headingErrDeg)
      ? b.headingErrDeg
      : (fin(b.headingErrRad) ? b.headingErrRad * DEG_PER_RAD : null);

    setTxt(fenderGapEl, "fender_gap", fenderGap !== null ? `${fenderGap.toFixed(1)} m` : "-- m");
    setTxt(foreAftEl, "fore_aft", foreAft !== null ? formatSignedMeters(foreAft, 1) : "-- m");
    setTxt(
      hdgErrEl,
      "hdg_err",
      hdgErrDeg !== null ? `${hdgErrDeg >= 0 ? "+" : "-"}${Math.abs(hdgErrDeg).toFixed(1)}°` : "--°"
    );

    const readyToMoor = Boolean(
      b.readyToMoor ??
      b.inEnvelope ??
      (fenderGap !== null && hdgErrDeg !== null &&
        fenderGap <= 3.0 &&
        Math.abs(hdgErrDeg) <= 6.0 &&
        sogMps <= 0.6 &&
        (foreAft === null || Math.abs(foreAft) <= 4.5))
    );

    let cueText = "OPEN WATER / APPROACH";
    let cueCls = "hb-ship-berth-cue";
    if (s.moored) {
      cueText = "MOORED — LINES FAST (M UNMOOR)";
      cueCls = "hb-ship-berth-cue moored";
    } else if (readyToMoor) {
      cueText = "READY TO MOOR — PRESS M";
      cueCls = "hb-ship-berth-cue ready";
    } else if (fenderGap !== null && fenderGap < 25) {
      cueText = "FINAL BERTHING ALIGNMENT";
    }
    setTxt(berthCueEl, "cue_txt", cueText);
    setCls(berthCueEl, "cue_cls", cueCls);

    const keyText = typeof s.keybindText === "string" && s.keybindText ? s.keybindText : SHIP_KEYBIND_TEXT;
    setTxt(keysEl, "keys_txt", keyText);
  }

  function prompt(text) {
    if (disposed) return;
    ensure();
    if (!promptEl) return;
    if (!text) {
      setStyle(promptEl, "display", "prompt_disp", "none");
      return;
    }
    setTxt(promptEl, "prompt_txt", String(text));
    setStyle(promptEl, "display", "prompt_disp", "block");
  }

  function setHidden(flag) {
    hidden = Boolean(flag);
    if (hidden && rootEl) {
      visible = false;
      setStyle(rootEl, "display", "root_disp", "none");
    }
  }

  function toggleHidden() {
    setHidden(!hidden);
    return hidden;
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    visible = false;
    try { rootEl?.remove?.(); } catch (_) {}
    try { promptEl?.remove?.(); } catch (_) {}
    try { styleEl?.remove?.(); } catch (_) {}
    rootEl = null;
    promptEl = null;
    styleEl = null;
    eotRowEls = [];
  }

  return {
    id: SHIP_OSD_ID,
    update,
    prompt,
    setHidden,
    toggleHidden,
    isVisible: () => visible && !hidden && !disposed,
    isHidden: () => hidden,
    get disposed() { return disposed; },
    get element() { return rootEl; },
    dispose,
  };
}
