import {
  getSpellBarSlots,
  setSpellBarSlot,
  getActiveSpellBar,
  setActiveSpellBar,
  SPELL_BAR_TABS,
  loadCatalog,
} from "./spellbook.js";

const STORAGE_KEY = "holtburger_combat_bar_v1";

const DEFAULTS = {
  attackHeight: 2, // MEDIUM
  powerLevel: 1.0,
  autoRepeat: true,
  chargeAttack: true, // Phase I.1 — auto-pursue to attack range on click
  armedSpellId: 0, // 0 = no spell armed
  spellBarSlots: [], // populated by the Spellbook plugin (📖)
};

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    return { ...DEFAULTS, ...parsed };
  } catch {
    return { ...DEFAULTS };
  }
}

function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // localStorage may be unavailable (private mode); silently drop
  }
}

function syncWindowState(state) {
  window.__combatBarState = {
    attackHeight: state.attackHeight,
    powerLevel: state.powerLevel,
    autoRepeat: state.autoRepeat,
    chargeAttack: state.chargeAttack !== false,
    armedSpellId: state.armedSpellId,
    spellBarSlots: state.spellBarSlots || [],
  };
}

// Module-scope disarm helper. Clears armedSpellId in localStorage +
// window.__combatBarState without touching DOM. Used by the mount()
// event subscribers (death / zone change) so the disarm works even
// when the combat-bar panel is closed. When the panel IS open,
// activate()'s local setArmed updates the row "armed" class; the
// next renderRows after reopen reads the fresh state either way.
function clearArmedSpell() {
  const state = loadState();
  if (state.armedSpellId === 0) return;
  state.armedSpellId = 0;
  saveState(state);
  syncWindowState(state);
}

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-combat-bar-style";
  style.textContent = `
    .hb-cb-row {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 12px;
    }
    .hb-cb-row label {
      flex: 0 0 auto;
      color: rgba(255, 255, 255, 0.75);
    }
    .hb-cb-heights {
      display: flex;
      gap: 4px;
      flex: 1;
    }
    .hb-cb-height-btn {
      flex: 1;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.06);
      border: 1px solid rgba(255, 255, 255, 0.15);
      color: rgba(255, 255, 255, 0.8);
      border-radius: 4px;
      font-size: 12px;
      font-family: inherit;
      cursor: pointer;
    }
    .hb-cb-height-btn:hover {
      background: rgba(255, 255, 255, 0.12);
    }
    .hb-cb-height-btn.active {
      background: rgba(255, 120, 60, 0.4);
      border-color: rgba(255, 140, 80, 0.7);
      color: #fff;
    }
    .hb-cb-power-row input[type="range"] {
      flex: 1;
    }
    .hb-cb-power-val {
      flex: 0 0 36px;
      text-align: right;
      font-variant-numeric: tabular-nums;
      color: rgba(255, 255, 255, 0.7);
    }
    .hb-cb-toggle {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: rgba(255, 255, 255, 0.75);
      cursor: pointer;
    }
    .hb-cb-stance-row {
      margin-bottom: 6px;
      padding-bottom: 6px;
      border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    }
    .hb-cb-stance-val {
      flex: 1;
      font-weight: 600;
      color: #fff;
    }
    .hb-cb-stance-btn {
      padding: 4px 10px;
      background: rgba(255, 255, 255, 0.10);
      border: 1px solid rgba(255, 255, 255, 0.22);
      border-radius: 3px;
      color: #fff;
      font: inherit;
      font-size: 12px;
      cursor: pointer;
    }
    .hb-cb-stance-btn:hover {
      background: rgba(255, 255, 255, 0.18);
    }
    .hb-cb-hint {
      font-size: 11px;
      color: rgba(255, 255, 255, 0.45);
      margin-top: 6px;
      line-height: 1.4;
    }
    .hb-cb-feed {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
      display: flex;
      flex-direction: column;
      gap: 2px;
      font-size: 11px;
      line-height: 1.35;
      max-height: 90px;
      overflow-y: auto;
    }
    .hb-cb-feed-line {
      color: rgba(255, 255, 255, 0.65);
      font-variant-numeric: tabular-nums;
    }
    .hb-cb-feed-line.hb-cb-feed-hit { color: rgba(255, 200, 120, 0.9); }
    .hb-cb-feed-line.hb-cb-feed-taken { color: rgba(255, 130, 130, 0.9); }
    .hb-cb-feed-line.hb-cb-feed-miss { color: rgba(180, 180, 180, 0.7); font-style: italic; }
    .hb-cb-feed-empty {
      color: rgba(255, 255, 255, 0.35);
      font-style: italic;
    }
    .hb-cb-spells {
      display: flex;
      flex-direction: column;
      gap: 3px;
      margin-bottom: 8px;
      max-height: 200px;
      overflow-y: auto;
    }
    .hb-cb-spell {
      display: flex;
      align-items: center;
      gap: 6px;
      padding: 4px 6px;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 4px;
      cursor: pointer;
      font-size: 11px;
      color: rgba(255, 255, 255, 0.8);
      font-family: inherit;
      text-align: left;
    }
    .hb-cb-spell:hover {
      background: rgba(255, 255, 255, 0.1);
      border-color: rgba(255, 255, 255, 0.2);
    }
    .hb-cb-spell.armed {
      background: rgba(160, 110, 255, 0.4);
      border-color: rgba(180, 130, 255, 0.7);
      color: #fff;
    }
    .hb-cb-spell-action {
      flex: 0 0 38px;
      font-weight: 600;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      font-size: 9px;
      color: rgba(255, 255, 255, 0.55);
    }
    .hb-cb-spell.armed .hb-cb-spell-action {
      color: #fff;
    }
    .hb-cb-spell-name {
      flex: 1;
    }
    .hb-cb-spell-tag {
      flex: 0 0 auto;
      font-size: 9px;
      padding: 1px 5px;
      background: rgba(0, 0, 0, 0.3);
      border-radius: 3px;
      color: rgba(255, 255, 255, 0.45);
    }
    .hb-cb-magic-hint {
      margin-bottom: 8px;
      font-size: 11px;
      color: rgba(180, 130, 255, 0.85);
    }
    .hb-cb-tabs {
      display: flex;
      gap: 2px;
      margin-bottom: 8px;
    }
    .hb-cb-tab {
      flex: 1;
      padding: 3px 0;
      font-size: 11px;
      font-family: inherit;
      background: rgba(255, 255, 255, 0.04);
      border: 1px solid rgba(255, 255, 255, 0.1);
      border-radius: 3px;
      color: rgba(255, 255, 255, 0.55);
      cursor: pointer;
      text-align: center;
    }
    .hb-cb-tab:hover {
      background: rgba(255, 255, 255, 0.1);
      color: rgba(255, 255, 255, 0.85);
    }
    .hb-cb-tab.active {
      background: rgba(160, 110, 255, 0.4);
      border-color: rgba(180, 130, 255, 0.7);
      color: #fff;
      font-weight: 600;
    }
    .hb-cb-power-meter {
      margin-top: 10px;
      padding-top: 8px;
      border-top: 1px solid rgba(255, 255, 255, 0.12);
    }
    .hb-cb-power-meter-label {
      font-size: 10px;
      color: rgba(255, 255, 255, 0.55);
      margin-bottom: 4px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .hb-cb-power-meter-bar {
      position: relative;
      height: 12px;
      background: rgba(0, 0, 0, 0.5);
      border: 1px solid rgba(255, 255, 255, 0.15);
      border-radius: 3px;
      overflow: hidden;
    }
    .hb-cb-power-meter-fill {
      position: absolute;
      top: 0; left: 0; bottom: 0;
      width: 0%;
      background: linear-gradient(180deg, #ffaa44, #cc6622);
      transition: width 100ms linear;
    }
    .hb-cb-power-meter.refilling .hb-cb-power-meter-fill {
      background: linear-gradient(180deg, #ffaa44, #cc6622);
    }
    .hb-cb-power-meter.ready .hb-cb-power-meter-fill {
      background: linear-gradient(180deg, #88ff88, #44cc44);
    }
  `;
  document.head.appendChild(style);
}

