// Combat HUD — retail port of gmCombatUI (layout 0x21000007, class
// 0x1000000C, 800x80 design canvas). Auto-shows when the player
// enters combat stance, auto-hides when peace.
//
// Layout decoded (combat_hud_layout_dump 2026-05-24 on 0x21000007):
//   Root 0x1000004B (type=268435468) 800x80  outer wrapper @ (0, 464)
//     0x1000004C (type=3)  10x80     left edge spacer       @ (0, 0)
//     0x1000004D (type=3)  690x80    main content area      @ (10, 0)
//     0x1000004E (type=3)  100x80    right edge spacer      @ (700, 0)
//     0x1000004F (type=11) 707x14    meter parent           @ (8, 9)
//       0x10000050 (type=7) 707x14   meter inner track
//         0x100005EF (type=3) 567x14 slider thumb / fill    @ (70, 0)
//     0x10000051 (type=0) 100x15     "Speed" label          @ (12, 9)
//     0x10000052 (type=0) 100x15     Speed value            @ (611, 9)
//     0x10000053 (type=0) 100x14     second-row label       @ (5, 29)
//     0x10000054 (type=0)  80x14     second-row value       @ (110, 29)
//     0x10000055 (type=0) 100x14     "Accuracy" label       @ (195, 29)
//     0x10000056 (type=17) 72x57     right button column    @ (722, 4)
//       0x10000057 (type=0) 72x19    High                   @ (0, 0)
//       0x10000058 (type=0) 72x19    Med                    @ (0, 19)
//       0x10000059 (type=0) 72x19    Low                    @ (0, 38)
//   0x1000005A (type=0) 72x19 (detached template, 4 states):
//     Normal=0x06004D1C  Pressed=0x06004D1D  Highlight=0x06004D1E
//
// Behaviour vs existing plugins:
//   - plugins/combat-bar.js — bar-slot popover with Hi/Med/Lo +
//     power + auto-repeat controls. Stays available in the bar.
//   - plugins/target-bar.js — Peace/Combat toggle + Use/Target/
//     Examine row. Stance toggle still lives there.
//   - plugins/combat-hud.js (THIS) — the horizontal wide bar that
//     auto-shows in combat. Power slider on left, 3 height buttons
//     on right. The user's "proper combat bar from the data".
//
// Authoritative stance source: window.__getCurrentStanceLow()
// (set by applyConfirmedStance on every kind=5 UpdateMotion).
// Low 16 bits == 0x3D = Peace; any other non-zero = in-combat stance.
//
// Click Hi/Med/Lo → window.__fireAttackOnTarget(heightId) — same
// path the existing combat-bar popover uses. The heightId values
// (Hi=2, Med=1, Lo=0) match scene3d/picking.js's expected enum.

import { setAcText } from "../ui/ac_font.js";
import { loadLayout, findElementById, getCachedLayout } from "../ui/ac_layout.js";
import { computeDamageRatingRollup } from "../ui/ac_damage_rating.js";
import { attachDefaultTopDragHandle, WINDOW_ID } from "../ui/ac_window_position.js";

/** gmCombatUI — retail layout that drives the combat HUD horizontal bar.
 *  Element-id map confirmed by combat_hud_layout_dump 2026-05-24:
 *    0x1000004B — root wrapper (800×80)
 *    0x1000004D — main content area (690×80 at 10,0)
 *    0x1000004F — meter parent (Speed/Power slider, 707×14 at 8,9)
 *    0x100005EF — slider fill/thumb (567×14 at 70,0 inside track)
 *    0x10000051 — "Speed" / Power label (100×15 at 12,9)
 *    0x10000052 — Speed/Power value text (100×15 at 611,9)
 *    0x10000053 — second-row label e.g. "Accuracy:" (100×14 at 5,29)
 *    0x10000054 — second-row value (80×14 at 110,29)
 *    0x10000055 — "Accuracy" label (100×14 at 195,29)
 *    0x10000056 — right button column container (72×57 at 722,4)
 *    0x10000057 — High button (72×19 at 0,0 in column)
 *    0x10000058 — Med  button (72×19 at 0,19)
 *    0x10000059 — Low  button (72×19 at 0,38)
 */
const COMBAT_HUD_LAYOUT_ID = 0x21000007;
const COMBAT_HUD_ELEMS = {
  root:        0x1000004B,
  main:        0x1000004D,
  slider:      0x1000004F,
  sliderFill:  0x100005EF,
  powerLabel:  0x10000051,
  powerValue:  0x10000052,
  row2Label:   0x10000053,
  row2Value:   0x10000054,
  accLabel:    0x10000055,
  buttonCol:   0x10000056,
  high:        0x10000057,
  med:         0x10000058,
  low:         0x10000059,
};

const OVERLAY_ID = "hb-combat-hud";
const STYLE_ID   = "hb-combat-hud-style";
const DEATH_OVERLAY_ID = "hb-combat-hud-death";
const DEATH_STYLE_ID   = "hb-combat-hud-death-style";
const SP = "./data/ui-sprites";

// MotionStance enum values (low 16 bits). Peace = 0x3D (61), Magic
// combat = 0x49 (73). Magic stance is excluded from the DR readout
// because the rollup helper's `base`/`reckless` math is melee/missile-
// specific (Recklessness power-band + per-weapon DamageMod don't apply
// to spellcasting). See `plugins/combat-bar.js:464` and
// `ui/ac_damage_rating.js` header for canonical sources.
const STANCE_PEACE = 0x3D;
const STANCE_MAGIC = 0x0049;

// How long the transient sneak component stays in the rollup after a
// `sneakAttackPredicted` event before we drop it back to the baseline
// (`hasSneak: false`). Matches `plugins/sneak-hud.js`'s TOTAL_MS so the
// inline readout fades the [SNEAK!] marker in sync with the floating
// overlay's exit transition.
const SNEAK_HOLD_MS = 1500;

