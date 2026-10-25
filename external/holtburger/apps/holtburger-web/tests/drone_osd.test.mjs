// tests/drone_osd.test.mjs
//
// WHY (2026-10-24). Drone Deploy (scene3d/drone/SPEC.md, `?drone=on`, DEFAULT
// OFF) shows an FPV on-screen display in the goggles. scene3d/drone/osd.js
// (SPEC §3.6) must: format every readout exactly (and print `--` for a
// missing / non-finite value), build ONE `#hb-drone-osd` body child whose every
// node has pointer-events none (a click must still reach the HUD), with the
// §3.6 child classes; follow `show` in `data-mode`; turn RAW OsdView values into
// text itself (index.js imports no osd constant); move the heading tape and the
// horizon by cached CSS transforms, writing only on change; drive static from
// the signal (0.85 pinned in a crash); fade the cheat sheet from `frame` calls
// (no timers); lay the readouts out below the default vitals with the heading
// tape at the bottom (PLAN §6.6) and the pilot-view banner below the pilot; and
// implement H as film's clean CSS + one keep rule WITHOUT ever stripping film's
// own `film-clean` class. No document → every method returns
// false and nothing throws. This suite EXECUTES the real module on the shared
// tests/helpers/social_fake_dom.mjs DOM.
//
// Run from apps/holtburger-web/: node tests/drone_osd.test.mjs

import assert from "node:assert/strict";
import { installFakeDom } from "./helpers/social_fake_dom.mjs";

const O = await import("../scene3d/drone/osd.js");
const CF = await import("../scene3d/film/runtime/clean_frame.js");

let passed = 0;
let failed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  [PASS] ${name}`);
    } catch (e) {
      failed += 1;
      console.log(`  [FAIL] ${name} — ${e && e.stack ? e.stack.split("\n").slice(0, 3).join(" | ") : e}`);
    }
  });
}
const near = (a, b, eps = 1e-9, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} expected ${b}, got ${a}`);
const RAD = Math.PI / 180;

function freshDom() {
  const win = {};
  const { document } = installFakeDom(win);
  return { win, document };
}

const VIEW = () => ({
  mode: "acro",
  battery: 0.874,
  timerSec: 135,
  signal: 0.5,
  distHomeM: 1234,
  aglM: 15.24,
  speedMps: 12.34,
  headingRad: 0.785,
  homeBearingRad: 0.785 + 30 * RAD,
  banners: { rangeLimit: false, lowBattery: false, returning: false, returningSec: null, crash: false, acroHint: false },
  reticle: "horizon",
});

/** Count writes of `prop` on `obj` (an own accessor over the inherited one or a plain field). */
function countWrites(obj, prop) {
  let n = 0;
  let proto = Object.getPrototypeOf(obj);
  let desc = null;
  while (proto && !desc) {
    desc = Object.getOwnPropertyDescriptor(proto, prop);
    proto = Object.getPrototypeOf(proto);
  }
  if (desc && desc.set) {
    Object.defineProperty(obj, prop, {
      configurable: true,
      get() { return desc.get.call(this); },
      set(v) { n += 1; desc.set.call(this, v); },
    });
  } else {
    let val = obj[prop];
    Object.defineProperty(obj, prop, {
      configurable: true,
      get() { return val; },
      set(v) { n += 1; val = v; },
    });
  }
  return () => n;
}

/**
 * The OSD's flat stylesheet → Map(selector → {property: value}); a selector
 * list sets every member, later rules merge over earlier ones, @-blocks skipped.
 */
function cssRules(text) {
  const out = new Map();
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("{", i);
    if (open < 0) break;
    const head = text.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < text.length && depth > 0) {
      if (text[j] === "{") depth += 1;
      else if (text[j] === "}") depth -= 1;
      j += 1;
    }
    const body = text.slice(open + 1, j - 1);
    i = j;
    if (head.startsWith("@")) continue;
    const decls = {};
    for (const part of body.split(";")) {
      const k = part.indexOf(":");
      if (k > 0) decls[part.slice(0, k).trim()] = part.slice(k + 1).trim();
    }
    for (const sel of head.split(",").map((s) => s.trim())) out.set(sel, { ...(out.get(sel) || {}), ...decls });
  }
  return out;
}

// ---------------------------------------------------------------------------
// pure formatters
// ---------------------------------------------------------------------------

check("ids and modes", () => {
  assert.equal(O.OSD_ID, "hb-drone-osd");
  assert.equal(O.OSD_STYLE_ID, "hb-drone-osd-style");
  assert.equal(O.DRONE_CLEAN_STYLE_ID, "hb-drone-clean-css");
  assert.equal(O.DRONE_CLEAN_KEEP_CSS, "html.film-clean #hb-drone-osd { display: block !important; }");
  assert.deepEqual(O.OSD_MODES, ["off", "boot", "fpv", "pilot", "crash"]);
  assert.ok(Object.isFrozen(O.OSD_MODES));
});