// Stance enum values that mean "ranged combat" — used to flip the
// slider label from Power → Accuracy. Mirrors RANGED_STANCES in
// index.html.
const RANGED_STANCES = new Set([
  0x003f, 0x0041, 0x0043, 0x0047, 0x00e8, 0x00e9, 0x013b, 0x013c,
]);
// Melee stance enum values (HandCombat, SwordCombat, etc.) — needed
// by `stanceWord()` after folding the standalone `stance-toggle`
// plugin in here. Mirrors MELEE_STANCES in `plugins/stance-toggle.js`
// (kept for symmetry with RANGED_STANCES). Pre-2026-05-17 this was
// missing and `stanceWord()` threw a ReferenceError on the first
// `MELEE_STANCES.has(low)` call, aborting the rest of `activate()` —
// so the panel rendered only the stance row + empty button.
const MELEE_STANCES = new Set([
  0x003c, 0x003e, 0x0040, 0x0044, 0x0046,
]);
function currentStanceIsRanged() {
  const fn = typeof window !== "undefined" ? window.__getCurrentStanceLow : null;
  if (typeof fn !== "function") return false;
  try {
    return RANGED_STANCES.has(fn());
  } catch {
    return false;
  }
}
function currentStanceIsMagic() {
  const fn = typeof window !== "undefined" ? window.__getCurrentStanceLow : null;
  if (typeof fn !== "function") return false;
  try {
    return fn() === 0x0049; // Magic stance (wand / orb / magic staff + combat mode)
  } catch {
    return false;
  }
}

