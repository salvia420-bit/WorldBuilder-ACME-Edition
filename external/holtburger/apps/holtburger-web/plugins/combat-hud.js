// Combat HUD — retail gmCombatUI (layout 0x21000007, class 0x1000000C) as a
// floaty combat panel (gmFloatyCombatUI 0x21000073, 610×90 frame). Shows in
// the melee and missile combat stances only; in the magic stance the
// spellcasting strip (#hb-spell-strip, plugins/combat-bar.js) takes this spot
// — retail swaps the two panels the same way.
//
// HUD overhaul 2026-10-05 — rebuilt. The previous HUD was an 800-px strip of
// hand-placed absolute labels: a gold "Recklessness … 100%" bar, a duplicated
// "Accuracy — Accuracy" row (two elements of the layout labelled the same)
// and three High/Medium/Low buttons whose bitmap labels were clipped inside
// 19-px sprites. It also sat on a `left:50%; margin-left:-400px` anchor that
// jumped 400 px the moment you dragged it. Now:
//
//   ┌ retail floaty frame (0x06006129 + 0x0600612A-D) ───────────────────┐
//   │ [Speed ═══════════ red wave power bar ═══◆══ Power 75%]  PgDn [High] │
//   │ ☐ Auto Repeat   Recklessness +10                         End [Medium]│
//   │ Ins / PgUp: adjust power                                 Del [Low]   │
//   └─────────────────────────────────────────────────────────────────────┘
//
// Retail layout facts (data/retail-layouts/0x21000007.json):
//   PowerSlider 0x1000004F  track sprite 0x060074CA; thumb 0x06001923 (12×14)
//   PowerMeter  0x10000050  meter sprite 0x06001200 (bright red wave)
//   basic_recklessness_fill 0x100005EF  0x0600715E spanning 10%-90% of the bar
//   Speed 0x10000051  left-end label "Speed" (every stance)
//   Power 0x10000052  right-end label — MeleeCombat "Power", MissileCombat
//                     "Accuracy" (state-dependent string; ONE label per end)
//   AutoRepeatAttack 0x10000053  player-option checkbox
//   AttackButtonGroup 0x10000056  High/Medium/Low 72×19 — Normal 0x06004D1C,
//     pressed 0x06004D1D, Highlight (selected height, yellow arrows) 0x06004D1E,
//     Highlight_pressed 0x06004D1F
//
// Retail behaviour matched (acclient.c):
//   gmCombatUI::ListenToElementMessage — msg 1 (click) on High/Medium/Low →
//     ClientCombatSystem::EndAttackRequest(height, USE_POWER_BAR_LEVEL): attack
//     at the slider's power; msg 10 (slider moved) → m_rUIRequestedPower =
//     dwParam1 × 0.001 clamped 0..1.
//   Hold to charge (2026-10-07, ui/attack_power_bar.js): pressing a height
//     button / key starts the power bar building (StartAttackRequest →
//     AttemptStartBuildingAttack, 1.0 s to full); releasing commits
//     max(selector, bar) — a quick tap waits for the bar to reach the selector
//     and attacks there, holding past it charges the swing (EndAttackRequest
//     :408952, UseTime :409015).
//   gmCombatUI::RecvNotice_AttackHeightChanged — the button group highlights
//     the requested height (attribute 0xB1 = selected child).
//   gmCombatUI::RecvNotice_SetCombatMode — MeleeCombat / MissileCombat states,
//     hidden otherwise; the recklessness fill is shown only when Recklessness
//     (skill 0x32) is Trained or better (InqSkillAdvancementClass ≥ 2).
//   Input actions HighAttack / MediumAttack / LowAttack / DecreasePowerSetting /
//     IncreasePowerSetting (retail input-action name table) — bound to the
//     nav cluster here (PgDn / End / Del, Ins / PgUp), scoped to melee/missile
//     exactly like the magic map's Insert/PgUp/Delete/PgDn/End is scoped to
//     the magic stance (plugins/combat-bar.js installSpellBarHotkeys).
//
// The shared truth is window.__combatBarState (seeded by combat-bar.js from
// localStorage `holtburger_combat_bar_v1`): powerLevel, attackHeight,
// autoRepeat. scene3d/picking.js reads powerLevel for every swing.

import { setAcText } from "../ui/ac_font.js";
import {
  readTrainingLevel,
  SKILL_RECKLESSNESS,
  TRAINING_TRAINED,
  TRAINING_SPECIALIZED,
  RECKLESSNESS_BAND_MIN,
  RECKLESSNESS_BAND_MAX,
} from "../ui/ac_damage_rating.js";
import { attachWindowPosition, WINDOW_ID } from "../ui/ac_window_position.js";
import {
  setAutoRepeatAttacks,
  isCharacterOptionEnabled,
  CHARACTER_OPTION,
} from "../ui/ac_character_options.js";
import { getInputFunnel, inputFunnelV2On } from "../ui/input-funnel.js";
import { getAttackCharge } from "../ui/attack_power_bar.js";

const OVERLAY_ID = "hb-combat-hud";
const STYLE_ID   = "hb-combat-hud-style";
const DEATH_OVERLAY_ID = "hb-combat-hud-death";
const DEATH_STYLE_ID   = "hb-combat-hud-death-style";
const SP = "./data/ui-sprites";
const COMBAT_BAR_STORAGE_KEY = "holtburger_combat_bar_v1";

