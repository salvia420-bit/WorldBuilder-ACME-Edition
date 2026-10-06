// Graphics settings — rendered by the Options view's Config tab
// (plugins/options-panel.js) and the legacy bar gear popover (ui/bar.js).
//
// Reads/writes a `holtburger_graphics_v1` localStorage payload and
// mirrors changes onto `window.__quality.flags` so any consumer that
// re-reads them (or any consumer that re-initializes) picks up the new
// value. Most consumers cache at init, so a "Reload" pill appears after
// the first persisted change in a session.

import { mountFullscreenControl } from "./fullscreen_toggle.js";

const LS_KEY = "holtburger_graphics_v1";
const QUALITY_EVENT = "hb-quality-changed";

// Mirrors quality.js BOOL_FLAGS + INT_FLAGS so the tab can render
// controls without importing the renderer side. Kept in sync by the
// docs/quality-presets.md table — if you add a flag in quality.js,
// add it here too.
const QUALITY_BOOL_FLAGS = [
  "antialias",
  // R9 (2026-08-03), task #153 — "shadows" removed. quality.js dropped it
  // from BOOL_FLAGS on 2026-08-01 (no reader), so its sanitizer silently
  // discards `flags.shadows`; listing it here only made setQualityFlag write
  // a key that nothing consumes. The live gate is the default-OFF
  // `?shadows=on` opt-in with its own exact-match reader in scene3d/index.js.
  "csm",
  "normalMaps",
  "detailFlag",
  "triplanar",
  "pom",
  "terrainDetailNormal",
  "bloom",
  "vignette",
  "lightShafts",
];
const QUALITY_INT_FLAGS = ["subdivLevel"];

// Non-quality extras persisted alongside the flags. Only `renderScale`
// (live, window.__setRenderScale) and `castStabilityRing` (live,
// scene3d/spell_shape_preview.js) have readers today; the rest have NO
// consumer and their controls were removed from the panel (HUD overhaul
// 2026-10-05). The keys stay so previously-saved blobs keep their shape
// and a future wiring has a place to land — re-add a control only
// together with its reader.
const EXTRA_DEFAULTS = Object.freeze({
  renderScale: 1.0,
  toneMapping: "default",
  exposure: 1.0,
  shadowMapSize: 2048,
  entityTickDistance: 120,
  nameplateDistance: 60,
  maxParticles: 256,
  maxDynamicLights: 64,
  targetFps: 0,         // 0 = unlimited
  fpsCounter: false,
  showRenderStats: false,
  wireframe: false,
  // Combat aids (consumed by scene3d/spell_shape_preview.js, not the renderer).
  // Cast-stability ring: a 6 m ground circle frozen where you begin a cast
  // (ACE Windup_MaxMove; leaving it fizzles the cast for PK chars). Off by
  // default — an opt-in aid, no retail equivalent (retail only toasted the
  // server's "You have moved too far!" WeenieError, drew no circle).
  castStabilityRing: false,
});

export function loadGraphicsState() {
  if (typeof localStorage === "undefined") return emptyState();
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return emptyState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyState();
    return {
      preset: typeof parsed.preset === "string" ? parsed.preset : null,
      flags: (parsed.flags && typeof parsed.flags === "object") ? parsed.flags : {},
      extras: { ...EXTRA_DEFAULTS, ...(parsed.extras || {}) },
    };
  } catch (_e) {
    return emptyState();
  }
}

function emptyState() {
  return { preset: null, flags: {}, extras: { ...EXTRA_DEFAULTS } };
}

function saveGraphicsState(state) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (_e) {
    /* quota — silent */
  }
}

function dispatchQualityChanged(detail) {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent(QUALITY_EVENT, { detail }));
  } catch (_e) {
    /* CustomEvent unsupported — silent */
  }
}

// Mutate window.__quality.flags so non-reloading consumers see the new
// value. The reload pill still appears because most consumers cache
// the flag at init, but for any that re-read (or new consumers added)
// this keeps the mirror coherent.
function mirrorOntoWindowQuality(flag, value) {
  if (typeof window === "undefined") return;
  const q = window.__quality;
  if (!q || !q.flags) return;
  q.flags[flag] = value;
}

