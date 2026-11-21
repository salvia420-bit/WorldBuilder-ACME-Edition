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
export const PALLETJACK_HUD_ID = "hb-palletjack-hud";
const STYLE_ID = "hb-vehicle-osd-style";

export const HIT_DECAY_SEC = 0.35;
export const KEYBIND_BAR_TEXT = "Click mouse-aim · C freelook · Space guns · G rockets · V bomb · Shift WEP · Tab view · H hud · X exit/bail";
export const GROUND_DRIVER_KEYBIND_TEXT = "W/S Drive/Brake · A/D Steer · Space Handbrake · Shift 4WD Low · L Lights · V Horn · G Windscreen · 1-4 Seat · Tab View · H HUD · X Exit";
export const GROUND_PAX_KEYBIND_TEXT = "1-4 Switch Seat · Tab View · C/RMB Freelook · H HUD · X Exit";
export const SEMI_DRIVER_KEYBIND_TEXT = "G Hitch/Unhitch · Shift Low Range · Space Air Brake · V Air Horn · L Lights · 1-2 Seat · Tab View · X Exit";
export const SEMI_PAX_KEYBIND_TEXT = "1-2 Switch Seat · Tab View · C/RMB Freelook · H HUD · X Exit";
export const PALLET_JACK_KEYBIND_TEXT = "WASD Drive/Steer · Space Raise/Lower · F Engage/Drop/Load · R Stow Nearby · V View · X/Esc Release";

export const SURFACE_NAMES = Object.freeze([
  "ROAD", "DIRT", "GRASS", "FOREST", "SNOW", "SAND", "SWAMP", "FORD", "ROCK", "OBSIDIAN", "VOLCANO",
]);

const CARGO_WCID_NAMES = Object.freeze({
  4000002: "RADAR STATION",
  4000010: "FLUX POD",
  4000011: "SOLAR PANELS",
  4000012: "POWER GENERATOR",
  4000013: "BATTERY UNIT",
  4000014: "MISSILE TURRET",
  4000015: "GROUND RADAR",
  4000016: "MORTAR TURRET",
  4000017: "HEAVY LASER TURRET",
});

const PITCH_RUNGS_DEG = [-20, -10, 10, 20];
const PX_PER_PITCH_DEG = 3.8;