// Seed window.__combatBarState at import time so picking.js reads
// the persisted values (or DEFAULTS on a fresh session) even when
// the user never opens the panel this session.
if (typeof window !== "undefined") {
  syncWindowState(loadState());
}

// Stance label — one-word descriptor read off the wasm-side stance.
// Mirrors `plugins/stance-toggle.js`'s classifyStance + STANCE_LABELS
// before that plugin was folded in here (2026-05-17).
function stanceWord() {
  const low = (typeof window !== "undefined" && typeof window.__getCurrentStanceLow === "function")
    ? window.__getCurrentStanceLow()
    : 0x003d;
  if (low === 0x003d) return "Peace";
  if (low === 0x0049) return "Magic";
  if (RANGED_STANCES.has(low)) return "Missile";
  if (MELEE_STANCES.has(low)) return "Melee";
  return "Other";
}

// Header injected at the top of every stance-form (attack controls
// AND spell picker). Folds the old `stance-toggle` plugin into the
// combat-bar so one panel covers stance + attack settings + spell
// picking. The bar slot for stance-toggle was removed from
// index.html on the same change.
function renderStanceHeader(bodyEl, client) {
  const row = document.createElement("div");
  row.className = "hb-cb-row hb-cb-stance-row";
  const label = document.createElement("label");
  label.textContent = "Stance";
  row.appendChild(label);
  const val = document.createElement("span");
  val.className = "hb-cb-stance-val";
  row.appendChild(val);
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hb-cb-stance-btn";
  row.appendChild(btn);
  bodyEl.appendChild(row);

  function refresh() {
    const w = stanceWord();
    val.textContent = w;
    btn.textContent = w === "Peace" ? "Combat" : "Peace";
  }
  btn.addEventListener("click", () => {
    try {
      // Use the JS-side stance label as the source of truth for
      // current state — ACE's `PrivateUpdatePropertyInt(CombatMode)`
      // doesn't reliably hydrate `world.player.combat_mode` on the
      // wasm side, so the older `toggleCombatMode()` path always
      // sees `Undef` and only ever toggles to Melee. By computing
      // the target mode here from `__getCurrentStanceLow()` (which
      // IS authoritative — `applyConfirmedStance` updates it on
      // every kind=5 UpdateMotion) and sending it explicitly via
      // `setCombatMode`, the toggle works in both directions.
      // CombatMode wire values: 1=NonCombat, 2=Melee.
      const inCombat = stanceWord() !== "Peace";
      const handle = window.__sessionHandle;
      if (typeof handle?.setCombatMode === "function") {
        handle.setCombatMode(inCombat ? 1 : 2);
      } else if (typeof client?.player?.toggleCombatMode === "function") {
        // Fallback for older wasm bundles without setCombatMode.
        client.player.toggleCombatMode();
      }
    } catch (e) {
      console.warn(`[combat-bar] setCombatMode failed: ${e?.message ?? e}`);
    }
    setTimeout(refresh, 250);
  });
  if (client?.events?.on) {
    const onStats = () => refresh();
    client.events.on("playerStatsUpdated", onStats);
    bodyEl.__stanceHeaderDispose = () => {
      try { client.events.off("playerStatsUpdated", onStats); } catch {}
    };
  } else {
    bodyEl.__stanceHeaderDispose = () => {};
  }
  refresh();
}

// ── Render helpers ──────────────────────────────────────────────
// Each render fn populates `bodyEl` with its stance-specific UI;
// they share the damage-feed code at the bottom of activate().

