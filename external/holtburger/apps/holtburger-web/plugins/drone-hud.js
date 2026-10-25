// Drone Deploy HUD — the toolbar launcher of scene3d/drone/ (2026-10-24).
//
// A 30×30 button directly under RynthSuite's ⚒ in the toolbar's add-on column
// (plugins/hotbar.js `.hb-hotbar-addons`; CSS `order: 10` stacks it below ⚒
// whatever the mount order; a fixed float at right 12 / bottom 84 px when there
// is no toolbar). It is the drone's whole page-side surface:
//   click        the action for the drone's state — deploy (idle), skip
//                (deploying), fly home (flying / pilot view), recall now
//                (returning): `__drone.button({shift})`;
//   Shift+click  recall at once; Shift+F11 = the button (manifest hotkey →
//                app/plugin_bar.js PLUGIN_HOTKEY_DISPATCH → __toggleDroneHud);
//   right-click  the settings popover (HUD kit look);
//   dot          grey idle · amber busy · green flying · red refused;
//   tooltip      what a click does now, or why a deploy is refused.
// It also owns what scene3d/drone/index.js gets from the page side, one deps
// object per page (SPEC §6.7 / §6.9): the deploy-refusal reader
// (`deps.refusal`), the late-bound plugin-bus edges damage / death / portal
// (`deps.onSignal`) and the real `/read` emote (`deps.broadcastPose`).
//
// Lazy by construction (I-27): nothing under scene3d/ and no three is imported
// statically. scene3d/drone/index.js loads on first use (a click, Shift+F11,
// the settings popover, `__droneHud.load()`), location.href-relative like
// rynth-hud's VTank layer; the one idle prewarm (the drone props' materials)
// runs once per page, in idle time after the scene is ready.
//
// FLAG: DEFAULT ON since 2026-10-25 (DRONE_DEFAULT_ON = true, flipped after the
// owner's 1070 eye test, docs/drone-deploy-2026-10-24/live/EYETEST.md); the exact
// `?drone=off` disables it, and then nothing mounts and nothing under
// scene3d/drone/ loads. Contract: scene3d/drone/SPEC.md §3.11, §6.6–§6.9, §7.5.

import { makeTitlebar } from "../ui/hud_kit.js";
import { listManifestBindings } from "../ui/keymap.js";
import { releaseMouseFocus } from "../ui/hud_focus.js";
import { hudRect, hudViewport } from "../ui/hud_scale.js";
import { isStandingStill, heldMovementKey } from "../ui/escape_action.js";

/** Default of the `?drone` flag: on since the 1070 eye test (2026-10-25); only the exact `?drone=off` disables. */
export const DRONE_DEFAULT_ON = true;

const PLUGIN_ID = "drone-hud";
const HOTKEY_FALLBACK = "Shift+F11";
const STYLE_ID = "hb-drone-hud-style";
const LAUNCHER_ID = "hb-drone-hud-launcher";
const FLOAT_ID = "hb-drone-hud-launcher-float";
const SETTINGS_ID = "hb-drone-hud-settings";
const SP = "./data/ui-sprites";
// Page-relative module paths (lazy — never statically imported, I-27).
const DRONE_INDEX_PATH = "scene3d/drone/index.js";
const DRONE_PROPS_PATH = "scene3d/drone/props.js";
const LAUNCHER_MS = 500;
const FLASH_MS = 2500; // a refused click keeps the dot red this long
const PREWARM_IDLE_TIMEOUT_MS = 5000;
const PREWARM_FALLBACK_MS = 2000; // no requestIdleCallback
const DEFAULT_TIP = "Deploy the camera drone (right-click: settings)";
const NO_HANDS_TIP = "No hands: the drone launches beside you";

/**
 * `?drone` reader (SPEC §2.5, DV-27): while `defaultOn` is false only the exact
 * string `on` enables (`ON`, `1`, `true` stay off); once it is true only the
 * exact string `off` disables. Never throws.
 * @param {string|null|undefined} search a `location.search` string
 * @param {boolean} [defaultOn] defaults to DRONE_DEFAULT_ON
 * @returns {boolean}
 */
export function droneHudEnabled(search, defaultOn = DRONE_DEFAULT_ON) {
  try {
    const v = new URLSearchParams(search ?? "").get("drone"); return defaultOn ? !(v === "off") : v === "on";
  } catch {
    return !!defaultOn;
  }
}

/**
 * Deploy-refusal reasons by code (SPEC §2.8; index.js DRONE_REFUSAL_REASONS is the same table).
 * `covered` (no open sky over the launch spot, phase 4 F1) is index.js's own check at deploy:
 * refusalFor never returns it; it arrives as a click's api refusal (the red flash).
 */
export const REFUSAL_TEXT = Object.freeze({
  "not-in-world": "Enter the world first",
  portal: "Not while in portal space",
  dead: "Not while dead",
  "film-busy": "A film take owns the camera",
  busy: "The drone is busy",
  targeting: "Finish targeting first",
  indoors: "Outdoors only",
  combat: "Leave combat mode first",
  moving: "Stand still to deploy",
  covered: "Needs open sky above you",
});

// Refusals that turn the dot red (and the launcher aria-disabled) on their
// own; `moving`, `busy` and `targeting` only flash it when a click is refused
// (DV-16, SPEC §14 R4-10), and so does `covered` (only index.js can see it,
// at deploy).
const PERSISTENT_REFUSALS = new Set(["not-in-world", "indoors", "combat", "portal", "dead", "film-busy"]);
const KNOWN_STATES = new Set(["idle", "deploying", "flying", "pilotView", "returning", "landing", "stowing", "aborting", "crashed"]);
const BUSY_STATES = new Set(["deploying", "returning", "landing", "stowing", "aborting", "crashed"]);
const FLYING_STATES = new Set(["flying", "pilotView"]);
const STATE_TIP = Object.freeze({
  deploying: "Deploying — click to skip",
  flying: "Flying — click to fly home (Shift: now)",
  pilotView: "Flying — click to fly home (Shift: now)",
  returning: "Flying home — click to recall now",
  landing: "Landing…",
  stowing: "Stowing…",
  aborting: "Aborting…",
  crashed: "Crashed…",
});

