const STYLE_ID = "hb-bar-style";
const BAR_CLASS = "hb-bar";
const PANEL_CLASS = "hb-panel";
const SETTINGS_CLASS = "hb-settings";
const PILL_CLASS = "hb-pill";

// localStorage key — versioned (_v1) so future schema changes can reset cleanly.
const LS_KEY = "holtburger_ui_bar_v1";
const SAVE_DEBOUNCE_MS = 150;

const DEFAULTS = Object.freeze({
  left: null,
  top: null,
  iconSize: 36,
  transparency: 0.7,
  color: "#141418",
  orientation: "h",
  minimized: false,
});

const CSS = `
  .hb-bar {
    --hb-icon-size: 36px;
    --hb-bg: #141418;
    --hb-bg-alpha: 0.7;
    position: fixed;
    left: 50%;
    bottom: 12px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 6px;
    background: rgba(20, 20, 24, var(--hb-bg-alpha));
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    color: #fff;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    z-index: 100;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.4);
    user-select: none;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
    cursor: grab;
  }
  .hb-bar.hb-bar-dragging { cursor: grabbing; }
  .hb-bar.hb-bar-vertical {
    flex-direction: column;
  }
  .hb-bar-icon {
    position: relative;
    width: var(--hb-icon-size);
    height: var(--hb-icon-size);
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(255, 255, 255, 0.06);
    border: 1px solid rgba(255, 255, 255, 0.12);
    border-radius: 6px;
    color: #fff;
    font-size: calc(var(--hb-icon-size) * 0.55);
    cursor: pointer;
    transition: background 120ms ease, border-color 120ms ease;
    padding: 0;
    font-family: inherit;
    line-height: 1;
    flex: 0 0 auto;
  }
  .hb-bar-icon:hover {
    background: rgba(255, 255, 255, 0.14);
    border-color: rgba(255, 255, 255, 0.28);
  }
  .hb-bar-icon.active {
    background: rgba(120, 170, 255, 0.25);
    border-color: rgba(120, 170, 255, 0.6);
  }
  .hb-bar-icon:focus { outline: none; }
  .hb-bar-icon:focus-visible {
    outline: 2px solid rgba(120, 170, 255, 0.7);
    outline-offset: 2px;
  }
  .hb-bar-tooltip {
    position: absolute;
    bottom: calc(100% + 6px);
    left: 50%;
    transform: translateX(-50%);
    padding: 3px 8px;
    background: rgba(10, 10, 14, 0.92);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 4px;
    font-size: 12px;
    white-space: nowrap;
    pointer-events: none;
    opacity: 0;
    transition: opacity 100ms ease;
  }
  .hb-bar.hb-bar-vertical .hb-bar-tooltip {
    bottom: auto;
    left: calc(100% + 6px);
    top: 50%;
    transform: translateY(-50%);
  }
  .hb-bar-icon:hover .hb-bar-tooltip,
  .hb-bar-icon:focus-visible .hb-bar-tooltip {
    opacity: 1;
  }
  .hb-bar-sep {
    width: 1px;
    height: 22px;
    margin: 0 4px;
    background: rgba(255, 255, 255, 0.25);
    flex: 0 0 auto;
  }
  .hb-bar.hb-bar-vertical .hb-bar-sep {
    width: 22px;
    height: 1px;
    margin: 4px 0;
  }
  .hb-bar-slot-empty {
    width: var(--hb-icon-size);
    height: var(--hb-icon-size);
    border: 1px dashed rgba(255, 255, 255, 0.3);
    border-radius: 6px;
    opacity: 0.5;
    flex: 0 0 auto;
  }
  .hb-panel {
    position: fixed;
    width: 280px;
    background: rgba(28, 28, 32, 0.94);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.15);
    border-radius: 8px;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    font-size: 13px;
    z-index: 101;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.55);
    overflow: hidden;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .hb-panel-title {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 8px 10px;
    background: rgba(255, 255, 255, 0.06);
    border-bottom: 1px solid rgba(255, 255, 255, 0.12);
    cursor: move;
    user-select: none;
  }
  .hb-panel-title-text {
    font-weight: 600;
    font-size: 13px;
  }
  .hb-panel-close {
    width: 22px;
    height: 22px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 4px;
    color: rgba(255, 255, 255, 0.7);
    cursor: pointer;
    font-size: 16px;
    line-height: 1;
    padding: 0;
    font-family: inherit;
  }
  .hb-panel-close:hover {
    background: rgba(255, 255, 255, 0.12);
    color: #fff;
  }
  .hb-panel-body {
    padding: 12px;
    line-height: 1.45;
  }
  .hb-panel-body .hb-panel-note {
    margin-top: 8px;
    font-size: 11px;
    color: rgba(255, 255, 255, 0.55);
    font-style: italic;
  }
  .hb-settings {
    position: fixed;
    width: 240px;
    background: rgba(28, 28, 32, 0.96);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 8px;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    font-size: 12px;
    z-index: 102;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.6);
    padding: 10px 12px;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .hb-settings-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 8px;
  }
  .hb-settings-row:last-child { margin-bottom: 0; }
  .hb-settings-row label {
    flex: 0 0 auto;
    color: rgba(255, 255, 255, 0.8);
  }
  .hb-settings-row input[type="range"] { flex: 1 1 auto; min-width: 0; }
  .hb-settings-row input[type="color"] {
    width: 32px; height: 22px;
    background: transparent; border: 1px solid rgba(255,255,255,0.2);
    border-radius: 4px; padding: 0; cursor: pointer;
  }
  .hb-settings-row .hb-settings-val {
    flex: 0 0 36px;
    text-align: right;
    color: rgba(255, 255, 255, 0.6);
    font-variant-numeric: tabular-nums;
  }
  .hb-settings-btnrow {
    display: flex;
    gap: 6px;
    margin-top: 4px;
  }
  .hb-settings-btn {
    flex: 1 1 0;
    padding: 5px 8px;
    background: rgba(255, 255, 255, 0.08);
    border: 1px solid rgba(255, 255, 255, 0.16);
    border-radius: 4px;
    color: #fff;
    cursor: pointer;
    font-family: inherit;
    font-size: 12px;
  }
  .hb-settings-btn:hover {
    background: rgba(255, 255, 255, 0.16);
    border-color: rgba(255, 255, 255, 0.3);
  }
  .hb-settings-btn.active {
    background: rgba(120, 170, 255, 0.25);
    border-color: rgba(120, 170, 255, 0.6);
  }
  .hb-pill {
    position: fixed;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(20, 20, 24, 0.78);
    border: 1px solid rgba(255, 255, 255, 0.18);
    border-radius: 18px;
    color: #fff;
    font-family: ui-sans-serif, system-ui, -apple-system, sans-serif;
    font-size: 18px;
    cursor: pointer;
    z-index: 100;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4);
    user-select: none;
    backdrop-filter: blur(6px);
    -webkit-backdrop-filter: blur(6px);
  }
  .hb-pill:hover {
    background: rgba(40, 40, 48, 0.88);
    border-color: rgba(255, 255, 255, 0.3);
  }
`;