// Wave 15 / Phase 46 — server-resolved damage readout.
//
// Ring-buffer depth for the running average. Sized to match the user-
// facing copy ("Avg (last 5)") so the displayed window === computed
// window. We keep the buffer trimmed to this size on push so summary()
// math is a one-pass sum / length without re-slicing.
const LAST_HIT_RING_CAPACITY = 5;
// How long the readout stays visible after the most recent damageDealt
// event before fading out (idle / out of combat). 30s window covers the
// long inter-attack gaps when chasing a fleeing target or repositioning
// without making the readout feel stale. On expiry we clear the buffer
// AND blank the DOM — re-entering combat starts fresh.
const LAST_HIT_IDLE_MS = 30_000;
// CSS fade duration (matches the .hch-last-hit `transition: opacity ...`
// declaration in ensureStyles()). Tracked here so the fade-out timer
// and the CSS stay in sync if either is tuned later.
const LAST_HIT_FADE_MS = 320;
// Bit 0x4 of AttackConditions = SneakAttack (set by ACE when
// DamageEvent.SneakAttackMod > 1.0f, see ACE.Server/Entity/DamageEvent.cs:693).
// Diag/combat.js documents the same constant — kept local here so the
// plugin doesn't import diag-only state.
const ATTACK_CONDITIONS_BIT_SNEAK_ATTACK = 0x4;

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    /* Retail gmCombatUI is 800×80 at design size; the layout applies
     * explicit child positions, so the overlay is just an anchored
     * pixel-accurate frame. CSS centering trap avoided per radar.js:
     * we use left:50% + margin-left:-400px instead of transform, so
     * applyCombatHudLayout's per-element transform overrides have a
     * clean baseline. */
    #${OVERLAY_ID} {
      position: fixed;
      bottom: 116px;  /* above target-bar (bottom:46) + hotbar (bottom:8) stack */
      left: 50%;
      margin-left: -400px;
      transform: none;
      width: 800px;
      height: 80px;
      z-index: 48;
      pointer-events: auto;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      /* P1-24 (cross-find combat-hud-chrome-background): retail
       * gmCombatUI is a child of gmFloatyPowerBarUI whose chrome
       * (border + frame) wraps the 8 outer sprites; this overlay
       * carries no synthetic background of its own. Was a solid
       * rgba(20,14,8,0.92) panel + brass border. */
      background: transparent;
      box-shadow: none;
      display: none;
      box-sizing: border-box;
    }
    #${OVERLAY_ID}[data-open="1"] { display: block; }
    /* Main content area (gmCombatUI 0x1000004D 690×80 @ 10,0). */
    #${OVERLAY_ID} .hch-main {
      position: absolute;
      left: 10px; top: 0;
      width: 690px; height: 80px;
    }
    /* Power/Speed slider parent (0x1000004F 707×14 @ 8,9). */
    #${OVERLAY_ID} .hch-slider {
      position: absolute;
      left: 8px; top: 9px;
      width: 707px; height: 14px;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      box-sizing: border-box;
      cursor: pointer;
    }
    /* Slider fill (0x100005EF 567×14 @ 70,0 inside the track). Width
     * is set imperatively to track the current power level; left
     * anchor stays at 0 so the fill grows from the left edge. */
    #${OVERLAY_ID} .hch-slider-fill {
      position: absolute;
      top: 1px; left: 1px; bottom: 1px;
      width: 50%;
      background: linear-gradient(90deg,
        rgba(180, 130, 50, 0.7) 0%,
        rgba(220, 180, 80, 0.9) 100%);
      transition: width 80ms linear;
      pointer-events: none;
    }
    /* "Power" label (0x10000051 100×15 @ 12,9). */
    #${OVERLAY_ID} .hch-power-label {
      position: absolute;
      left: 12px; top: 9px;
      width: 100px; height: 15px;
      color: var(--hb-text-gold-dim);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 10px;
      line-height: 14px;
      pointer-events: none;
    }
    /* Power-value readout (0x10000052 100×15 @ 611,9). */
    #${OVERLAY_ID} .hch-slider-val {
      position: absolute;
      left: 611px; top: 9px;
      width: 100px; height: 15px;
      color: var(--hb-text-gold);
      font-variant-numeric: tabular-nums;
      font-size: 10px;
      line-height: 14px;
      text-align: right;
      pointer-events: none;
    }
    /* Row-2 label "Accuracy:" (0x10000053 100×14 @ 5,29). */
    #${OVERLAY_ID} .hch-acc-label {
      position: absolute;
      left: 5px; top: 29px;
      width: 100px; height: 14px;
      color: var(--hb-text-gold-dim);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 10px;
      line-height: 14px;
      pointer-events: none;
    }
    /* Row-2 value (0x10000054 80×14 @ 110,29). */
    #${OVERLAY_ID} .hch-acc-val {
      position: absolute;
      left: 110px; top: 29px;
      width: 80px; height: 14px;
      color: var(--hb-text-gold);
      font-size: 10px;
      line-height: 14px;
      pointer-events: none;
    }
    /* Trailing "Accuracy" label (0x10000055 100×14 @ 195,29). */
    #${OVERLAY_ID} .hch-acc-trailing {
      position: absolute;
      left: 195px; top: 29px;
      width: 100px; height: 14px;
      color: var(--hb-text-gold-dim);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 10px;
      line-height: 14px;
      pointer-events: none;
    }
    /* Damage Rating readout (Phase 35) — shares the row-2 y-baseline
     * with the Accuracy labels. The dead space between the trailing
     * "Accuracy" label (x=195 + width=100 = 295) and the right button
     * column (x=722) is ~427px, more than enough for the breakdown
     * text. Tabular nums so the digits don't jitter as the rollup
     * components flip between single-digit (sneak +0) and double-digit
     * (reckless +20) values. */
    /* P1-24 (cross-find combat-hud-panel-dr-row): retail gmCombatUI
     * has no on-bar damage-rating breakdown — DR is shown in the
     * combat log + character sheet, not as a HUD row. The DOM stays
     * (the DR-rollup math is consumed by other panels via
     * computeDamageRatingRollup) but the row is hidden. */
    #${OVERLAY_ID} .hch-dr-row {
      display: none;
    }
    /* The "DR: +N" total — slightly brighter gold so the headline
     * value reads cleanly against the dim breakdown. */
    #${OVERLAY_ID} .hch-dr-total {
      color: var(--hb-text-gold);
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
    }
    /* Breakdown text (base/sneak/reckless components). Dim by default;
     * the sneak slice picks up the red accent when armed. */
    #${OVERLAY_ID} .hch-dr-break {
      color: var(--hb-text-gold-dim);
      margin-left: 6px;
    }
    /* Sneak component when the predictor has fired — matches the
     * sneak-hud overlay's rgba(220, 80, 40, *) accent so the inline
     * readout and the floating overlay read as the same beat. */
    #${OVERLAY_ID} .hch-dr-row[data-sneak="1"] .hch-dr-sneak {
      color: rgb(255, 180, 140);
      text-shadow: 0 0 4px rgba(220, 80, 40, 0.55);
    }
    /* The transient [SNEAK!] tail tag. Inline so it pushes the trailing
     * accuracy whitespace inward instead of overlapping the buttons. */
    #${OVERLAY_ID} .hch-dr-flag {
      display: none;
      margin-left: 8px;
      color: rgb(255, 200, 160);
      font-weight: 700;
      letter-spacing: 0.06em;
      text-shadow: 0 0 4px rgba(220, 80, 40, 0.6);
    }
    #${OVERLAY_ID} .hch-dr-row[data-sneak="1"] .hch-dr-flag {
      display: inline;
    }
    /* Wave 15 / Phase 46 — "Last hit" readout row.
     *
     * Sits immediately below the DR row (which lives at y=29, height
     * 14, so bottom edge is 43). We anchor the last-hit row at y=48
     * (5px breathing-room gap so the two readouts don't visually
     * collide) and give it the same 14px height + tabular-nums treatment
     * the DR row uses. Width stops at x=710 to clear the right button
     * column container (which lives at x=722,top=4,height=57 → bottom 61).
     *
     * Idle-fade: opacity transitions over LAST_HIT_FADE_MS so the line
     * dims smoothly when no damageDealt arrives inside LAST_HIT_IDLE_MS
     * (30s) instead of popping out. Pointer-events:none so the slider
     * drag-rect underneath remains clickable (defensive — the DR row
     * does the same). */
    /* P1-24 (cross-find combat-hud-panel-last-hit): retail's last-hit
     * readout lives in the chat log, not on the combat HUD. DOM stays
     * (the JS still tracks damageDealt for any downstream consumers)
     * but the row is hidden. */
    #${OVERLAY_ID} .hch-last-hit {
      display: none;
    }
    /* Idle / out-of-combat fade-out state. data-idle is flipped by
     * the JS idle timer; the CSS transition handles the visual fade. */
    #${OVERLAY_ID} .hch-last-hit[data-idle="1"] {
      opacity: 0;
    }
    /* The "Last hit:" label — dim gold, uppercase, matches the row-2
     * trailing label aesthetic so the two readouts read as a stack. */
    #${OVERLAY_ID} .hch-lh-label {
      color: var(--hb-text-gold-dim);
      letter-spacing: 0.04em;
      text-transform: uppercase;
      margin-right: 6px;
    }
    /* Damage value — slightly brighter gold + bold to anchor the line. */
    #${OVERLAY_ID} .hch-lh-dmg {
      color: var(--hb-text-gold);
      font-weight: 600;
    }
    /* [SneakAttack] tag. Uses the same red-accent family as the DR
     * row's sneak slice + sneak-hud floating overlay
     * (rgba(220, 80, 40, *)) so all three signals read as one beat
     * when the server confirms a sneak hit. Display:none until JS
     * flips data-sneak=1 on the parent. */
    #${OVERLAY_ID} .hch-lh-sneak {
      display: none;
      margin-left: 8px;
      color: rgb(255, 180, 140);
      font-weight: 700;
      letter-spacing: 0.05em;
      text-shadow: 0 0 4px rgba(220, 80, 40, 0.55);
    }
    #${OVERLAY_ID} .hch-last-hit[data-sneak="1"] .hch-lh-sneak {
      display: inline;
    }
    /* Running-average tail — pushed to the right of the [SneakAttack]
     * tag so the visual rhythm is: label, damage, [tag], avg. Same
     * tabular-nums treatment so the digits don't jitter across hits. */
    #${OVERLAY_ID} .hch-lh-avg {
      margin-left: 18px;
      color: var(--hb-text-gold-dim);
    }
    #${OVERLAY_ID} .hch-lh-avg-val {
      color: var(--hb-text-gold);
      font-weight: 600;
    }
    /* Right button column (0x10000056 72×57 @ 722,4). */
    #${OVERLAY_ID} .hch-buttons {
      position: absolute;
      left: 722px; top: 4px;
      width: 72px; height: 57px;
    }
    /* Hi/Med/Lo buttons (0x10000057..9 72×19 each, stacked at y=0/19/38). */
    #${OVERLAY_ID} .hch-height {
      position: absolute;
      left: 0;
      width: 72px; height: 19px;
      background: url("${SP}/0x06004D1C.png") no-repeat center / 100% 100%;
      border: 0; padding: 0; margin: 0;
      font-family: var(--hb-font-serif);
      font-size: 10px;
      font-weight: 600;
      color: var(--hb-text-cream);
      letter-spacing: 0.04em;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
      cursor: pointer;
    }
    #${OVERLAY_ID} .hch-height[data-height="high"]   { top: 0; }
    #${OVERLAY_ID} .hch-height[data-height="medium"] { top: 19px; }
    #${OVERLAY_ID} .hch-height[data-height="low"]    { top: 38px; }
    #${OVERLAY_ID} .hch-height:hover {
      background-image: url("${SP}/0x06004D1E.png");
      color: var(--hb-text-gold);
    }
    #${OVERLAY_ID} .hch-height:active {
      background-image: url("${SP}/0x06004D1D.png");
    }
    #${OVERLAY_ID} .hch-height.armed {
      background-image: url("${SP}/0x06004D1E.png");
      color: var(--hb-text-gold);
    }
  `;
  document.head.appendChild(s);
}

// Module state (singleton).
let state = {
  overlayEl: null,
  visible: false,
  power: 1.0,         // 0..1, drives __combatBarState.powerLevel
  // DR readout state (Phase 35). drHasSneak flips to true when
  // `sneakAttackPredicted` fires and back to false ~SNEAK_HOLD_MS later
  // via drSneakTimer. drLastPower remembers the last polled power value
  // so the rAF poll skips repaints when nothing changed.
  drRowEl: null,
  drTotalEl: null,
  drBreakEl: null,
  drHasSneak: false,
  drSneakTimer: null,
  drLastPower: -1,
  drLastSneakFlag: -1,
  drLastStance: -1,
  // Wave 15 / Phase 46 — "Last hit" readout state.
  //  - lhRowEl / lhDmgEl / lhAvgEl: cached DOM refs so the update path
  //    is allocation-free.
  //  - lhRing: ring buffer of recent damageDealt events (capped at
  //    LAST_HIT_RING_CAPACITY); newest at the tail. Each entry is
  //    `{ damage, attackConditions, ts }` per the task spec.
  //  - lhIdleTimer: setTimeout id that fires LAST_HIT_IDLE_MS after the
  //    most recent event to flip the row into the faded-out state.
  lhRowEl: null,
  lhDmgEl: null,
  lhSneakEl: null,
  lhAvgValEl: null,
  lhRing: [],
  lhIdleTimer: null,
};

function stanceIsCombat() {
  try {
    const fn = window.__getCurrentStanceLow;
    if (typeof fn !== "function") return false;
    const low = fn() || 0;
    return low !== 0 && low !== STANCE_PEACE;
  } catch { return false; }
}

// True when the player is in a melee OR missile combat stance — i.e.
// in combat but NOT in the magic-combat stance (0x49). The DR rollup's
// reckless component is gated on a melee/missile power band; magic
// stance uses a different damage path entirely, so we hide the readout
// to avoid showing misleading numbers.
function stanceIsMeleeOrMissile() {
  try {
    const fn = window.__getCurrentStanceLow;
    if (typeof fn !== "function") return false;
    const low = fn() || 0;
    return low !== 0 && low !== STANCE_PEACE && low !== STANCE_MAGIC;
  } catch { return false; }
}

function syncPowerFill() {
  const ov = state.overlayEl;
  if (!ov) return;
  const fill = ov.querySelector(".hch-slider-fill");
  const val = ov.querySelector(".hch-slider-val");
  if (fill) fill.style.width = `${Math.round(state.power * 100)}%`;
  if (val) setAcText(val, `${Math.round(state.power * 100)}%`);
  // Propagate to the shared combat bar state so picking.js's
  // fireAttackOnTarget honours the power level set here.
  if (window.__combatBarState) {
    window.__combatBarState.powerLevel = state.power;
  }
}

// Format a signed integer with an explicit `+` for non-negative values
// (matches the acpedia DR display convention: "+0" / "+10" / "+20").
function _fmtSigned(n) {
  return n >= 0 ? `+${n}` : `${n}`;
}

// Recompute the Damage Rating rollup and paint the row-2 readout. Pure
// rendering — caller (rAF poll, event handlers) decides WHEN to call.
// Reads the current power-bar slider value from window.__combatBarState
// (combat-bar.js and our own slider both write that global); falls back
// to 1.0 (full power) when the bar hasn't initialized yet. Same default
// sneak-hud.js uses on line 161, so both consumers agree.
function updateDamageRating() {
  const row = state.drRowEl;
  if (!row) return;
  // Stance gate. When magic / peace, blank the row so the user doesn't
  // see stale melee numbers while reading a fireball. The overlay's
  // own visibility (data-open) is driven by stanceIsCombat; this guard
  // covers the magic-stance case (in-combat but DR math doesn't apply).
  if (!stanceIsMeleeOrMissile()) {
    if (state.drTotalEl) setAcText(state.drTotalEl, "");
    if (state.drBreakEl) setAcText(state.drBreakEl, "");
    row.dataset.sneak = "0";
    state.drLastPower = -1;
    state.drLastSneakFlag = -1;
    return;
  }
  const power =
    (typeof window !== "undefined")
      ? (Number(window.__combatBarState?.powerLevel ?? 1.0) || 0)
      : 1.0;
  const hasSneak = !!state.drHasSneak;
  let rollup;
  try {
    rollup = computeDamageRatingRollup({
      powerLevel: power,
      hasSneak,
      sessionHandle:
        (typeof window !== "undefined") ? window.__sessionHandle : null,
    });
  } catch (_) {
    // Defensive — never let a transient session-handle hiccup wipe the
    // bar. Leave the existing text in place.
    return;
  }
  if (!rollup) return;
  const { base = 0, sneak = 0, reckless = 0, total = 0 } = rollup;
  if (state.drTotalEl) {
    setAcText(state.drTotalEl, `DR: ${_fmtSigned(total)}`);
  }
  if (state.drBreakEl) {
    // Span the sneak component in its own <span> so the CSS [data-sneak]
    // selector can color it red on arm without rebuilding the parent.
    // setAcText only handles text content, so use innerHTML with safe
    // numeric interpolation (all three values come from the rollup
    // helper as integers).
    const baseStr = `${_fmtSigned(base)}`;
    const sneakStr = `${_fmtSigned(sneak)}`;
    const recklessStr = `${_fmtSigned(reckless)}`;
    state.drBreakEl.innerHTML =
      `(base ${baseStr}, ` +
      `<span class="hch-dr-sneak">sneak ${sneakStr}</span>, ` +
      `reckless ${recklessStr})`;
  }
  row.dataset.sneak = hasSneak ? "1" : "0";
  state.drLastPower = power;
  state.drLastSneakFlag = hasSneak ? 1 : 0;
}

// Handler for the `sneakAttackPredicted` event from picking.js. Arms
// the transient sneak component for ~SNEAK_HOLD_MS, mirroring
// `plugins/sneak-hud.js`'s 1500ms TOTAL_MS so the inline readout fades
// in sync with the floating overlay. Re-arming (rapid back-to-back
// swings in the rear cone) resets the timer so the marker keeps
// reading "on".
function onSneakAttackPredicted(_payload) {
  state.drHasSneak = true;
  if (state.drSneakTimer) {
    clearTimeout(state.drSneakTimer);
    state.drSneakTimer = null;
  }
  state.drSneakTimer = setTimeout(() => {
    state.drHasSneak = false;
    state.drSneakTimer = null;
    updateDamageRating();
  }, SNEAK_HOLD_MS);
  updateDamageRating();
}

// Handler for `playerStatsUpdated` — re-runs the rollup so a mid-
// session training-level change (Recklessness / Sneak Attack rank-up)
// flows into the readout immediately. Vitals churn (HP/mana fluctuation)
// fires this event too, but `computeDamageRatingRollup` is pure +
// cheap — one stats-snapshot read per event — so we don't bother
// gating on a diff.
function onPlayerStatsUpdated(_payload) {
  updateDamageRating();
}

// Wave 15 / Phase 46 — repaint the "Last hit" row from the current ring
// buffer. Pure DOM — caller (idle-timer expiry, onDamageDealt) decides
// WHEN to call. Empty buffer leaves the placeholder dashes in place
// (the row's opacity is what controls visibility; we don't blank text
// on idle because that would re-trigger CSS transitions if a fresh
// event lands during the fade).
function updateLastHitRow() {
  const row = state.lhRowEl;
  if (!row) return;
  const ring = state.lhRing;
  if (!ring || ring.length === 0) {
    if (state.lhDmgEl) setAcText(state.lhDmgEl, "—");
    if (state.lhAvgValEl) setAcText(state.lhAvgValEl, "—");
    row.dataset.sneak = "0";
    return;
  }
  const latest = ring[ring.length - 1];
  const dmg = Math.max(0, latest.damage | 0);
  // Bit 0x4 set on the MOST RECENT hit drives the [SneakAttack] tag —
  // per the task spec. Averaging is over the whole ring; the tag
  // tracks the latest event only.
  const hasSneakBit =
    (Number(latest.attackConditions) & ATTACK_CONDITIONS_BIT_SNEAK_ATTACK) !== 0;
  // Running average over the buffer (1..LAST_HIT_RING_CAPACITY hits).
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) sum += (ring[i].damage | 0);
  const avg = Math.round(sum / ring.length);
  if (state.lhDmgEl) setAcText(state.lhDmgEl, `${dmg} dmg`);
  if (state.lhAvgValEl) setAcText(state.lhAvgValEl, `${avg}`);
  row.dataset.sneak = hasSneakBit ? "1" : "0";
}

// Wave 15 / Phase 46 — `damageDealt` handler. Pure consumer of the
// existing event surface: src/lib.rs:23601 emits
// `{ defenderName, damage, damageType, healthPercent, criticalHit,
//    attackConditions }` against `kind=19` CombatEvent; the plugin
// client republishes as a CustomEvent-shaped object so `.detail`
// carries the payload (see combat-bar.js:1467 for the same pattern).
//
// Stance-gate: hide while in magic stance OR peace. Magic damage flows
// through a different ACE event family (per the task notes), so showing
// a melee/missile-only readout there would mislead. Peace is already
// covered by overlay visibility — but if the bus delivers a stale hit
// after `hide()` we still don't want to bump the idle timer.
function onDamageDealt(ev) {
  const d = ev?.detail ?? {};
  // Defensive: ignore well-formed-but-zero-damage events (evades come
  // through a separate `evadedTarget` channel; a `damageDealt` with
  // damage=0 is rare but cleaner to drop than to log "0 dmg" as the
  // "last hit").
  const damage = (d.damage | 0);
  if (damage <= 0) return;
  if (!stanceIsMeleeOrMissile()) return;

  // Push to ring + trim to capacity (oldest drops off the head).
  const conditionsRaw = d.attackConditions ?? 0;
  const conditions = typeof conditionsRaw === "bigint"
    ? Number(conditionsRaw)
    : Number(conditionsRaw);
  state.lhRing.push({
    damage,
    attackConditions: Number.isFinite(conditions) ? conditions : 0,
    ts: performance.now(),
  });
  while (state.lhRing.length > LAST_HIT_RING_CAPACITY) state.lhRing.shift();

  // Wake the row out of any in-progress fade-out and re-arm the idle
  // timer. data-idle=0 flips opacity back to 1 via the CSS transition;
  // if the row was already fully faded, this same transition fades it
  // back in.
  if (state.lhRowEl) state.lhRowEl.dataset.idle = "0";
  if (state.lhIdleTimer) {
    clearTimeout(state.lhIdleTimer);
    state.lhIdleTimer = null;
  }
  state.lhIdleTimer = setTimeout(() => {
    if (state.lhRowEl) state.lhRowEl.dataset.idle = "1";
    state.lhIdleTimer = null;
  }, LAST_HIT_IDLE_MS);

  updateLastHitRow();
}

// Returns { overlay, refs } where refs is the element map applyCombatHudLayout
// walks. DOM mirrors the 0x21000007 element tree:
//   overlay (root 0x1000004B)
//   ├─ .hch-main (0x1000004D)
//   ├─ .hch-slider (0x1000004F)
//   │   └─ .hch-slider-fill (0x100005EF)
//   ├─ .hch-power-label (0x10000051)
//   ├─ .hch-slider-val (0x10000052)
//   ├─ .hch-acc-label (0x10000053)
//   ├─ .hch-acc-val (0x10000054)
//   ├─ .hch-acc-trailing (0x10000055)
//   └─ .hch-buttons (0x10000056)
//       ├─ .hch-height[data-height="high"]   (0x10000057)
//       ├─ .hch-height[data-height="medium"] (0x10000058)
//       └─ .hch-height[data-height="low"]    (0x10000059)
function build() {
  const ov = document.createElement("div");
  ov.id = OVERLAY_ID;
  ov.dataset.open = "0";

  const main = document.createElement("div");
  main.className = "hch-main";
  // main holds the slider, labels, and button column; using pointer-events:
  // none on .main would prevent the slider drag from working, so leave it on.
  ov.appendChild(main);

  // Power slider (0x1000004F at 8,9). Fill child is 0x100005EF.
  const powerSlider = document.createElement("div");
  powerSlider.className = "hch-slider";
  const powerFill = document.createElement("div");
  powerFill.className = "hch-slider-fill";
  powerSlider.appendChild(powerFill);
  ov.appendChild(powerSlider);

  // Slider drag → update power. Hit-rect is the slider element, not the fill.
  let dragging = false;
  function setFromEv(ev) {
    const r = powerSlider.getBoundingClientRect();
    const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
    state.power = f;
    syncPowerFill();
  }
  powerSlider.addEventListener("pointerdown", (ev) => {
    dragging = true;
    powerSlider.setPointerCapture?.(ev.pointerId);
    setFromEv(ev);
  });
  powerSlider.addEventListener("pointermove", (ev) => {
    if (dragging) setFromEv(ev);
  });
  powerSlider.addEventListener("pointerup", (ev) => {
    dragging = false;
    powerSlider.releasePointerCapture?.(ev.pointerId);
  });

  // P1-24 (cross-find combat-hud-identity-recklessness): retail
  // gmCombatUI's m_RecklessnessField (acclient.h:54502) labels this as
  // "Recklessness" — the slider drives the Recklessness skill +
  // power-bar value, not a generic "Power". The 0x10000051 element_id
  // is the same UIElement holding the label.
  const powerLabel = document.createElement("div");
  powerLabel.className = "hch-power-label";
  setAcText(powerLabel, "Recklessness");
  ov.appendChild(powerLabel);

  // Power-value readout (0x10000052).
  const powerVal = document.createElement("div");
  powerVal.className = "hch-slider-val";
  setAcText(powerVal, "100%");
  ov.appendChild(powerVal);

  // Row-2 label e.g. "Accuracy:" (0x10000053).
  const row2Label = document.createElement("div");
  row2Label.className = "hch-acc-label";
  setAcText(row2Label, "Accuracy");
  ov.appendChild(row2Label);

  // Row-2 value (0x10000054).
  const row2Val = document.createElement("div");
  row2Val.className = "hch-acc-val";
  setAcText(row2Val, "—");
  ov.appendChild(row2Val);

  // Trailing accuracy label (0x10000055).
  const accLabel = document.createElement("div");
  accLabel.className = "hch-acc-trailing";
  setAcText(accLabel, "Accuracy");
  ov.appendChild(accLabel);

  // Damage Rating readout (Phase 35). Lives in the row-2 dead space
  // between the trailing accuracy label and the height-button column.
  // Three child spans:
  //   - .hch-dr-total   "DR: +N"        (headline; brighter gold)
  //   - .hch-dr-break   "(base ..., sneak ..., reckless ...)"
  //   - .hch-dr-flag    "[SNEAK!]"      (display:none unless data-sneak)
  // updateDamageRating() rebuilds the contents on a poll + on
  // playerStatsUpdated/sneakAttackPredicted. data-sneak=1 toggles the
  // sneak-arm accent + [SNEAK!] tail tag.
  const drRow = document.createElement("div");
  drRow.className = "hch-dr-row";
  drRow.dataset.sneak = "0";
  const drTotal = document.createElement("span");
  drTotal.className = "hch-dr-total";
  drRow.appendChild(drTotal);
  const drBreak = document.createElement("span");
  drBreak.className = "hch-dr-break";
  drRow.appendChild(drBreak);
  const drFlag = document.createElement("span");
  drFlag.className = "hch-dr-flag";
  setAcText(drFlag, "[SNEAK!]");
  drRow.appendChild(drFlag);
  ov.appendChild(drRow);
  state.drRowEl = drRow;
  state.drTotalEl = drTotal;
  state.drBreakEl = drBreak;

  // Wave 15 / Phase 46 — "Last hit" readout row. Sibling to drRow,
  // anchored one line below it (y=48). DOM mirror of the DR row's
  // sub-span pattern so the CSS sneak-accent selector + average-tail
  // styling can target individual slices without rebuilds:
  //   .hch-lh-label   — "LAST HIT:"      (dim gold, uppercase)
  //   .hch-lh-dmg     — "47 dmg"         (brighter gold, bold)
  //   .hch-lh-sneak   — "[SneakAttack]"  (display:none unless data-sneak)
  //   .hch-lh-avg     — "Avg (last 5):"  (dim gold)
  //     └─ .hch-lh-avg-val "38"          (brighter gold inside the same span)
  // The row starts faded-out (data-idle="1") until the first
  // damageDealt arrives — no point flashing empty placeholders into
  // view on each combat-stance entry.
  const lhRow = document.createElement("div");
  lhRow.className = "hch-last-hit";
  lhRow.dataset.sneak = "0";
  lhRow.dataset.idle = "1";

  const lhLabel = document.createElement("span");
  lhLabel.className = "hch-lh-label";
  setAcText(lhLabel, "Last hit:");
  lhRow.appendChild(lhLabel);

  const lhDmg = document.createElement("span");
  lhDmg.className = "hch-lh-dmg";
  setAcText(lhDmg, "—");
  lhRow.appendChild(lhDmg);

  const lhSneak = document.createElement("span");
  lhSneak.className = "hch-lh-sneak";
  setAcText(lhSneak, "[SneakAttack]");
  lhRow.appendChild(lhSneak);

  const lhAvg = document.createElement("span");
  lhAvg.className = "hch-lh-avg";
  // Build the "Avg (last N):" label + value as two adjacent text nodes
  // so updates only repaint the numeric child via setAcText.
  lhAvg.appendChild(document.createTextNode(`Avg (last ${LAST_HIT_RING_CAPACITY}): `));
  const lhAvgVal = document.createElement("span");
  lhAvgVal.className = "hch-lh-avg-val";
  setAcText(lhAvgVal, "—");
  lhAvg.appendChild(lhAvgVal);
  lhRow.appendChild(lhAvg);

  ov.appendChild(lhRow);
  state.lhRowEl = lhRow;
  state.lhDmgEl = lhDmg;
  state.lhSneakEl = lhSneak;
  state.lhAvgValEl = lhAvgVal;

  // Right button column (0x10000056).
  const buttons = document.createElement("div");
  buttons.className = "hch-buttons";
  const HEIGHTS = [
    { id: "high",   label: "High",   value: 2 },
    { id: "medium", label: "Medium", value: 1 },
    { id: "low",    label: "Low",    value: 0 },
  ];
  const heightEls = { high: null, medium: null, low: null };
  // P1-24 (cross-find combat-hud-states-armed): mirror retail
  // `UIElement::SetState(Highlight)` when a height is selected so the
  // sprite swap visually anchors the user's choice. Synced from
  // `window.__combatBarState.attackHeight` (the cross-plugin truth set
  // by picking.js + combat-bar) AND from local clicks.
  function syncArmedFromState() {
    const v = window.__combatBarState?.attackHeight;
    if (v == null) return;
    for (const h of HEIGHTS) {
      if (heightEls[h.id]) heightEls[h.id].classList.toggle("armed", v === h.value);
    }
  }
  for (const h of HEIGHTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hch-height";
    btn.dataset.height = h.id;
    btn.dataset.heightValue = String(h.value);
    setAcText(btn, h.label);
    btn.title = `Attack at ${h.label} height`;
    btn.addEventListener("click", () => {
      // Mirrors plugins/combat-bar.js's Hi/Med/Lo wiring — calls
      // the global exposed by picking.js (line 375).
      if (typeof window.__fireAttackOnTarget === "function") {
        window.__fireAttackOnTarget(h.value);
      } else {
        console.warn("[combat-hud] __fireAttackOnTarget not exposed");
      }
      if (window.__combatBarState) {
        window.__combatBarState.attackHeight = h.value;
      }
      syncArmedFromState();
    });
    buttons.appendChild(btn);
    heightEls[h.id] = btn;
  }
  syncArmedFromState();
  ov.appendChild(buttons);

  document.body.appendChild(ov);
  attachDefaultTopDragHandle(ov, WINDOW_ID.COMBAT_HUD);

  // Apply retail layout positions for sub-elements once the DOM is wired.
  applyCombatHudLayout({
    mainEl: main,
    sliderEl: powerSlider,
    fillEl: powerFill,
    powerLabelEl: powerLabel,
    powerValEl: powerVal,
    row2LabelEl: row2Label,
    row2ValEl: row2Val,
    accLabelEl: accLabel,
    buttonsEl: buttons,
    heightEls,
  });

  return ov;
}

// Apply gmCombatUI 0x21000007 layout to the combat-hud's sub-elements.
// Sizes + positions come from the LayoutDesc; the hand-tuned CSS values
// in ensureStyles() are very close already (no 1-2px deltas; they were
// derived from the dump comment, but applying the layout at runtime
// makes the DAT the source of truth so future tweaks come from the
// asset rather than the plugin).
//
// Boot-order note: combat-hud mounts via mountBar() — same race window
// as radar. Retry every 2s up to 8 times (~16s) before giving up.
function applyCombatHudLayout(refs, attempt = 0) {
  const apply = (layout) => {
    if (!layout) {
      if (attempt < 8) {
        setTimeout(() => applyCombatHudLayout(refs, attempt + 1), 2000);
      }
      return;
    }
    let applied = 0;
    const pairs = [
      [COMBAT_HUD_ELEMS.main,        refs.mainEl],
      [COMBAT_HUD_ELEMS.slider,      refs.sliderEl],
      [COMBAT_HUD_ELEMS.sliderFill,  refs.fillEl],
      [COMBAT_HUD_ELEMS.powerLabel,  refs.powerLabelEl],
      [COMBAT_HUD_ELEMS.powerValue,  refs.powerValEl],
      [COMBAT_HUD_ELEMS.row2Label,   refs.row2LabelEl],
      [COMBAT_HUD_ELEMS.row2Value,   refs.row2ValEl],
      [COMBAT_HUD_ELEMS.accLabel,    refs.accLabelEl],
      [COMBAT_HUD_ELEMS.buttonCol,   refs.buttonsEl],
      [COMBAT_HUD_ELEMS.high,        refs.heightEls?.high],
      [COMBAT_HUD_ELEMS.med,         refs.heightEls?.medium],
      [COMBAT_HUD_ELEMS.low,         refs.heightEls?.low],
    ];
    for (const [id, el] of pairs) {
      if (!el) continue;
      const desc = findElementById(layout, id);
      if (!desc) continue;
      // Slider fill: x is the rest-position of the thumb (567×14 @ 70,0).
      // We DON'T want to apply that x as left — width is driven by
      // syncPowerFill(). Skip the x-write for the fill ref; width
      // comes from syncPowerFill at runtime.
      if (el === refs.fillEl) {
        if (typeof desc.y === "number") el.style.top = `${desc.y + 1}px`;
        if (typeof desc.height === "number") el.style.height = `${desc.height - 2}px`;
        applied += 1;
        continue;
      }
      // Hi/Med/Lo buttons: positions are relative to the .hch-buttons
      // container, which lives at (722, 4). Apply x/y as-is.
      if (typeof desc.x === "number") el.style.left = `${desc.x}px`;
      if (typeof desc.y === "number") el.style.top = `${desc.y}px`;
      if (typeof desc.width === "number") el.style.width = `${desc.width}px`;
      if (typeof desc.height === "number") el.style.height = `${desc.height}px`;
      applied += 1;
    }
    // After re-applying widths/positions, refresh the fill width to
    // honor the new slider track width.
    syncPowerFill();
    try {
      window.__diag?.layout?.onCombatHudApplied?.({ applied });
    } catch (_) {}
  };
  const cached = getCachedLayout(COMBAT_HUD_LAYOUT_ID);
  if (cached) { apply(cached); return; }
  loadLayout(COMBAT_HUD_LAYOUT_ID).then(apply).catch(() => {});
}

function show() {
  if (!state.overlayEl) state.overlayEl = build();
  state.overlayEl.dataset.open = "1";
  state.visible = true;
  syncPowerFill();
  // Phase 35: paint the DR readout immediately on open. The rAF poll
  // covers slider drags during the visible window; show() handles the
  // initial frame so the readout isn't blank for one rAF tick.
  state.drLastPower = -1;  // force a repaint regardless of prior value
  updateDamageRating();
}

function hide() {
  if (!state.overlayEl) return;
  state.overlayEl.dataset.open = "0";
  state.visible = false;
}

// Q1a (2026-05-26): "You died." overlay — fires off the kind=29
// Death bus event when victim matches local player. Cream serif on
// black-tinted backdrop, brass border, 3s auto-fade. No respawn
// button here (deferred to Wave R).
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
      padding: 28px 48px;
      background: rgba(0, 0, 0, 0.78);
      border: 2px solid var(--hb-border-brass);
      box-shadow: 0 6px 24px rgba(0, 0, 0, 0.75);
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream);
      font-size: 28px;
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