// Settings popover rows (keys = scene3d/drone/index.js DRONE_SETTINGS_DEFAULTS;
// the API validates every write, these ranges only bound the sliders).
const SETTINGS_ROWS = Object.freeze([
  { key: "mode", label: "Flight mode", kind: "select", options: [["cine", "Cine"], ["angle", "Angle"], ["acro", "Acro"]] },
  { key: "quickDeploy", label: "Quick deploy", kind: "check" },
  { key: "invertY", label: "Invert mouse Y", kind: "check" },
  { key: "crash", label: "Crashes", kind: "check" },
  { key: "broadcastPose", label: "Show /read to others", kind: "check" },
  { key: "volume", label: "Motor volume", kind: "range", min: 0, max: 1, step: 0.05, fmt: (v) => `${Math.round(v * 100)}%` },
  { key: "sensitivity", label: "Mouse sensitivity", kind: "range", min: 0.25, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
  { key: "rangeM", label: "Range", kind: "range", min: 50, max: 180, step: 5, fmt: (v) => `${Math.round(v)} m` },
  { key: "batteryMin", label: "Battery", kind: "select", number: true,
    options: [[0, "Off"], [5, "5 min"], [10, "10 min"], [15, "15 min"], [20, "20 min"]], custom: (v) => `${v} min` },
]);

// 24×24 quadcopter outline, used as a CSS mask (no innerHTML, no createElementNS).
const QUAD_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="1.6" stroke-linecap="round">' +
  '<circle cx="5.5" cy="5.5" r="3.5"/><circle cx="18.5" cy="5.5" r="3.5"/>' +
  '<circle cx="5.5" cy="18.5" r="3.5"/><circle cx="18.5" cy="18.5" r="3.5"/>' +
  '<path d="M8 8l2.5 2.5M16 8l-2.5 2.5M8 16l2.5-2.5M16 16l-2.5-2.5"/>' +
  '<rect x="10" y="10" width="4" height="4" rx="1" fill="#000"/></svg>';
const QUAD_MASK = `url("data:image/svg+xml,${encodeURIComponent(QUAD_SVG)}")`;

// ── module state (one launcher per page) ────────────────────────────────
const S = {
  launcher: null,
  launcherTimer: 0,
  unFocusLauncher: null,
  onHotbarMounted: null,
  onDroneState: null,
  onBootState: null,
  loadImpl: null, // ctx.loadDrone test seam, else the computed-URL import
  prewarmImpl: null, // ctx.prewarm test seam, else props.prewarm
  api: null, // the resolved DroneApi
  loadPromise: null, // memo; cleared on failure so the next click retries
  prewarmPromise: null, // the ONE idle prewarm of this page
  prewarmTimer: null, // {idle, id} while scheduled
  flash: null, // {code, reason, at} of the last refused click
  health: null, // {current, max} from vitalChangedHealth (readDeploySignals' cache)
  sinks: new Set(), // index.js listeners registered through deps.onSignal
  bus: null, // {events, handlers} once subscribed
  busGen: 0, // bumped by dispose: a late __pluginClientReady never subscribes
  settings: null, // the popover refs once built
  onSettingsKey: null,
  onOutsideDown: null,
  warned: new Set(),
};

/**
 * The deps object handed to every installDrone call (SPEC §6.7; installDrone is
 * idempotent and keeps the first one).
 */
const droneDeps = Object.freeze({
  refusal: () => refusalFor(readDeploySignals(window, S)),
  onSignal: (fn) => { if (typeof fn !== "function") return () => {}; S.sinks.add(fn); return () => { S.sinks.delete(fn); }; },
  broadcastPose: () => broadcastReadEmote(window),
});
function emitSignal(name, detail) { for (const fn of [...S.sinks]) { try { fn(name, detail); } catch {} } }

// ── deploy refusals (SPEC §6.7 — the plugin is the single implementation) ──
/**
 * The deploy refusal code for a readDeploySignals() result, first match in
 * priority order, or null when a deploy may start.
 * @param {object|null|undefined} s
 * @returns {string|null} a REFUSAL_TEXT key
 */
export function refusalFor(s) {
  if (!s || s.inWorld !== true) return "not-in-world";
  if (s.portal) return "portal"; if (s.dead) return "dead"; if (s.filmBusy) return "film-busy"; if (s.busy) return "busy";
  if (s.targeting) return "targeting";
  if (s.indoors) return "indoors"; if (s.combat) return "combat"; if (s.moving) return "moving";
  return null;
}

function jumpPending(w) { return w.__jumpKeydownTs != null || w.__jumpChargeActive === true; }

/**
 * Read the deploy-refusal signals off the page. Never throws (every read is
 * guarded); `{inWorld: false}` until the player is in the world.
 * @param {object} [win] the page window
 * @param {{health?: {current: number, max: number}|null}} [cache] the plugin
 *   state; its `health` (from the bus) wins over the polled vitals
 * @param {string} [droneState] the drone state the caller has just read
 *   (`busy` = it is not `idle`); omitted → read from `__drone.status()`. Never
 *   a cached value: a state even 500 ms old would refuse an idle click as busy.
 * @returns {{inWorld: boolean, portal?: boolean, dead?: boolean, filmBusy?: boolean,
 *   busy?: boolean, targeting?: boolean, indoors?: boolean, combat?: boolean, moving?: boolean}}
 */
export function readDeploySignals(win = globalThis.window, cache = S, droneState) {   // never throws
  const w = win || {};
  const read = (fn, dflt) => { try { const v = fn(); return v === undefined || v === null ? dflt : v; } catch { return dflt; } };
  const h = read(() => w.__sessionHandle, null);
  const bs = read(() => w.__bootState, "");
  // 'in-world' and 'ready' share one scalar and arrive in EITHER order (index.html setBootState).
  const inWorld = (bs === "in-world" || bs === "ready") && !!h && !!read(() => w.liveScene3d, null)
    && read(() => (w.getLocalPlayerGuid?.() ?? 0) >>> 0, 0) !== 0 && read(() => w.__hbLoggingOff, false) !== true;
  if (!inWorld) return { inWorld: false };
  const portal = read(() => w.__isPortalSpaceActive?.() === true, false);
  let hp = cache && cache.health ? cache.health : null;
  if (!hp) { const v = read(() => w.__pluginClient?.host?.TryGetPlayerStats?.()?.vitals?.[1], null); if (v) hp = { current: v.current >>> 0, max: v.max >>> 0 }; }
  const dead = !!hp && hp.max > 0 && hp.current === 0;
  const fs = read(() => w.__film?.status?.(), null);
  const filmBusy = !!fs && (fs.active === true || fs.cameraOwned === true || fs.clean === true
    || fs.take?.running != null);                                  // take.running: null | {mode, locked, record, frames, progress}
  const busy = (typeof droneState === "string" ? droneState : read(() => w.__drone?.status?.()?.state, "idle")) !== "idle";
  const targeting = read(() => w.__useTargeting?.pending != null, false); // pending: null | {itemGuid, itemName} (app/hud_panels.js)
  const cell = read(() => h.getCurrentCellId?.() >>> 0, 0);
  const indoors = read(() => h.isCurrentCellIndoor?.() === true, false) || (cell & 0xffff) >= 0x100;
  const low = read(() => (w.__getCurrentStanceLow?.() ?? 0x3d) & 0xffff, 0x3d);
  const combat = low !== 0 && low !== 0x3d;                      // NonCombat 0x8000003D; magic 0x49 counts as combat
  let onGround = true;
  try { const pose = h.getLocalPlayerPose?.(); if (pose) { if (pose.isOnGround === false) onGround = false; try { pose.free?.(); } catch {} } } catch {}
  const moving = !isStandingStill({ onGround, movementKeyHeld: read(() => heldMovementKey(w.__inputFunnel), false),
    autoRun: read(() => w.__autoRunOn === true, false), autonomousMotion: read(() => h.localAutonomousMotion?.() >>> 0, 0) })
    || read(() => jumpPending(w, h), false);                       // __jumpKeydownTs != null || __jumpChargeActive === true
  return { inWorld, portal, dead, filmBusy, busy, targeting, indoors, combat, moving };
}

// ── the /read broadcast (SPEC §6.9; index.js runs it only with settings.broadcastPose) ──
/**
 * Send the real `/read` emote through the chat router — the same path as
 * typing it (0x01E1 SoulEmote + one MoveToState go out). Never throws.
 * @param {object} [win] the page window
 * @returns {{ok: boolean, echo?: string|null, error?: string}}
 */
export function broadcastReadEmote(win = globalThis.window) {
  const handle = win?.__sessionHandle ?? null;
  const route = win?.__routeSlashCommand;
  if (!handle || typeof route !== "function") return { ok: false, error: "Enter the world first." };
  if (typeof handle.resolveSoulEmote !== "function") return { ok: false, error: "Emotes need a newer client build." };
  let probe = null; try { probe = handle.resolveSoulEmote("read"); } catch { probe = null; }
  const known = !!probe; try { probe?.free?.(); } catch {}
  if (!known) return { ok: false, error: "/read is not available yet." };   // an UNKNOWN token would go out as "@read"
  let r = null; try { r = route(handle, "/read"); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
  if (r?.error) return { ok: false, error: r.error };
  if (!r?.dispatched) return { ok: false, error: "/read is not available." };
  if (r.echo) { try { win.__appendChatLine?.(r.echo, 4); } catch {} }      // CHAT_CATEGORY.EMOTE; the chat form prints it
  return { ok: true, echo: r.echo ?? null };
}

// ── small helpers ───────────────────────────────────────────────────────
function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = String(text);
  return e;
}
function setText(e, v) {
  const s = v == null ? "" : String(v);
  if (e && e.textContent !== s) e.textContent = s;
}
function warnOnce(message) {
  if (S.warned.has(message)) return;
  S.warned.add(message);
  try { console.warn(`[drone] ${message}`); } catch { /* no console */ }
}
function hotkeyLabel() {
  let list = null;
  try { list = listManifestBindings(); } catch { list = null; }
  if (!Array.isArray(list) || list.length === 0) return HOTKEY_FALLBACK;
  const hit = list.find((b) => b && b.pluginId === PLUGIN_ID && b.hotkeyId === "toggle");
  return hit ? String(hit.keyString || "") : "";
}

// ── styles ──────────────────────────────────────────────────────────────
function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const st = document.createElement("style");
  st.id = STYLE_ID;
  st.textContent = `
  /* Toolbar launcher (inside #hb-hotbar .hb-hotbar-addons, below RynthSuite's ⚒). */
  .dhud-launcher { position: relative; width: 30px; height: 30px; padding: 0; order: 10;
    border: 1px solid var(--hbk-gold-dim, #8a7544); background: url("${SP}/0x06004CC2.png") repeat, #0b0c10;
    color: var(--hbk-gold, #d9b45a); cursor: pointer; box-shadow: 0 0 0 1px #000, 0 4px 10px rgba(0, 0, 0, 0.6); }
  .dhud-launcher:hover, .dhud-launcher:focus-visible { color: var(--hbk-gold-bright, #f3d27a); border-color: var(--hbk-gold, #d9b45a); outline: none; }
  .dhud-launcher.is-active { box-shadow: 0 0 0 1px #000, 0 0 7px rgba(243, 210, 122, 0.65); }
  .dhud-launcher[aria-disabled="true"] { cursor: default; }
  .dhud-launcher[aria-disabled="true"] .dhud-launcher-icon { opacity: 0.45; }
  .dhud-launcher-icon { position: absolute; left: 4px; top: 4px; width: 20px; height: 20px; pointer-events: none;
    background: currentColor; -webkit-mask: ${QUAD_MASK} center / 20px 20px no-repeat; mask: ${QUAD_MASK} center / 20px 20px no-repeat; }
  .dhud-launcher-dot { position: absolute; right: 2px; bottom: 2px; width: 7px; height: 7px; border-radius: 50%; background: #555; box-shadow: 0 0 0 1px #000; pointer-events: none; }
  .dhud-launcher[data-state="busy"] .dhud-launcher-dot { background: #e0b040; }
  .dhud-launcher[data-state="flying"] .dhud-launcher-dot { background: #6fe36f; box-shadow: 0 0 0 1px #000, 0 0 5px #6fe36f; }
  .dhud-launcher[data-state="refused"] .dhud-launcher-dot { background: #c85040; }
  #${FLOAT_ID} { position: fixed; right: 12px; bottom: 84px; z-index: 55; }

  /* Settings popover (right-click). */
  #${SETTINGS_ID} { width: 240px; z-index: 61; }
  #${SETTINGS_ID}[data-open="0"] { display: none; }
  #${SETTINGS_ID} .dhud-body { padding: 6px 10px 8px; display: grid; grid-template-columns: 1fr auto; gap: 5px 8px; align-items: center; }
  #${SETTINGS_ID} .dhud-row-label { color: var(--hbk-text-dim, #a8a090); font-size: 12px; white-space: nowrap; }
  #${SETTINGS_ID} select.hbk-select { min-width: 84px; font-size: 11px; min-height: 18px; padding: 1px 18px 1px 4px; }
  #${SETTINGS_ID} .dhud-range { display: flex; align-items: center; gap: 5px; }
  #${SETTINGS_ID} .dhud-range input.hbk-range { width: 78px; }
  #${SETTINGS_ID} .dhud-val { min-width: 38px; text-align: right; font-size: 11px; color: var(--hbk-value, #8aef6d); }
  #${SETTINGS_ID} .dhud-msg { grid-column: 1 / -1; min-height: 14px; font-size: 11px; color: var(--hbk-gold-bright, #f3d27a); }
  #${SETTINGS_ID} .dhud-msg[data-kind="error"] { color: var(--hbk-warn, #ff6a50); }
  `;
  document.head.appendChild(st);
}