function setQualityFlag(state, flag, value) {
  state.flags[flag] = value;
  saveGraphicsState(state);
  mirrorOntoWindowQuality(flag, value);
  dispatchQualityChanged({ kind: "flag", flag, value });
}

function setPreset(state, preset) {
  state.preset = preset;
  state.flags = {}; // a preset switch clears per-flag overrides
  saveGraphicsState(state);
  if (typeof window !== "undefined" && window.__quality) {
    window.__quality.preset = preset;
  }
  dispatchQualityChanged({ kind: "preset", preset });
}

function setExtra(state, key, value) {
  state.extras[key] = value;
  saveGraphicsState(state);
  dispatchQualityChanged({ kind: "extra", key, value });
}

function clearOverrides(state) {
  state.preset = null;
  state.flags = {};
  state.extras = { ...EXTRA_DEFAULTS };
  saveGraphicsState(state);
  dispatchQualityChanged({ kind: "clear" });
}

// Live-applyable changes — these don't require reload.
function applyRenderScaleLive(scale) {
  if (typeof window === "undefined") return;
  if (typeof window.__setRenderScale !== "function") return;
  try {
    window.__setRenderScale(scale);
  } catch (_e) { /* live setter may not be ready yet */ }
}

/**
 * Re-apply the live-applicable extras from the persisted blob. The Options
 * view's Cancel button restores `holtburger_graphics_v1` to its on-open
 * snapshot and then calls this so render scale + the cast ring snap back
 * without a reload (HUD overhaul 2026-10-05).
 */
export function reapplyLiveGraphics() {
  const s = loadGraphicsState();
  applyRenderScaleLive(Number(s.extras.renderScale) || 1);
  dispatchQualityChanged({ kind: "restore" });
}

// ---------------------------------------------------------------------------
// Rendering ------------------------------------------------------------------
//
// HUD overhaul 2026-10-05 — every control is a shared-kit control
// (`input.hbk-check` retail orb checkbox, `input.hbk-range`,
// `select.hbk-select`, `hbk-btn-brass` preset tags, `hbk-btn-small`),
// labels are real <label for> elements so clicking the text toggles the
// box, and the controls that NOTHING reads were removed (R9 / #153
// precedent — "removal is the no-op"): Tone mapping, Exposure, Shadow map
// size, the five "Entities & particles" caps and the three "Debug"
// toggles were persisted into `extras` but no consumer ever read them
// (`?exposure=` / `?targetFps=` / `?wireframe=` are URL-only gates in
// scene3d), so the panel advertised settings that silently did nothing.
// EXTRA_DEFAULTS keeps their keys so saved blobs stay well-formed.

const SUBDIV_OPTIONS = [1, 2, 4, 8];