// MotionStance low words. Peace = 0x3D, Magic = 0x49.
const STANCE_PEACE = 0x3D;
const STANCE_MAGIC = 0x0049;
// Ranged stances (bow / crossbow / thrown / atlatl families) — the right end
// of the bar reads "Accuracy" there. Mirrors combat-bar.js RANGED_STANCES.
const RANGED_STANCES_HUD = new Set([
  0x003f, 0x0041, 0x0043, 0x0047, 0x00e8, 0x00e9, 0x013b, 0x013c,
]);

// ATTACK_HEIGHT (acclient.h): 1 High, 2 Medium, 3 Low — the wasm attack()
// rejects anything else.
const HEIGHTS = Object.freeze([
  Object.freeze({ id: "high",   label: "High",   value: 1, code: "PageDown", key: "PgDn" }),
  Object.freeze({ id: "medium", label: "Medium", value: 2, code: "End",      key: "End" }),
  Object.freeze({ id: "low",    label: "Low",    value: 3, code: "Delete",   key: "Del" }),
]);
const POWER_KEYS = Object.freeze({ Insert: -0.1, PageUp: +0.1 });
// Width of the docked panel (retail gmFloatyCombatUI root is 610×90).
const PANEL_W = 610;
// Gap left between the panel and whatever bottom-centre HUD it docks above.
const DOCK_GAP = 6;
const DOCK_FALLBACK_BOTTOM = 124;