function renderAttackControls(bodyEl, state) {
  // Height picker — one-word labels (Hi/Mid/Lo). Stance header is
  // injected by activate() before this fn runs.
  const heightRow = document.createElement("div");
  heightRow.className = "hb-cb-row";
  const heightLabel = document.createElement("label");
  heightLabel.textContent = "Height";
  heightRow.appendChild(heightLabel);
  const heightGroup = document.createElement("div");
  heightGroup.className = "hb-cb-heights";
  const HEIGHTS = [
    { value: 1, label: "Hi" },
    { value: 2, label: "Mid" },
    { value: 3, label: "Lo" },
  ];
  const heightButtons = new Map();
  for (const h of HEIGHTS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-cb-height-btn";
    btn.textContent = h.label;
    btn.dataset.value = String(h.value);
    if (state.attackHeight === h.value) btn.classList.add("active");
    btn.addEventListener("click", () => {
      state.attackHeight = h.value;
      for (const [v, b] of heightButtons) {
        b.classList.toggle("active", v === h.value);
      }
      saveState(state);
      syncWindowState(state);
    });
    heightButtons.set(h.value, btn);
    heightGroup.appendChild(btn);
  }
  heightRow.appendChild(heightGroup);
  bodyEl.appendChild(heightRow);

  // Power / Accuracy slider — label flips based on local combat stance.
  const powerRow = document.createElement("div");
  powerRow.className = "hb-cb-row hb-cb-power-row";
  const powerLabel = document.createElement("label");
  powerLabel.textContent = currentStanceIsRanged() ? "Accuracy" : "Power";
  powerRow.appendChild(powerLabel);
  const powerSlider = document.createElement("input");
  powerSlider.type = "range";
  powerSlider.min = "0";
  powerSlider.max = "100";
  powerSlider.step = "1";
  powerSlider.value = String(Math.round(state.powerLevel * 100));
  const powerVal = document.createElement("span");
  powerVal.className = "hb-cb-power-val";
  powerVal.textContent = `${powerSlider.value}%`;
  // F1 — coalesce slider `input` syncs to one per animation frame.
  // The label / numeric readout updates synchronously (cheap, and
  // the user wants instant visual feedback), but `syncWindowState`
  // (which writes window.__combatBarState and is polled by picking +
  // wire dispatch) only fires once per frame at most. Drag at 60+ Hz
  // → 60 Hz max writes instead of one per pointermove tick.
  //
  // F2 already uses a `rafId` inside the power-meter IIFE; that
  // closure is separate so a unique name here (`_powerSyncRafId`)
  // keeps the two coalescers clearly distinct.
  let _powerSyncRafId = 0;
  powerSlider.addEventListener("input", () => {
    state.powerLevel = Number(powerSlider.value) / 100;
    powerVal.textContent = `${powerSlider.value}%`;
    if (_powerSyncRafId !== 0) return; // already scheduled this frame
    _powerSyncRafId = requestAnimationFrame(() => {
      _powerSyncRafId = 0;
      syncWindowState(state);
    });
  });
  powerSlider.addEventListener("change", () => {
    // Release — cancel any pending coalesced sync and flush the final
    // value immediately so the wire-side state lands without waiting
    // another frame, then persist to localStorage.
    if (_powerSyncRafId !== 0) {
      cancelAnimationFrame(_powerSyncRafId);
      _powerSyncRafId = 0;
    }
    syncWindowState(state);
    saveState(state);
  });
  powerRow.appendChild(powerSlider);
  powerRow.appendChild(powerVal);
  bodyEl.appendChild(powerRow);

  // Auto-repeat tickbox
  const repeatLabel = document.createElement("label");
  repeatLabel.className = "hb-cb-toggle";
  const repeatBox = document.createElement("input");
  repeatBox.type = "checkbox";
  repeatBox.checked = !!state.autoRepeat;
  repeatBox.addEventListener("change", () => {
    state.autoRepeat = repeatBox.checked;
    saveState(state);
    syncWindowState(state);
  });
  repeatLabel.appendChild(repeatBox);
  const repeatText = document.createElement("span");
  repeatText.textContent = "Repeat";
  repeatLabel.appendChild(repeatText);
  bodyEl.appendChild(repeatLabel);

  // Phase I.1 — Charge Attack tickbox (retail's "Use Charge Attack").
  const chargeLabel = document.createElement("label");
  chargeLabel.className = "hb-cb-toggle";
  const chargeBox = document.createElement("input");
  chargeBox.type = "checkbox";
  chargeBox.checked = state.chargeAttack !== false;
  chargeBox.addEventListener("change", () => {
    state.chargeAttack = chargeBox.checked;
    saveState(state);
    syncWindowState(state);
  });
  chargeLabel.appendChild(chargeBox);
  const chargeText = document.createElement("span");
  chargeText.textContent = "Charge";
  chargeLabel.appendChild(chargeText);
  bodyEl.appendChild(chargeLabel);

  // Phase H.6 — power-bar meter. Subscribes to combatCommenceAttack +
  // attackDone events to animate the refill cycle. Refill duration is
  // approximated from the current power slider (retail's
  // nextRefillTime ≈ PowerLevel × ~1.5s for melee). We don't know the
  // exact refillMod ACE uses; the visual feedback approximates it.
  const meter = document.createElement("div");
  meter.className = "hb-cb-power-meter ready";
  const meterBar = document.createElement("div");
  meterBar.className = "hb-cb-power-meter-bar";
  const meterFill = document.createElement("div");
  meterFill.className = "hb-cb-power-meter-fill";
  meterFill.style.width = "100%";
  meterBar.appendChild(meterFill);
  meter.appendChild(meterBar);
  bodyEl.appendChild(meter);

  // Expose tween handle so the activate() teardown can clear it.
  bodyEl.__powerMeterDispose = (function attachPowerMeter() {
    const client = window.__pluginClient;
    if (!client?.events?.on) return () => {};

    let refillStartMs = 0;
    let refillDurMs = 1500;
    let rafId = 0;
    // F2: when the bar / panel is hidden mid-refill we stop scheduling
    // rAFs and remember to resume on the next visible frame so the
    // power slider, refill duration, and elapsed time all stay correct.
    let pendingResume = false;
    let visibilityObserver = null;

    function isHidden() {
      // offsetParent === null catches display:none on any ancestor and
      // detachment from the DOM. It's the cheapest layout-free check
      // (no getBoundingClientRect → no forced reflow).
      return meterFill.offsetParent === null;
    }

    function tick() {
      // F2 gate — bail without scheduling another frame if the meter
      // (or any ancestor) is display:none / detached. The next
      // combatCommenceAttack will reset state + restart; the
      // visibilityObserver below picks up "becomes visible again with
      // refill still in flight" so the meter resumes from where it
      // would have been.
      if (isHidden()) {
        pendingResume = true;
        rafId = 0;
        return;
      }
      pendingResume = false;
      const elapsed = performance.now() - refillStartMs;
      const t = Math.min(1, elapsed / refillDurMs);
      meterFill.style.width = `${(t * 100).toFixed(1)}%`;
      if (t < 1) {
        rafId = requestAnimationFrame(tick);
      } else {
        meter.classList.remove("refilling");
        meter.classList.add("ready");
        rafId = 0;
      }
    }

    // F2 restart path — watch the panel subtree for attribute changes
    // (display / class toggles on any ancestor of the meter). When the
    // meter flips back to visible while a refill is still pending,
    // re-enter tick() so the loop picks up from where it left off
    // (refillStartMs is preserved across the hidden interval, so the
    // first visible frame snaps to the correct elapsed position).
    if (typeof MutationObserver === "function") {
      visibilityObserver = new MutationObserver(() => {
        if (pendingResume && !isHidden() && rafId === 0) {
          rafId = requestAnimationFrame(tick);
        }
      });
      // Walk up to the nearest containing panel root (or body) and
      // watch style/class mutations on each ancestor. attributeFilter
      // keeps the observer cheap.
      let node = meterFill.parentElement;
      while (node && node !== document.body) {
        visibilityObserver.observe(node, {
          attributes: true,
          attributeFilter: ["style", "class", "hidden"],
        });
        node = node.parentElement;
      }
    }

    const onCommence = () => {
      // Power slider drives expected refill duration.
      const power = (window.__combatBarState?.powerLevel ?? 1.0);
      refillDurMs = 600 + power * 1200; // ~0.6s low, ~1.8s full
      refillStartMs = performance.now();
      meter.classList.remove("ready");
      meter.classList.add("refilling");
      meterFill.style.width = "0%";
      if (rafId) cancelAnimationFrame(rafId);
      // F2: if the bar is hidden right now, mark pending so the
      // visibilityObserver picks it up when we become visible again.
      // Don't schedule a frame we'd immediately bail on.
      if (isHidden()) {
        pendingResume = true;
        rafId = 0;
        return;
      }
      pendingResume = false;
      rafId = requestAnimationFrame(tick);
    };
    const onDone = () => {
      // AttackDone — power refilled, ready for next swing.
      meter.classList.remove("refilling");
      meter.classList.add("ready");
      meterFill.style.width = "100%";
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      pendingResume = false;
    };

    client.events.on("combatCommenceAttack", onCommence);
    client.events.on("attackDone", onDone);
    // F2 open-path restart: if attachPowerMeter is re-entered while a
    // refill is in flight (e.g. the panel was reopened mid-refill in
    // a future architecture that retains meter state across opens),
    // start the loop straight away. In the current code each activate()
    // creates a fresh closure so this is a no-op, but the check makes
    // the gate self-contained.
    if (meter.classList.contains("refilling") && rafId === 0 && !isHidden()) {
      rafId = requestAnimationFrame(tick);
    }
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (visibilityObserver) visibilityObserver.disconnect();
      client.events.off("combatCommenceAttack", onCommence);
      client.events.off("attackDone", onDone);
    };
  })();
}