export function renderGraphicsTab(containerEl, { onAnyChange } = {}) {
  // A preset click / reset re-renders in place — dispose the previous
  // render's document-level listeners (fullscreenchange) first so they
  // don't stack up one per re-render.
  try { containerEl.__hbGraphicsDispose?.(); } catch (_e) { /* stale */ }
  const state = loadGraphicsState();
  const activePreset = currentActivePreset(state);
  let dirty = false;
  const markDirty = () => {
    if (dirty) return;
    dirty = true;
    reloadBanner.style.display = "";
    if (typeof onAnyChange === "function") onAnyChange();
  };

  containerEl.innerHTML = "";
  containerEl.classList.add("hb-graphics");

  // --- Preset row ----------------------------------------------------------
  // Retail-familiar brass tags (gmCombatUI High/Medium/Low 0x06004D1C/1D).
  containerEl.appendChild(makeSectionHeader("Preset"));
  const presetRow = document.createElement("div");
  presetRow.className = "hb-settings-btnrow hb-graphics-presets";
  presetRow.setAttribute("role", "radiogroup");
  presetRow.setAttribute("aria-label", "Graphics preset");
  for (const p of ["low", "mid", "high", "ultra"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hbk-btn-brass hb-graphics-preset";
    const on = p === activePreset;
    btn.classList.toggle("is-active", on);
    btn.setAttribute("role", "radio");
    btn.setAttribute("aria-checked", on ? "true" : "false");
    btn.textContent = capitalize(p);
    btn.dataset.preset = p;
    btn.addEventListener("click", () => {
      setPreset(state, p);
      // Re-render the controls so toggles reflect the new preset defaults.
      renderGraphicsTab(containerEl, { onAnyChange });
      containerEl.__hbGraphicsMarkDirty?.();
    });
    presetRow.appendChild(btn);
  }
  containerEl.appendChild(presetRow);

  // Snapshot the effective flag values (preset+overrides) so toggles
  // start in the right position even when nothing is in localStorage yet.
  const effective = effectiveFlags(state);

  // --- Renderer ------------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Renderer"));
  containerEl.appendChild(boolRow("Antialiasing", effective.antialias, (v) => {
    setQualityFlag(state, "antialias", v);
    markDirty();
  }));
  containerEl.appendChild(rangeRow({
    label: "Render scale",
    min: 0.5, max: 1.5, step: 0.05,
    value: state.extras.renderScale,
    format: (v) => `${Math.round(v * 100)}%`,
    hint: "Applies immediately",
    onInput: (v) => {
      setExtra(state, "renderScale", v);
      applyRenderScaleLive(v);
    },
  }));

  // --- Shadows -------------------------------------------------------------
  // R9 (2026-08-03), task #153 — the master "Shadows" checkbox that used to
  // live here has been REMOVED, not rewired. It wrote `flags.shadows` into
  // `holtburger_graphics_v1`, but `scene3d/quality.js`'s sanitizer drops that
  // key (it is in none of BOOL_FLAGS / INT_FLAGS / STR_FLAGS — see the
  // decision block under BOOL_FLAGS there), so the control was inert end to
  // end and displayed `true` while the live gate is the default-OFF
  // `?shadows=on` opt-in with its own exact-match reader in scene3d/index.js.
  //
  // Rewiring is NOT on the table: the panel has been writing `shadows: true`
  // into localStorage since it shipped, so honouring the key would silently
  // switch shadow maps ON for every returning user — a ship-visible render
  // change with no GPU measurement behind it. Removal is the no-op.
  // CSM below is a real, sanitizer-backed control and stays.
  containerEl.appendChild(makeSectionHeader("Shadows"));
  containerEl.appendChild(boolRow("Cascaded shadows (CSM)", effective.csm, (v) => {
    setQualityFlag(state, "csm", v); markDirty();
  }));

  // --- Materials -----------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Materials"));
  containerEl.appendChild(boolRow("Normal maps", effective.normalMaps, (v) => {
    setQualityFlag(state, "normalMaps", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Detail textures", effective.detailFlag, (v) => {
    setQualityFlag(state, "detailFlag", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Triplanar mapping", effective.triplanar, (v) => {
    setQualityFlag(state, "triplanar", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Parallax occlusion", effective.pom, (v) => {
    setQualityFlag(state, "pom", v); markDirty();
  }));
  // "Hero models" checkbox REMOVED 2026-08: `hero` was a preset key with zero
  // consumers repo-wide (never read by any render path), so the checkbox
  // toggled nothing. See external/holtburger/docs/quality-presets.md.

  // --- Terrain -------------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Terrain"));
  containerEl.appendChild(boolRow("Terrain detail normals", effective.terrainDetailNormal, (v) => {
    setQualityFlag(state, "terrainDetailNormal", v); markDirty();
  }));
  containerEl.appendChild(selectRow({
    label: "Terrain subdivision",
    options: SUBDIV_OPTIONS.map((n) => [String(n), `${n}×`]),
    value: String(effective.subdivLevel),
    onChange: (v) => { setQualityFlag(state, "subdivLevel", Number(v)); markDirty(); },
  }));

  // --- Post-processing -----------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Post-processing"));
  containerEl.appendChild(boolRow("Bloom", effective.bloom, (v) => {
    setQualityFlag(state, "bloom", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Vignette", effective.vignette, (v) => {
    setQualityFlag(state, "vignette", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Light shafts", effective.lightShafts, (v) => {
    setQualityFlag(state, "lightShafts", v); markDirty();
  }));

  // --- Combat --------------------------------------------------------------
  // Cast-stability ring applies live (no reload) — spell_shape_preview.js
  // re-reads the persisted value on the hb-quality-changed event.
  containerEl.appendChild(makeSectionHeader("Combat aids"));
  containerEl.appendChild(boolRow("Cast-stability ring", state.extras.castStabilityRing, (v) => {
    setExtra(state, "castStabilityRing", v);
  }, { hint: "Draws the 6 m circle you must stay inside while casting." }));

  // --- Display ---------------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Display"));
  const fullscreenRow = document.createElement("div");
  fullscreenRow.className = "hb-graphics-row hb-graphics-fullscreen";
  const disposeFullscreen = mountFullscreenControl(fullscreenRow);
  // ui/fullscreen_toggle.js styles its button/status inline (glass-era
  // chrome); swap those for the kit so the row matches the panel.
  restyleFullscreenControl(fullscreenRow);
  containerEl.appendChild(fullscreenRow);

  // --- Reload banner + reset ----------------------------------------------
  const reloadBanner = document.createElement("div");
  reloadBanner.className = "hb-graphics-reload";
  reloadBanner.style.display = "none";
  const reloadText = document.createElement("span");
  reloadText.textContent = "Some changes take effect after a reload.";
  const reloadBtn = document.createElement("button");
  reloadBtn.type = "button";
  reloadBtn.className = "hbk-btn-small hb-graphics-reload-btn";
  reloadBtn.textContent = "Reload";
  reloadBtn.addEventListener("click", () => {
    if (typeof window !== "undefined") window.location.reload();
  });
  reloadBanner.appendChild(reloadText);
  reloadBanner.appendChild(reloadBtn);
  containerEl.appendChild(reloadBanner);
  // A preset click re-renders (new closure) — let it re-show the banner.
  containerEl.__hbGraphicsMarkDirty = markDirty;

  const resetRow = document.createElement("div");
  resetRow.className = "hb-settings-btnrow hb-graphics-resetrow";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "hbk-btn-small hbk-brown";
  resetBtn.textContent = "Restore defaults";
  resetBtn.addEventListener("click", () => {
    clearOverrides(state);
    applyRenderScaleLive(EXTRA_DEFAULTS.renderScale);
    renderGraphicsTab(containerEl, { onAnyChange });
    containerEl.__hbGraphicsMarkDirty?.();
  });
  resetRow.appendChild(resetBtn);
  containerEl.appendChild(resetRow);

  function dispose() {
    // Event listeners on the rows above are attached to DOM nodes inside
    // containerEl; they're garbage-collected when the container is emptied
    // or removed. The fullscreen control attaches a document-level
    // `fullscreenchange` listener that outlives containerEl, so it needs
    // an explicit dispose to avoid stacking listeners on every re-render.
    disposeFullscreen();
    if (containerEl.__hbGraphicsDispose === dispose) containerEl.__hbGraphicsDispose = null;
  }
  containerEl.__hbGraphicsDispose = dispose;
  return dispose;
}

// ---------------------------------------------------------------------------
// Row widgets — shared with ui/camera_settings.js (and styled by both the
// Options view (plugins/options-panel.js) and the legacy bar popover).
// HUD overhaul 2026-10-05: kit classes + <label for> association.

let _rowSeq = 0;
function nextRowId() {
  _rowSeq += 1;
  return `hb-set-${_rowSeq}`;
}

export function makeSectionHeader(text) {
  const h = document.createElement("div");
  h.className = "hb-graphics-section hbk-section-title";
  h.textContent = text;
  return h;
}

export function boolRow(label, value, onChange, { hint } = {}) {
  const row = document.createElement("div");
  row.className = "hb-settings-row hb-graphics-row hb-graphics-bool";
  const id = nextRowId();
  const lbl = document.createElement("label");
  lbl.htmlFor = id;
  lbl.textContent = label;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.className = "hbk-check";
  cb.id = id;
  cb.checked = !!value;
  cb.addEventListener("change", () => onChange(!!cb.checked));
  if (hint) row.title = hint;
  row.appendChild(lbl);
  row.appendChild(cb);
  return row;
}

export function rangeRow({ label, min, max, step, value, format, onInput, onChange, hint }) {
  const row = document.createElement("div");
  row.className = "hb-settings-row hb-graphics-row hb-graphics-range";
  const id = nextRowId();
  const lbl = document.createElement("label");
  lbl.htmlFor = id;
  lbl.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.className = "hbk-range";
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const val = document.createElement("span");
  val.className = "hb-settings-val";
  const show = (v) => {
    const text = format ? format(Number(v)) : String(v);
    val.textContent = text;
    input.setAttribute("aria-valuetext", text);
  };
  show(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    show(v);
    if (typeof onInput === "function") onInput(v);
  });
  if (typeof onChange === "function") {
    input.addEventListener("change", () => onChange(Number(input.value)));
  }
  if (hint) row.title = hint;
  row.appendChild(lbl);
  row.appendChild(input);
  row.appendChild(val);
  return row;
}

export function selectRow({ label, options, value, onChange, hint }) {
  const row = document.createElement("div");
  row.className = "hb-settings-row hb-graphics-row hb-graphics-selectrow";
  const id = nextRowId();
  const lbl = document.createElement("label");
  lbl.htmlFor = id;
  lbl.textContent = label;
  const sel = document.createElement("select");
  sel.className = "hb-graphics-select hbk-select";
  sel.id = id;
  for (const [v, text] of options) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = text;
    if (v === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  if (hint) row.title = hint;
  row.appendChild(lbl);
  row.appendChild(sel);
  return row;
}

function restyleFullscreenControl(rowEl) {
  for (const child of Array.from(rowEl.children || [])) {
    if (child.tagName === "BUTTON") {
      child.style.cssText = "";
      child.className = "hbk-btn hb-graphics-fullscreen-btn";
    } else {
      child.style.cssText = "";
      child.className = "hb-graphics-note";
    }
  }
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Best-effort "what preset is currently active" for the highlighted
// button. URL > localStorage > mobile default > "mid". This is purely
// presentational; the actual resolution happens in quality.js.
function currentActivePreset(state) {
  try {
    if (typeof window !== "undefined" && window.__quality?.preset) {
      return window.__quality.preset;
    }
  } catch (_e) { /* fallthrough */ }
  if (state.preset) return state.preset;
  return "mid";
}

// Resolve the effective flag values used to seed the UI controls.
// Prefers the live `window.__quality.flags` mirror (most accurate),
// falling back to per-preset defaults baked here.
function effectiveFlags(state) {
  // If quality.js has already exposed window.__quality, use it.
  if (typeof window !== "undefined" && window.__quality?.flags) {
    return { ...window.__quality.flags, ...(state.flags || {}) };
  }
  // Fallback: minimal hardcoded preset defaults (mirrors quality.js).
  // Used only during early init before quality.js has run; the real
  // values land on the next render.
  const fallback = {
    antialias: true,
    // R9 (2026-08-03), task #153 — `shadows: true` deleted. There is no
    // longer a control reading it, and the value was WRONG: shadow maps are
    // gated by the default-OFF `?shadows=on` opt-in (exact-match reader in
    // scene3d/index.js), so this fallback advertised the opposite of the
    // shipped default on every pre-quality.js render.
    csm: false,
    // Wave 2.B (2026-05-28): mirrors the `mid` preset (false). Users on
    // `high`/`ultra` see this overridden after quality.js boots.
    normalMaps: false,
    detailFlag: true,
    triplanar: true,
    pom: false,
    terrainDetailNormal: true,
    bloom: true,
    vignette: false,
    lightShafts: false,
    subdivLevel: 2,
  };
  return { ...fallback, ...(state.flags || {}) };
}

// Exposed so bar.js (or anywhere else) can re-read the persisted
// state if needed.
export const __test_only = {
  QUALITY_BOOL_FLAGS,
  QUALITY_INT_FLAGS,
  EXTRA_DEFAULTS,
  effectiveFlags,
};