// ── drone module (lazy) ─────────────────────────────────────────────────
// The page-relative URLs are computed at call time (index.html and
// index-bundled.html both resolve them next to the page; a bundler leaves a
// computed URL alone, so scene3d/drone/ is never bundled into the plugin).
async function defaultLoadDrone(deps) {
  const m = await import(new URL(DRONE_INDEX_PATH, location.href).href);
  if (!m || typeof m.installDrone !== "function") throw new Error(`${DRONE_INDEX_PATH} exports no installDrone`);
  return m.installDrone(deps);
}

/** Load scene3d/drone/index.js and install `window.__drone` (memoised; a failure clears the memo). */
function loadDrone() {
  if (S.loadPromise) return S.loadPromise;
  const impl = typeof S.loadImpl === "function" ? S.loadImpl : defaultLoadDrone;
  let p;
  try { p = Promise.resolve(impl(droneDeps)); } catch (e) { p = Promise.reject(e); }
  const memo = p.then((api) => {
    if (!api || typeof api.button !== "function") throw new Error("installDrone resolved without a DroneApi");
    if (S.loadPromise === memo) S.api = api;
    return api;
  });
  S.loadPromise = memo;
  memo.catch((e) => {
    if (S.loadPromise === memo) { S.loadPromise = null; S.api = null; }
    warnOnce(`the drone module failed to load: ${e?.message ?? e}`);
  });
  return memo;
}

