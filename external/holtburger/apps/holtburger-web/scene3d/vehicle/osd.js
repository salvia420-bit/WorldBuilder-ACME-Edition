// scene3d/vehicle/osd.js — Graphical Fighter HUD, combat sights (Mk 8 mil reticle, velocity vector FPM, mouse-aim
// director ring, roll-stabilized dive-bomb fall-line & pipper, target hit-confirmation cross + damage pop), and
// physiological G-force vignette.
//
// Built strictly from lightweight DOM elements + CSS transforms (zero Canvas2D / innerHTML parsers): renders crisp
// vector symbology at ~0 GPU cost in Chrome, mutates DOM properties only when values change, works in minimal fake
// DOM test harnesses, and guarantees zero DOM creation or mutation after dispose().

import { MODE, MODE_NAMES } from "./flight_model.js";

export const OSD_ID = "hb-vehicle-osd";
export const PROMPT_ID = "hb-vehicle-prompt";
export const RETICLE_ID = "hb-vehicle-reticle";
export const PIPPER_ID = "hb-vehicle-pipper";
export const FPM_ID = "hb-vehicle-fpm";
export const AIM_ID = "hb-vehicle-aim";
export const FALLLINE_ID = "hb-vehicle-fallline";
export const HIT_ID = "hb-vehicle-hit";
export const VIGNETTE_ID = "hb-vehicle-gvignette";
const STYLE_ID = "hb-vehicle-osd-style";

export const HIT_DECAY_SEC = 0.35;
export const KEYBIND_BAR_TEXT = "Click mouse-aim · C freelook · Space guns · G rockets · V bomb · Shift WEP · Tab view · H hud · X exit/bail";

const PITCH_RUNGS_DEG = [-20, -10, 10, 20];
const PX_PER_PITCH_DEG = 3.8;