/** Retail floaty frame — corner 0x06006129, edges 0x0600612A-D. */
function floatyFrameCss(sel) {
  const u = (id) => `url("${SP}/${id}.png")`;
  return `
    ${sel} {
      background:
        ${u("0x06006129")} left top / 5px 5px no-repeat,
        ${u("0x06006129")} right top / 5px 5px no-repeat,
        ${u("0x06006129")} left bottom / 5px 5px no-repeat,
        ${u("0x06006129")} right bottom / 5px 5px no-repeat,
        ${u("0x0600612A")} left top / 10px 5px repeat-x,
        ${u("0x0600612C")} left bottom / 10px 5px repeat-x,
        ${u("0x0600612B")} left top / 5px 10px repeat-y,
        ${u("0x0600612D")} right top / 5px 10px repeat-y,
        ${u("0x06004CC2")} left top / 48px 48px repeat,
        #0b0c10;
      image-rendering: pixelated;
    }`;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      left: 0; right: 0;          /* + auto margins = centred, no transform */
      margin-left: auto; margin-right: auto;
      bottom: ${DOCK_FALLBACK_BOTTOM}px;
      width: ${PANEL_W}px;
      max-width: calc(100 * var(--hb-hud-vw, 1vw) - 8px);
      box-sizing: border-box;
      padding: 5px;
      z-index: 48;
      display: none;
      color: var(--hbk-text, #e8dfc8);
      font-family: var(--hbk-font, var(--hb-font-serif));
      font-size: 11px;
      user-select: none;
      box-shadow: 0 4px 14px rgba(0, 0, 0, 0.6);
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    ${floatyFrameCss(`#${OVERLAY_ID}`)}
    #${OVERLAY_ID} .hch-inner {
      display: flex;
      align-items: stretch;
      gap: 10px;
      padding: 3px 4px 3px 5px;
    }
    #${OVERLAY_ID} .hch-main {
      flex: 1 1 auto;
      min-width: 0;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      gap: 5px;
    }
    /* ── Power bar (PowerSlider + PowerMeter + recklessness fill) ── */
    #${OVERLAY_ID} .hch-bar {
      position: relative;
      height: 14px;
      margin-top: 2px;
      background: url("${SP}/0x060074CA.png") left center / 60px 14px repeat-x, #000;
      box-shadow: 0 0 0 1px #000, 0 0 0 2px rgba(138, 117, 68, 0.55);
      cursor: pointer;
      touch-action: none;
      outline: none;
    }
    #${OVERLAY_ID} .hch-bar:focus-visible { box-shadow: 0 0 0 1px #000, 0 0 0 2px var(--hbk-gold-bright, #f3d27a); }
    #${OVERLAY_ID} .hch-band {
      position: absolute; top: 0; bottom: 0;
      left: ${RECKLESSNESS_BAND_MIN * 100}%;
      width: ${(RECKLESSNESS_BAND_MAX - RECKLESSNESS_BAND_MIN) * 100}%;
      background: url("${SP}/0x0600715E.png") left center / 60px 14px repeat-x;
      display: none;
      pointer-events: none;
    }
    #${OVERLAY_ID}[data-reck="1"] .hch-band,
    #${OVERLAY_ID}[data-reck="2"] .hch-band { display: block; }
    #${OVERLAY_ID} .hch-fill {
      position: absolute; top: 0; bottom: 0; left: 0;
      width: 100%;
      background: url("${SP}/0x06001200.png") left center / 60px 14px repeat-x;
      pointer-events: none;
    }
    #${OVERLAY_ID} .hch-fill.is-charging { filter: brightness(0.85) saturate(0.8); }
    #${OVERLAY_ID} .hch-fill.is-building { filter: brightness(1.2) saturate(1.1); }
    #${OVERLAY_ID} .hch-thumb {
      position: absolute; top: 0;
      left: 100%;
      width: 12px; height: 14px;
      margin-left: -6px;
      background: url("${SP}/0x06001923.png") center / 12px 14px no-repeat;
      pointer-events: none;
      filter: drop-shadow(0 0 1px #000);
    }
    #${OVERLAY_ID} .hch-end {
      position: absolute; top: 0;
      height: 14px;
      display: flex; align-items: center;
      color: #fff;
      font-size: 11px;
      line-height: 14px;
      text-shadow: 0 0 2px #000, 1px 1px 0 #000;
      pointer-events: none;
      white-space: nowrap;
    }
    #${OVERLAY_ID} .hch-end-l { left: 14px; }
    #${OVERLAY_ID} .hch-end-r { right: 8px; }
    /* ── Option + hint rows ── */
    #${OVERLAY_ID} .hch-row {
      display: flex; align-items: center; gap: 12px;
      min-height: 16px;
      white-space: nowrap;
      overflow: hidden;
    }
    #${OVERLAY_ID} .hch-row .hbk-label { color: var(--hbk-text, #e8dfc8); font-size: 11px; }
    #${OVERLAY_ID} .hch-reck {
      color: #ff9a7a;
      text-shadow: 0 0 4px rgba(220, 80, 40, 0.5);
      display: none;
    }
    #${OVERLAY_ID} .hch-reck.is-on { display: inline; }
    #${OVERLAY_ID} .hch-hints {
      display: block;
      line-height: 16px;
      color: var(--hbk-text-faint, #77705f);
      font-size: 10px;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    #${OVERLAY_ID} .hch-hints kbd, #${OVERLAY_ID} .hch-key {
      font-family: inherit;
      font-size: 10px;
      color: var(--hbk-text-dim, #a8a090);
    }
    /* ── High / Medium / Low (AttackButtonGroup) ── */
    #${OVERLAY_ID} .hch-heights {
      flex: 0 0 auto;
      display: grid;
      grid-template-columns: auto 72px;
      grid-auto-rows: 19px;
      column-gap: 5px;
      row-gap: 2px;
      align-items: center;
    }
    #${OVERLAY_ID} .hch-key { text-align: right; }
    #${OVERLAY_ID} .hch-height {
      width: 72px; min-width: 72px; height: 19px; min-height: 19px;
      padding: 0 10px;
      font-size: 11px;
    }
    /* Selected (requested) height — retail Highlight state, the sprite with
       the yellow end arrows; hover keeps the kit's pressed look. */
    #${OVERLAY_ID} .hch-height.is-selected { background-image: url("${SP}/0x06004D1E.png"); color: #fff; }
    #${OVERLAY_ID} .hch-height.is-selected:active { background-image: url("${SP}/0x06004D1F.png"); }
    #${OVERLAY_ID} .hch-height:focus-visible { outline: 1px solid var(--hbk-gold-bright, #f3d27a); outline-offset: 1px; }
  `;
  document.head.appendChild(s);
}

// Module state (singleton).
const state = {
  overlayEl: null,
  refs: null,          // DOM refs built by build()
  posCtl: null,        // attachWindowPosition control surface
  visible: false,
  power: 1.0,          // 0..1, drives __combatBarState.powerLevel
  // Last value syncPowerFill() wrote into __combatBarState.powerLevel.
  // `null` = never published, so the FIRST sync always adopts whatever the
  // combat-bar seeded (its persisted localStorage value) instead of
  // stomping it with this module's 1.0 default. See syncPowerFill().
  lastPublishedPower: null,
  reckTraining: null,  // cached Recklessness SAC (0..3) / null
  charging: false,     // a swing's refill animation is running
  building: false,     // the hold-to-charge bar is building (attack_power_bar.js)
  debugPinned: false,  // window.__combatHudDebug() — keep open outside combat
};

function clamp01(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function stanceLow() {
  try {
    const fn = window.__getCurrentStanceLow;
    return typeof fn === "function" ? (fn() | 0) : 0;
  } catch { return 0; }
}

// True when the player is in a melee OR missile combat stance — i.e. in
// combat but NOT in the magic-combat stance (0x49), where the spellcasting
// strip owns this spot.
function stanceIsMeleeOrMissile() {
  const low = stanceLow();
  return low !== 0 && low !== STANCE_PEACE && low !== STANCE_MAGIC;
}

function stanceIsRanged() {
  return RANGED_STANCES_HUD.has(stanceLow());
}

/** Merge one field into combat-bar's persisted record so the panel, the
 *  HUD and the next session agree (combat-bar.js loadState()/saveState()). */
function persistCombatBarField(key, value) {
  try {
    const raw = localStorage.getItem(COMBAT_BAR_STORAGE_KEY);
    const rec = raw ? JSON.parse(raw) : {};
    rec[key] = value;
    localStorage.setItem(COMBAT_BAR_STORAGE_KEY, JSON.stringify(rec));
  } catch (_) { /* private mode / quota — the live state still applies */ }
}

function recklessnessTier() {
  const lvl = state.reckTraining;
  if (lvl === TRAINING_SPECIALIZED) return 2;
  if (lvl === TRAINING_TRAINED) return 1;
  return 0;
}

// Paint the bar and its end labels from state.power + stance. Null-safe on
// every ref (the power-ownership test drives syncPowerFill with no DOM).
function paintPower() {
  const r = state.refs;
  if (!r) return;
  const pct = Math.round(state.power * 100);
  const ranged = stanceIsRanged();
  const rightLabel = ranged ? "Accuracy" : "Power";
  if (!state.charging && !state.building && r.fill) r.fill.style.width = `${pct}%`;
  if (r.thumb) r.thumb.style.left = `${pct}%`;
  if (r.bar) {
    r.bar.setAttribute?.("aria-valuenow", String(pct));
    r.bar.setAttribute?.("aria-valuetext", `${rightLabel} ${pct}%`);
  }
  // ONE right-end label carrying the value ("Power 75%" / "Accuracy 75%") —
  // the old HUD printed the stance word twice ("Accuracy — Accuracy").
  const endText = `${rightLabel} ${pct}%`;
  if (r.endR && r.endR.dataset.label !== endText) {
    r.endR.dataset.label = endText;
    setAcText(r.endR, endText);
  }
  const tier = recklessnessTier();
  if (state.overlayEl?.dataset) state.overlayEl.dataset.reck = String(tier);
  if (r.reck) {
    const inBand = state.power >= RECKLESSNESS_BAND_MIN && state.power <= RECKLESSNESS_BAND_MAX;
    const bonus = tier === 2 ? 20 : 10;
    const on = tier > 0 && inBand;
    r.reck.classList.toggle("is-on", on);
    if (on) {
      r.reck.textContent = `Recklessness +${bonus}`;
      r.reck.title =
        `Recklessness is active between ${Math.round(RECKLESSNESS_BAND_MIN * 100)}% and ` +
        `${Math.round(RECKLESSNESS_BAND_MAX * 100)}%: +${bonus} damage rating on non-critical hits ` +
        `(you also take +${bonus} from non-critical hits).`;
    }
  }
}

/** Adopt-then-publish, half 1 (round-9 finding R9-4): if the shared value
 *  has moved since WE last published it, the other widget (the combat-bar
 *  PANEL slider, or the persisted seed) changed it and wins. */
function adoptSharedPower() {
  const shared = Number(window.__combatBarState?.powerLevel);
  if (Number.isFinite(shared) && shared !== state.lastPublishedPower) {
    state.power = clamp01(shared);
  }
}

/** Half 2: publish our value as the swing power scene3d/picking.js reads. */
function publishPower() {
  if (window.__combatBarState) {
    window.__combatBarState.powerLevel = state.power;
    state.lastPublishedPower = state.power;
  }
}

function syncPowerFill() {
  const ov = state.overlayEl;
  if (!ov) return;
  // TWO widgets drive the same value: this HUD bar and the combat-bar PANEL
  // slider (combat-bar.js `powerSlider` → syncWindowState →
  // window.__combatBarState.powerLevel), which is also the value persisted in
  // localStorage `holtburger_combat_bar_v1`.
  adoptSharedPower();
  paintPower();
  publishPower();
}

/** HUD-driven power change (drag, click, Ins/PgUp, arrows) — the player's
 *  own input always wins: paint, publish, persist. */
function setPowerFromHud(v, { persist = true } = {}) {
  state.power = clamp01(Math.round(clamp01(v) * 100) / 100);
  paintPower();
  publishPower();
  if (persist) persistCombatBarField("powerLevel", state.power);
}

/** Relative step (Ins/PgUp, arrow keys) from the CURRENT shared power, so a
 *  panel-slider change made since our last tick is stepped from, not lost. */
function stepPowerFromHud(delta) {
  adoptSharedPower();
  setPowerFromHud(state.power + delta);
}

function selectedHeight() {
  const v = Number(window.__combatBarState?.attackHeight);
  return v === 1 || v === 2 || v === 3 ? v : 2;
}

function syncHeightHighlight() {
  const els = state.refs?.heightEls;
  if (!els) return;
  const v = selectedHeight();
  for (const h of HEIGHTS) {
    const b = els[h.id];
    if (!b) continue;
    const on = h.value === v;
    b.classList.toggle("is-selected", on);
    b.setAttribute?.("aria-pressed", on ? "true" : "false");
  }
}

/** Retail SetRequestedAttackHeight — the requested height is selected on
 *  PRESS (the button group highlights it at once). */
function requestHeight(value) {
  if (window.__combatBarState) window.__combatBarState.attackHeight = value;
  persistCombatBarField("attackHeight", value);
  syncHeightHighlight();
}

/** Height button / key DOWN — StartAttackRequest: the power bar builds. */
function pressHeight(value) {
  requestHeight(value);
  if (typeof window.__fireAttackOnTarget !== "function") {
    console.warn("[combat-hud] __fireAttackOnTarget not exposed");
    return;
  }
  getAttackCharge().press(value);
}

/** Height button / key UP — EndAttackRequest(height, USE_POWER_BAR_LEVEL). */
function releaseHeight(value) {
  getAttackCharge().release(value);
}

/** A whole tap (keyboard activation of a focused button): attacks at the
 *  selector once the bar reaches it. */
function attackAtHeight(value) {
  pressHeight(value);
  releaseHeight(value);
}

/** Paint the building bar: the fill grows from 0 while the button is held;
 *  the thumb stays on the selector. */
function onChargeChange(s) {
  const fill = state.refs?.fill;
  const wasBuilding = state.building;
  state.building = !!s?.building;
  if (!fill) return;
  if (state.building) {
    fill.classList.add("is-building");
    fill.style.transition = "none";
    fill.style.width = `${(Math.max(0, Math.min(1, Number(s.level) || 0)) * 100).toFixed(1)}%`;
  } else if (wasBuilding) {
    fill.classList.remove("is-building");
    // The swing's refill animation (onCommenceAttack) takes over if the
    // release fired; otherwise (cancelled) show the selector again.
    if (!state.charging) paintPower();
  }
}

function syncAutoRepeat() {
  const box = state.refs?.repeatBox;
  if (!box) return;
  const server = isCharacterOptionEnabled(CHARACTER_OPTION.AutoRepeatAttacks, null);
  const local = window.__combatBarState?.autoRepeat;
  const v = server ?? (local == null ? true : !!local);
  if (box.checked !== v) box.checked = v;
  if (server != null && window.__combatBarState && window.__combatBarState.autoRepeat !== server) {
    window.__combatBarState.autoRepeat = server;
    persistCombatBarField("autoRepeat", server);
  }
}

// playerStats() walks the wasm entity's property bag — not free, and
// playerStatsUpdated fires on every vitals tick in a fight — so the
// Recklessness training read is throttled (it changes only on a skill
// raise / redistribution).
let lastTrainingReadMs = -Infinity;
function refreshTraining({ force = false } = {}) {
  const now = Date.now();
  if (!force && now - lastTrainingReadMs < 2000) return;
  lastTrainingReadMs = now;
  state.reckTraining = readTrainingLevel(SKILL_RECKLESSNESS);
}

// ── Swing refill animation (retail PowerMeter, RecvNotice_SetPowerbarLevel) ──
// The meter empties when a swing commences and refills to the requested power
// over the swing, mirroring the combat-bar panel meter's cadence (detail
// swingDurationMs when picking.js resolved the clip, else ~0.6 s…1.8 s).
function onCommenceAttack(ev) {
  const fill = state.refs?.fill;
  if (!fill || !state.visible) return;
  const swingMs = Number(ev?.detail?.swingDurationMs);
  const dur = Number.isFinite(swingMs) && swingMs > 0 ? swingMs : 600 + state.power * 1200;
  state.charging = true;
  fill.classList.add("is-charging");
  fill.style.transition = "none";
  fill.style.width = "0%";
  void fill.offsetWidth;
  fill.style.transition = `width ${Math.round(dur)}ms linear`;
  fill.style.width = `${Math.round(state.power * 100)}%`;
}
function onAttackDone() {
  const fill = state.refs?.fill;
  state.charging = false;
  if (!fill) return;
  fill.classList.remove("is-charging");
  fill.style.transition = "width 80ms linear";
  fill.style.width = `${Math.round(state.power * 100)}%`;
}

function build() {
  const ov = document.createElement("div");
  ov.id = OVERLAY_ID;
  ov.dataset.open = "0";
  ov.dataset.reck = "0";
  ov.setAttribute("role", "group");
  ov.setAttribute("aria-label", "Combat");

  const inner = document.createElement("div");
  inner.className = "hch-inner";
  ov.appendChild(inner);

  const main = document.createElement("div");
  main.className = "hch-main";
  inner.appendChild(main);

  // Power bar.
  const bar = document.createElement("div");
  bar.className = "hch-bar";
  bar.tabIndex = 0;
  bar.setAttribute("role", "slider");
  bar.setAttribute("aria-label", "Attack power");
  bar.setAttribute("aria-valuemin", "0");
  bar.setAttribute("aria-valuemax", "100");
  bar.title = "Drag to set attack power — left is faster, right hits harder.";
  const band = document.createElement("div");
  band.className = "hch-band";
  const fill = document.createElement("div");
  fill.className = "hch-fill";
  const thumb = document.createElement("div");
  thumb.className = "hch-thumb";
  const endL = document.createElement("span");
  endL.className = "hch-end hch-end-l";
  setAcText(endL, "Speed");
  const endR = document.createElement("span");
  endR.className = "hch-end hch-end-r";
  bar.appendChild(band);
  bar.appendChild(fill);
  bar.appendChild(thumb);
  bar.appendChild(endL);
  bar.appendChild(endR);
  main.appendChild(bar);

  // Pointer → power. clientX and the bar's rect are both SCREEN px, so the
  // ratio is zoom-independent (HUD scale 1-3).
  let dragging = false;
  const setFromEv = (ev) => {
    const r = bar.getBoundingClientRect();
    if (!r.width) return;
    setPowerFromHud((ev.clientX - r.left) / r.width, { persist: false });
  };
  bar.addEventListener("pointerdown", (ev) => {
    if (ev.button != null && ev.button !== 0) return;
    dragging = true;
    ev.preventDefault();
    ev.stopPropagation();
    try { bar.setPointerCapture(ev.pointerId); } catch (_) {}
    setFromEv(ev);
  });
  bar.addEventListener("pointermove", (ev) => { if (dragging) setFromEv(ev); });
  const endDrag = (ev) => {
    if (!dragging) return;
    dragging = false;
    try { bar.releasePointerCapture(ev.pointerId); } catch (_) {}
    persistCombatBarField("powerLevel", state.power);
  };
  bar.addEventListener("pointerup", endDrag);
  bar.addEventListener("pointercancel", endDrag);
  bar.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowLeft" || ev.key === "ArrowDown") { stepPowerFromHud(-0.05); ev.preventDefault(); ev.stopPropagation(); }
    else if (ev.key === "ArrowRight" || ev.key === "ArrowUp") { stepPowerFromHud(+0.05); ev.preventDefault(); ev.stopPropagation(); }
  });

  // Row 2 — Auto Repeat (retail AutoRepeatAttack option) + Recklessness status.
  const row = document.createElement("div");
  row.className = "hch-row";
  const repeatLabel = document.createElement("label");
  repeatLabel.className = "hbk-label";
  repeatLabel.title = "Keep attacking the same target after each swing.";
  const repeatBox = document.createElement("input");
  repeatBox.type = "checkbox";
  repeatBox.className = "hbk-check";
  repeatBox.addEventListener("change", () => {
    const v = !!repeatBox.checked;
    if (window.__combatBarState) window.__combatBarState.autoRepeat = v;
    persistCombatBarField("autoRepeat", v);
    // F11-2 — the option is server-side (ACE re-fires on AttackDone).
    setAutoRepeatAttacks(v);
  });
  const repeatText = document.createElement("span");
  repeatText.textContent = "Auto Repeat";
  repeatLabel.appendChild(repeatBox);
  repeatLabel.appendChild(repeatText);
  row.appendChild(repeatLabel);
  const reck = document.createElement("span");
  reck.className = "hch-reck";
  row.appendChild(reck);
  main.appendChild(row);

  // Row 3 — keyboard hints.
  const hints = document.createElement("div");
  hints.className = "hch-row hch-hints";
  hints.innerHTML = "<kbd>Ins</kbd> / <kbd>PgUp</kbd> lower / raise power · tap a height to attack, hold it to charge";
  main.appendChild(hints);

  // AttackButtonGroup.
  const heights = document.createElement("div");
  heights.className = "hch-heights";
  const heightEls = {};
  for (const h of HEIGHTS) {
    const key = document.createElement("span");
    key.className = "hch-key";
    key.textContent = h.key;
    heights.appendChild(key);
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hbk-btn-brass hch-height";
    btn.dataset.height = h.id;
    btn.dataset.heightValue = String(h.value);
    btn.textContent = h.label;
    btn.title = `${h.label} attack (${h.key}) — click to attack at the selector's power, hold to charge`;
    // Hold to charge: DOWN starts the bar, UP commits (pointer-captured, so a
    // release off the button still lands here).
    btn.addEventListener("pointerdown", (ev) => {
      if (ev.button != null && ev.button !== 0) return;
      ev.preventDefault();
      try { btn.setPointerCapture(ev.pointerId); } catch (_) {}
      btn._chargePointer = ev.pointerId;
      pressHeight(h.value);
    });
    const onUp = (ev) => {
      if (btn._chargePointer == null || btn._chargePointer !== ev.pointerId) return;
      btn._chargePointer = null;
      try { btn.releasePointerCapture(ev.pointerId); } catch (_) {}
      releaseHeight(h.value);
    };
    btn.addEventListener("pointerup", onUp);
    btn.addEventListener("pointercancel", onUp);
    // Keyboard activation of a focused button (Enter / Space) arrives as a
    // click with no pointer sequence (detail 0): a tap.
    btn.addEventListener("click", (ev) => { if (ev.detail === 0) attackAtHeight(h.value); });
    heights.appendChild(btn);
    heightEls[h.id] = btn;
  }
  inner.appendChild(heights);

  document.body.appendChild(ov);

  state.refs = {
    bar, band, fill, thumb, endL, endR,
    repeatBox, reck, heightEls,
  };

  // Drag by the frame / empty panel area; controls keep their own input.
  try {
    state.posCtl = attachWindowPosition(ov, {
      windowId: WINDOW_ID.COMBAT_HUD,
      dragHandle: ov,
      ignoreSelector: "button, input, label, .hch-bar, kbd",
      defaultPos: { left: "0px", right: "0px", bottom: `${DOCK_FALLBACK_BOTTOM}px`, top: "auto" },
    });
    // A position saved by the pre-2026-10-05 800-px strip (dragged by its
    // 6-px top handle) would strand the new 610-px panel off-centre; drop
    // it once so the panel docks above the toolbar again.
    const raw = localStorage.getItem(`hb.window.${(WINDOW_ID.COMBAT_HUD >>> 0).toString(16)}`);
    const saved = raw ? JSON.parse(raw) : null;
    if (saved && Number(saved.w) > PANEL_W + 60) state.posCtl?.resetPosition?.();
  } catch (e) {
    console.warn("[combat-hud] window position attach failed", e);
  }
  return ov;
}

