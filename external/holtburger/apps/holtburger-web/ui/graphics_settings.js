// Graphics settings tab for the bar's gear-icon popover.
//
// Reads/writes a `holtburger_graphics_v1` localStorage payload and
// mirrors changes onto `window.__quality.flags` so any consumer that
// re-reads them (or any consumer that re-initializes) picks up the new
// value. Most consumers cache at init, so a "Reload to apply" pill
// appears after the first persisted change in a session.

const LS_KEY = "holtburger_graphics_v1";
const QUALITY_EVENT = "hb-quality-changed";

// Mirrors quality.js BOOL_FLAGS + INT_FLAGS so the tab can render
// controls without importing the renderer side. Kept in sync by the
// docs/quality-presets.md table — if you add a flag in quality.js,
// add it here too.
const QUALITY_BOOL_FLAGS = [
  "antialias",
  "shadows",
  "csm",
  "normalMaps",
  "detailFlag",
  "triplanar",
  "pom",
  "hero",
  "terrainDetailNormal",
  "bloom",
  "vignette",
  "lightShafts",
];
const QUALITY_INT_FLAGS = ["subdivLevel"];

// Stub flags — UI controls that persist to localStorage but aren't
// consumed by the renderer yet. Listed for visibility so future wiring
// has a place to land.
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

// ---------------------------------------------------------------------------
// Rendering ------------------------------------------------------------------

const TONE_MAPPING_OPTIONS = [
  ["default", "Default"],
  ["none", "None"],
  ["linear", "Linear"],
  ["reinhard", "Reinhard"],
  ["cineon", "Cineon"],
  ["aces", "ACES"],
  ["agx", "AGX"],
];
const SUBDIV_OPTIONS = [1, 2, 4, 8];
const SHADOW_SIZES = [512, 1024, 2048, 4096];
const PARTICLE_CAPS = [64, 128, 256, 512, 1024, 2048];
const LIGHT_CAPS = [16, 32, 64, 128, 256];
const TARGET_FPS = [
  [0, "Unlimited"],
  [30, "30"],
  [60, "60"],
  [120, "120"],
  [144, "144"],
];