/** The loaded DroneApi (ours, else one already on the page), or null. */
function currentApi() {
  const api = S.api;
  if (api) return api;
  try {
    const w = window.__drone;
    if (w && typeof w.button === "function" && typeof w.status === "function") return w;
  } catch { /* no window */ }
  return null;
}

/** `api.status()` of the loaded drone, or null. A disposed api drops the memo (the next use reloads). */
function droneStatus() {
  const api = currentApi();
  if (!api || typeof api.status !== "function") return null;
  let st = null;
  try { st = api.status(); } catch { st = null; }
  if (st && st.ok === false && st.code === "disposed") {
    if (S.api === api) { S.api = null; S.loadPromise = null; }
    return null;
  }
  return st && typeof st === "object" ? st : null;
}
function stateOf(st) {
  return st && typeof st.state === "string" && KNOWN_STATES.has(st.state) ? st.state : "idle";
}
/** The first deploy refusal now; `state` = the drone state the caller has just read (one status() per read). */
function currentRefusal(state) {
  try { return refusalFor(readDeploySignals(window, S, state)); } catch { return "not-in-world"; }
}
/**
 * The refusal that turns the dot red (a PERSISTENT_REFUSALS code), or null.
 * refusalFor ranks `busy` and `targeting` (a pending use-target) above
 * `indoors` and `combat`, so the persistent codes are read past `busy` /
 * `targeting` / `moving` (§3.11 dot rule). `state` as in currentRefusal.
 */
function persistentRefusal(state) {
  let s;
  try { s = readDeploySignals(window, S, state); } catch { return "not-in-world"; }
  const code = refusalFor(s);
  if (code === null || PERSISTENT_REFUSALS.has(code)) return code;
  return refusalFor({ ...s, busy: false, targeting: false, moving: false });
}
function flashActive() {
  return !!S.flash && Date.now() - S.flash.at < FLASH_MS;
}
function noteRefused(code, reason) {
  S.flash = { code: String(code), reason: typeof reason === "string" ? reason : null, at: Date.now() };
  launcherTick();
}

function pressButton(api, shift) {
  let r = null;
  try { r = api.button({ shift: shift === true }); } catch (e) { r = { ok: false, code: "internal", reason: String(e?.message ?? e) }; }
  if (r && r.ok === false && typeof r.code === "string") noteRefused(r.code, r.reason);
  else launcherTick();
  return r && typeof r === "object" ? r : { ok: false, code: "internal", reason: "no result" };
}