// ── Docking ───────────────────────────────────────────────────────────
// Until the player drags it, the panel docks centred just above whatever
// bottom-centre HUD is showing (the toolbar / target bar stack), measured
// live so a taller toolbar or a different HUD scale never overlaps it.
const DOCK_SKIP = new Set([
  OVERLAY_ID, "hb-spell-strip", DEATH_OVERLAY_ID, "hb-sneak-hud", "hb-portal-storm-pulse",
]);
// Transient roots (hover tooltips over the toolbar, drag ghosts, toasts,
// context menus) must not shove the panel up and down while they live.
const DOCK_SKIP_RE = /tooltip|tip\b|ghost|drag|toast|popup|menu|confirm|dialog/i;

function zoomOf(el) {
  const z = Number(el?.currentCSSZoom);
  return Number.isFinite(z) && z > 0 ? z : 1;
}

/** Bottom offset (in `el`'s own HUD px) that clears every bottom-anchored,
 *  centre-straddling `#hb-*` HUD root. Exported for the spell strip twin. */
function computeDockBottom(el) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const z = zoomOf(el);
  let top = vh;
  for (const c of document.body.children) {
    const id = c.id || "";
    if (!id.startsWith("hb-") || DOCK_SKIP.has(id) || DOCK_SKIP_RE.test(id)) continue;
    const r = c.getBoundingClientRect?.();
    if (!r || !r.width || !r.height) continue;
    if (r.height > vh * 0.5 || r.width > vw * 0.9) continue;   // overlays / full-width
    if (r.bottom < vh * 0.7) continue;                          // not bottom-anchored
    if (r.left > vw / 2 + 40 || r.right < vw / 2 - 40) continue; // not centre column
    top = Math.min(top, r.top);
  }
  if (top >= vh) return DOCK_FALLBACK_BOTTOM;
  const bottom = (vh - top) / z + DOCK_GAP;
  // Never climb past mid-screen, whatever the neighbours do.
  return Math.round(Math.min(bottom, (vh / z) * 0.5));
}