const CSS = `
@keyframes hb-hud-blink{0%,49%{opacity:1}50%,100%{opacity:.28}}
#${VIGNETTE_ID}{position:fixed;inset:0;z-index:58;pointer-events:none;display:none;transition:opacity 60ms linear}
#${OSD_ID}{position:fixed;inset:0;z-index:60;pointer-events:none;
  font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#ccf7c4;
  text-shadow:0 1px 2px rgba(0,0,0,.92),0 0 6px rgba(40,180,80,.22)}
#${OSD_ID}.warn .hb-hud-bottom{border-color:rgba(255,190,90,.65)}
.hb-hud-top{position:fixed;left:50%;top:11%;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:4px}
.hb-hud-hdg-box{padding:2px 10px;background:rgba(6,16,11,.62);border:1px solid rgba(150,240,155,.45);border-radius:4px;
  font-size:13px;letter-spacing:.06em;color:#e6ffe0}
.hb-hud-hdg-window{width:220px;height:16px;overflow:hidden;position:relative;border-bottom:1px solid rgba(150,240,155,.3);
  mask-image:linear-gradient(90deg,transparent,#000 18%,#000 82%,transparent)}
.hb-hud-hdg-strip{position:absolute;left:50%;top:0;white-space:nowrap;font-size:10px;color:rgba(195,245,190,.82);will-change:transform}
.hb-hud-bank-arc{position:relative;width:140px;height:22px;border-top:1.5px solid rgba(150,240,155,.38);border-radius:70px 70px 0 0}
.hb-hud-bank-ptr{position:absolute;left:50%;top:2px;margin-left:-5px;width:10px;height:14px;text-align:center;font-size:10px;
  line-height:10px;color:#ffd878;transform-origin:50% 62px;will-change:transform}
.hb-hud-att{position:fixed;left:50%;top:50%;width:260px;height:210px;margin:-105px 0 0 -130px;overflow:hidden}
.hb-hud-att-rot{position:absolute;inset:0;transform-origin:50% 50%;will-change:transform}
.hb-hud-att-pitch{position:absolute;left:50%;top:50%;width:0;height:0;will-change:transform}
.hb-hud-horizon{position:absolute;left:-96px;top:-1px;width:192px;height:2px;
  background:linear-gradient(90deg,rgba(160,250,165,.85) 0 36%,transparent 36% 64%,rgba(160,250,165,.85) 64% 100%)}
.hb-hud-rung{position:absolute;left:-58px;width:116px;height:0;border-top:1.5px solid rgba(165,245,170,.78);
  display:flex;justify-content:space-between;font-size:9px;color:rgba(195,250,195,.85)}
.hb-hud-rung.neg{border-top-style:dashed;border-color:rgba(255,200,120,.75);color:rgba(255,210,140,.85)}
.hb-hud-rung span{transform:translateY(-6px);padding:0 2px}
.hb-hud-left{position:fixed;right:calc(50% + 162px);top:50%;transform:translateY(-50%);display:flex;align-items:center;gap:8px}
.hb-hud-bars{display:flex;gap:5px;align-items:flex-end}
.hb-hud-vbar{position:relative;width:9px;height:108px;background:rgba(6,16,11,.62);border:1px solid rgba(150,235,155,.38);border-radius:3px;overflow:hidden}
.hb-hud-vbar-fill{position:absolute;left:0;right:0;bottom:0;height:0%;background:linear-gradient(180deg,#9ef7a4,#42b868)}
.hb-hud-vbar-fill.wep{background:linear-gradient(180deg,#ffe082,#ff7b1c);box-shadow:0 0 8px rgba(255,145,35,.85)}
.hb-hud-stall-band{position:absolute;left:0;right:0;bottom:0;background:rgba(255,70,55,.45);border-top:1px solid rgba(255,95,80,.85)}
.hb-hud-cap-tick{position:absolute;left:0;right:0;height:2px;background:#ffd878}
.hb-hud-box{background:rgba(6,16,11,.6);border:1px solid rgba(150,235,155,.38);border-radius:5px;padding:5px 9px;min-width:116px}
.hb-hud-primary{font-size:15px;font-weight:700;color:#eaffea}
.hb-hud-sub{font-size:11px;color:rgba(195,240,195,.82)}
.hb-hud-wep-tag{display:inline-block;margin-left:5px;padding:0 5px;border-radius:3px;background:rgba(255,135,25,.28);
  border:1px solid #ff9e2c;color:#ffd180;font-weight:700}
.hb-hud-right{position:fixed;left:calc(50% + 162px);top:50%;transform:translateY(-50%);display:flex;flex-direction:column;gap:5px;min-width:136px}
.hb-hud-pills{display:flex;flex-wrap:wrap;gap:4px;max-width:185px}
.hb-hud-pill{padding:1px 6px;border-radius:3px;font-size:11px;font-weight:700;background:rgba(12,28,18,.72);
  border:1px solid rgba(150,235,155,.45);color:#d8f8d2}
.hb-hud-pill.crit{background:rgba(165,24,18,.78);border-color:#ff6b5b;color:#fff0ed;animation:hb-hud-blink .42s infinite}
.hb-hud-pill.caution{background:rgba(135,82,10,.74);border-color:#ffbe55;color:#ffe6b3}
.hb-hud-bottom{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);background:rgba(6,14,10,.6);
  border:1px solid rgba(160,230,150,.36);border-radius:6px;padding:6px 14px;text-align:center;white-space:pre}
.hb-hud-keys{margin-top:2px;font-size:10.5px;color:rgba(195,235,195,.76)}
#${PROMPT_ID}{position:fixed;left:50%;bottom:154px;transform:translateX(-50%);z-index:61;pointer-events:none;
  font:600 14px/1.3 system-ui,sans-serif;color:#fff;background:rgba(0,0,0,.65);border:1px solid rgba(255,255,255,.2);
  border-radius:6px;padding:6px 14px}
#${RETICLE_ID},#${PIPPER_ID},#${FPM_ID},#${AIM_ID},#${FALLLINE_ID},#${HIT_ID}{position:fixed;left:0;top:0;z-index:59;pointer-events:none;will-change:transform}
#${RETICLE_ID}{width:36px;height:36px;margin:-18px 0 0 -18px;border:2px solid rgba(255,216,120,.88);border-radius:50%;
  box-shadow:0 0 3px rgba(0,0,0,.9),inset 0 0 4px rgba(255,210,100,.25)}
#${RETICLE_ID}::before,#${RETICLE_ID}::after{content:"";position:absolute;background:rgba(255,216,120,.92)}
#${RETICLE_ID}::before{left:16px;top:-8px;width:2px;height:50px;
  background:linear-gradient(180deg,rgba(255,216,120,.92) 0 34%,transparent 34% 66%,rgba(255,216,120,.92) 66% 100%)}
#${RETICLE_ID}::after{top:16px;left:-8px;height:2px;width:50px;
  background:linear-gradient(90deg,rgba(255,216,120,.92) 0 34%,transparent 34% 66%,rgba(255,216,120,.92) 66% 100%)}
#${FPM_ID}{width:16px;height:16px;margin:-8px 0 0 -8px;border:2px solid rgba(130,255,155,.92);border-radius:50%;
  box-shadow:0 0 2px #000}
#${FPM_ID}::before{content:"";position:absolute;left:-11px;top:5px;width:34px;height:2px;
  background:linear-gradient(90deg,rgba(130,255,155,.92) 0 29%,transparent 29% 71%,rgba(130,255,155,.92) 71% 100%)}
#${FPM_ID}::after{content:"";position:absolute;left:5px;top:-8px;width:2px;height:7px;background:rgba(130,255,155,.92)}
#${AIM_ID}{width:42px;height:42px;margin:-21px 0 0 -21px;border:2px solid rgba(225,248,255,.88);border-radius:50%;
  box-shadow:0 0 4px rgba(0,0,0,.85)}
#${FALLLINE_ID}{height:1.5px;margin-top:-1px;transform-origin:0 50%;
  background:repeating-linear-gradient(90deg,rgba(255,155,115,.85) 0 6px,transparent 6px 11px)}
#${PIPPER_ID}{width:26px;height:26px;margin:-13px 0 0 -13px;border:2px dashed rgba(255,120,90,.95);border-radius:50%;
  box-shadow:0 0 2px #000}
#${PIPPER_ID}::after{content:attr(data-label);position:absolute;left:30px;top:3px;white-space:nowrap;
  font:600 11px ui-monospace,Menlo,Consolas,monospace;color:#ffb39a;text-shadow:0 1px 1px #000}
#${HIT_ID}{width:28px;height:28px;margin:-14px 0 0 -14px;z-index:60}
.hb-hud-hit-x{position:absolute;inset:0;transform:rotate(45deg)}
.hb-hud-hit-x::before,.hb-hud-hit-x::after{content:"";position:absolute;background:#ffdf7e;box-shadow:0 0 3px #000}
.hb-hud-hit-x::before{left:13px;top:0;width:2px;height:28px;
  background:linear-gradient(180deg,#ffdf7e 0 35%,transparent 35% 65%,#ffdf7e 65% 100%)}
.hb-hud-hit-x::after{top:13px;left:0;height:2px;width:28px;
  background:linear-gradient(90deg,#ffdf7e 0 35%,transparent 35% 65%,#ffdf7e 65% 100%)}
.hb-hud-hit-dmg{position:absolute;left:24px;top:-8px;font:700 12px ui-monospace,Menlo,Consolas,monospace;
  color:#ffae64;text-shadow:0 1px 2px #000;white-space:nowrap}
`;