check("formatPercent / formatDistance / formatAltitude / formatSpeed exact strings; `--` for null / NaN", () => {
  assert.equal(O.formatPercent(0.874), "87%");
  assert.equal(O.formatPercent(1), "100%");
  assert.equal(O.formatPercent(0), "0%");
  assert.equal(O.formatPercent(0.2), "20%");
  assert.equal(O.formatDistance(12.34), "12 m");
  assert.equal(O.formatDistance(1234), "1.23 km");
  assert.equal(O.formatDistance(0), "0 m");
  assert.equal(O.formatDistance(150), "150 m");
  assert.equal(O.formatDistance(999.4), "999 m");
  assert.equal(O.formatDistance(999.6), "1.00 km");
  assert.equal(O.formatAltitude(15.24), "15.2 m");
  assert.equal(O.formatAltitude(123.4), "123 m");
  assert.equal(O.formatAltitude(0), "0.0 m");
  assert.equal(O.formatAltitude(99.94), "99.9 m");
  assert.equal(O.formatAltitude(99.96), "100 m");
  assert.equal(O.formatAltitude(-0.04), "0.0 m");
  assert.equal(O.formatAltitude(-1.3), "-1.3 m");
  assert.equal(O.formatSpeed(12.34), "12.3 m/s");
  assert.equal(O.formatSpeed(0), "0.0 m/s");
  assert.equal(O.formatSpeed(19.96), "20.0 m/s");
  for (const f of [O.formatPercent, O.formatDistance, O.formatAltitude, O.formatSpeed, O.formatTimer, O.formatHeading, O.compassLabel]) {
    for (const bad of [null, undefined, NaN, Infinity, -Infinity, "12"]) assert.equal(f(bad), "--", `${f.name}(${String(bad)})`);
  }
});

check("formatTimer / formatHeading / compassLabel / modeLabel", () => {
  assert.equal(O.formatTimer(135), "02:15");
  assert.equal(O.formatTimer(3725), "1:02:05");
  assert.equal(O.formatTimer(0), "00:00");
  assert.equal(O.formatTimer(59.9), "00:59");
  assert.equal(O.formatTimer(3600), "1:00:00");
  assert.equal(O.formatTimer(36000 + 61), "10:01:01");
  assert.equal(O.formatTimer(-1), "--");
  assert.equal(O.formatHeading(0.785), "045°");
  assert.equal(O.formatHeading(0), "000°");
  assert.equal(O.formatHeading(Math.PI), "180°");
  assert.equal(O.formatHeading(-Math.PI / 2), "270°");
  assert.equal(O.formatHeading(2 * Math.PI - 0.001), "000°", "359.94 rounds to 360 → 000");
  assert.equal(O.formatHeading(7), "041°", "unwrapped heading");
  const labels = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
  for (let i = 0; i < 8; i++) assert.equal(O.compassLabel(i * 45 * RAD), labels[i], `${i * 45}°`);
  assert.equal(O.compassLabel(-45 * RAD), "NW");
  assert.equal(O.compassLabel(22 * RAD), "N");
  assert.equal(O.compassLabel(23 * RAD), "NE");
  assert.equal(O.compassLabel(2 * Math.PI), "N");
  assert.equal(O.modeLabel("cine"), "CINE");
  assert.equal(O.modeLabel("angle"), "ANGLE");
  assert.equal(O.modeLabel("acro"), "ACRO");
  for (const bad of [null, undefined, "", "CINE", "toString", 3]) assert.equal(O.modeLabel(bad), "--", String(bad));
});