/**
 * The launcher / Shift+F11 action. Idle (or not loaded yet): the refusal check
 * first (red flash, no load), then load + `button`. Any other state: `button`.
 * Synchronous inside the click once the module is loaded (the deploy resumes
 * the audio context inside the user gesture).
 */
function activate({ shift = false } = {}) {
  const state = stateOf(droneStatus());
  if (state === "idle") {
    const code = currentRefusal(state);
    if (code) {
      noteRefused(code);
      return Promise.resolve({ ok: false, code, reason: REFUSAL_TEXT[code] });
    }
  }
  const api = currentApi();
  if (api) return Promise.resolve(pressButton(api, shift));
  return loadDrone().then(
    (a) => pressButton(a, shift),
    (e) => {
      noteRefused("busy");
      return { ok: false, code: "not-available", reason: String(e?.message ?? e) };
    },
  );
}

// ── launcher ────────────────────────────────────────────────────────────
function launcherTip() {
  const st = droneStatus();
  const state = stateOf(st);
  let sub;
  if (state === "idle") {
    const code = currentRefusal(state);
    if (code) sub = REFUSAL_TEXT[code];
    else if (flashActive()) sub = REFUSAL_TEXT[S.flash.code] ?? S.flash.reason ?? REFUSAL_TEXT.busy;
    else sub = DEFAULT_TIP;
  } else {
    sub = STATE_TIP[state] ?? DEFAULT_TIP;
  }
  if (st?.rig?.kind === "no-hands") sub = `${sub} · ${NO_HANDS_TIP}`;
  return { text: "Drone", key: hotkeyLabel(), sub };
}

function buildLauncher() {
  const b = el("button", "dhud-launcher");
  b.type = "button";
  b.id = LAUNCHER_ID;
  b.setAttribute("aria-label", "Drone");
  b.setAttribute("aria-disabled", "false");
  b.dataset.tip = "";
  b.dataset.state = "idle";
  b.appendChild(el("span", "dhud-launcher-icon"));
  b.appendChild(el("span", "dhud-launcher-dot"));
  b._hbTip = () => launcherTip();
  b.addEventListener("click", (e) => { e.stopPropagation(); void activate({ shift: e.shiftKey === true }); });
  // Never `disabled`: a disabled button gets no contextmenu (refused = aria-disabled).
  b.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    try { toggleSettings(); } catch (err) { warnOnce(`the settings popover failed: ${err?.message ?? err}`); }
  });
  return b;
}

function attachLauncher(hint) {
  const b = S.launcher; if (!b) return;
  // hb-hotbar-mounted fires BEFORE hotbar.js assigns window.__hotbar: on a remount __hotbar.addonSlot() is the
  // removed column. Prefer the event's column, then a connected addonSlot(), then the live DOM.
  let slot = hint && hint.isConnected !== false ? hint : null;
  if (!slot) { try { slot = window.__hotbar?.addonSlot?.() ?? null; } catch { slot = null; } if (slot && slot.isConnected === false) slot = null; }
  if (!slot) slot = document.querySelector?.("#hb-hotbar .hb-hotbar-addons") ?? null;
  if (slot) { document.getElementById(FLOAT_ID)?.remove(); if (b.parentNode !== slot) slot.appendChild(b); b.removeAttribute("title"); return; }
  let float = document.getElementById(FLOAT_ID);
  if (!float) { float = document.createElement("div"); float.id = FLOAT_ID; document.body.appendChild(float); }
  if (b.parentNode !== float) float.appendChild(b);
  b.title = `Drone — deploy / recall (${hotkeyLabel() || "Shift+F11"})`;   // no kit tooltip outside #hb-hotbar
}

/** 500 ms and on every hb-drone-state event: re-attach, dot, aria-disabled, .is-active, column flip. */
function launcherTick() {
  const b = S.launcher;
  if (!b) return;
  try {
    if (!b.isConnected) attachLauncher(null);
    const state = stateOf(droneStatus());
    let dot = "idle";
    let refused = false;
    if (BUSY_STATES.has(state)) dot = "busy";
    else if (FLYING_STATES.has(state)) dot = "flying";
    else {
      refused = persistentRefusal(state) !== null;
      if (refused || flashActive()) dot = "refused";
    }
    if (b.dataset.state !== dot) b.dataset.state = dot;
    const aria = refused ? "true" : "false";
    if (b.getAttribute("aria-disabled") !== aria) b.setAttribute("aria-disabled", aria);
    // Active = a cycle is running or the settings popover is open.
    const active = state !== "idle" || settingsOpen();
    if (b.classList.contains("is-active") !== active) b.classList.toggle("is-active", active);
  } catch { /* the next tick retries */ }
  // Flip to the toolbar's left side when its right edge is at the screen edge
  // (exactly rynth-hud's rule — idempotent with its tick, needed under ?rynthHud=off).
  try {
    const slot = b.parentNode;
    const hb = slot?.parentNode;
    if (slot && hb && hb.id === "hb-hotbar" && typeof hb.getBoundingClientRect === "function") {
      const r = hb.getBoundingClientRect();
      const z = Number(hb.currentCSSZoom) > 0 ? Number(hb.currentCSSZoom) : 1;
      const flip = r.right + 36 * z > (window.innerWidth || 0);
      if (slot.classList.contains("flip") !== flip) slot.classList.toggle("flip", flip);
    }
  } catch { /* layout read failed — leave as is */ }
}