function renderSpellPicker(bodyEl, state, client) {
  // Banner naming the stance — magic combat with wand/orb/staff equipped.
  const hint = document.createElement("div");
  hint.className = "hb-cb-magic-hint";
  hint.textContent =
    "Magic stance — click a self-spell to cast on yourself, or arm a target spell then click an enemy.";
  bodyEl.appendChild(hint);

  // Phase I.2 — numbered tab strip (retail had 7).
  const tabsEl = document.createElement("div");
  tabsEl.className = "hb-cb-tabs";
  const tabButtons = [];
  for (let i = 0; i < SPELL_BAR_TABS; i++) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.className = "hb-cb-tab";
    tab.textContent = String(i + 1);
    tab.dataset.tabIndex = String(i);
    tab.title = `Spell bar ${i + 1}`;
    tab.addEventListener("click", () => {
      setActiveSpellBar(i);
      // Re-highlight; renderRows fires from the spellbar-changed event.
      for (const t of tabButtons) {
        t.classList.toggle("active", Number(t.dataset.tabIndex) === i);
      }
    });
    // Phase I.2 — also accept dropped spells onto a tab to populate it.
    tab.addEventListener("dragover", (ev) => {
      if (ev.dataTransfer.types.includes("application/x-hb-spell-id")) {
        ev.preventDefault();
        ev.dataTransfer.dropEffect = "copy";
        tab.style.background = "rgba(160, 110, 255, 0.5)";
      }
    });
    tab.addEventListener("dragleave", () => {
      tab.style.background = "";
    });
    tab.addEventListener("drop", (ev) => {
      ev.preventDefault();
      tab.style.background = "";
      const draggedId = parseInt(ev.dataTransfer.getData("application/x-hb-spell-id"), 10);
      if (!Number.isFinite(draggedId) || draggedId <= 0) return;
      // Drop onto an inactive tab: switch to it, add to first empty slot.
      const targetTab = Number(tab.dataset.tabIndex);
      setActiveSpellBar(targetTab);
      const slots = getSpellBarSlots(targetTab);
      const empty = slots.findIndex((v) => v === 0);
      setSpellBarSlot(empty === -1 ? slots.length - 1 : empty, draggedId, targetTab);
      for (const t of tabButtons) {
        t.classList.toggle("active", Number(t.dataset.tabIndex) === targetTab);
      }
    });
    tabButtons.push(tab);
    tabsEl.appendChild(tab);
  }
  function refreshTabActive() {
    const active = getActiveSpellBar();
    for (const t of tabButtons) {
      t.classList.toggle("active", Number(t.dataset.tabIndex) === active);
    }
  }
  refreshTabActive();
  bodyEl.appendChild(tabsEl);

  const list = document.createElement("div");
  list.className = "hb-cb-spells";
  bodyEl.appendChild(list);

  let catalog = null;
  const rows = new Map();

  function setArmed(spellId) {
    state.armedSpellId = spellId;
    saveState(state);
    syncWindowState(state);
    for (const [id, row] of rows) {
      row.classList.toggle("armed", id === spellId && spellId !== 0);
    }
  }

  function renderRows() {
    list.innerHTML = "";
    rows.clear();

    const slots = getSpellBarSlots();
    const populated = slots.filter((v) => v > 0);

    if (populated.length === 0) {
      const empty = document.createElement("div");
      empty.className = "hb-cb-hint";
      empty.style.padding = "10px 4px";
      empty.style.color = "rgba(255, 255, 255, 0.55)";
      empty.textContent =
        "No spells on the magic combat bar. Open the 📖 Spellbook and double-click known spells to add them here.";
      list.appendChild(empty);
      return;
    }

    for (let i = 0; i < slots.length; i++) {
      const spellId = slots[i];
      if (spellId === 0) {
        // Phase H.5 — empty slot rendered as drop target so user can
        // drop a dragged spell into a specific position. The slot
        // appears as a thin dashed placeholder.
        const placeholder = document.createElement("div");
        placeholder.className = "hb-cb-spell hb-cb-spell-empty";
        placeholder.dataset.slotIndex = String(i);
        placeholder.style.borderStyle = "dashed";
        placeholder.style.opacity = "0.4";
        placeholder.style.cursor = "default";
        const action = document.createElement("span");
        action.className = "hb-cb-spell-action";
        action.textContent = `${i + 1}`;
        placeholder.appendChild(action);
        const empty = document.createElement("span");
        empty.className = "hb-cb-spell-name";
        empty.textContent = "(empty — drop a spell here)";
        empty.style.color = "rgba(255, 255, 255, 0.4)";
        empty.style.fontStyle = "italic";
        placeholder.appendChild(empty);
        placeholder.addEventListener("dragover", (ev) => {
          if (ev.dataTransfer.types.includes("application/x-hb-spell-id")) {
            ev.preventDefault();
            ev.dataTransfer.dropEffect = "copy";
            placeholder.style.opacity = "1";
            placeholder.style.borderColor = "rgba(160, 110, 255, 0.7)";
          }
        });
        placeholder.addEventListener("dragleave", () => {
          placeholder.style.opacity = "0.4";
          placeholder.style.borderColor = "";
        });
        placeholder.addEventListener("drop", (ev) => {
          ev.preventDefault();
          const draggedId = parseInt(ev.dataTransfer.getData("application/x-hb-spell-id"), 10);
          if (Number.isFinite(draggedId) && draggedId > 0) {
            setSpellBarSlot(i, draggedId);
          }
        });
        list.appendChild(placeholder);
        continue;
      }
      const meta = catalog ? catalog[String(spellId)] : null;
      const row = document.createElement("button");
      row.type = "button";
      row.className = "hb-cb-spell";
      row.dataset.spellId = String(spellId);
      row.dataset.slotIndex = String(i);
      const isUntargeted = meta?.untargeted ?? true;
      if (state.armedSpellId === spellId && !isUntargeted) {
        row.classList.add("armed");
      }
      // Phase H.5 — accept dragged spells from the Spellbook plugin.
      row.addEventListener("dragover", (ev) => {
        if (ev.dataTransfer.types.includes("application/x-hb-spell-id")) {
          ev.preventDefault();
          ev.dataTransfer.dropEffect = "copy";
        }
      });
      row.addEventListener("drop", (ev) => {
        ev.preventDefault();
        const draggedId = parseInt(ev.dataTransfer.getData("application/x-hb-spell-id"), 10);
        if (Number.isFinite(draggedId) && draggedId > 0) {
          setSpellBarSlot(i, draggedId);
        }
      });

      const action = document.createElement("span");
      action.className = "hb-cb-spell-action";
      action.textContent = isUntargeted ? "Cast" : "Arm";
      row.appendChild(action);

      const name = document.createElement("span");
      name.className = "hb-cb-spell-name";
      name.textContent = meta?.name ?? `Spell 0x${spellId.toString(16)}`;
      row.appendChild(name);

      const tag = document.createElement("span");
      tag.className = "hb-cb-spell-tag";
      tag.textContent = isUntargeted ? "self" : (meta?.school ? schoolName(meta.school) : "target");
      row.appendChild(tag);

      row.addEventListener("click", () => {
        if (isUntargeted) {
          try {
            if (client?.player?.castSpell) {
              client.player.castSpell(spellId, null);
            }
          } catch (e) {
            console.warn(`[combat-bar] cast(${spellId}) failed: ${e?.message ?? e}`);
          }
        } else {
          setArmed(state.armedSpellId === spellId ? 0 : spellId);
        }
      });

      rows.set(spellId, row);
      list.appendChild(row);
    }
  }

  // Initial draw + load catalog → second draw with names.
  renderRows();
  loadCatalog().then((c) => {
    catalog = c;
    renderRows();
  });

  // Re-render when the spellbook plugin updates the slots or
  // when the user switches the active tab.
  const onSpellbarChanged = () => {
    refreshTabActive();
    renderRows();
  };
  window.addEventListener("hb-spellbar-changed", onSpellbarChanged);

  // (No teardown needed for the slot listener — bar.js calls our
  // returned dispose; the damage-feed return-fn below adds + manages
  // its own teardown chain.)
  // We store this so the outer activate() can include it in dispose.
  bodyEl.__spellPickerDispose = () => {
    window.removeEventListener("hb-spellbar-changed", onSpellbarChanged);
  };
}