function ensureStyle() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULTS };
    return { ...DEFAULTS, ...parsed };
  } catch (_e) {
    return { ...DEFAULTS };
  }
}

function makeSaver() {
  let timer = null;
  return function save(state) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(state));
      } catch (_e) { /* quota or disabled — silently ignore */ }
    }, SAVE_DEBOUNCE_MS);
  };
}

function hexToRgb(hex) {
  const m = /^#?([a-f0-9]{6})$/i.exec(hex || "");
  if (!m) return { r: 20, g: 20, b: 24 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

function makeIcon(slot) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "hb-bar-icon";
  btn.dataset.pluginId = slot.id;
  btn.setAttribute("aria-label", slot.name);
  btn.textContent = slot.icon;

  const tip = document.createElement("span");
  tip.className = "hb-bar-tooltip";
  tip.textContent = slot.name;
  btn.appendChild(tip);

  return btn;
}

function makePanel(slot, anchorRect, hostState) {
  const panel = document.createElement("div");
  panel.className = PANEL_CLASS;
  panel.dataset.pluginId = slot.id;
  // hostState is currently unused inside makePanel but threaded
  // through so future plugin activate() calls can read host state
  // (selected target, etc) without a global.
  void hostState;

  const title = document.createElement("div");
  title.className = "hb-panel-title";

  const titleText = document.createElement("span");
  titleText.className = "hb-panel-title-text";
  titleText.textContent = slot.name;

  const closeBtn = document.createElement("button");
  closeBtn.type = "button";
  closeBtn.className = "hb-panel-close";
  closeBtn.setAttribute("aria-label", "Close panel");
  closeBtn.textContent = "×";

  title.appendChild(titleText);
  title.appendChild(closeBtn);

  const body = document.createElement("div");
  body.className = "hb-panel-body";
  body.innerHTML = "";
  // Slot may provide either a static `panelBody` string OR an
  // `activate(bodyEl)` function (Phase D plugin pattern). When
  // activate is provided the plugin owns the body's contents;
  // when panelBody is provided we render the legacy stub layout.
  if (typeof slot.activate !== "function") {
    const main = document.createElement("div");
    main.textContent = slot.panelBody ?? slot.name;
    body.appendChild(main);
    const note = document.createElement("div");
    note.className = "hb-panel-note";
    note.textContent =
      "Plugin facade is wired but no plugin logic exists yet.";
    body.appendChild(note);
  }

  panel.appendChild(title);
  panel.appendChild(body);

  const panelW = 280;
  const panelH = 140;
  const margin = 8;
  let left = anchorRect.left + anchorRect.width / 2 + 8;
  let top = anchorRect.top - panelH - 8;
  if (left + panelW > window.innerWidth - margin) {
    left = window.innerWidth - panelW - margin;
  }
  if (left < margin) left = margin;
  if (top < margin) top = anchorRect.bottom + 8;
  panel.style.left = `${Math.round(left)}px`;
  panel.style.top = `${Math.round(top)}px`;

  return { panel, title, closeBtn };
}

function attachDrag(panel, handle) {
  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originLeft = 0;
  let originTop = 0;

  function onDown(ev) {
    if (ev.button !== 0) return;
    if (ev.target.closest(".hb-panel-close")) return;
    dragging = true;
    const rect = panel.getBoundingClientRect();
    originLeft = rect.left;
    originTop = rect.top;
    startX = ev.clientX;
    startY = ev.clientY;
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    ev.preventDefault();
  }
  function onMove(ev) {
    if (!dragging) return;
    const dx = ev.clientX - startX;
    const dy = ev.clientY - startY;
    let nl = originLeft + dx;
    let nt = originTop + dy;
    const rect = panel.getBoundingClientRect();
    const maxL = window.innerWidth - rect.width;
    const maxT = window.innerHeight - rect.height;
    if (nl < 0) nl = 0;
    if (nt < 0) nt = 0;
    if (nl > maxL) nl = maxL;
    if (nt > maxT) nt = maxT;
    panel.style.left = `${nl}px`;
    panel.style.top = `${nt}px`;
  }
  function onUp() {
    dragging = false;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  }

  handle.addEventListener("mousedown", onDown);
  return () => {
    handle.removeEventListener("mousedown", onDown);
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };
}

export function mountBar({ client, root, slots: slotsOpt }) {
  if (!root) throw new Error("mountBar: root required");
  ensureStyle();

  const existing = root.querySelector(`.${BAR_CLASS}`);
  if (existing) existing.remove();
  const existingPanel = root.querySelector(`.${PANEL_CLASS}`);
  if (existingPanel) existingPanel.remove();
  const existingSettings = root.querySelector(`.${SETTINGS_CLASS}`);
  if (existingSettings) existingSettings.remove();
  const existingPill = root.querySelector(`.${PILL_CLASS}`);
  if (existingPill) existingPill.remove();

  const state = loadState();
  const save = makeSaver();
  const persist = () => save(state);

  const slots = Array.isArray(slotsOpt) && slotsOpt.length > 0
    ? slotsOpt
    : [
        {
          id: "rynthsuite",
          name: "RynthSuite",
          icon: "⚔",
          panelBody: "RynthSuite — combat & navigation (stub)",
        },
      ];

  const bar = document.createElement("div");
  bar.className = BAR_CLASS;
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Holtburger plugin bar");

  const iconButtons = new Map();
  for (const slot of slots) {
    // `iconHidden` slots register through the plugin system (and
    // run their `mount` lifecycle below) but don't take up a bar
    // icon. Used by always-on overlays like the vitals HUD whose
    // presentation is the screen-edge widget itself, not a panel
    // opened from a bar click. Pre-2026-05-17 the vitals HUD was
    // bolted directly into index.html; the `mount` + `iconHidden`
    // hooks let it move under the plugin framework without
    // claiming bar real estate.
    if (slot.iconHidden) continue;
    const btn = makeIcon(slot);
    iconButtons.set(slot.id, btn);
    bar.appendChild(btn);
  }

  // Per-slot mount lifecycle. Runs once at bar init for every slot
  // (including iconHidden ones). Plugins that need an always-on
  // presence — vitals overlay, ambient HUD chrome, compass — wire
  // their DOM here. Activate() still fires later on panel-open for
  // plugins that have an icon. The returned disposer is wired into
  // the bar's teardown path (TODO: bar teardown not yet plumbed —
  // mount-only plugins live for the lifetime of the page).
  const slotMountDisposers = [];
  for (const slot of slots) {
    if (typeof slot.mount !== "function") continue;
    try {
      const dispose = slot.mount({ client, slot, root, bar });
      if (typeof dispose === "function") {
        slotMountDisposers.push(dispose);
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn(`[bar] slot.mount threw for ${slot.id}:`, e);
    }
  }

  const sep = document.createElement("div");
  sep.className = "hb-bar-sep";
  sep.setAttribute("aria-hidden", "true");
  bar.appendChild(sep);

  for (let i = 0; i < 2; i++) {
    const placeholder = document.createElement("div");
    placeholder.className = "hb-bar-slot-empty";
    placeholder.setAttribute("aria-hidden", "true");
    bar.appendChild(placeholder);
  }

  // Gear icon at end of bar — opens settings popover.
  const gearBtn = document.createElement("button");
  gearBtn.type = "button";
  gearBtn.className = "hb-bar-icon hb-bar-gear";
  gearBtn.setAttribute("aria-label", "Bar settings");
  gearBtn.textContent = "⚙";
  const gearTip = document.createElement("span");
  gearTip.className = "hb-bar-tooltip";
  gearTip.textContent = "Settings";
  gearBtn.appendChild(gearTip);
  bar.appendChild(gearBtn);

  root.appendChild(bar);

  // Pill (minimized state) — created lazily.
  let pill = null;

  function applyStyleVars() {
    bar.style.setProperty("--hb-icon-size", `${state.iconSize}px`);
    bar.style.setProperty("--hb-bg", state.color);
    bar.style.setProperty("--hb-bg-alpha", String(state.transparency));
    const { r, g, b } = hexToRgb(state.color);
    bar.style.background = `rgba(${r}, ${g}, ${b}, ${state.transparency})`;
    bar.style.gap = `${Math.max(2, Math.round(state.iconSize * 0.11))}px`;
  }

  function applyOrientation() {
    if (state.orientation === "v") {
      bar.classList.add("hb-bar-vertical");
    } else {
      bar.classList.remove("hb-bar-vertical");
    }
  }

  function clampToViewport(left, top, w, h) {
    const m = 4;
    let nl = left;
    let nt = top;
    if (nl < m) nl = m;
    if (nt < m) nt = m;
    if (nl + w > window.innerWidth - m) nl = window.innerWidth - w - m;
    if (nt + h > window.innerHeight - m) nt = window.innerHeight - h - m;
    if (nl < m) nl = m;
    if (nt < m) nt = m;
    return { left: nl, top: nt };
  }

  function applyPosition() {
    // If position has been set explicitly, use top-left; otherwise keep bottom-center default.
    if (state.left != null && state.top != null) {
      bar.style.transform = "none";
      bar.style.left = `${state.left}px`;
      bar.style.top = `${state.top}px`;
      bar.style.bottom = "auto";
      // Re-clamp on next frame once layout is known.
      requestAnimationFrame(() => {
        const rect = bar.getBoundingClientRect();
        const c = clampToViewport(state.left, state.top, rect.width, rect.height);
        if (c.left !== state.left || c.top !== state.top) {
          state.left = c.left;
          state.top = c.top;
          bar.style.left = `${state.left}px`;
          bar.style.top = `${state.top}px`;
          persist();
        }
      });
    } else {
      bar.style.transform = "translateX(-50%)";
      bar.style.left = "50%";
      bar.style.top = "auto";
      bar.style.bottom = "12px";
    }
  }

  function resetPosition() {
    state.left = null;
    state.top = null;
    applyPosition();
    persist();
  }

  // Settings popover -------------------------------------------------------

  let settingsEl = null;
  let settingsCleanup = null;

  function positionSettings(el) {
    const barRect = bar.getBoundingClientRect();
    const elW = el.offsetWidth || 240;
    const elH = el.offsetHeight || 200;
    const m = 8;
    // Prefer above bar; fall back to below if no room.
    let left = barRect.right - elW;
    let top = barRect.top - elH - m;
    if (top < m) top = barRect.bottom + m;
    if (left < m) left = m;
    if (left + elW > window.innerWidth - m) left = window.innerWidth - elW - m;
    if (top + elH > window.innerHeight - m) top = window.innerHeight - elH - m;
    el.style.left = `${Math.round(left)}px`;
    el.style.top = `${Math.round(top)}px`;
  }

  function closeSettings() {
    if (!settingsEl) return;
    if (settingsCleanup) settingsCleanup();
    settingsCleanup = null;
    settingsEl.remove();
    settingsEl = null;
    gearBtn.classList.remove("active");
  }

  function openSettings() {
    if (settingsEl) { closeSettings(); return; }
    const el = document.createElement("div");
    el.className = SETTINGS_CLASS;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-label", "Bar settings");

    el.innerHTML = `
      <div class="hb-settings-row">
        <label for="hb-set-color">Color</label>
        <input id="hb-set-color" type="color" value="${state.color}">
      </div>
      <div class="hb-settings-row">
        <label for="hb-set-size">Icon size</label>
        <input id="hb-set-size" type="range" min="28" max="56" step="1" value="${state.iconSize}">
        <span class="hb-settings-val" data-val="size">${state.iconSize}</span>
      </div>
      <div class="hb-settings-row">
        <label for="hb-set-alpha">Transparency</label>
        <input id="hb-set-alpha" type="range" min="0.3" max="1" step="0.05" value="${state.transparency}">
        <span class="hb-settings-val" data-val="alpha">${state.transparency.toFixed(2)}</span>
      </div>
      <div class="hb-settings-row">
        <label>Orientation</label>
        <div class="hb-settings-btnrow" style="margin-top:0">
          <button type="button" class="hb-settings-btn ${state.orientation === "h" ? "active" : ""}" data-orient="h">Horizontal</button>
          <button type="button" class="hb-settings-btn ${state.orientation === "v" ? "active" : ""}" data-orient="v">Vertical</button>
        </div>
      </div>
      <div class="hb-settings-btnrow">
        <button type="button" class="hb-settings-btn" data-action="minimize">Minimize</button>
        <button type="button" class="hb-settings-btn" data-action="reset-pos">Reset position</button>
      </div>
    `;

    root.appendChild(el);
    settingsEl = el;
    gearBtn.classList.add("active");
    positionSettings(el);

    const colorInput = el.querySelector("#hb-set-color");
    const sizeInput = el.querySelector("#hb-set-size");
    const alphaInput = el.querySelector("#hb-set-alpha");
    const sizeVal = el.querySelector('[data-val="size"]');
    const alphaVal = el.querySelector('[data-val="alpha"]');

    const onColor = (e) => { state.color = e.target.value; applyStyleVars(); persist(); };
    const onSize = (e) => {
      state.iconSize = Number(e.target.value);
      sizeVal.textContent = String(state.iconSize);
      applyStyleVars();
      persist();
    };
    const onAlpha = (e) => {
      state.transparency = Number(e.target.value);
      alphaVal.textContent = state.transparency.toFixed(2);
      applyStyleVars();
      persist();
    };
    colorInput.addEventListener("input", onColor);
    sizeInput.addEventListener("input", onSize);
    alphaInput.addEventListener("input", onAlpha);

    const orientBtns = el.querySelectorAll("[data-orient]");
    const onOrient = (e) => {
      const o = e.currentTarget.dataset.orient;
      if (o === state.orientation) return;
      state.orientation = o;
      orientBtns.forEach((b) =>
        b.classList.toggle("active", b.dataset.orient === o));
      applyOrientation();
      // Re-clamp explicit position after axis change.
      if (state.left != null && state.top != null) {
        requestAnimationFrame(() => {
          const rect = bar.getBoundingClientRect();
          const c = clampToViewport(state.left, state.top, rect.width, rect.height);
          state.left = c.left;
          state.top = c.top;
          bar.style.left = `${state.left}px`;
          bar.style.top = `${state.top}px`;
          positionSettings(el);
          persist();
        });
      } else {
        persist();
      }
    };
    orientBtns.forEach((b) => b.addEventListener("click", onOrient));

    const minBtn = el.querySelector('[data-action="minimize"]');
    const resetBtn = el.querySelector('[data-action="reset-pos"]');
    const onMinimize = () => { closeSettings(); minimize(); };
    const onResetPos = () => { resetPosition(); positionSettings(el); };
    minBtn.addEventListener("click", onMinimize);
    resetBtn.addEventListener("click", onResetPos);

    const onDocDown = (ev) => {
      if (ev.target.closest(`.${SETTINGS_CLASS}`)) return;
      if (ev.target.closest(`.${BAR_CLASS}`)) return;
      closeSettings();
    };
    const onKey = (ev) => { if (ev.key === "Escape") closeSettings(); };
    window.addEventListener("mousedown", onDocDown, true);
    window.addEventListener("keydown", onKey);

    settingsCleanup = () => {
      colorInput.removeEventListener("input", onColor);
      sizeInput.removeEventListener("input", onSize);
      alphaInput.removeEventListener("input", onAlpha);
      orientBtns.forEach((b) => b.removeEventListener("click", onOrient));
      minBtn.removeEventListener("click", onMinimize);
      resetBtn.removeEventListener("click", onResetPos);
      window.removeEventListener("mousedown", onDocDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }

  gearBtn.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openSettings();
  });

  // Minimize / restore -----------------------------------------------------

  function minimize() {
    if (state.minimized) return;
    state.minimized = true;
    closePanel();
    closeSettings();
    bar.style.display = "none";
    if (!pill) {
      pill = document.createElement("button");
      pill.type = "button";
      pill.className = PILL_CLASS;
      pill.setAttribute("aria-label", "Restore bar");
      pill.textContent = "≡";
      pill.addEventListener("click", restore);
      root.appendChild(pill);
    }
    // Pin pill near the bar's last known corner, or bottom-right by default.
    if (state.left != null && state.top != null) {
      pill.style.left = `${state.left}px`;
      pill.style.top = `${state.top}px`;
      pill.style.bottom = "auto";
      pill.style.right = "auto";
    } else {
      pill.style.left = "auto";
      pill.style.top = "auto";
      pill.style.right = "12px";
      pill.style.bottom = "12px";
    }
    pill.style.display = "";
    persist();
  }

  function restore() {
    state.minimized = false;
    if (pill) pill.style.display = "none";
    bar.style.display = "";
    persist();
  }

  // Drag-to-reposition the bar --------------------------------------------

  let barDragging = false;
  let barDragMoved = false;
  let dragStartX = 0;
  let dragStartY = 0;
  let dragOriginLeft = 0;
  let dragOriginTop = 0;

  function onBarMouseDown(ev) {
    if (ev.button !== 0) return;
    // Don't start drag from icons, placeholders, or the gear.
    if (ev.target.closest(".hb-bar-icon")) return;
    if (ev.target.closest(".hb-bar-slot-empty")) return;
    const rect = bar.getBoundingClientRect();
    // Convert current (possibly bottom/transform-anchored) position into explicit left/top.
    dragOriginLeft = rect.left;
    dragOriginTop = rect.top;
    bar.style.transform = "none";
    bar.style.bottom = "auto";
    bar.style.left = `${dragOriginLeft}px`;
    bar.style.top = `${dragOriginTop}px`;
    barDragging = true;
    barDragMoved = false;
    dragStartX = ev.clientX;
    dragStartY = ev.clientY;
    bar.classList.add("hb-bar-dragging");
    window.addEventListener("mousemove", onBarMouseMove);
    window.addEventListener("mouseup", onBarMouseUp);
    ev.preventDefault();
  }

  function onBarMouseMove(ev) {
    if (!barDragging) return;
    const dx = ev.clientX - dragStartX;
    const dy = ev.clientY - dragStartY;
    if (!barDragMoved && Math.hypot(dx, dy) > 2) barDragMoved = true;
    const rect = bar.getBoundingClientRect();
    const c = clampToViewport(
      dragOriginLeft + dx,
      dragOriginTop + dy,
      rect.width,
      rect.height,
    );
    bar.style.left = `${c.left}px`;
    bar.style.top = `${c.top}px`;
  }

  function onBarMouseUp() {
    if (!barDragging) return;
    barDragging = false;
    bar.classList.remove("hb-bar-dragging");
    window.removeEventListener("mousemove", onBarMouseMove);
    window.removeEventListener("mouseup", onBarMouseUp);
    if (barDragMoved) {
      const rect = bar.getBoundingClientRect();
      state.left = Math.round(rect.left);
      state.top = Math.round(rect.top);
      persist();
    }
  }

  bar.addEventListener("mousedown", onBarMouseDown);

  // Plugin panel logic (preserved) ----------------------------------------

  let openState = null;

  function closePanel() {
    if (!openState) return;
    const { panel, btn, cleanup } = openState;
    cleanup();
    panel.remove();
    btn.classList.remove("active");
    btn.setAttribute("aria-expanded", "false");
    openState = null;
  }

  function openPanel(slot, btn) {
    if (openState) {
      const sameSlot = openState.slot.id === slot.id;
      closePanel();
      if (sameSlot) return;
    }
    const anchorRect = btn.getBoundingClientRect();
    const { panel, title, closeBtn } = makePanel(slot, anchorRect);
    root.appendChild(panel);

    // Phase D — if the slot provides an activate function, hand it
    // the panel body element so the plugin can populate its own UI.
    let activatedDispose = null;
    if (typeof slot.activate === "function") {
      const bodyEl = panel.querySelector(".hb-panel-body");
      try {
        activatedDispose = slot.activate(bodyEl, { client, slot });
      } catch (e) {
        console.warn(`[bar] slot.activate threw for ${slot.id}:`, e);
      }
    }

    const detachDrag = attachDrag(panel, title);
    const onClose = () => closePanel();
    closeBtn.addEventListener("click", onClose);

    btn.classList.add("active");
    btn.setAttribute("aria-expanded", "true");

    openState = {
      slot,
      panel,
      btn,
      cleanup: () => {
        detachDrag();
        closeBtn.removeEventListener("click", onClose);
        if (typeof activatedDispose === "function") {
          try {
            activatedDispose();
          } catch (e) {
            console.warn(`[bar] slot.activate dispose threw for ${slot.id}:`, e);
          }
        }
      },
    };
  }

  for (const slot of slots) {
    // 2026-05-18 fix: iconHidden slots have no bar button (the
    // earlier loop skipped them), so iconButtons.get() returns
    // undefined here and .setAttribute crashes the whole mount.
    // Skip click-wire for them — they live entirely through their
    // `mount` lifecycle.
    const btn = iconButtons.get(slot.id);
    if (!btn) continue;
    btn.setAttribute("aria-expanded", "false");
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (openState && openState.slot.id === slot.id) {
        closePanel();
      } else {
        openPanel(slot, btn);
      }
    });
  }

  // Initial apply from restored state -------------------------------------
  applyStyleVars();
  applyOrientation();
  applyPosition();
  if (state.minimized) {
    // Defer one frame so initial layout is final before swapping to pill.
    requestAnimationFrame(() => {
      state.minimized = false; // minimize() requires false to flip
      minimize();
    });
  }

  return {
    destroy() {
      closePanel();
      closeSettings();
      window.removeEventListener("mousemove", onBarMouseMove);
      window.removeEventListener("mouseup", onBarMouseUp);
      bar.removeEventListener("mousedown", onBarMouseDown);
      if (pill) pill.remove();
      bar.remove();
    },
  };
}