// ── settings popover ────────────────────────────────────────────────────
function settingsOpen() {
  return !!S.settings && S.settings.root.dataset.open === "1";
}
function showMsg(text, kind) {
  const m = S.settings?.msg;
  if (!m) return;
  setText(m, text);
  if (kind) m.dataset.kind = kind; else delete m.dataset.kind;
}
function ensureOption(select, value, row) {
  if (value === undefined || value === null) return;
  const v = String(value);
  for (const o of select.children) if (o.value === v) return;
  const o = el("option", null, typeof row.custom === "function" ? row.custom(value) : v);
  o.value = v;
  select.appendChild(o);
}
function renderSettings(settings) {
  const refs = S.settings;
  if (!refs || !settings || typeof settings !== "object") return;
  for (const { row, ctl, val } of refs.controls) {
    const v = settings[row.key];
    if (row.kind === "select") {
      ensureOption(ctl, v, row);
      if (v !== undefined && v !== null) ctl.value = String(v);
    } else if (row.kind === "check") {
      ctl.checked = v === true;
    } else {
      const n = Number(v);
      if (!Number.isFinite(n)) continue;
      ctl.value = String(Math.min(row.max, Math.max(row.min, n)));
      setText(val, row.fmt(n));
    }
  }
}
function refreshSettings() {
  const api = currentApi();
  if (!api || typeof api.settings !== "function") return;
  let r = null;
  try { r = api.settings(); } catch (e) { r = { ok: false, reason: String(e?.message ?? e) }; }
  if (r && r.ok !== false && r.settings) renderSettings(r.settings);
  else showMsg(r?.reason ?? "Settings unavailable", "error");
}
function writeSetting(row, value) {
  const api = currentApi();
  if (!api || typeof api.setSettings !== "function") { showMsg("The drone module is not loaded", "error"); return; }
  let r = null;
  try { r = api.setSettings({ [row.key]: value }); } catch (e) { r = { ok: false, reason: String(e?.message ?? e) }; }
  if (r && r.ok === true && r.settings) {
    renderSettings(r.settings);
    showMsg("");
  } else {
    showMsg(r?.reason ?? "Setting refused", "error");
    refreshSettings();
  }
}
function buildSettings() {
  const root = el("div", "hbk-window dhud-settings");
  root.id = SETTINGS_ID;
  root.dataset.open = "0";
  root.tabIndex = -1;
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Drone settings");
  const { bar } = makeTitlebar("Drone", { onClose: () => closeSettings() });
  root.appendChild(bar);
  const body = el("div", "dhud-body");
  const controls = [];
  const cleanups = [];
  for (const row of SETTINGS_ROWS) {
    const label = el("label", "dhud-row-label", row.label);
    let ctl;
    let val = null;
    let cell;
    if (row.kind === "select") {
      ctl = el("select", "hbk-select");
      for (const [v, t] of row.options) { const o = el("option", null, t); o.value = String(v); ctl.appendChild(o); }
      ctl.addEventListener("change", () => {
        try { ctl.blur?.(); } catch { /* ignore */ } // a parked select would eat the movement keys
        writeSetting(row, row.number ? Number(ctl.value) : ctl.value);
      });
      cell = ctl;
    } else if (row.kind === "check") {
      ctl = el("input", "hbk-check");
      ctl.type = "checkbox";
      ctl.addEventListener("change", () => writeSetting(row, ctl.checked === true));
      cleanups.push(releaseMouseFocus(ctl));
      cell = ctl;
    } else {
      ctl = el("input", "hbk-range");
      ctl.type = "range";
      ctl.min = String(row.min);
      ctl.max = String(row.max);
      ctl.step = String(row.step);
      val = el("span", "dhud-val");
      ctl.addEventListener("input", () => setText(val, row.fmt(Number(ctl.value))));
      ctl.addEventListener("change", () => writeSetting(row, Number(ctl.value)));
      cleanups.push(releaseMouseFocus(ctl));
      cell = el("span", "dhud-range");
      cell.append(ctl, val);
    }
    ctl.id = `${SETTINGS_ID}-${row.key}`;
    ctl.dataset.key = row.key;
    label.setAttribute("for", ctl.id);
    body.append(label, cell);
    controls.push({ row, ctl, val });
  }
  const msg = el("div", "dhud-msg");
  body.appendChild(msg);
  root.appendChild(body);
  document.body.appendChild(root);
  return { root, controls, msg, cleanups };
}
/** Next to the launcher in HUD px (both are zoomed `#hb-*` roots); prefers the side away from the toolbar. */
function placeSettings() {
  const pop = S.settings?.root;
  const b = S.launcher;
  if (!pop || !b) return;
  try {
    const r = hudRect(b);
    const vp = hudViewport();
    pop.style.left = "0px";
    pop.style.top = "0px";
    const p = hudRect(pop);
    const w = p.width > 0 ? p.width : 240;
    const h = p.height > 0 ? p.height : 0;
    const preferLeft = b.parentNode?.classList?.contains?.("flip") === true || b.parentNode?.id === FLOAT_ID;
    const rightX = r.right + 6;
    const leftX = r.left - 6 - w;
    let left = preferLeft ? leftX : rightX;
    if (preferLeft ? left < 4 : left + w > vp.width - 4) left = preferLeft ? rightX : leftX;
    left = Math.max(4, Math.min(left, vp.width - w - 4));
    const top = Math.max(4, Math.min(r.bottom - h, vp.height - h - 4));
    pop.style.left = `${Math.round(left)}px`;
    pop.style.top = `${Math.round(top)}px`;
  } catch { /* layout read failed — keep the last position */ }
}
/**
 * The popover's outside-press closer, registered ONCE at mount (window
 * capture, pointerdown + mousedown) and removed only by the disposer; it
 * returns while the popover is closed. Same-target, same-phase listeners run
 * in registration order, so registered at mount it runs before the drone
 * lock's window-capture blockers (controls.js stopImmediatePropagation()s every
 * canvas press from the deploy click on); registered at open time, a popover
 * opened mid-cycle would never see a canvas press (SPEC §14 R2-4).
 * pointerdown too: a press whose pointerdown was cancelled (picking.js on an
 * entity pick, HUD buttons) gets no compatibility mousedown.
 */