function schoolName(s) {
  return { 1: "War", 2: "Life", 3: "Item", 4: "Creature", 5: "Void" }[s] ?? "?";
}

export const manifest = {
  id: "combat-bar",
  name: "Combat",
  icon: "⚔",
  version: "0.1.0",
  description: "Stance toggle + attack settings + spell picker",
};

// Auto-disarm subscriptions. Mount runs at bar init (pre-login) so
// the plugin keeps a live disarm hook even when the panel is closed.
// Two trigger events:
//   - `landblockChanged` — zone exit clears armed spell (matches
//     retail AC's "armed spell cleared on portal / teleport")
//   - `playerStatsUpdated` with HP=0 — death clears armed spell
// The first emission of `landblockChanged` also catches the
// log-in case (lastLocalPlayerLb starts at 0 in index.html), so
// reloading the page with a stale armed spell no longer leaves the
// UI lying to the user.
export function mount(ctx) {
  let pollTimer = null;
  let unsubLb = null;
  let unsubStats = null;

  function tryHook() {
    const client = ctx?.client ?? window.__pluginClient ?? null;
    if (!client?.events?.on || !client?.player) {
      return false;
    }
    const onZoneChange = () => clearArmedSpell();
    const onStatsUpdated = () => {
      try {
        const stats = client.player.stats;
        const vitals = stats?.vitals;
        if (!vitals) return;
        // vitals packs [type, current, base, buffed_max] × N — see
        // plugins/vitals-hud.js for the same wire-layout reader.
        // Type 1 = HP; current at offset +1.
        for (let i = 0; i + 3 < vitals.length; i += 4) {
          if (vitals[i] === 1 && vitals[i + 1] === 0) {
            clearArmedSpell();
            return;
          }
        }
      } catch {
        // Stats accessor can throw pre-biota; ignore.
      }
    };
    client.events.on("landblockChanged", onZoneChange);
    client.events.on("playerStatsUpdated", onStatsUpdated);
    unsubLb = () => client.events.off("landblockChanged", onZoneChange);
    unsubStats = () => client.events.off("playerStatsUpdated", onStatsUpdated);
    return true;
  }

  if (!tryHook()) {
    pollTimer = setInterval(() => {
      if (tryHook()) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    }, 500);
  }

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    if (unsubLb) unsubLb();
    if (unsubStats) unsubStats();
  };
}