function userPlaced() {
  const st = state.posCtl?.getState?.();
  return !!st && st.x != null && st.y != null;
}

function dock() {
  const ov = state.overlayEl;
  if (!ov || !state.visible || userPlaced()) return;
  ov.style.left = "0px";
  ov.style.right = "0px";
  ov.style.top = "auto";
  ov.style.bottom = `${computeDockBottom(ov)}px`;
}

function show() {
  if (!state.overlayEl) state.overlayEl = build();
  refreshTraining({ force: true });
  state.overlayEl.dataset.open = "1";
  state.visible = true;
  syncPowerFill();
  syncHeightHighlight();
  syncAutoRepeat();
  dock();
  // A second pass once the toolbar's own layout has settled.
  window.requestAnimationFrame?.(() => dock());
}

function hide() {
  if (!state.overlayEl) return;
  state.overlayEl.dataset.open = "0";
  state.visible = false;
  // Left melee/missile (retail cancels a request outside the ready position).
  heldAttackKeys.clear();
  getAttackCharge().cancel();
  onAttackDone();
}

// ── Keyboard (melee / missile only) ───────────────────────────────────
// The spellbook's "Forget selected spell" action (keymap DELETE_SPELL,
// 0xFF000011) also defaults to Delete; while it is armed (spellbook open with
// a spell selected) the focused panel owns the key and Low attack stands down.
function deleteKeyOwnedByPanel() {
  try {
    const f = getInputFunnel();
    return !!f?.actions?.some?.((a) => a.labelHash === "0xFF000011" && typeof a.when === "function" && a.when());
  } catch (_) { return false; }
}