export function renderGraphicsTab(containerEl, { onAnyChange } = {}) {
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
  containerEl.appendChild(makeSectionHeader("Preset"));
  const presetRow = document.createElement("div");
  presetRow.className = "hb-settings-btnrow";
  for (const p of ["low", "mid", "high", "ultra"]) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-settings-btn";
    if (p === activePreset) btn.classList.add("active");
    btn.textContent = capitalize(p);
    btn.dataset.preset = p;
    btn.addEventListener("click", () => {
      setPreset(state, p);
      presetRow.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("active", b.dataset.preset === p);
      });
      // Re-render the controls so toggles reflect the new preset defaults.
      const target = containerEl;
      renderGraphicsTab(target, { onAnyChange });
      markDirty();
    });
    presetRow.appendChild(btn);
  }
  containerEl.appendChild(presetRow);

  // Snapshot the effective flag values (preset+overrides) so toggles
  // start in the right position even when nothing is in localStorage yet.
  const effective = effectiveFlags(state);

  // --- Renderer ------------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Renderer"));
  containerEl.appendChild(boolRow("Antialias", "antialias", effective.antialias, (v) => {
    setQualityFlag(state, "antialias", v);
    markDirty();
  }));
  containerEl.appendChild(rangeRow({
    label: "Render scale",
    min: 0.5, max: 1.5, step: 0.05,
    value: state.extras.renderScale,
    format: (v) => v.toFixed(2),
    note: "live",
    onInput: (v) => {
      setExtra(state, "renderScale", v);
      applyRenderScaleLive(v);
    },
  }));
  containerEl.appendChild(selectRow({
    label: "Tone mapping",
    options: TONE_MAPPING_OPTIONS,
    value: state.extras.toneMapping,
    onChange: (v) => { setExtra(state, "toneMapping", v); markDirty(); },
  }));
  containerEl.appendChild(rangeRow({
    label: "Exposure",
    min: 0.2, max: 2.0, step: 0.05,
    value: state.extras.exposure,
    format: (v) => v.toFixed(2),
    onInput: (v) => { setExtra(state, "exposure", v); markDirty(); },
  }));

  // --- Shadows -------------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Shadows"));
  containerEl.appendChild(boolRow("Shadows", "shadows", effective.shadows, (v) => {
    setQualityFlag(state, "shadows", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Cascaded shadows (CSM)", "csm", effective.csm, (v) => {
    setQualityFlag(state, "csm", v); markDirty();
  }));
  containerEl.appendChild(selectRow({
    label: "Shadow map",
    options: SHADOW_SIZES.map((n) => [String(n), `${n}×${n}`]),
    value: String(state.extras.shadowMapSize),
    onChange: (v) => { setExtra(state, "shadowMapSize", Number(v)); markDirty(); },
  }));

  // --- Materials -----------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Materials"));
  containerEl.appendChild(boolRow("Normal maps", "normalMaps", effective.normalMaps, (v) => {
    setQualityFlag(state, "normalMaps", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Detail flag", "detailFlag", effective.detailFlag, (v) => {
    setQualityFlag(state, "detailFlag", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Triplanar", "triplanar", effective.triplanar, (v) => {
    setQualityFlag(state, "triplanar", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Parallax occlusion (POM)", "pom", effective.pom, (v) => {
    setQualityFlag(state, "pom", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Hero models", "hero", effective.hero, (v) => {
    setQualityFlag(state, "hero", v); markDirty();
  }));

  // --- Terrain -------------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Terrain"));
  containerEl.appendChild(boolRow("Terrain detail normals", "terrainDetailNormal", effective.terrainDetailNormal, (v) => {
    setQualityFlag(state, "terrainDetailNormal", v); markDirty();
  }));
  containerEl.appendChild(selectRow({
    label: "Subdivision level",
    options: SUBDIV_OPTIONS.map((n) => [String(n), `${n}×`]),
    value: String(effective.subdivLevel),
    onChange: (v) => { setQualityFlag(state, "subdivLevel", Number(v)); markDirty(); },
  }));

  // --- Post-processing -----------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Post-processing"));
  containerEl.appendChild(boolRow("Bloom", "bloom", effective.bloom, (v) => {
    setQualityFlag(state, "bloom", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Vignette", "vignette", effective.vignette, (v) => {
    setQualityFlag(state, "vignette", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Light shafts", "lightShafts", effective.lightShafts, (v) => {
    setQualityFlag(state, "lightShafts", v); markDirty();
  }));

  // --- Entities & particles (stubs — UI persists; renderer wires later) ---
  containerEl.appendChild(makeSectionHeader("Entities & particles"));
  containerEl.appendChild(rangeRow({
    label: "Entity tick distance",
    min: 30, max: 240, step: 5,
    value: state.extras.entityTickDistance,
    format: (v) => `${v} m`,
    onInput: (v) => { setExtra(state, "entityTickDistance", v); markDirty(); },
  }));
  containerEl.appendChild(rangeRow({
    label: "Nameplate distance",
    min: 20, max: 160, step: 5,
    value: state.extras.nameplateDistance,
    format: (v) => `${v} m`,
    onInput: (v) => { setExtra(state, "nameplateDistance", v); markDirty(); },
  }));
  containerEl.appendChild(selectRow({
    label: "Max particles / emitter",
    options: PARTICLE_CAPS.map((n) => [String(n), String(n)]),
    value: String(state.extras.maxParticles),
    onChange: (v) => { setExtra(state, "maxParticles", Number(v)); markDirty(); },
  }));
  containerEl.appendChild(selectRow({
    label: "Max dynamic lights",
    options: LIGHT_CAPS.map((n) => [String(n), String(n)]),
    value: String(state.extras.maxDynamicLights),
    onChange: (v) => { setExtra(state, "maxDynamicLights", Number(v)); markDirty(); },
  }));
  containerEl.appendChild(selectRow({
    label: "Target FPS cap",
    options: TARGET_FPS.map(([n, label]) => [String(n), label]),
    value: String(state.extras.targetFps),
    onChange: (v) => { setExtra(state, "targetFps", Number(v)); markDirty(); },
  }));

  // --- Debug ---------------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Debug"));
  containerEl.appendChild(boolRow("FPS counter", "fpsCounter", state.extras.fpsCounter, (v) => {
    setExtra(state, "fpsCounter", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Render stats overlay", "showRenderStats", state.extras.showRenderStats, (v) => {
    setExtra(state, "showRenderStats", v); markDirty();
  }));
  containerEl.appendChild(boolRow("Wireframe", "wireframe", state.extras.wireframe, (v) => {
    setExtra(state, "wireframe", v); markDirty();
  }));

  // --- Reload banner + reset ----------------------------------------------
  const reloadBanner = document.createElement("div");
  reloadBanner.className = "hb-graphics-reload";
  reloadBanner.style.display = "none";
  reloadBanner.innerHTML = `
    <span>Some changes apply on reload.</span>
    <button type="button" class="hb-settings-btn hb-graphics-reload-btn">Reload</button>
  `;
  reloadBanner.querySelector(".hb-graphics-reload-btn").addEventListener("click", () => {
    if (typeof window !== "undefined") window.location.reload();
  });
  containerEl.appendChild(reloadBanner);

  const resetRow = document.createElement("div");
  resetRow.className = "hb-settings-btnrow";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "hb-settings-btn";
  resetBtn.textContent = "Reset to preset defaults";
  resetBtn.addEventListener("click", () => {
    clearOverrides(state);
    renderGraphicsTab(containerEl, { onAnyChange });
    markDirty();
  });
  resetRow.appendChild(resetBtn);
  containerEl.appendChild(resetRow);

  return function dispose() {
    // Event listeners are attached to DOM nodes inside containerEl;
    // they're garbage-collected when the container is emptied or
    // removed. Nothing further to clean up.
  };
}

// ---------------------------------------------------------------------------
// Helpers --------------------------------------------------------------------

function makeSectionHeader(text) {
  const h = document.createElement("div");
  h.className = "hb-graphics-section";
  h.textContent = text;
  return h;
}

function boolRow(label, _flagKey, value, onChange) {
  const row = document.createElement("div");
  row.className = "hb-settings-row hb-graphics-row";
  const lbl = document.createElement("label");
  lbl.textContent = label;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = !!value;
  cb.addEventListener("change", () => onChange(!!cb.checked));
  row.appendChild(lbl);
  row.appendChild(cb);
  return row;
}

function rangeRow({ label, min, max, step, value, format, onInput, note }) {
  const row = document.createElement("div");
  row.className = "hb-settings-row hb-graphics-row";
  const lbl = document.createElement("label");
  lbl.textContent = label;
  const input = document.createElement("input");
  input.type = "range";
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  const val = document.createElement("span");
  val.className = "hb-settings-val";
  val.textContent = format ? format(Number(value)) : String(value);
  input.addEventListener("input", () => {
    const v = Number(input.value);
    val.textContent = format ? format(v) : String(v);
    onInput(v);
  });
  row.appendChild(lbl);
  row.appendChild(input);
  row.appendChild(val);
  if (note) {
    const tag = document.createElement("span");
    tag.className = "hb-graphics-tag";
    tag.textContent = `(${note})`;
    row.appendChild(tag);
  }
  return row;
}

function selectRow({ label, options, value, onChange }) {
  const row = document.createElement("div");
  row.className = "hb-settings-row hb-graphics-row";
  const lbl = document.createElement("label");
  lbl.textContent = label;
  const sel = document.createElement("select");
  sel.className = "hb-graphics-select";
  for (const [v, text] of options) {
    const opt = document.createElement("option");
    opt.value = v;
    opt.textContent = text;
    if (v === value) opt.selected = true;
    sel.appendChild(opt);
  }
  sel.addEventListener("change", () => onChange(sel.value));
  row.appendChild(lbl);
  row.appendChild(sel);
  return row;
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
    shadows: true,
    csm: false,
    normalMaps: true,
    detailFlag: true,
    triplanar: true,
    pom: false,
    hero: false,
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