function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

function nowMs() {
  return typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();
}

export function compass(rad) {
  const deg = ((rad * 180) / Math.PI + 360) % 360;
  const names = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  return `${String(Math.round(deg) % 360).padStart(3, "0")}° ${names[Math.round(deg / 45) % 8]}`;
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

function hasUrlDebugFlag(doc) {
  try {
    const search = doc?.defaultView?.location?.search ?? "";
    return new URLSearchParams(search).get("vehicleDebug") === "on";
  } catch (_) {
    return false;
  }
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

function setAttr(node, k, v) {
  if (!node) return;
  if (typeof node.setAttribute === "function") node.setAttribute(k, v);
  else node[k] = v;
}

export function createVehicleOsd(deps = {}) {
  const doc = deps.document ?? (typeof document !== "undefined" ? document : null);

  let el = null;
  let promptEl = null;
  let reticle = null;
  let pipper = null;
  let fpmEl = null;
  let aimEl = null;
  let fallLineEl = null;
  let hitEl = null;
  let hitDmgEl = null;
  let vignetteEl = null;

  // Structured child sub-nodes inside #hb-vehicle-osd
  let hdgBoxEl = null;
  let hdgStripEl = null;
  let bankPtrEl = null;
  let attRotEl = null;
  let attPitchEl = null;
  let thrFillEl = null;
  let spdFillEl = null;
  let spdStallEl = null;
  let spdCapEl = null;
  let spdTextEl = null;
  let thrTextEl = null;
  let altTextEl = null;
  let vsiTextEl = null;
  let gTextEl = null;
  let pillsBoxEl = null;
  let pillNodes = [];
  let headerTextEl = null;
  let armsTextEl = null;
  let debugTextEl = null;
  let keysTextEl = null;

  let hidden = false;
  let disposed = false;
  let hitState = null; // { atMs, damage, x, y }
  let lastRetPos = null;

  const last = {
    text: null, cls: null, shown: null,
    prompt: null,
    ret: null, pip: null, pipLabel: null, fpm: null, aim: null, fall: null,
    hdgBox: null, hdgTx: null, bankTx: null, attRotTx: null, attPitchTx: null,
    thrH: null, thrCls: null, spdH: null, stallH: null, capB: null,
    spdTxt: null, thrTxt: null, altTxt: null, vsiTxt: null, gTxt: null,
    pillsSig: null, headerTxt: null, armsTxt: null, dbgTxt: null, keysTxt: null,
    vigSig: null, hitDisp: null, hitOp: null, hitTx: null, hitDmg: null,
  };

  function setTxt(node, key, val) {
    if (!node || last[key] === val) return;
    last[key] = val;
    node.textContent = val;
  }

  function setStyle(node, prop, key, val) {
    if (!node || last[key] === val) return;
    last[key] = val;
    node.style[prop] = val;
  }

  function ensure() {
    if (disposed || !doc || el) return;
    if (typeof doc.getElementById === "function" && !doc.getElementById(STYLE_ID) && doc.head) {
      const st = mkEl(doc, "style", "", STYLE_ID);
      st.textContent = CSS;
      append(doc.head, st);
    }

    const mkRoot = (id) => {
      const d = mkEl(doc, "div", "", id);
      d.style.display = "none";
      append(doc.body, d);
      return d;
    };

    vignetteEl = mkRoot(VIGNETTE_ID);
    el = mkRoot(OSD_ID);
    promptEl = mkRoot(PROMPT_ID);
    fallLineEl = mkRoot(FALLLINE_ID);
    reticle = mkRoot(RETICLE_ID);
    fpmEl = mkRoot(FPM_ID);
    aimEl = mkRoot(AIM_ID);
    pipper = mkRoot(PIPPER_ID);
    hitEl = mkRoot(HIT_ID);

    const hitCross = mkEl(doc, "div", "hb-hud-hit-x");
    hitDmgEl = mkEl(doc, "div", "hb-hud-hit-dmg");
    hitCross.textContent = "×";
    append(hitEl, hitCross);
    append(hitEl, hitDmgEl);

    // 1. Center-top Heading Ribbon & Bank Angle Pointer
    const topWrap = append(el, mkEl(doc, "div", "hb-hud-top"));
    hdgBoxEl = append(topWrap, mkEl(doc, "div", "hb-hud-hdg-box"));
    const hdgWin = append(topWrap, mkEl(doc, "div", "hb-hud-hdg-window"));
    hdgStripEl = append(hdgWin, mkEl(doc, "div", "hb-hud-hdg-strip"));
    hdgStripEl.textContent = "W · 300 · 330 · N · 030 · 060 · E · 120 · 150 · S · 210 · 240 · W · 300 · 330 · N · 030 · 060 · E";
    const bankArc = append(topWrap, mkEl(doc, "div", "hb-hud-bank-arc"));
    bankPtrEl = append(bankArc, mkEl(doc, "div", "hb-hud-bank-ptr"));
    bankPtrEl.textContent = "▲";

    // 2. Center Attitude Pitch Ladder & Artificial Horizon
    const attWrap = append(el, mkEl(doc, "div", "hb-hud-att"));
    attRotEl = append(attWrap, mkEl(doc, "div", "hb-hud-att-rot"));
    attPitchEl = append(attRotEl, mkEl(doc, "div", "hb-hud-att-pitch"));
    const horizon = append(attPitchEl, mkEl(doc, "div", "hb-hud-horizon"));
    horizon.style.transform = "translateY(0px)";
    for (const deg of PITCH_RUNGS_DEG) {
      const rung = append(attPitchEl, mkEl(doc, "div", deg < 0 ? "hb-hud-rung neg" : "hb-hud-rung"));
      rung.style.transform = `translateY(${Math.round(-deg * PX_PER_PITCH_DEG)}px)`;
      const l = append(rung, mkEl(doc, "span"));
      const r = append(rung, mkEl(doc, "span"));
      const lbl = String(Math.abs(deg));
      l.textContent = lbl;
      r.textContent = lbl;
    }

    // 3. Left Airspeed Gauge + Throttle / WEP Bar
    const leftWrap = append(el, mkEl(doc, "div", "hb-hud-left"));
    const barsWrap = append(leftWrap, mkEl(doc, "div", "hb-hud-bars"));
    const thrBar = append(barsWrap, mkEl(doc, "div", "hb-hud-vbar"));
    thrFillEl = append(thrBar, mkEl(doc, "div", "hb-hud-vbar-fill"));
    const spdBar = append(barsWrap, mkEl(doc, "div", "hb-hud-vbar"));
    spdStallEl = append(spdBar, mkEl(doc, "div", "hb-hud-stall-band"));
    spdFillEl = append(spdBar, mkEl(doc, "div", "hb-hud-vbar-fill"));
    spdCapEl = append(spdBar, mkEl(doc, "div", "hb-hud-cap-tick"));
    const leftBox = append(leftWrap, mkEl(doc, "div", "hb-hud-box"));
    spdTextEl = append(leftBox, mkEl(doc, "div", "hb-hud-primary"));
    thrTextEl = append(leftBox, mkEl(doc, "div", "hb-hud-sub"));

    // 4. Right Altitude (AGL + MSL), VSI, Live G-Meter & Status Pills
    const rightWrap = append(el, mkEl(doc, "div", "hb-hud-right"));
    const rightBox = append(rightWrap, mkEl(doc, "div", "hb-hud-box"));
    altTextEl = append(rightBox, mkEl(doc, "div", "hb-hud-primary"));
    vsiTextEl = append(rightBox, mkEl(doc, "div", "hb-hud-sub"));
    gTextEl = append(rightBox, mkEl(doc, "div", "hb-hud-sub"));
    pillsBoxEl = append(rightWrap, mkEl(doc, "div", "hb-hud-pills"));
    pillNodes = [];
    for (let i = 0; i < 6; i++) {
      const pn = append(pillsBoxEl, mkEl(doc, "span", "hb-hud-pill"));
      pn.style.display = "none";
      pillNodes.push(pn);
    }

    // 5. Bottom Armament, Debug Telemetry & Compact Keybind Bar
    const botWrap = append(el, mkEl(doc, "div", "hb-hud-bottom"));
    headerTextEl = append(botWrap, mkEl(doc, "div", "hb-hud-sub"));
    armsTextEl = append(botWrap, mkEl(doc, "div", ""));
    debugTextEl = append(botWrap, mkEl(doc, "div", "hb-hud-sub"));
    keysTextEl = append(botWrap, mkEl(doc, "div", "hb-hud-keys"));
  }

  function show(node, key, on) {
    if (!node || last[key] === on) return;
    last[key] = on;
    node.style.display = on ? "block" : "none";
  }

  function place(node, key, p) {
    if (!node) return;
    const on = !!(p && Number.isFinite(p.x) && Number.isFinite(p.y)) && !hidden;
    const k = on ? `${Math.round(p.x)},${Math.round(p.y)}` : "off";
    if (last[key] === k) return;
    last[key] = k;
    if (!on) {
      node.style.display = "none";
      return;
    }
    node.style.display = "block";
    node.style.transform = `translate(${Math.round(p.x)}px, ${Math.round(p.y)}px)`;
  }

  function syncFallLine(ret, pip) {
    if (!fallLineEl) return;
    const both = !!(ret && pip && Number.isFinite(ret.x) && Number.isFinite(ret.y) && Number.isFinite(pip.x) && Number.isFinite(pip.y)) && !hidden;
    if (!both) {
      setStyle(fallLineEl, "display", "fall", "none");
      return;
    }
    const dx = pip.x - ret.x;
    const dy = pip.y - ret.y;
    const len = Math.hypot(dx, dy);
    if (len < 4) {
      setStyle(fallLineEl, "display", "fall", "none");
      return;
    }
    const ang = (Math.atan2(dy, dx) * 180) / Math.PI;
    const sig = `${Math.round(ret.x)},${Math.round(ret.y)},${Math.round(len)},${ang.toFixed(1)}`;
    if (last.fall === sig) return;
    last.fall = sig;
    fallLineEl.style.display = "block";
    fallLineEl.style.width = `${Math.round(len)}px`;
    fallLineEl.style.transform = `translate(${Math.round(ret.x)}px, ${Math.round(ret.y)}px) rotate(${ang.toFixed(1)}deg)`;
  }

  function syncHit() {
    if (!hitEl) return;
    if (!hitState || hidden) {
      setStyle(hitEl, "display", "hitDisp", "none");
      return;
    }
    const ageSec = (nowMs() - hitState.atMs) / 1000;
    if (ageSec >= HIT_DECAY_SEC) {
      hitState = null;
      setStyle(hitEl, "display", "hitDisp", "none");
      setStyle(hitEl, "opacity", "hitOp", "0");
      return;
    }
    const frac = clamp(1 - ageSec / HIT_DECAY_SEC, 0, 1);
    const scale = (1 + (1 - frac) * 0.18).toFixed(2);
    const pos = (Number.isFinite(hitState.x) && Number.isFinite(hitState.y))
      ? hitState
      : lastRetPos;
    const tx = pos
      ? `translate(${Math.round(pos.x)}px, ${Math.round(pos.y)}px) scale(${scale})`
      : `translate(50vw, 50vh) scale(${scale})`;
    setStyle(hitEl, "display", "hitDisp", "block");
    setStyle(hitEl, "opacity", "hitOp", frac.toFixed(2));
    setStyle(hitEl, "transform", "hitTx", tx);
  }

  function syncVignette(gLoad, active) {
    if (!vignetteEl) return;
    if (!active || hidden || !Number.isFinite(gLoad) || (gLoad <= 3.0 && gLoad >= -0.7)) {
      if (last.vigSig !== "off") {
        last.vigSig = "off";
        vignetteEl.style.display = "none";
        vignetteEl.style.opacity = "0";
      }
      return;
    }
    let bg;
    let op;
    if (gLoad > 3.0) {
      const u = clamp((gLoad - 3.0) / 3.0, 0, 1);
      const inner = Math.round(62 - u * 26);
      const alpha = (0.28 + u * 0.56).toFixed(2);
      op = clamp(u * 0.95, 0.08, 0.95).toFixed(2);
      bg = `radial-gradient(circle at 50% 50%, rgba(0,0,0,0) ${inner}%, rgba(10,12,14,${alpha}) 100%)`;
    } else {
      const u = clamp((-0.7 - gLoad) / 1.8, 0, 1);
      const inner = Math.round(58 - u * 22);
      const alpha = (0.25 + u * 0.52).toFixed(2);
      op = clamp(u * 0.9, 0.08, 0.9).toFixed(2);
      bg = `radial-gradient(circle at 50% 50%, rgba(120,0,0,0) ${inner}%, rgba(168,14,10,${alpha}) 100%)`;
    }
    const sig = `${op}:${bg}`;
    if (last.vigSig === sig) return;
    last.vigSig = sig;
    vignetteEl.style.display = "block";
    vignetteEl.style.opacity = op;
    vignetteEl.style.background = bg;
  }

  function hideAllSights() {
    place(reticle, "ret", null);
    place(pipper, "pip", null);
    place(fpmEl, "fpm", null);
    place(aimEl, "aim", null);
    syncFallLine(null, null);
    if (hitEl) setStyle(hitEl, "display", "hitDisp", "none");
    syncVignette(1.0, false);
  }

  return {
    /**
     * Update HUD gauges, attitude ladder, warning pills, G-vignette & armament block.
     * @param {object|null} s (null hides)
     */
    update(s) {
      if (disposed) return;
      ensure();
      if (!el) return;
      if (!s || hidden) {
        show(el, "shown", false);
        syncVignette(1.0, false);
        syncHit();
        return;
      }

      const speed = Number.isFinite(s.speed) ? s.speed : 0;
      const kmh = Math.round(speed * 3.6);
      const kt = Math.round(speed * 1.94384);
      const vCapMs = Number.isFinite(s.vCap) && s.vCap > 0 ? s.vCap : 97;
      const vMaxMs = Number.isFinite(s.vMax) && s.vMax > 0 ? s.vMax : Math.max(vCapMs, 97);
      const vMinMs = Number.isFinite(s.vMin) && s.vMin > 0 ? s.vMin : 30;
      const cap = Math.round(vCapMs * 3.6);

      const aglVal = Number.isFinite(s.agl) ? s.agl : 0;
      const agl = Math.round(aglVal);
      const msl = Math.round(Number.isFinite(s.msl) ? s.msl : (Number.isFinite(s.z) ? s.z : aglVal));
      const heading = Number.isFinite(s.heading) ? s.heading : 0;
      const pitch = Number.isFinite(s.pitch) ? s.pitch : 0;
      const bank = Number.isFinite(s.bank) ? s.bank : 0;
      const thrPct = clamp(Math.round((s.throttle || 0) * 100), 0, 100);
      const boost = !!s.boost;
      const land = !!s.land;

      const vsiRaw = Number.isFinite(s.vsi) ? s.vsi : speed * Math.sin(pitch);
      const vsiRound = Math.round(vsiRaw);
      const vsiStr = `${vsiRound >= 0 ? "+" : ""}${vsiRound} m/s`;
      const gLoad = Number.isFinite(s.gLoad) ? s.gLoad : 1.0;
      const gStr = `${gLoad.toFixed(1)} G`;

      const inFlight = s.mode === MODE.FLIGHT || s.mode === "Flight";
      const pullUp = inFlight && !land && aglVal < 38;
      const ceilingLim = Number.isFinite(s.ceilingAgl) ? s.ceilingAgl : 450;
      const atCeiling = Boolean(s.ceiling) || (inFlight && aglVal >= ceilingLim - 4);
      const stallWarn = inFlight && !land && speed < vMinMs * 1.06;

      // Heading ribbon & bank pointer
      const hdgTxt = compass(heading);
      setTxt(hdgBoxEl, "hdgBox", hdgTxt);
      const hdgDeg = ((heading * 180) / Math.PI + 360) % 360;
      const stripShift = -Math.round(hdgDeg * 1.15) - 110;
      setStyle(hdgStripEl, "transform", "hdgTx", `translateX(${stripShift}px)`);
      const bankDeg = (bank * 180) / Math.PI;
      setStyle(bankPtrEl, "transform", "bankTx", `rotate(${(-bankDeg).toFixed(1)}deg)`);

      // Attitude pitch ladder & horizon
      const pitchDeg = clamp((pitch * 180) / Math.PI, -45, 45);
      setStyle(attRotEl, "transform", "attRotTx", `rotate(${(-bankDeg).toFixed(1)}deg)`);
      setStyle(attPitchEl, "transform", "attPitchTx", `translateY(${(pitchDeg * PX_PER_PITCH_DEG).toFixed(1)}px)`);

      // Left airspeed & throttle/WEP bars
      setStyle(thrFillEl, "height", "thrH", `${boost ? 100 : thrPct}%`);
      if (thrFillEl) {
        const tCls = boost ? "hb-hud-vbar-fill wep" : "hb-hud-vbar-fill";
        if (last.thrCls !== tCls) { last.thrCls = tCls; thrFillEl.className = tCls; }
      }
      const spdPct = clamp(Math.round((speed / vMaxMs) * 100), 0, 100);
      const stallPct = clamp(Math.round((vMinMs / vMaxMs) * 100), 5, 60);
      const capPct = clamp(Math.round((vCapMs / vMaxMs) * 100), 10, 100);
      setStyle(spdFillEl, "height", "spdH", `${spdPct}%`);
      setStyle(spdStallEl, "height", "stallH", `${stallPct}%`);
      setStyle(spdCapEl, "bottom", "capB", `${capPct}%`);

      const spdLine = `SPD ${String(kmh).padStart(3)} km/h  (${kt} kt · cap ${cap})`;
      const thrLine = `THR ${String(thrPct).padStart(3)}%${boost ? "  WEP" : ""}`;
      setTxt(spdTextEl, "spdTxt", spdLine);
      setTxt(thrTextEl, "thrTxt", thrLine);

      // Right altitude, VSI, G-meter & status pills
      const altLine = `ALT ${agl} m AGL  (${msl} m MSL)`;
      const vsiLine = `VSI ${vsiStr}`;
      setTxt(altTextEl, "altTxt", altLine);
      setTxt(vsiTextEl, "vsiTxt", vsiLine);
      setTxt(gTextEl, "gTxt", gStr);

      const pills = [];
      if (pullUp) pills.push(["PULL UP", "hb-hud-pill crit"]);
      if (stallWarn) pills.push(["STALL", "hb-hud-pill crit"]);
      if (atCeiling) pills.push(["CEILING", "hb-hud-pill caution"]);
      if (land || s.mode === MODE.LANDING) pills.push(["[LAND]", "hb-hud-pill"]);
      if (s.mouseAim) pills.push(["[MOUSE AIM]", "hb-hud-pill"]);
      if (Math.abs(s.pitchTrim || 0) > 0.01) {
        const trimPct = Math.round((s.pitchTrim || 0) * 100);
        pills.push([`[TRIM] ${trimPct >= 0 ? "+" : ""}${trimPct}%`, "hb-hud-pill caution"]);
      }

      const pillsSig = pills.map((p) => p[0]).join("|");
      if (last.pillsSig !== pillsSig) {
        last.pillsSig = pillsSig;
        for (let i = 0; i < pillNodes.length; i++) {
          const pn = pillNodes[i];
          if (i < pills.length) {
            pn.textContent = pills[i][0];
            pn.className = pills[i][1];
            pn.style.display = "inline-block";
          } else {
            pn.textContent = "";
            pn.style.display = "none";
          }
        }
      }

      // Bottom header, armament, gated debug corr, and keybind bar
      const modeLabel = MODE_NAMES[s.mode] ?? s.mode ?? "";
      const headerLine = `${s.name || "Vehicle"}  ${modeLabel}${land ? "  [LAND]" : ""}${boost ? "  WEP" : ""}`;
      const armsStr = armamentLine(s.arms);
      const showDbg = s.showDebug !== undefined ? !!s.showDebug : hasUrlDebugFlag(doc);
      const dbgLine = showDbg && s.corr ? String(s.corr) : "";
      const keysLine = KEYBIND_BAR_TEXT;

      setTxt(headerTextEl, "headerTxt", headerLine);
      setTxt(armsTextEl, "armsTxt", armsStr);
      if (armsTextEl) armsTextEl.style.display = armsStr ? "block" : "none";
      setTxt(debugTextEl, "dbgTxt", dbgLine);
      if (debugTextEl) debugTextEl.style.display = dbgLine ? "block" : "none";
      setTxt(keysTextEl, "keysTxt", keysLine);

      // In lightweight fake-DOM environments (`!el.nodeType`), mirror full summary onto `el.textContent`
      // without touching real browser child nodes.
      if (!el.nodeType) {
        const summaryLines = [
          headerLine,
          `${spdLine}   ${altLine}   HDG ${hdgTxt}   ${vsiLine}   ${gStr}`,
          thrLine + (pills.length ? "   " + pills.map((p) => p[0]).join(" ") : ""),
        ];
        if (armsStr) summaryLines.push(armsStr);
        if (dbgLine) summaryLines.push(dbgLine);
        summaryLines.push(keysLine);
        const summary = summaryLines.join("\n");
        if (summary !== last.text) {
          last.text = summary;
          el.textContent = summary;
        }
      }

      const cls = (s.warn || pullUp || stallWarn) ? "warn" : "";
      if (cls !== last.cls) {
        last.cls = cls;
        el.className = cls;
      }

      syncVignette(gLoad, true);
      syncHit();
      show(el, "shown", true);
    },

    /**
     * Screen positions (CSS px) of gun convergence reticle, bomb pipper, and optional `{fpm, aim}`, or null to hide.
     */
    sights(ret, pip, pipLabel, extra = {}) {
      if (disposed) return;
      ensure();
      if (!reticle) return;
      lastRetPos = ret && Number.isFinite(ret.x) && Number.isFinite(ret.y) ? { x: ret.x, y: ret.y } : null;
      place(reticle, "ret", ret);
      place(pipper, "pip", pip);
      const lbl = pip ? (pipLabel || "") : "";
      if (lbl !== last.pipLabel) {
        last.pipLabel = lbl;
        setAttr(pipper, "data-label", lbl);
      }
      const ext = extra && typeof extra === "object" ? extra : {};
      place(fpmEl, "fpm", ext.fpm ?? null);
      place(aimEl, "aim", ext.aim ?? null);
      syncFallLine(ret, pip);
      syncHit();
    },

    /** Trigger target hit-confirmation cross (`×`) & damage pop (`+42`), decaying smoothly over 0.35 s. */
    hit(info = {}) {
      if (disposed) return;
      ensure();
      if (!hitEl) return;
      const dmg = Math.round(Number(info?.damage) || 0);
      hitState = {
        atMs: nowMs(),
        damage: dmg,
        x: Number.isFinite(info?.x) ? info.x : null,
        y: Number.isFinite(info?.y) ? info.y : null,
      };
      const dmgTxt = dmg > 0 ? `+${dmg}` : "";
      setTxt(hitDmgEl, "hitDmg", dmgTxt);
      syncHit();
    },

    prompt(text) {
      if (disposed) return;
      ensure();
      if (!promptEl) return;
      const t = text || null;
      if (t === last.prompt) return;
      last.prompt = t;
      if (!t) {
        promptEl.style.display = "none";
        return;
      }
      promptEl.textContent = t;
      promptEl.style.display = "block";
    },

    get promptText() {
      return last.prompt;
    },

    toggleHidden() {
      if (disposed) return hidden;
      hidden = !hidden;
      if (hidden && el) {
        show(el, "shown", false);
        hideAllSights();
      }
      return hidden;
    },

    hide() {
      if (disposed) return;
      if (el) show(el, "shown", false);
      if (promptEl) {
        promptEl.style.display = "none";
        last.prompt = null;
      }
      if (reticle) hideAllSights();
    },

    dispose() {
      disposed = true;
      hitState = null;
      try {
        el?.remove?.();
        promptEl?.remove?.();
        reticle?.remove?.();
        pipper?.remove?.();
        fpmEl?.remove?.();
        aimEl?.remove?.();
        fallLineEl?.remove?.();
        hitEl?.remove?.();
        vignetteEl?.remove?.();
      } catch (_) { /* gone */ }
      el = null;
      promptEl = null;
      reticle = null;
      pipper = null;
      fpmEl = null;
      aimEl = null;
      fallLineEl = null;
      hitEl = null;
      hitDmgEl = null;
      vignetteEl = null;
      pillNodes = [];
    },
  };
}