// Attack keys held right now (code → height) — a keyup releases only the
// key whose keydown started the build here.
const heldAttackKeys = new Map();

function onCombatKey(ev) {
  if (!state.visible || ev.ctrlKey || ev.altKey || ev.metaKey || ev.shiftKey) return;
  if (!stanceIsMeleeOrMissile()) return;
  const h = HEIGHTS.find((x) => x.code === ev.code);
  if (h && h.code === "Delete" && deleteKeyOwnedByPanel()) return;
  if (h) {
    ev.preventDefault();
    // Hold to charge: the press starts the bar (OS auto-repeat ignored), the
    // keyup below commits it.
    if (!ev.repeat && !heldAttackKeys.has(h.code)) {
      heldAttackKeys.set(h.code, h.value);
      pressHeight(h.value);
    }
    return;
  }
  const delta = POWER_KEYS[ev.code];
  if (delta) {
    ev.preventDefault();
    stepPowerFromHud(delta);
  }
}

// Releases are ungated (a key let go while typing / after a stance change
// must still end the build).
function onCombatKeyUp(ev) {
  const value = heldAttackKeys.get(ev.code);
  if (value == null) return;
  heldAttackKeys.delete(ev.code);
  releaseHeight(value);
}

function installKeys() {
  const unsubCharge = getAttackCharge().onChange(onChargeChange);
  if (inputFunnelV2On()) {
    const f = getInputFunnel();
    const unDown = f?.bindRaw?.("combat-hud.attackKeys", onCombatKey) || (() => {});
    const unUp = f?.bindRawUp?.("combat-hud.attackKeysUp", onCombatKeyUp) || (() => {});
    return () => { unDown(); unUp(); unsubCharge(); };
  }
  const legacy = (ev) => {
    const t = ev.target;
    const tag = (t?.tagName || "").toUpperCase();
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t?.isContentEditable) return;
    onCombatKey(ev);
  };
  window.addEventListener("keydown", legacy);
  window.addEventListener("keyup", onCombatKeyUp);
  return () => {
    window.removeEventListener("keydown", legacy);
    window.removeEventListener("keyup", onCombatKeyUp);
    unsubCharge();
  };
}