function armOutsideClose() {
  if (S.onOutsideDown) return;
  S.onOutsideDown = (ev) => {
    if (!settingsOpen()) return;
    const t = ev?.target ?? null;
    if (t && (S.settings.root.contains(t) || S.launcher?.contains(t))) return;
    closeSettings();
  };
  window.addEventListener("pointerdown", S.onOutsideDown, true);
  window.addEventListener("mousedown", S.onOutsideDown, true);
}
function disarmOutsideClose() {
  const fn = S.onOutsideDown;
  S.onOutsideDown = null;
  if (!fn) return;
  try { window.removeEventListener("pointerdown", fn, true); } catch { /* ignore */ }
  try { window.removeEventListener("mousedown", fn, true); } catch { /* ignore */ }
}
function openSettings() {
  if (!S.launcher) return false;
  if (!S.settings) S.settings = buildSettings();
  S.settings.root.dataset.open = "1";
  if (!S.onSettingsKey) {
    // Escape closes (preventDefault: consumed for ui/escape_action.js); the
    // outside-press closer is armed at mount (armOutsideClose).
    S.onSettingsKey = (ev) => {
      if (ev?.key !== "Escape" || !settingsOpen()) return;
      ev.preventDefault?.();
      closeSettings();
    };
    window.addEventListener("keydown", S.onSettingsKey);
  }
  if (currentApi()) { showMsg(""); refreshSettings(); } else showMsg("Loading…");
  placeSettings();
  launcherTick();
  loadDrone().then(
    () => { if (!settingsOpen()) return; showMsg(""); refreshSettings(); placeSettings(); },
    () => { noteRefused("busy"); showMsg("The drone module failed to load", "error"); },
  );
  return true;
}
function closeSettings() {
  if (S.onSettingsKey) {
    try { window.removeEventListener("keydown", S.onSettingsKey); } catch { /* ignore */ }
    S.onSettingsKey = null;
  }
  if (!S.settings) return false;
  const was = S.settings.root.dataset.open === "1";
  // A control still focused inside the hidden popover (a select opened and
  // closed without a change) would keep the input funnel deferring every key.
  try {
    const a = document.activeElement;
    if (a && a !== document.body && S.settings.root.contains(a)) a.blur?.();
  } catch { /* ignore */ }
  S.settings.root.dataset.open = "0";
  if (was) launcherTick();
  return was;
}
function toggleSettings() {
  return settingsOpen() ? (closeSettings(), false) : openSettings();
}

// ── plugin bus (SPEC §6.7, A7): bound late — mount() runs with ctx.client null ──
function onVitalHealth(ev) {
  const d = ev?.detail ?? {};
  const cur = Number(d.current);
  const max = Number(d.buffedMax);
  if (!Number.isFinite(cur) || !Number.isFinite(max)) return;
  const prev = S.health;
  S.health = { current: cur >>> 0, max: max >>> 0 };
  const old = d.oldValue == null ? NaN : Number(d.oldValue);
  // A drop that comes with a lower max (a buff ran out) is not damage; with no
  // earlier max on record the max is taken as unchanged.
  if (Number.isFinite(old) && cur < old && (!prev || max >= prev.max)) emitSignal("damage", d);
  if (max > 0 && cur === 0) emitSignal("death", d);
}
function onDeath(ev) {
  const d = ev?.detail ?? {};
  let me = 0;
  try { me = (window.getLocalPlayerGuid?.() ?? 0) >>> 0; } catch { me = 0; }
  if (me !== 0 && (d.victimGuid >>> 0) === me) emitSignal("death", d); // broadcast for every kill: ours only
}
function subscribe(client) {
  const ev = client?.events;
  if (S.bus || !ev || typeof ev.on !== "function") return false;
  const handlers = {
    vitalChangedHealth: onVitalHealth,
    damageTaken: (e) => emitSignal("damage", e?.detail),
    death: onDeath,
    portalSpaceEntered: (e) => emitSignal("portal", e?.detail),
    landblockChanged: (e) => emitSignal("landblock", e?.detail), // unused by v1
  };
  for (const [name, fn] of Object.entries(handlers)) { try { ev.on(name, fn); } catch { /* ignore */ } }
  S.bus = { events: ev, handlers };
  return true;
}
function unsubscribe() {
  const b = S.bus;
  S.bus = null;
  if (!b) return;
  // events.on returns nothing — off() with the kept handler refs.
  for (const [name, fn] of Object.entries(b.handlers)) { try { b.events.off?.(name, fn); } catch { /* ignore */ } }
}
function bindBus(ctx) {
  const gen = S.busGen;
  const client = ctx?.client ?? window.__pluginClient ?? null;
  if (client?.events?.on) subscribe(client);
  else window.__pluginClientReady?.then?.((c) => { if (gen === S.busGen) subscribe(c ?? window.__pluginClient); }, () => {});
}

// ── the ONE idle prewarm per page (SPEC §7.5) ───────────────────────────
function sceneReadyEver() {
  try { return window.__sceneReadyEverFired === true; } catch { return false; }
}
async function defaultPrewarm() {
  const live = window.liveScene3d ?? null;
  if (!live || !live.renderer || !live.scene || !live.camera) return { ok: false, compiled: 0, ms: 0, reason: "no live scene" };
  const [THREE, m] = await Promise.all([import("three"), import(new URL(DRONE_PROPS_PATH, location.href).href)]);
  if (typeof m?.prewarm !== "function") return { ok: false, compiled: 0, ms: 0, reason: `${DRONE_PROPS_PATH} exports no prewarm` };
  return m.prewarm({ THREE, renderer: live.renderer, scene: live.scene, camera: live.camera, offscreen: !live.wireframeMode });
}
function runPrewarm() {
  if (S.prewarmPromise) return S.prewarmPromise;
  disarmBootListener();
  cancelScheduledPrewarm();
  const impl = typeof S.prewarmImpl === "function" ? S.prewarmImpl : defaultPrewarm;
  let p;
  try { p = Promise.resolve(impl()); } catch (e) { p = Promise.reject(e); }
  S.prewarmPromise = p.then(
    (r) => {
      const res = r && typeof r === "object" ? r : { ok: true };
      if (res.ok === false) warnOnce(`idle prewarm skipped: ${res.reason ?? "unknown"}`);
      return res;
    },
    (e) => {
      warnOnce(`idle prewarm failed: ${e?.message ?? e}`);
      return { ok: false, compiled: 0, ms: 0, reason: String(e?.message ?? e) };
    },
  );
  return S.prewarmPromise;
}
function schedulePrewarm() {
  if (S.prewarmPromise || S.prewarmTimer) return;
  const fire = () => { S.prewarmTimer = null; runPrewarm(); };
  const ric = typeof window.requestIdleCallback === "function" ? window.requestIdleCallback : null;
  if (ric) S.prewarmTimer = { idle: true, id: ric.call(window, fire, { timeout: PREWARM_IDLE_TIMEOUT_MS }) };
  else S.prewarmTimer = { idle: false, id: setTimeout(fire, PREWARM_FALLBACK_MS) };
}
function cancelScheduledPrewarm() {
  const t = S.prewarmTimer;
  S.prewarmTimer = null;
  if (!t) return;
  try {
    if (t.idle) window.cancelIdleCallback?.(t.id);
    else clearTimeout(t.id);
  } catch { /* ignore */ }
}
function disarmBootListener() {
  if (!S.onBootState) return;
  try { window.removeEventListener("holtburger:state", S.onBootState); } catch { /* ignore */ }
  S.onBootState = null;
}
function armPrewarm() {
  if (sceneReadyEver()) { schedulePrewarm(); return; }
  // 'ready' and 'in-world' share __bootState and can overwrite each other: the
  // latch (checked above) or the "ready" event, never the scalar.
  S.onBootState = (ev) => {
    if (ev?.detail?.state !== "ready") return;
    disarmBootListener();
    schedulePrewarm();
  };
  window.addEventListener("holtburger:state", S.onBootState);
}