function showDeathOverlay(message) {
  ensureDeathStyles();
  let ov = document.getElementById(DEATH_OVERLAY_ID);
  if (!ov) {
    ov = document.createElement("div");
    ov.id = DEATH_OVERLAY_ID;
    document.body.appendChild(ov);
  }
  setAcText(ov, message || "You died.");
  // Force reflow so the opacity transition retriggers if the overlay
  // is already mounted (rapid back-to-back deaths in PK).
  ov.dataset.open = "0";
  void ov.offsetWidth;
  ov.dataset.open = "1";
  if (deathOverlayTimer) clearTimeout(deathOverlayTimer);
  deathOverlayTimer = setTimeout(() => {
    ov.dataset.open = "0";
    deathOverlayTimer = setTimeout(() => {
      ov.remove();
      deathOverlayTimer = null;
    }, 320);
  }, 3000);
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
  version: "0.1.0",
  description: "Retail gmCombatUI horizontal bar — auto-shows when in combat stance",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  state.overlayEl = build();
  syncPowerFill();
  updateDamageRating();

  // 4Hz poll of the authoritative stance source. Cheap; ~0.0001ms.
  const t = setInterval(() => {
    const inCombat = stanceIsCombat();
    if (inCombat && !state.visible) show();
    else if (!inCombat && state.visible) hide();
  }, 250);

  // Phase 35: rAF-poll the powerLevel / stance pair so a combat-bar
  // slider drag (which DOES NOT emit an event — see combat-bar.js:733
  // input handler that only writes the window state, no broadcast)
  // flows into the DR readout in real time. We diff against the last
  // observed power + stance and skip the rebuild when nothing changed,
  // so the per-frame cost is one global read + two integer compares.
  //
  // Why rAF instead of hooking into combat-bar.js's slider listener?
  // Two reasons: (a) avoids cross-plugin coupling (combat-bar's slider
  // DOM element isn't exposed); (b) covers BOTH sliders — our own
  // .hch-slider (build() lines 297-323) and combat-bar's — without
  // double-wiring. Cost is ~1 µs/frame; well under the rAF budget.
  let drRafId = 0;
  function drPollFrame() {
    drRafId = 0;
    if (!state.overlayEl) return;
    // Only repaint when visible — the overlay is display:none in
    // peace stance, so there's no point recomputing.
    if (state.visible) {
      const power = Number(window.__combatBarState?.powerLevel ?? 1.0) || 0;
      const stance = (typeof window.__getCurrentStanceLow === "function")
        ? (window.__getCurrentStanceLow() | 0)
        : 0;
      const sneakFlag = state.drHasSneak ? 1 : 0;
      if (
        power !== state.drLastPower
        || stance !== state.drLastStance
        || sneakFlag !== state.drLastSneakFlag
      ) {
        state.drLastStance = stance;
        updateDamageRating();
      }
    }
    drRafId = requestAnimationFrame(drPollFrame);
  }
  drRafId = requestAnimationFrame(drPollFrame);

  // Subscribe to the plugin event bus for reactive updates. The
  // pluginClient is created post-login, so mountBar may call us before
  // it exists. Poll until available, matching sneak-hud.js's pattern.
  //
  // Wave 15 / Phase 46 added `damageDealt` to the same hook block so
  // the three subscriptions share the post-login readiness gate — no
  // separate retry loop for the last-hit row.
  let drPluginPoll = null;
  let drUnsubStats = null;
  let drUnsubSneak = null;
  let lhUnsubDamage = null;
  function drTryHookEvents() {
    const client = window.__pluginClient;
    if (!client?.events?.on) return false;
    client.events.on("playerStatsUpdated", onPlayerStatsUpdated);
    client.events.on("sneakAttackPredicted", onSneakAttackPredicted);
    client.events.on("damageDealt", onDamageDealt);
    drUnsubStats = () => {
      try { client.events.off("playerStatsUpdated", onPlayerStatsUpdated); } catch (_) {}
    };
    drUnsubSneak = () => {
      try { client.events.off("sneakAttackPredicted", onSneakAttackPredicted); } catch (_) {}
    };
    lhUnsubDamage = () => {
      try { client.events.off("damageDealt", onDamageDealt); } catch (_) {}
    };
    // Recompute now that we can read fresh stats.
    updateDamageRating();
    return true;
  }
  if (!drTryHookEvents()) {
    drPluginPoll = setInterval(() => {
      if (drTryHookEvents()) {
        clearInterval(drPluginPoll);
        drPluginPoll = null;
      }
    }, 500);
  }

  // Q1a: subscribe to the Death bus event for the self-death overlay.
  const pc = window.__pluginClient;
  if (pc?.events?.on) {
    pc.events.on("death", onDeath);
  }

  return () => {
    clearInterval(t);
    if (drRafId) cancelAnimationFrame(drRafId);
    drRafId = 0;
    if (drPluginPoll) clearInterval(drPluginPoll);
    drPluginPoll = null;
    if (state.drSneakTimer) {
      clearTimeout(state.drSneakTimer);
      state.drSneakTimer = null;
    }
    state.drHasSneak = false;
    // Phase 46: tear down the last-hit subscription + idle timer.
    // Clear the ring + DOM refs so a remount starts fresh (the new
    // `build()` call replaces them; the explicit nulling here keeps
    // the state object honest for tests / debug snapshots).
    if (state.lhIdleTimer) {
      clearTimeout(state.lhIdleTimer);
      state.lhIdleTimer = null;
    }
    state.lhRing.length = 0;
    state.lhRowEl = null;
    state.lhDmgEl = null;
    state.lhSneakEl = null;
    state.lhAvgValEl = null;
    if (drUnsubStats) drUnsubStats();
    if (drUnsubSneak) drUnsubSneak();
    if (lhUnsubDamage) lhUnsubDamage();
    drUnsubStats = null;
    drUnsubSneak = null;
    lhUnsubDamage = null;
    if (state.overlayEl) {
      state.overlayEl.remove();
      state.overlayEl = null;
    }
    if (pc?.events?.off) {
      pc.events.off("death", onDeath);
    }
    if (deathOverlayTimer) {
      clearTimeout(deathOverlayTimer);
      deathOverlayTimer = null;
    }
    const dov = document.getElementById(DEATH_OVERLAY_ID);
    if (dov) dov.remove();
  };
}

// Debug: pop the bar without needing combat stance.
if (typeof window !== "undefined") {
  window.__combatHudDebug = function () {
    ensureStyles();
    if (!state.overlayEl) state.overlayEl = build();
    show();
  };
}