check("signalBars / staticOpacity / headingTapeOffsetPx / homeArrowDeg", () => {
  assert.equal(O.signalBars(0), 0);
  assert.equal(O.signalBars(-0.5), 0);
  assert.equal(O.signalBars(0.01), 1);
  assert.equal(O.signalBars(0.2), 1);
  assert.equal(O.signalBars(0.21), 2);
  assert.equal(O.signalBars(0.5), 3);
  assert.equal(O.signalBars(0.99), 5);
  assert.equal(O.signalBars(1), 5);
  assert.equal(O.signalBars(3), 5);
  assert.equal(O.signalBars(NaN), 0);
  assert.equal(O.staticOpacity(1), 0);
  near(O.staticOpacity(0), 0.85, 1e-12);
  near(O.staticOpacity(0.5), 0.85 * Math.pow(0.5, 1.5), 1e-12);
  assert.equal(O.staticOpacity(2), 0, "clamped");
  near(O.staticOpacity(-1), 0.85, 1e-12, "clamped");
  assert.equal(O.staticOpacity(NaN), 0, "unknown signal: no static flash");
  let prev = Infinity;
  for (let s = 0; s <= 1.0001; s += 0.05) {
    const v = O.staticOpacity(s);
    assert.ok(v <= prev + 1e-12, "non-increasing in signal");
    prev = v;
  }
  assert.equal(O.headingTapeOffsetPx(0), 0);
  near(O.headingTapeOffsetPx(Math.PI / 2), -360, 1e-9);
  near(O.headingTapeOffsetPx(-Math.PI / 2), -1080, 1e-9);
  near(O.headingTapeOffsetPx(Math.PI / 2, 2), -180, 1e-9);
  near(O.headingTapeOffsetPx(Math.PI / 2 + 2 * Math.PI), -360, 1e-9, "wrapped");
  assert.equal(O.headingTapeOffsetPx(NaN), 0);
  near(O.homeArrowDeg(0, Math.PI / 2), 90, 1e-9);
  near(O.homeArrowDeg(Math.PI / 2, 0), -90, 1e-9);
  near(O.homeArrowDeg(0, Math.PI), 180, 1e-9, "(−180, 180]: 180 kept");
  near(O.homeArrowDeg(Math.PI, 0), 180, 1e-9, "−180 → 180");
  near(O.homeArrowDeg(0.1, 0.1 + 2 * Math.PI), 0, 1e-9);
  near(O.homeArrowDeg(350 * RAD, 10 * RAD), 20, 1e-9, "across north");
  assert.equal(O.homeArrowDeg(NaN, 1), 0);
  for (let i = 0; i < 500; i++) {
    const h = (i * 0.731) % 13 - 6.5;
    const b = (i * 1.379) % 17 - 8.5;
    const r = O.homeArrowDeg(h, b);
    assert.ok(r > -180 && r <= 180, `range at ${h}, ${b}: ${r}`);
  }
});

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