// ── plugin lifecycle ────────────────────────────────────────────────────
/**
 * Mount the launcher (ui/bar.js calls it once at page load with
 * `{client: null, slot, root, bar}`). Test seams: `ctx.loadDrone(deps) →
 * Promise<DroneApi>` replaces the scene3d/drone/index.js import,
 * `ctx.prewarm() → Promise` the idle prewarm's import + `props.prewarm`.
 * Mounts nothing (returns a no-op) without `?drone=on` or when a launcher
 * already exists.
 * @param {{client?: object|null, slot?: object, root?: object, bar?: object,
 *   loadDrone?: (deps: object) => Promise<object>, prewarm?: () => Promise<object>}} [ctx]
 * @returns {() => void} dispose — removes everything mount added
 */
export function mount(ctx) {
  if (!droneHudEnabled(globalThis.location?.search)) return () => {};
  if (S.launcher || document.getElementById(LAUNCHER_ID)) return () => {};
  ensureStyles();
  S.loadImpl = typeof ctx?.loadDrone === "function" ? ctx.loadDrone : null;
  S.prewarmImpl = typeof ctx?.prewarm === "function" ? ctx.prewarm : null;
  S.launcher = buildLauncher();
  attachLauncher(null);
  S.unFocusLauncher = releaseMouseFocus(S.launcher); // after the click handler: the action runs first
  S.onHotbarMounted = (ev) => {
    try { attachLauncher(ev?.detail?.addons ?? null); } catch { /* the tick retries */ }
    launcherTick();
  };
  document.addEventListener("hb-hotbar-mounted", S.onHotbarMounted);
  // index.js dispatches it on `document` (bubbles: false), once per transition;
  // the tick runs after the frame driver's action list (a microtask).
  S.onDroneState = () => {
    if (typeof queueMicrotask === "function") queueMicrotask(launcherTick);
    else Promise.resolve().then(launcherTick);
  };
  document.addEventListener("hb-drone-state", S.onDroneState);
  armOutsideClose(); // before any deploy's lock (see armOutsideClose)
  bindBus(ctx);
  armPrewarm();
  S.launcherTimer = setInterval(launcherTick, LAUNCHER_MS);
  launcherTick();
  window.__toggleDroneHud = () => activate({ shift: false });
  window.__droneHud = Object.freeze({
    /** Install window.__drone without deploying → {ok, version} | {ok:false, code, reason}; never rejects. */
    load: () => loadDrone().then(
      (api) => ({ ok: true, version: typeof api.version === "string" ? api.version : null }),
      (e) => ({ ok: false, code: "not-available", reason: String(e?.message ?? e) }),
    ),
    /** The page's one idle prewarm now (memoised; refused before the scene is ready); never rejects. */
    prewarm: () => (S.prewarmPromise || sceneReadyEver()
      ? runPrewarm()
      : Promise.resolve({ ok: false, compiled: 0, ms: 0, reason: "the scene is not ready" })),
  });
  let disposed = false;
  return () => {
    if (disposed) return; // idempotent: a late second call never touches a newer mount
    disposed = true;
    clearInterval(S.launcherTimer);
    cancelScheduledPrewarm();
    disarmBootListener();
    try { document.removeEventListener("hb-hotbar-mounted", S.onHotbarMounted); } catch { /* ignore */ }
    try { document.removeEventListener("hb-drone-state", S.onDroneState); } catch { /* ignore */ }
    S.busGen += 1;
    unsubscribe();
    closeSettings();
    disarmOutsideClose();
    for (const off of S.settings?.cleanups ?? []) { try { off(); } catch { /* ignore */ } }
    try { S.settings?.root.remove(); } catch { /* ignore */ }
    try { S.unFocusLauncher?.(); } catch { /* ignore */ }
    try { S.launcher?.remove(); } catch { /* ignore */ }
    try { document.getElementById(FLOAT_ID)?.remove(); } catch { /* ignore */ }
    try { document.getElementById(STYLE_ID)?.remove(); } catch { /* ignore */ }
    for (const k of ["__toggleDroneHud", "__droneHud"]) {
      try { delete window[k]; } catch { window[k] = undefined; }
    }
    S.sinks.clear();
    S.warned.clear();
    Object.assign(S, {
      launcher: null, launcherTimer: 0, unFocusLauncher: null, onHotbarMounted: null, onDroneState: null,
      loadImpl: null, prewarmImpl: null, api: null, loadPromise: null, prewarmPromise: null, flash: null,
      health: null, settings: null,
    });
  };
}

/** The plugin module (ui/bar.js calls `mount` once at page load). */
export default { mount };