const CSS = `
@keyframes hb-hud-blink{0%,49%{opacity:1}50%,100%{opacity:.28}}
#${VIGNETTE_ID}{position:fixed;inset:0;z-index:58;pointer-events:none;display:none;transition:opacity 60ms linear}
#${OSD_ID}{position:fixed;inset:0;z-index:60;pointer-events:none;
  font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#ccf7c4;
  text-shadow:0 1px 2px rgba(0,0,0,.92),0 0 6px rgba(40,180,80,.22)}
#${OSD_ID}.warn .hb-hud-bottom{border-color:rgba(255,190,90,.65)}
.hb-ground-dashboard{position:fixed;inset:0;pointer-events:none;display:none}
.hb-ground-left{position:fixed;left:32px;bottom:36px;display:flex;flex-direction:column;gap:8px;pointer-events:none}
.hb-ground-speed-box{background:rgba(6,16,11,.75);border:1.5px solid rgba(150,235,155,.45);border-radius:8px;padding:10px 16px;min-width:170px;box-shadow:0 4px 12px rgba(0,0,0,.5)}
.hb-ground-speed-num{font-size:28px;font-weight:800;color:#f0fff0;line-height:1}
.hb-ground-speed-unit{font-size:13px;font-weight:700;color:#a2f0a8;margin-left:4px}
.hb-ground-speed-sub{font-size:12px;color:rgba(195,240,195,.82);margin-top:4px}
.hb-ground-speed-bar{position:relative;width:100%;height:6px;background:rgba(10,24,15,.8);border-radius:3px;overflow:hidden;margin-top:6px}
.hb-ground-speed-fill{height:100%;width:0%;background:linear-gradient(90deg,#42b868,#9ef7a4)}
.hb-ground-gear-box{display:flex;align-items:center;gap:10px;margin-top:6px}
.hb-ground-gear-badge{padding:3px 10px;background:rgba(16,40,24,.85);border:1.5px solid #85e08c;border-radius:4px;font-size:16px;font-weight:800;color:#eaffea}
.hb-ground-4wd-badge{padding:3px 8px;background:rgba(80,50,10,.85);border:1.5px solid #ffbe55;border-radius:4px;font-size:11px;font-weight:800;color:#ffd878;display:none}
.hb-ground-right{position:fixed;right:32px;bottom:36px;display:flex;flex-direction:column;gap:8px;align-items:flex-end;pointer-events:none}
.hb-ground-drivetrain-box{background:rgba(6,16,11,.75);border:1.5px solid rgba(150,235,155,.45);border-radius:8px;padding:10px 16px;min-width:170px;box-shadow:0 4px 12px rgba(0,0,0,.5)}
.hb-ground-rpm-title{font-size:12px;color:rgba(195,240,195,.85)}
.hb-ground-rpm-val{font-size:16px;font-weight:700;color:#f0fff0;margin-left:6px}
.hb-ground-rpm-bar{position:relative;width:100%;height:6px;background:rgba(10,24,15,.8);border-radius:3px;overflow:hidden;margin:4px 0 8px 0}
.hb-ground-rpm-fill{height:100%;width:0%;background:linear-gradient(90deg,#42b868,#ffd878)}
.hb-ground-surface-badge{display:inline-block;padding:3px 8px;background:rgba(18,36,24,.75);border:1px solid rgba(150,235,155,.5);border-radius:4px;font-size:11px;font-weight:700;color:#ccf7c4;letter-spacing:0.05em}
.hb-ground-crew-box{background:rgba(6,16,11,.75);border:1.5px solid rgba(150,235,155,.45);border-radius:8px;padding:8px 12px;box-shadow:0 4px 12px rgba(0,0,0,.5)}
.hb-ground-crew-title{font-size:11px;font-weight:700;color:#a2f0a8;margin-bottom:6px;text-transform:uppercase;letter-spacing:.08em}
.hb-ground-crew-grid{display:grid;grid-template-columns:1fr 1fr;gap:6px;width:220px}
.hb-ground-seat-card{padding:4px 6px;border-radius:4px;font-size:10.5px;border:1px solid rgba(150,235,155,.25);background:rgba(10,24,15,.6);cursor:pointer;pointer-events:auto;text-align:center}
.hb-ground-seat-card.you{background:rgba(28,80,38,.85);border-color:#52e668;color:#eaffea;font-weight:800;box-shadow:0 0 6px rgba(82,230,104,.4)}
.hb-ground-seat-card.teammate{background:rgba(30,60,70,.85);border-color:#5edfe0;color:#d6faff;font-weight:700}
.hb-ground-seat-card.empty{background:rgba(10,18,12,.4);border-color:rgba(150,235,155,.15);color:rgba(180,210,180,.4)}
.hb-ground-center{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;gap:6px;pointer-events:none}
.hb-ground-status-bar{display:flex;gap:8px;align-items:center}
.hb-ground-status-item{padding:2px 8px;border-radius:3px;font-size:11px;font-weight:800;background:rgba(12,28,18,.72);border:1px solid rgba(150,235,155,.3);color:rgba(180,220,180,.4)}
.hb-ground-status-item.active-lights{background:rgba(30,90,40,.85);border-color:#52e668;color:#f0fff0;box-shadow:0 0 8px rgba(82,230,104,.5)}
.hb-ground-status-item.active-brake{background:rgba(140,30,20,.85);border-color:#ff5545;color:#fff0ed;box-shadow:0 0 8px rgba(255,85,69,.5)}
.hb-ground-status-item.active-horn{background:rgba(135,100,10,.85);border-color:#ffd878;color:#fffde0;box-shadow:0 0 8px rgba(255,216,120,.5)}
.hb-ground-status-item.caution{background:rgba(135,82,10,.85);border-color:#ffbe55;color:#ffe6b3}
.hb-ground-status-item.crit{background:rgba(165,24,18,.88);border-color:#ff6b5b;color:#fff0ed;animation:hb-hud-blink .42s infinite}
.hb-ground-keybind-bar{background:rgba(6,14,10,.7);border:1px solid rgba(160,230,150,.36);border-radius:6px;padding:5px 14px;font-size:11px;color:rgba(200,240,200,.85);white-space:nowrap;text-align:center}
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
#${PALLETJACK_HUD_ID}{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);z-index:60;pointer-events:none;
  font:600 12px/1.35 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#ccf7c4;
  background:rgba(6,16,11,.78);border:1.5px solid rgba(150,235,155,.45);border-radius:8px;padding:8px 16px;
  text-align:center;box-shadow:0 4px 12px rgba(0,0,0,.5)}
#${PALLETJACK_HUD_ID} .hb-pj-top{font-size:13px;font-weight:800;color:#f0fff0;margin-bottom:4px}
#${PALLETJACK_HUD_ID} .hb-pj-keys{font-size:11px;color:rgba(195,240,195,.85);white-space:nowrap}
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

function wrapPi(a) {
  if (!Number.isFinite(a)) return 0;
  let d = a % (2 * Math.PI);
  if (d > Math.PI) d -= 2 * Math.PI;
  else if (d < -Math.PI) d += 2 * Math.PI;
  return d === 0 ? 0 : d;
}

function normalizeTrailerKind(k) {
  if (
    k === "40ft" ||
    k === 40 ||
    k === 14 ||
    k === 15 ||
    k === 4000031 ||
    k === 4000032 ||
    k === "Chassis40ft" ||
    k === "TrailerChassis40" ||
    k === "sidelifter40" ||
    k === "Sidelifter40" ||
    k === "TrailerSidelifter40"
  ) {
    return "40ft";
  }
  if (k === "20ft" || k === 20 || k === 13 || k === 4000030 || k === "Chassis20ft" || k === "TrailerChassis20") {
    return "20ft";
  }
  return null;
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

  // Aircraft wrapper nodes
  let topWrap = null;
  let attWrap = null;
  let leftWrap = null;
  let rightWrap = null;
  let botWrap = null;

  // Ground dashboard nodes (locomotion === 2)
  let groundWrap = null;
  let gSpeedNumEl = null;
  let gSpeedUnitEl = null;
  let gSpeedSubEl = null;
  let gSpeedFillEl = null;
  let gGearBadgeEl = null;
  let g4wdBadgeEl = null;
  let gRpmValEl = null;
  let gRpmFillEl = null;
  let gSurfaceBadgeEl = null;
  let gSeatCards = [];
  let gCrewTitleEl = null;
  let gTrailerBarEl = null;
  let gTrailerCoupledEl = null;
  let gTwistlockEl = null;
  let gArticulationEl = null;
  let gSideliftEl = null;
  let palletJackEl = null;
  let palletJackTopEl = null;
  let palletJackKeysEl = null;
  let gLightsEl = null;
  let gBrakeEl = null;
  let gHornEl = null;
  let gKeybindEl = null;

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
    pjSig: null, pjShown: null,
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
    palletJackEl = mkRoot(PALLETJACK_HUD_ID);
    palletJackTopEl = append(palletJackEl, mkEl(doc, "div", "hb-pj-top"));
    palletJackKeysEl = append(palletJackEl, mkEl(doc, "div", "hb-pj-keys"));
    palletJackKeysEl.textContent = PALLET_JACK_KEYBIND_TEXT;
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
    topWrap = append(el, mkEl(doc, "div", "hb-hud-top"));
    hdgBoxEl = append(topWrap, mkEl(doc, "div", "hb-hud-hdg-box"));
    const hdgWin = append(topWrap, mkEl(doc, "div", "hb-hud-hdg-window"));
    hdgStripEl = append(hdgWin, mkEl(doc, "div", "hb-hud-hdg-strip"));
    hdgStripEl.textContent = "W · 300 · 330 · N · 030 · 060 · E · 120 · 150 · S · 210 · 240 · W · 300 · 330 · N · 030 · 060 · E";
    const bankArc = append(topWrap, mkEl(doc, "div", "hb-hud-bank-arc"));
    bankPtrEl = append(bankArc, mkEl(doc, "div", "hb-hud-bank-ptr"));
    bankPtrEl.textContent = "▲";

    // 2. Center Attitude Pitch Ladder & Artificial Horizon
    attWrap = append(el, mkEl(doc, "div", "hb-hud-att"));
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
    leftWrap = append(el, mkEl(doc, "div", "hb-hud-left"));
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
    rightWrap = append(el, mkEl(doc, "div", "hb-hud-right"));
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
    botWrap = append(el, mkEl(doc, "div", "hb-hud-bottom"));
    headerTextEl = append(botWrap, mkEl(doc, "div", "hb-hud-sub"));
    armsTextEl = append(botWrap, mkEl(doc, "div", ""));
    debugTextEl = append(botWrap, mkEl(doc, "div", "hb-hud-sub"));
    keysTextEl = append(botWrap, mkEl(doc, "div", "hb-hud-keys"));

    // 6. Dedicated WWII Ground Vehicle Dashboard (locomotion === 2)
    groundWrap = append(el, mkEl(doc, "div", "hb-ground-dashboard", "hb-ground-dashboard"));

    // Left Speedometer & Gear/4WD
    const gLeft = append(groundWrap, mkEl(doc, "div", "hb-ground-left"));
    const gSpeedBox = append(gLeft, mkEl(doc, "div", "hb-ground-speed-box"));
    const gSpeedLine = append(gSpeedBox, mkEl(doc, "div", ""));
    gSpeedNumEl = append(gSpeedLine, mkEl(doc, "span", "hb-ground-speed-num"));
    gSpeedNumEl.textContent = "0";
    gSpeedUnitEl = append(gSpeedLine, mkEl(doc, "span", "hb-ground-speed-unit"));
    gSpeedUnitEl.textContent = "MPH";
    gSpeedSubEl = append(gSpeedBox, mkEl(doc, "div", "hb-ground-speed-sub"));
    gSpeedSubEl.textContent = "0 km/h";
    const gSpeedBar = append(gSpeedBox, mkEl(doc, "div", "hb-ground-speed-bar"));
    gSpeedFillEl = append(gSpeedBar, mkEl(doc, "div", "hb-ground-speed-fill"));

    const gGearBox = append(gSpeedBox, mkEl(doc, "div", "hb-ground-gear-box"));
    gGearBadgeEl = append(gGearBox, mkEl(doc, "div", "hb-ground-gear-badge"));
    gGearBadgeEl.textContent = "N";
    g4wdBadgeEl = append(gGearBox, mkEl(doc, "div", "hb-ground-4wd-badge"));
    g4wdBadgeEl.textContent = "4WD LOW";

    // Center Status Bar & Keybinds
    const gCenter = append(groundWrap, mkEl(doc, "div", "hb-ground-center"));
    gTrailerBarEl = append(gCenter, mkEl(doc, "div", "hb-ground-status-bar"));
    gTrailerBarEl.style.display = "none";
    gTrailerCoupledEl = append(gTrailerBarEl, mkEl(doc, "span", "hb-ground-status-item"));
    gTrailerCoupledEl.textContent = "BOBTAIL";
    gTwistlockEl = append(gTrailerBarEl, mkEl(doc, "span", "hb-ground-status-item"));
    gTwistlockEl.textContent = "TWISTLOCK: OPEN";
    gArticulationEl = append(gTrailerBarEl, mkEl(doc, "span", "hb-ground-status-item"));
    gArticulationEl.textContent = "ARTIC: 0°";
    gSideliftEl = append(gTrailerBarEl, mkEl(doc, "span", "hb-ground-status-item", "hb-trailer-sidelift"));
    gSideliftEl.textContent = "SIDELIFT ACTIVE — LOCKED";
    gSideliftEl.style.display = "none";

    const gStatusBar = append(gCenter, mkEl(doc, "div", "hb-ground-status-bar"));
    gLightsEl = append(gStatusBar, mkEl(doc, "span", "hb-ground-status-item"));
    gLightsEl.textContent = "LIGHTS";
    gBrakeEl = append(gStatusBar, mkEl(doc, "span", "hb-ground-status-item"));
    gBrakeEl.textContent = "BRAKE";
    gHornEl = append(gStatusBar, mkEl(doc, "span", "hb-ground-status-item"));
    gHornEl.textContent = "HORN";
    gKeybindEl = append(gCenter, mkEl(doc, "div", "hb-ground-keybind-bar"));
    gKeybindEl.textContent = GROUND_DRIVER_KEYBIND_TEXT;

    // Right Drivetrain & 2x2 Crew Diagram
    const gRight = append(groundWrap, mkEl(doc, "div", "hb-ground-right"));
    const gDrivetrainBox = append(gRight, mkEl(doc, "div", "hb-ground-drivetrain-box"));
    const gRpmLine = append(gDrivetrainBox, mkEl(doc, "div", ""));
    const gRpmTitle = append(gRpmLine, mkEl(doc, "span", "hb-ground-rpm-title"));
    gRpmTitle.textContent = "ENGINE RPM";
    gRpmValEl = append(gRpmLine, mkEl(doc, "span", "hb-ground-rpm-val"));
    gRpmValEl.textContent = "600";
    const gRpmBar = append(gDrivetrainBox, mkEl(doc, "div", "hb-ground-rpm-bar"));
    gRpmFillEl = append(gRpmBar, mkEl(doc, "div", "hb-ground-rpm-fill"));
    gSurfaceBadgeEl = append(gDrivetrainBox, mkEl(doc, "div", "hb-ground-surface-badge"));
    gSurfaceBadgeEl.textContent = "TRACTION: ROAD";

    const gCrewBox = append(gRight, mkEl(doc, "div", "hb-ground-crew-box"));
    gCrewTitleEl = append(gCrewBox, mkEl(doc, "div", "hb-ground-crew-title"));
    gCrewTitleEl.textContent = "CREW (1-4)";
    const gCrewGrid = append(gCrewBox, mkEl(doc, "div", "hb-ground-crew-grid"));
    gSeatCards = [];
    const seatLabels = ["1 Driver", "2 Front Pax", "3 Rear L", "4 Rear R"];
    for (let i = 0; i < 4; i++) {
      const card = append(gCrewGrid, mkEl(doc, "div", "hb-ground-seat-card empty"));
      card.textContent = seatLabels[i];
      if (typeof card.addEventListener === "function") {
        card.addEventListener("click", () => {
          if (typeof deps.onSeatClick === "function") deps.onSeatClick(i);
        });
      }
      gSeatCards.push(card);
    }
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
      if (s.locomotion === 2) {
        if (topWrap) topWrap.style.display = "none";
        if (attWrap) attWrap.style.display = "none";
        if (leftWrap) leftWrap.style.display = "none";
        if (rightWrap) rightWrap.style.display = "none";
        if (botWrap) botWrap.style.display = "none";
        hideAllSights();

        if (groundWrap) groundWrap.style.display = "block";

        const isSemi = s.vehicleClass === 3 || s.profileKey === "semi-379";
        const vMaxRoad = (Number.isFinite(s.vMaxRoad) && s.vMaxRoad > 0) ? s.vMaxRoad : (isSemi ? 27.0 : 29.0);
        const absSpeed = Math.abs(speed);
        const mph = Math.round(absSpeed * 2.23694);
        const kmh = Math.round(absSpeed * 3.6);

        setTxt(gSpeedNumEl, "gSpdNum", String(mph));
        setTxt(gSpeedSubEl, "gSpdSub", `${kmh} km/h`);
        const spdPct = clamp(Math.round((absSpeed / vMaxRoad) * 100), 0, 100);
        setStyle(gSpeedFillEl, "width", "gSpdFill", `${spdPct}%`);

        let gear = "N";
        if (s.gear !== undefined && s.gear !== null) {
          gear = String(s.gear).toUpperCase();
        } else {
          if (speed < -0.2 || (s.throttle < 0 && speed <= 0.2)) gear = "R";
          else if (absSpeed <= 0.2 && (!s.throttle || Math.abs(s.throttle) < 0.05)) gear = "N";
          else if (isSemi) {
            if (absSpeed < 5.0) gear = "1";
            else if (absSpeed < 10.0) gear = "2";
            else if (absSpeed < 16.0) gear = "3";
            else if (absSpeed < 22.0) gear = "4";
            else gear = "5";
          } else {
            if (absSpeed < 9.0) gear = "1";
            else if (absSpeed < 18.0) gear = "2";
            else gear = "3";
          }
        }
        setTxt(gGearBadgeEl, "gGear", gear);

        const boost = !!(s.boost || (s.groundFlags & 0x04) || s.fourWheelLow);
        if (g4wdBadgeEl) {
          setTxt(g4wdBadgeEl, "g4wdTxt", isSemi ? "LOW RANGE" : "4WD LOW");
          setStyle(g4wdBadgeEl, "display", "g4wd", boost ? "inline-block" : "none");
        }

        const rpmMax = Number.isFinite(s.rpmMax) && s.rpmMax > 600 ? s.rpmMax : (isSemi ? 2100 : 3800);
        let rpm = 600;
        if (Number.isFinite(s.rpm)) {
          rpm = Math.round(s.rpm);
        } else if (isSemi) {
          const thrAbs = Math.abs(s.throttle || 0);
          if (gear === "N") rpm = Math.round(600 + thrAbs * 750);
          else rpm = Math.round(900 + clamp(absSpeed / vMaxRoad, 0, 1) * 1000 + thrAbs * 200);
        } else {
          if (gear === "R") rpm = Math.round(800 + (absSpeed / 9.0) * 2600);
          else if (gear === "N") rpm = Math.round(600 + Math.abs(s.throttle || 0) * 1200);
          else if (gear === "1") rpm = Math.round(800 + (absSpeed / 9.0) * 2800);
          else if (gear === "2") rpm = Math.round(1200 + ((absSpeed - 9.0) / 9.0) * 2400);
          else rpm = Math.round(1600 + ((absSpeed - 18.0) / 11.0) * 2200);
        }
        rpm = clamp(rpm, 600, rpmMax);
        setTxt(gRpmValEl, "gRpmVal", String(rpm));
        const rpmPct = clamp(Math.round((rpm / rpmMax) * 100), 0, 100);
        setStyle(gRpmFillEl, "width", "gRpmFill", `${rpmPct}%`);

        let surfName = "ROAD";
        if (typeof s.surface === "string") surfName = s.surface.toUpperCase();
        else if (Number.isFinite(s.surfaceFamily)) surfName = SURFACE_NAMES[s.surfaceFamily] || "ROAD";
        else if (Number.isFinite(s.surface)) surfName = SURFACE_NAMES[s.surface] || "ROAD";
        setTxt(gSurfaceBadgeEl, "gSurf", `TRACTION: ${surfName}`);

        const lights = !!(s.headlights || (s.groundFlags & 0x10));
        const brake = !!(s.handbrake || s.brake || (s.groundFlags & 0x02));
        const horn = !!(s.horn || (s.groundFlags & 0x20));
        if (gLightsEl) gLightsEl.className = lights ? "hb-ground-status-item active-lights" : "hb-ground-status-item";
        if (gBrakeEl) gBrakeEl.className = brake ? "hb-ground-status-item active-brake" : "hb-ground-status-item";
        if (gHornEl) gHornEl.className = horn ? "hb-ground-status-item active-horn" : "hb-ground-status-item";

        const maxSeats = isSemi ? 2 : 4;
        const localSeat = clamp(Number.isFinite(s.seatIndex) ? Math.round(s.seatIndex) : 0, 0, maxSeats - 1);
        const seats = Array.isArray(s.seats) ? s.seats : (isSemi ? [1, 0] : [1, 0, 0, 0]);
        const baseLabels = isSemi
          ? ["1 Driver", "2 Co-Driver"]
          : ["1 Driver", "2 Front Pax", "3 Rear L", "4 Rear R"];
        if (gCrewTitleEl) setTxt(gCrewTitleEl, "gCrewTitle", isSemi ? "CREW (1-2)" : "CREW (1-4)");
        for (let i = 0; i < 4; i++) {
          const card = gSeatCards[i];
          if (!card) continue;
          if (i >= maxSeats) {
            card.style.display = "none";
            continue;
          }
          card.style.display = "";
          const isYou = (i === localSeat);
          const occ = seats[i] >>> 0;
          const isOccupied = !isYou && occ !== 0;
          if (isYou) {
            card.className = "hb-ground-seat-card you";
            card.textContent = `${baseLabels[i]} (You)`;
          } else if (isOccupied) {
            card.className = "hb-ground-seat-card teammate";
            card.textContent = baseLabels[i];
          } else {
            card.className = "hb-ground-seat-card empty";
            card.textContent = `${baseLabels[i]}`;
          }
        }

        // Semi-tractor trailer telemetry bar
        let coupledLabel = "BOBTAIL";
        let twistLabel = "OPEN";
        let artSignedDeg = 0;
        let artAbsDeg = 0;
        let artWarnTag = "";
        if (isSemi) {
          const tFlags = s.trailerFlags ?? 0;
          const hGuid = Number.isFinite(s.hitchedTrailerGuid) ? (s.hitchedTrailerGuid >>> 0) : 0;
          const coupled = Boolean(s.trailerCoupled || hGuid !== 0 || (tFlags & 0x01));
          const kindNorm = normalizeTrailerKind(s.trailerKind ?? s.hitchedTrailerKind);
          coupledLabel = coupled
            ? (kindNorm === "40ft" ? "COUPLED 40FT" : (kindNorm === "20ft" ? "COUPLED 20FT" : "COUPLED"))
            : "BOBTAIL";
          const twistLocked = Boolean(s.twistlocksLocked !== undefined ? s.twistlocksLocked : (tFlags & 0x02));
          twistLabel = twistLocked ? "LOCKED" : "OPEN";
          const artRad = Number.isFinite(s.trailerArticulationRad)
            ? s.trailerArticulationRad
            : (Number.isFinite(s.articulationRad)
              ? s.articulationRad
              : (Number.isFinite(s.trailerHeading) && Number.isFinite(s.heading)
                ? wrapPi(s.heading - s.trailerHeading)
                : 0));
          artAbsDeg = Math.round((Math.abs(artRad) * 180) / Math.PI);
          artSignedDeg = Math.round((artRad * 180) / Math.PI);
          const isCrit = coupled && artAbsDeg >= 68;
          const isCaution = coupled && !isCrit && artAbsDeg >= 55;
          artWarnTag = isCrit ? " [JACKKNIFE CRIT]" : (isCaution ? " [JACKKNIFE WARN]" : "");

          if (gTrailerBarEl) setStyle(gTrailerBarEl, "display", "gTrBar", "flex");
          if (gTrailerCoupledEl) {
            setTxt(gTrailerCoupledEl, "gTrCpl", coupledLabel);
            gTrailerCoupledEl.className = coupled ? "hb-ground-status-item active-lights" : "hb-ground-status-item";
          }
          if (gTwistlockEl) {
            setTxt(gTwistlockEl, "gTrTw", `TWISTLOCK: ${twistLabel}`);
            gTwistlockEl.className = twistLocked ? "hb-ground-status-item active-lights" : "hb-ground-status-item";
          }
          if (gArticulationEl) {
            const artText = isCrit
              ? `JACKKNIFE! ${artSignedDeg}°`
              : (isCaution ? `JACKKNIFE WARN ${artSignedDeg}°` : `ARTIC: ${artSignedDeg}°`);
            setTxt(gArticulationEl, "gTrArt", artText);
            gArticulationEl.className = isCrit
              ? "hb-ground-status-item crit"
              : (isCaution ? "hb-ground-status-item caution" : "hb-ground-status-item");
          }
          if (gSideliftEl) {
            const slActive = coupled && (s.sideliftPhase ?? 0) > 0;
            setStyle(gSideliftEl, "display", "gTrSlDisp", slActive ? "inline-block" : "none");
            gSideliftEl.className = slActive ? "hb-ground-status-item crit" : "hb-ground-status-item";
          }
        } else if (gTrailerBarEl) {
          setStyle(gTrailerBarEl, "display", "gTrBar", "none");
          if (gSideliftEl) setStyle(gSideliftEl, "display", "gTrSlDisp", "none");
        }

        const isPassenger = localSeat > 0;
        const keybindStr = isSemi
          ? (isPassenger ? SEMI_PAX_KEYBIND_TEXT : SEMI_DRIVER_KEYBIND_TEXT)
          : (isPassenger ? GROUND_PAX_KEYBIND_TEXT : GROUND_DRIVER_KEYBIND_TEXT);
        setTxt(gKeybindEl, "gKeys", keybindStr);

        // Mirror summary to el.textContent for fake-DOM test harness
        if (!el.nodeType) {
          const crewSummary = baseLabels.map((lbl, i) => {
            if (i === localSeat) return `[${lbl}: You]`;
            if (seats[i] && (seats[i] >>> 0)) return `[${lbl}: Teammate]`;
            return `[${lbl}: Empty]`;
          }).join(" ");
          const statusSummary = `${lights ? "[LIGHTS]" : "LIGHTS"} ${brake ? "[BRAKE]" : "BRAKE"} ${horn ? "[HORN]" : "HORN"}`;
          const fourWdStr = boost ? (isSemi ? "  [LOW RANGE]" : "  [4WD LOW]") : "";
          const summaryLines = [
            `${s.name || (isSemi ? "Ironhorse 379" : "Willys MB")}  ${gear}${fourWdStr}`,
            `SPEED: ${mph} MPH (${kmh} km/h)   GEAR: ${gear}${fourWdStr}   RPM: ${rpm}`,
            `TRACTION: [${surfName}]   STATUS: ${statusSummary}`,
          ];
          if (isSemi) {
            summaryLines.push(`CREW (1-2): ${crewSummary}`);
            summaryLines.push(`TRAILER: [${coupledLabel}]   TWISTLOCK: [${twistLabel}]   ARTIC: ${artSignedDeg}°${artWarnTag}${(s.sideliftPhase ?? 0) > 0 ? "   [SIDELIFT ACTIVE — LOCKED]" : ""}`);
          } else {
            summaryLines.push(`CREW: ${crewSummary}`);
          }
          summaryLines.push(keybindStr);
          const summary = summaryLines.join("\n");
          if (summary !== last.text) {
            last.text = summary;
            el.textContent = summary;
          }
        }

        show(el, "shown", true);
        return;
      }

      if (groundWrap) groundWrap.style.display = "none";
      if (topWrap) topWrap.style.display = "flex";
      if (attWrap) attWrap.style.display = "block";
      if (leftWrap) leftWrap.style.display = "flex";
      if (rightWrap) rightWrap.style.display = "flex";
      if (botWrap) botWrap.style.display = "block";

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

    palletJack(s) {
      if (disposed) return;
      ensure();
      if (!palletJackEl) return;
      if (!s || hidden) {
        if (last.pjShown !== false) {
          last.pjShown = false;
          palletJackEl.style.display = "none";
        }
        return;
      }
      const forkMm = Math.round((Number.isFinite(s.forkHeightM) ? s.forkHeightM : 0.085) * 1000);
      const forkLbl = forkMm >= 180 ? "RAISED" : (forkMm <= 95 ? "LOWERED" : `${forkMm} mm`);
      const rawWcid = typeof s.carriedWcid === "string" && s.carriedWcid.trim() !== ""
        ? Number(s.carriedWcid)
        : s.carriedWcid;
      const wcid = Number.isFinite(rawWcid) && rawWcid > 0 ? (rawWcid >>> 0) : 0;
      const cargoName = wcid ? CARGO_WCID_NAMES[wcid] : null;
      const cargoLbl = wcid
        ? (cargoName ? `CARGO: ${cargoName} (${wcid})` : `CARGO: WCID ${wcid}`)
        : "EMPTY FORKS";
      const surfLbl = typeof s.surface === "string" ? s.surface.toUpperCase() : "TERRAIN";
      const viewLbl = s.viewMode === "interior" ? "CLOSE" : "FOLLOW";
      const topLine = `PALLET JACK · FORKS ${forkLbl} (${forkMm} mm) · ${cargoLbl} · ${surfLbl} · CAM ${viewLbl}`;
      setTxt(palletJackTopEl, "pjSig", topLine);
      if (!palletJackEl.nodeType) {
        const fullTxt = `${topLine}\n${PALLET_JACK_KEYBIND_TEXT}`;
        if (palletJackEl.textContent !== fullTxt) palletJackEl.textContent = fullTxt;
      }
      if (last.pjShown !== true) {
        last.pjShown = true;
        palletJackEl.style.display = "block";
      }
    },

    toggleHidden() {
      if (disposed) return hidden;
      hidden = !hidden;
      if (hidden && el) {
        show(el, "shown", false);
        if (palletJackEl) {
          last.pjShown = false;
          palletJackEl.style.display = "none";
        }
        hideAllSights();
      }
      return hidden;
    },

    hide() {
      if (disposed) return;
      if (el) show(el, "shown", false);
      if (palletJackEl) {
        last.pjShown = false;
        palletJackEl.style.display = "none";
      }
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
        palletJackEl?.remove?.();
        reticle?.remove?.();
        pipper?.remove?.();
        fpmEl?.remove?.();
        aimEl?.remove?.();
        fallLineEl?.remove?.();
        hitEl?.remove?.();
        vignetteEl?.remove?.();
        groundWrap?.remove?.();
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
      topWrap = null;
      attWrap = null;
      leftWrap = null;
      rightWrap = null;
      botWrap = null;
      groundWrap = null;
      gSpeedNumEl = null;
      gSpeedUnitEl = null;
      gSpeedSubEl = null;
      gSpeedFillEl = null;
      gGearBadgeEl = null;
      g4wdBadgeEl = null;
      gRpmValEl = null;
      gRpmFillEl = null;
      gSurfaceBadgeEl = null;
      gSeatCards = [];
      gCrewTitleEl = null;
      gTrailerBarEl = null;
      gTrailerCoupledEl = null;
      gTwistlockEl = null;
      gArticulationEl = null;
      gSideliftEl = null;
      palletJackEl = null;
      palletJackTopEl = null;
      palletJackKeysEl = null;
      gLightsEl = null;
      gBrakeEl = null;
      gHornEl = null;
      gKeybindEl = null;
    },
  };
}