// Q1a (2026-05-26): "You died." overlay — fires off the kind=29 Death bus
// event when the victim is the local player. Kit plaque, 5.5 s narrative.
function ensureDeathStyles() {
  if (document.getElementById(DEATH_STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = DEATH_STYLE_ID;
  s.textContent = `
    #${DEATH_OVERLAY_ID} {
      position: fixed;
      top: 38%;
      left: 50%;
      transform: translate(-50%, -50%);
      min-width: 320px;
      padding: 24px 48px;
      box-sizing: border-box;
      background: url("${SP}/0x06004CC2.png") repeat, rgba(0, 0, 0, 0.85);
      border: 1px solid var(--hbk-gold-dim, #8a7544);
      box-shadow: inset 0 0 0 1px #1c160b, 0 0 0 1px #000, 0 10px 28px rgba(0, 0, 0, 0.75);
      font-family: var(--hbk-font, var(--hb-font-serif));
      color: var(--hbk-gold-bright, #f3d27a);
      font-size: 26px;
      letter-spacing: 0.08em;
      text-align: center;
      text-shadow: 0 2px 0 rgba(0, 0, 0, 0.9);
      pointer-events: none;
      z-index: 90;
      opacity: 0;
      transition: opacity 280ms ease-out;
    }
    #${DEATH_OVERLAY_ID}[data-open="1"] { opacity: 1; }
  `;
  document.head.appendChild(s);
}

let deathOverlayTimer = null;
let deathPhaseTimers = [];

function clearDeathSequence() {
  for (const t of deathPhaseTimers) {
    try { clearTimeout(t); } catch (_) {}
  }
  deathPhaseTimers = [];
  if (deathOverlayTimer) {
    try { clearTimeout(deathOverlayTimer); } catch (_) {}
    deathOverlayTimer = null;
  }
}

// Multi-phase death narrative (rec #166), timer-driven until the
// portalSpaceEntered / player-teleport bus events surface:
//   t=0 "You died." · t=1.5 "Entering portal space…" · t=4.0 "Resurrecting…" · t=5.5 fade
function setDeathMessage(ov, message) {
  setAcText(ov, message || "You died.");
  ov.dataset.open = "0";
  void ov.offsetWidth;
  ov.dataset.open = "1";
}

function showDeathOverlay(message) {
  ensureDeathStyles();
  let ov = document.getElementById(DEATH_OVERLAY_ID);
  if (!ov) {
    ov = document.createElement("div");
    ov.id = DEATH_OVERLAY_ID;
    document.body.appendChild(ov);
  }
  clearDeathSequence();
  setDeathMessage(ov, message || "You died.");
  const sequence = [
    { at: 1500, text: "Entering portal space…" },
    { at: 4000, text: "Resurrecting…" },
  ];
  for (const step of sequence) {
    const t = setTimeout(() => {
      if (!document.body.contains(ov)) return;
      setDeathMessage(ov, step.text);
    }, step.at);
    deathPhaseTimers.push(t);
  }
  deathOverlayTimer = setTimeout(() => {
    ov.dataset.open = "0";
    deathOverlayTimer = setTimeout(() => {
      try { ov.remove(); } catch (_) {}
      deathOverlayTimer = null;
    }, 320);
  }, 5500);
}

function onDeath(ev) {
  const detail = ev?.detail || {};
  const victim = (detail.victimGuid >>> 0) || 0;
  let localGuid = 0;
  try { localGuid = (window.getLocalPlayerGuid?.() ?? 0) >>> 0; } catch { localGuid = 0; }
  if (localGuid === 0 || victim !== localGuid) return;
  showDeathOverlay("You died.");
}

export const manifest = {
  id: "combat-hud",
  name: "Combat HUD",
  icon: "⚔",
  iconHidden: true,
  version: "0.2.0",
  description: "Retail gmCombatUI power bar + High/Medium/Low — shows in melee/missile stance",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  state.overlayEl = build();
  syncPowerFill();
  syncHeightHighlight();

  // Show in melee/missile, hide otherwise. playerStatsUpdated (kind=8)
  // covers every stance refresh; the 1 Hz tick is the convergence backstop.
  const recomputeVisible = () => {
    const inCombat = stanceIsMeleeOrMissile() || state.debugPinned;
    if (inCombat && !state.visible) show();
    else if (!inCombat && state.visible) hide();
    syncPowerFill();
    if (state.visible) {
      syncHeightHighlight();
      dock();   // the toolbar / target bar below may have grown or shrunk
    }
  };
  const t = setInterval(recomputeVisible, 1000);

  const subs = [];
  let clientPoll = null;
  function tryHook() {
    const client = window.__pluginClient;
    if (!client?.events?.on) return false;
    const onStats = () => {
      if (state.visible) refreshTraining();
      recomputeVisible();
      if (state.visible) syncAutoRepeat();
    };
    client.events.on("playerStatsUpdated", onStats);
    client.events.on("combatCommenceAttack", onCommenceAttack);
    client.events.on("attackDone", onAttackDone);
    client.events.on("death", onDeath);
    subs.push(() => {
      try { client.events.off("playerStatsUpdated", onStats); } catch (_) {}
      try { client.events.off("combatCommenceAttack", onCommenceAttack); } catch (_) {}
      try { client.events.off("attackDone", onAttackDone); } catch (_) {}
      try { client.events.off("death", onDeath); } catch (_) {}
    });
    recomputeVisible();
    return true;
  }
  if (!tryHook()) {
    if (window.__pluginClientReady?.then) {
      window.__pluginClientReady.then(() => { tryHook(); });
    } else {
      clientPoll = setInterval(() => {
        if (tryHook()) { clearInterval(clientPoll); clientPoll = null; }
      }, 500);
    }
  }

  const unbindKeys = installKeys();

  // Re-dock on viewport / HUD-scale changes (user-placed windows are
  // re-clamped by attachWindowPosition itself).
  let dockRaf = 0;
  const scheduleDock = () => {
    cancelAnimationFrame(dockRaf);
    dockRaf = requestAnimationFrame(dock);
  };
  window.addEventListener("resize", scheduleDock);
  document.addEventListener("hb-hud-scale-changed", scheduleDock);

  return () => {
    clearInterval(t);
    if (clientPoll) clearInterval(clientPoll);
    for (const u of subs) u();
    try { unbindKeys(); } catch (_) {}
    cancelAnimationFrame(dockRaf);
    window.removeEventListener("resize", scheduleDock);
    document.removeEventListener("hb-hud-scale-changed", scheduleDock);
    if (state.overlayEl) {
      state.overlayEl.remove();
      state.overlayEl = null;
    }
    state.refs = null;
    state.posCtl = null;
    state.visible = false;
    clearDeathSequence();
    document.getElementById(DEATH_OVERLAY_ID)?.remove();
  };
}

// Debug: pop the panel without needing a combat stance. `__combatHudDebug()`
// pins it open (the 1 Hz stance check would otherwise hide it again within a
// second); `__combatHudDebug(false)` releases it back to the stance gate.
if (typeof window !== "undefined") {
  window.__combatHudDebug = function (pin = true) {
    ensureStyles();
    state.debugPinned = pin !== false;
    if (!state.debugPinned) {
      if (!stanceIsMeleeOrMissile()) hide();
      return;
    }
    if (!state.overlayEl) state.overlayEl = build();
    show();
  };
}

export const __test = Object.freeze({ computeDockBottom, HEIGHTS, POWER_KEYS, PANEL_W });