export function activate(bodyEl, ctx) {
  ensureStyles();
  const state = loadState();
  syncWindowState(state);
  const client = ctx?.client ?? window.__pluginClient ?? null;

  // Stance toggle header (was the separate `stance-toggle` plugin
  // pre-2026-05-17). Shown above whichever stance-specific body
  // renders below.
  renderStanceHeader(bodyEl, client);

  // Phase F — branch on local combat stance. Magic stance (wand / orb
  // / magic staff in hand + combat mode) shows a spell picker;
  // melee / missile / NonCombat show the attack-controls row.
  if (currentStanceIsMagic()) {
    renderSpellPicker(bodyEl, state, client);
  } else {
    renderAttackControls(bodyEl, state);
  }

  // ── Damage feed (shared across all stances) ──────────────────────
  // Live damage feed — subscribes to the facade combat events and
  // prepends the last few lines. Skipped gracefully when the facade
  // isn't available yet (pre-login).
  const feedEl = document.createElement("div");
  feedEl.className = "hb-cb-feed";
  const feedEmpty = document.createElement("div");
  feedEmpty.className = "hb-cb-feed-empty";
  feedEmpty.textContent = client ? "" : "Log in to enable.";
  feedEl.appendChild(feedEmpty);
  bodyEl.appendChild(feedEl);

  const FEED_LIMIT = 5;
  const lines = [];
  function pushLine(text, cls) {
    if (feedEmpty.parentNode) feedEmpty.remove();
    const line = document.createElement("div");
    line.className = `hb-cb-feed-line ${cls}`;
    line.textContent = text;
    feedEl.insertBefore(line, feedEl.firstChild);
    lines.unshift(line);
    while (lines.length > FEED_LIMIT) {
      const old = lines.pop();
      if (old?.parentNode) old.remove();
    }
  }

  const subs = [];
  if (client?.events?.on) {
    const onDealt = (ev) => {
      const d = ev.detail ?? {};
      const crit = d.criticalHit ? " (crit)" : "";
      pushLine(
        `→ ${d.defenderName ?? "?"}  ${d.damage ?? 0} ${d.damageType ?? ""}${crit}`,
        "hb-cb-feed-hit",
      );
    };
    const onTaken = (ev) => {
      const d = ev.detail ?? {};
      const crit = d.criticalHit ? " (crit)" : "";
      pushLine(
        `← ${d.attackerName ?? "?"}  ${d.damage ?? 0} ${d.damageType ?? ""} → ${d.damageLocation ?? ""}${crit}`,
        "hb-cb-feed-taken",
      );
    };
    const onEvadeTarget = (ev) => {
      pushLine(`→ ${ev.detail?.defenderName ?? "?"} evaded`, "hb-cb-feed-miss");
    };
    const onEvadeAttacker = (ev) => {
      pushLine(`← evaded ${ev.detail?.attackerName ?? "?"}`, "hb-cb-feed-miss");
    };
    client.events.on("damageDealt", onDealt);
    client.events.on("damageTaken", onTaken);
    client.events.on("evadedTarget", onEvadeTarget);
    client.events.on("evadedAttacker", onEvadeAttacker);
    subs.push(() => client.events.off("damageDealt", onDealt));
    subs.push(() => client.events.off("damageTaken", onTaken));
    subs.push(() => client.events.off("evadedTarget", onEvadeTarget));
    subs.push(() => client.events.off("evadedAttacker", onEvadeAttacker));
  }

  // Return a teardown so the bar's openPanel can clean up our
  // event subscriptions when the panel closes.
  return () => {
    for (const dispose of subs) {
      try { dispose(); } catch {}
    }
    // Phase G — spell-picker installs a window listener; clean it up.
    if (typeof bodyEl.__spellPickerDispose === "function") {
      try { bodyEl.__spellPickerDispose(); } catch {}
    }
    // Phase H.6 — power-meter rAF + event subscriptions.
    if (typeof bodyEl.__powerMeterDispose === "function") {
      try { bodyEl.__powerMeterDispose(); } catch {}
    }
    // Stance-header playerStatsUpdated subscription.
    if (typeof bodyEl.__stanceHeaderDispose === "function") {
      try { bodyEl.__stanceHeaderDispose(); } catch {}
    }
  };
}