check("show('fpv') builds ONE #hb-drone-osd body child: §3.6 children, pointer-events none on every node, HUD-space sizing, the stylesheet", () => {
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  assert.equal(document.getElementById(O.OSD_ID), null, "nothing before the first show");
  assert.equal(osd.show("off"), true, "'off' before the build is fine");
  assert.equal(document.getElementById(O.OSD_ID), null, "'off' builds nothing");
  assert.equal(osd.show("fpv"), true);
  const root = document.getElementById(O.OSD_ID);
  assert.ok(root, "root built");
  assert.equal(root.parentNode, document.body, "a direct <body> child (HUD-zoomed as body > [id^=hb-])");
  assert.equal(root.tagName, "DIV");
  assert.equal(root.getAttribute("data-mode"), "fpv");
  assert.equal(root.style.position, "fixed");
  assert.equal(root.style.left, "0");
  assert.equal(root.style.top, "0");
  assert.match(root.style.width, /calc\(100 \* var\(--hb-hud-vw/);
  assert.match(root.style.height, /calc\(100 \* var\(--hb-hud-vh/);
  const kids = root.children.map((c) => c.className);
  for (const cls of ["dosd-tl", "dosd-tr", "dosd-center", "dosd-tape", "dosd-banner", "dosd-static", "dosd-vignette", "dosd-fade", "dosd-cheat"]) {
    assert.ok(kids.includes(cls), `direct child .${cls}`);
  }
  assert.ok(root.querySelector('.dosd-center [data-reticle="crosshair"]'));
  assert.ok(root.querySelector('.dosd-center [data-reticle="horizon"]'));
  const all = [root, ...root.querySelectorAll("*")];
  assert.ok(all.length > 40);
  for (const el of all) assert.equal(el.style.pointerEvents, "none", `pointer-events on .${el.className}`);
  const style = document.getElementById(O.OSD_STYLE_ID);
  assert.ok(style && style.tagName === "STYLE");
  assert.equal(style.parentNode, document.head);
  assert.match(style.textContent, /#hb-drone-osd, #hb-drone-osd \* \{ pointer-events: none !important;/);
  assert.ok(style.textContent.includes('html.film-clean #hb-drone-osd[data-mode="off"]'), "'off' beats the clean keep rule");
  assert.ok(style.textContent.includes("data:image/svg+xml,"), "static = SVG data URI");
  assert.ok(style.textContent.includes("feTurbulence"));
  // banner texts exactly as the SPEC lists them (phase 3: the pilot banner names the gamepad's View button too)
  const bannerTexts = root.querySelectorAll(".dosd-banner .dosd-b").map((b) => b.textContent);
  assert.deepEqual(bannerTexts, ["RANGE LIMIT", "LOW BATTERY", "RETURNING", "CRASH", "PILOT VIEW · Tab / View: goggles", "ACRO: gamepad recommended"]);
  // idempotent: a second show builds nothing new
  osd.show("fpv");
  assert.equal(document.body.querySelectorAll("#hb-drone-osd").length, 1);
  assert.equal(document.head.querySelectorAll("#hb-drone-osd-style").length, 1);
  osd.dispose();
});

check("data-mode follows show(); 'boot' sets the wipe duration and alternates its animation; unknown modes are refused", () => {
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  assert.equal(osd.show("boot"), true);
  const root = document.getElementById(O.OSD_ID);
  assert.equal(root.getAttribute("data-mode"), "boot");
  assert.equal(root.style.getPropertyValue("--dosd-boot"), "0.35s", "default 0.35 s");
  const first = root.getAttribute("data-boot");
  assert.ok(first === "a" || first === "b");
  osd.show("fpv");
  osd.show("boot", { durationSec: 0.35 / 1.5 });
  assert.equal(root.style.getPropertyValue("--dosd-boot"), `${0.35 / 1.5}s`);
  assert.notEqual(root.getAttribute("data-boot"), first, "a second boot restarts the animation");
  osd.show("boot", { durationSec: undefined });
  assert.equal(root.style.getPropertyValue("--dosd-boot"), "0.35s");
  for (const m of ["fpv", "pilot", "crash", "off", "fpv"]) {
    assert.equal(osd.show(m), true);
    assert.equal(root.getAttribute("data-mode"), m);
    assert.equal(osd.mode, m);
  }
  assert.equal(osd.show("goggles"), false);
  assert.equal(osd.show(null), false);
  assert.equal(root.getAttribute("data-mode"), "fpv", "a refused mode changes nothing");
  osd.dispose();
});

check("update(view) writes the texts from RAW values (mode 'acro' → ACRO, battery 0.874 → 87%, …), only what changed", () => {
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  osd.show("fpv");
  const root = document.getElementById(O.OSD_ID);
  const q = (s) => root.querySelector(s);
  const view = VIEW();
  assert.equal(osd.update(view), true);
  assert.equal(q(".dosd-mode").textContent, "ACRO");
  assert.equal(q(".dosd-batt").textContent, "87%");
  assert.equal(q(".dosd-timer").textContent, "02:15");
  assert.equal(q(".dosd-dist").textContent, "1.23 km");
  assert.equal(q(".dosd-agl").textContent, "15.2 m");
  assert.equal(q(".dosd-speed").textContent, "12.3 m/s");
  assert.equal(q(".dosd-heading").textContent, "045°");
  const bars = root.querySelectorAll(".dosd-bar").map((b) => b.getAttribute("data-on"));
  assert.deepEqual(bars, ["1", "1", "1", "0", "0"], "signal 0.5 → 3 bars");
  assert.equal(q('[data-reticle="horizon"]').hidden, false, "angle / acro: horizon");
  assert.equal(q('[data-reticle="crosshair"]').hidden, true);
  assert.equal(q(".dosd-home").hidden, false, "home arrow shown");
  assert.equal(q(".dosd-home").style.transform, "translateX(120px)", "home 30° right → 120 px");
  // only changed text is written
  const batt = q(".dosd-batt");
  const mode = q(".dosd-mode");
  const nb = countWrites(batt, "textContent");
  const nm = countWrites(mode, "textContent");
  osd.update(view);
  osd.update(view);
  assert.equal(nb(), 0, "unchanged battery not rewritten");
  assert.equal(nm(), 0);
  view.battery = 0.5;
  osd.update(view);
  assert.equal(nb(), 1);
  assert.equal(batt.textContent, "50%");
  assert.equal(nm(), 0);
  // cine → crosshair; missing values → --
  view.mode = "cine";
  view.reticle = "crosshair";
  view.battery = null;
  view.signal = NaN;
  view.aglM = undefined;
  osd.update(view);
  assert.equal(mode.textContent, "CINE");
  assert.equal(batt.textContent, "--");
  assert.equal(q(".dosd-agl").textContent, "--");
  assert.deepEqual(root.querySelectorAll(".dosd-bar").map((b) => b.getAttribute("data-on")), ["0", "0", "0", "0", "0"]);
  assert.equal(q('[data-reticle="crosshair"]').hidden, false);
  assert.equal(q('[data-reticle="horizon"]').hidden, true);
  // the home arrow pins to the tape edge with an arrow when home is behind
  view.homeBearingRad = view.headingRad + 120 * RAD;
  osd.update(view);
  assert.equal(q(".dosd-home-glyph").textContent, "H▶");
  view.homeBearingRad = view.headingRad - 120 * RAD;
  osd.update(view);
  assert.equal(q(".dosd-home-glyph").textContent, "◀H");
  view.distHomeM = 0.4;
  osd.update(view);
  assert.equal(q(".dosd-home").hidden, true, "at home: no arrow");
  // low battery colours the battery and shows the banner
  view.battery = 0.15;
  view.banners.lowBattery = true;
  osd.update(view);
  assert.equal(batt.getAttribute("data-warn"), "1");
  assert.equal(q('[data-banner="lowBattery"]').hidden, false);
  assert.equal(osd.update(null), false);
  osd.dispose();
});

check("update() before the first build is kept and shown at the build (index.js updates once the drone is in the world)", () => {
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  assert.equal(osd.update(VIEW()), true);
  assert.equal(document.getElementById(O.OSD_ID), null, "update builds nothing");
  osd.show("boot");
  const root = document.getElementById(O.OSD_ID);
  assert.equal(root.querySelector(".dosd-mode").textContent, "ACRO");
  assert.equal(root.querySelector(".dosd-speed").textContent, "12.3 m/s");
  osd.dispose();
});

check("banners by mode: fpv follows the flags; 'pilot' = PILOT VIEW (+ low battery) only; 'crash' = CRASH + static 0.85", () => {
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  osd.show("fpv");
  const root = document.getElementById(O.OSD_ID);
  const vis = () => root.querySelectorAll(".dosd-b").filter((b) => !b.hidden).map((b) => b.getAttribute("data-banner"));
  const view = VIEW();
  osd.update(view);
  assert.deepEqual(vis(), []);
  view.banners = { rangeLimit: true, lowBattery: true, returning: true, crash: false, acroHint: true };
  osd.update(view);
  assert.deepEqual(vis(), ["rangeLimit", "lowBattery", "returning", "acroHint"]);
  osd.show("pilot");
  assert.deepEqual(vis(), ["lowBattery", "pilot"]);
  view.banners.lowBattery = false;
  osd.update(view);
  assert.deepEqual(vis(), ["pilot"]);
  osd.show("crash");
  assert.deepEqual(vis(), ["crash"]);
  const st = root.querySelector(".dosd-static");
  assert.equal(st.style.opacity, "0.85");
  assert.equal(osd.staticLevel(1), 0.85, "pinned while crashed");
  assert.equal(st.style.opacity, "0.85");
  osd.show("fpv");
  assert.deepEqual(vis(), ["rangeLimit", "returning", "acroHint"], "the pilot banner does not outlive the pilot view");
  osd.dispose();
});

check("RETURNING counts down the recall grace (returningSec, 2026-10-25): formatReturning and the banner text", () => {
  assert.equal(O.formatReturning(null), "RETURNING");
  for (const bad of [undefined, NaN, Infinity, -0.1, "2"]) assert.equal(O.formatReturning(bad), "RETURNING", String(bad));
  assert.equal(O.formatReturning(3), "RETURNING 3 · FLY TO CANCEL");
  assert.equal(O.formatReturning(2.4), "RETURNING 3 · FLY TO CANCEL", "rounded up");
  assert.equal(O.formatReturning(0.01), "RETURNING 1 · FLY TO CANCEL");
  assert.equal(O.formatReturning(0), "RETURNING 1 · FLY TO CANCEL", "never 0 while it still shows");
  assert.equal(O.formatReturning(12), "RETURNING 12 · FLY TO CANCEL");
  assert.equal(O.formatReturning(2), O.formatReturning(2), "the same string object each time (no per-update building)");
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  osd.show("fpv");
  const banner = document.getElementById(O.OSD_ID).querySelectorAll(".dosd-b").find((b) => b.getAttribute("data-banner") === "returning");
  const view = VIEW();
  view.banners = { rangeLimit: false, lowBattery: false, returning: true, returningSec: 2.2, crash: false, acroHint: false };
  osd.update(view);
  assert.equal(banner.hidden, false);
  assert.equal(banner.textContent, "RETURNING 3 · FLY TO CANCEL");
  view.banners.returningSec = 0.4;
  osd.update(view);
  assert.equal(banner.textContent, "RETURNING 1 · FLY TO CANCEL");
  view.banners.returningSec = null;
  osd.update(view);
  assert.equal(banner.textContent, "RETURNING", "no countdown once it cannot be cancelled");
  osd.dispose();
});

check("layout (PLAN §6.6, 1070 V1): readouts in a row below the vitals, the heading tape at the bottom under the cheat sheet, the H corner overrides, the pilot-view banner below the pilot", () => {
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  osd.show("fpv");
  const css = cssRules(document.getElementById(O.OSD_STYLE_ID).textContent);
  const rule = (sel) => {
    const r = css.get(sel);
    assert.ok(r, `a rule for ${sel}`);
    return r;
  };
  const px = (v) => {
    const m = /^(-?\d+(?:\.\d+)?)px$/.exec(v ?? "");
    assert.ok(m, `a px value, got ${v}`);
    return Number(m[1]);
  };
  // HUD px (the OSD is HUD-zoomed; the HUD space is ≈ 1280 × 720). The default vitals (orbs at
  // left 260 / 401 / 542, the classic bars at left 260) end at ≈ 127 / 169, z 50 over the OSD's 30.
  const HUD_H = 720;
  const VITALS_BOTTOM = 174;
  const TOOLBAR_TOP = 606;
  for (const sel of [".dosd-tl", ".dosd-tr"]) {
    assert.equal(rule(sel).top, "190px", `${sel} top`);
    assert.ok(px(rule(sel).top) > VITALS_BOTTOM, `${sel} clears the vitals (BAT was hidden behind the stamina plaque)`);
  }
  assert.equal(rule(".dosd-tl").left, "calc(50% - 330px)");
  assert.equal(rule(".dosd-tr").right, "max(calc(50% - 330px), 310px)", "the right block keeps 310 HUD px from the right edge: an open main panel (right 8 + width 300) cannot cover it at 16:10");
  const tape = rule(".dosd-tape");
  assert.equal(tape.top, "auto", "the tape is bottom-anchored (it sat on the mana orb)");
  assert.equal(tape.bottom, "150px");
  const cheat = rule(".dosd-cheat");
  assert.equal(cheat.bottom, "240px");
  const tapeTop = HUD_H - px(tape.bottom) - px(tape.height);
  assert.ok(tapeTop > HUD_H - px(cheat.bottom), `the tape (from y ${tapeTop}) starts below the cheat sheet's bottom edge (y ${HUD_H - px(cheat.bottom)})`);
  assert.ok(HUD_H - px(tape.bottom) < TOOLBAR_TOP, "…and ends above the toolbar");
  assert.equal(rule(".dosd-banner").top, "30%", "fpv banners stay centred high, clear of the tape");
  // pilot view: the banner moves below the pilot (it crossed the pilot's neck), above the toolbar
  const pilot = rule('#hb-drone-osd[data-mode="pilot"] > .dosd-banner');
  assert.equal(pilot.top, "auto");
  assert.equal(pilot.bottom, "24%");
  // H (clean): the classic FPV corners and the tape at the edge, still clear of the cheat sheet
  assert.deepEqual([rule("html.film-clean #hb-drone-osd > .dosd-tl").left, rule("html.film-clean #hb-drone-osd > .dosd-tl").top], ["22px", "16px"]);
  assert.deepEqual([rule("html.film-clean #hb-drone-osd > .dosd-tr").right, rule("html.film-clean #hb-drone-osd > .dosd-tr").top], ["22px", "16px"]);
  const cleanTape = rule("html.film-clean #hb-drone-osd > .dosd-tape");
  const cleanCheat = rule("html.film-clean #hb-drone-osd > .dosd-cheat");
  assert.equal(cleanTape.bottom, "18px");
  assert.equal(cleanCheat.bottom, "100px");
  assert.ok(px(cleanCheat.bottom) > px(cleanTape.bottom) + px(tape.height), "clean: the cheat sheet clears the tape");
  // the DOM side: in 'pilot' the one banner shows, naming the gamepad's View button too
  osd.show("pilot");
  const root = document.getElementById(O.OSD_ID);
  assert.equal(root.getAttribute("data-mode"), "pilot", "the mode-scoped banner rule applies");
  assert.deepEqual(root.querySelectorAll(".dosd-b").filter((b) => !b.hidden).map((b) => b.textContent), ["PILOT VIEW · Tab / View: goggles"]);
  osd.dispose();
});

check("staticLevel(signal) applies and returns staticOpacity, written only on a 0.01 change; data-on drives the jitter", () => {
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  assert.equal(osd.staticLevel(0.5), O.staticOpacity(0.5), "returns the level before the build too");
  osd.show("fpv");
  const st = document.getElementById(O.OSD_ID).querySelector(".dosd-static");
  assert.equal(st.style.opacity, "0.3", "the pre-build level applied at the build");
  assert.equal(st.getAttribute("data-on"), "1");
  const n = countWrites(st.style, "opacity");
  assert.equal(osd.staticLevel(1), 0);
  assert.equal(st.style.opacity, "0");
  assert.equal(st.getAttribute("data-on"), "0");
  osd.staticLevel(1);
  osd.staticLevel(0.99999);
  assert.equal(n(), 1, "unchanged level not rewritten");
  near(osd.staticLevel(0), 0.85, 1e-12);
  assert.equal(st.style.opacity, "0.85");
  assert.equal(osd.staticLevel(NaN), 0);
  osd.dispose();
});

check("frame(): heading tape + horizon transforms from cached strings, written only on change", () => {
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  assert.equal(osd.frame({ headingRad: 0, rollRad: 0, pitchRad: 0 }), false, "nothing built yet");
  osd.show("fpv");
  const root = document.getElementById(O.OSD_ID);
  const strip = root.querySelector(".dosd-tape-strip");
  const hz = root.querySelector('[data-reticle="horizon"]');
  const line = root.querySelector(".dosd-horizon-line");
  assert.equal(osd.frame({ headingRad: 0, rollRad: 0, pitchRad: 0 }), true);
  assert.equal(strip.style.transform, "translateX(-540px)", "north centred (strip starts at −180°)");
  osd.frame({ headingRad: Math.PI / 2, rollRad: 10 * RAD, pitchRad: -10 * RAD });
  assert.equal(strip.style.transform, "translateX(-900px)", "east: 180 − 720 + headingTapeOffsetPx");
  assert.equal(hz.style.transform, "rotate(-10deg)", "bank right turns the horizon counter-clockwise");
  assert.equal(line.style.transform, "translateY(-40px)", "nose down lifts the horizon");
  osd.frame({ headingRad: Math.PI / 2 + 2 * Math.PI, rollRad: -0.25 * RAD, pitchRad: 100 * RAD });
  assert.equal(strip.style.transform, "translateX(-900px)", "wrapped heading");
  assert.equal(hz.style.transform, "rotate(0.5deg)", "0.5° quantum");
  assert.equal(line.style.transform, "translateY(360px)", "pitch clamped to ±90°");
  const ns = countWrites(strip.style, "transform");
  const nh = countWrites(hz.style, "transform");
  const nl = countWrites(line.style, "transform");
  for (let i = 0; i < 5; i++) osd.frame({ headingRad: Math.PI / 2, rollRad: -0.25 * RAD, pitchRad: 100 * RAD });
  assert.equal(ns(), 0, "same heading: no write");
  assert.equal(nh(), 0);
  assert.equal(nl(), 0);
  osd.frame({ headingRad: Math.PI / 2 + 0.0001, rollRad: -0.25 * RAD, pitchRad: 100 * RAD });
  assert.equal(ns(), 0, "sub-pixel change: no write");
  osd.frame({ headingRad: Math.PI / 2 + 1 * RAD, rollRad: NaN, pitchRad: undefined });
  assert.equal(ns(), 1);
  assert.equal(strip.style.transform, "translateX(-904px)");
  assert.equal(hz.style.transform, "rotate(0deg)", "non-finite roll → level");
  assert.equal(line.style.transform, "translateY(0px)");
  assert.equal(osd.frame(null), true, "no pose: nothing moves, no throw");
  osd.dispose();
});

check("cheatSheet(true, {durationSec}) fades after durationSec of frame-driven clock time, then hides (no timers)", () => {
  const { win, document } = freshDom();
  let now = 100;
  const osd = O.createOsd({ document, window: win, clock: () => now });
  assert.equal(osd.cheatSheet(true, { durationSec: 2 }), true);
  const root = document.getElementById(O.OSD_ID);
  assert.ok(root, "the cheat sheet builds the OSD");
  const cheat = root.querySelector(".dosd-cheat");
  assert.equal(cheat.hidden, false);
  assert.equal(cheat.getAttribute("data-fade"), "0");
  assert.ok(cheat.textContent.includes("Tab pilot view"));
  osd.show("fpv");
  now = 101;
  osd.frame({ headingRad: 0, rollRad: 0, pitchRad: 0 });
  assert.equal(cheat.getAttribute("data-fade"), "0");
  now = 102.01;
  osd.frame({ headingRad: 0, rollRad: 0, pitchRad: 0 });
  assert.equal(cheat.getAttribute("data-fade"), "1", "fading");
  assert.equal(cheat.hidden, false);
  now = 102.7;
  osd.frame({ headingRad: 0, rollRad: 0, pitchRad: 0 });
  assert.equal(cheat.hidden, true, "gone after the fade");
  // the default is 5 s; cheatSheet(false) hides at once
  now = 200;
  osd.cheatSheet(true);
  now = 204.9;
  osd.frame({ headingRad: 0, rollRad: 0, pitchRad: 0 });
  assert.equal(cheat.getAttribute("data-fade"), "0");
  now = 205.05;
  osd.frame({ headingRad: 0, rollRad: 0, pitchRad: 0 });
  assert.equal(cheat.getAttribute("data-fade"), "1");
  assert.equal(osd.cheatSheet(false), false);
  assert.equal(cheat.hidden, true);
  osd.dispose();
});

check("clean(true): #hb-drone-clean-css = FILM_CLEAN_CSS + ' ' + keep rule and html.film-clean; clean(false) removes both (keeps the class while film's style exists)", () => {
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  const html = document.documentElement;
  assert.equal(osd.clean(true), true);
  const st = document.getElementById(O.DRONE_CLEAN_STYLE_ID);
  assert.ok(st && st.tagName === "STYLE");
  assert.equal(st.textContent, `${CF.FILM_CLEAN_CSS} ${O.DRONE_CLEAN_KEEP_CSS}`);
  assert.ok(html.classList.contains(CF.FILM_CLEAN_CLASS));
  assert.equal(document.getElementById(O.OSD_ID), null, "clean() needs no OSD DOM");
  assert.equal(osd.clean(true), true, "idempotent");
  assert.equal(document.head.querySelectorAll(`#${O.DRONE_CLEAN_STYLE_ID}`).length, 1);
  assert.equal(osd.clean(false), false);
  assert.equal(document.getElementById(O.DRONE_CLEAN_STYLE_ID), null);
  assert.equal(html.classList.contains(CF.FILM_CLEAN_CLASS), false);
  // film's own clean frame is up: our off must not strip its class
  const film = document.createElement("style");
  film.id = CF.FILM_CLEAN_STYLE_ID;
  document.head.appendChild(film);
  html.classList.add(CF.FILM_CLEAN_CLASS);
  osd.clean(true);
  osd.clean(false);
  assert.equal(document.getElementById(O.DRONE_CLEAN_STYLE_ID), null, "our style removed");
  assert.equal(html.classList.contains(CF.FILM_CLEAN_CLASS), true, "film's class kept");
  assert.ok(document.getElementById(CF.FILM_CLEAN_STYLE_ID), "film's style untouched");
  osd.dispose();
  assert.equal(html.classList.contains(CF.FILM_CLEAN_CLASS), true, "dispose leaves film's class too");
});

check("dispose(): clean(false), removes the root and both styles; idempotent; every method is inert afterwards", () => {
  const { win, document } = freshDom();
  const osd = O.createOsd({ document, window: win });
  osd.show("fpv");
  osd.update(VIEW());
  osd.clean(true);
  osd.dispose();
  assert.equal(document.getElementById(O.OSD_ID), null);
  assert.equal(document.getElementById(O.OSD_STYLE_ID), null);
  assert.equal(document.getElementById(O.DRONE_CLEAN_STYLE_ID), null);
  assert.equal(document.documentElement.classList.contains(CF.FILM_CLEAN_CLASS), false);
  assert.doesNotThrow(() => osd.dispose());
  assert.equal(osd.show("fpv"), false);
  assert.equal(document.getElementById(O.OSD_ID), null, "no rebuild after dispose");
  assert.equal(osd.update(VIEW()), false);
  assert.equal(osd.frame({ headingRad: 0 }), false);
  assert.equal(osd.staticLevel(0.5), false);
  assert.equal(osd.cheatSheet(true), false);
  assert.equal(osd.clean(true), false);
  assert.equal(document.getElementById(O.DRONE_CLEAN_STYLE_ID), null);
  assert.equal(osd.built, false);
});

check("no document → every method returns false without throwing (and nothing is created anywhere)", () => {
  const { document } = freshDom(); // a global document exists; the OSD must still not use it
  for (const deps of [undefined, {}, { document: null }, { document: undefined, window: {} }]) {
    const osd = O.createOsd(deps);
    assert.equal(osd.show("fpv"), false);
    assert.equal(osd.show("off"), false);
    assert.equal(osd.update(VIEW()), false);
    assert.equal(osd.frame({ headingRad: 1, rollRad: 0, pitchRad: 0 }), false);
    assert.equal(osd.staticLevel(0.2), false);
    assert.equal(osd.cheatSheet(true), false);
    assert.equal(osd.clean(true), false);
    assert.equal(osd.clean(false), false);
    assert.doesNotThrow(() => osd.dispose());
  }
  assert.equal(document.getElementById(O.OSD_ID), null);
  assert.equal(document.getElementById(O.DRONE_CLEAN_STYLE_ID), null);
});

// ---------------------------------------------------------------------------

for (const p of pending) await p();
console.log(`\ndrone_osd: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
process.exit(0);
