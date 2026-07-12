// Camera settings tab for the bar's gear-icon popover.
//
// Mirrors retail AC's camera/input options (PlayerOptionPage sliders:
// Camera.Stiffness, Input.MouseLookSensitivity, Input.MouseLookSmoothingAmount,
// Input.InvertMouseLookYAxis) plus our follow-camera additions (auto-follow
// behind the character + distance). Every control is LIVE — the handlers call
// the `window.__set*` hooks registered by the CameraSwitcher constructor
// (scene3d/camera.js), which mutate the live camera instance — so no reload is
// needed. Values persist to `holtburger_camera_v1` and are re-applied at
// construction on the next load.
//
// DEFAULTS deliberately match the pre-existing camera behaviour (stiffness 1.0
// = hard-lock, smoothing off, sensitivity 1.0, no auto-follow) so an untouched
// install is unchanged; retail's own default stiffness is ~0.44 (noted in the
// UI as a hint). Ranges follow the decomp: Camera.Stiffness ∈ [0.2857, 1.0].

const LS_KEY = "holtburger_camera_v1";

// 1.0 stiffness = instant/hard-lock (retail clamps the blend factor to 1 at
// stiffness 1). Lower = more camera lag/smoothing. Retail's shipped default is
// ~0.44; we default to 1.0 to preserve holtburger's existing hard-set feel.
const DEFAULTS = Object.freeze({
  distance: 6.0,       // metres behind the player
  stiffness: 1.0,      // [0.2857..1.0], 1.0 = instant
  mouseSens: 1.0,      // sensitivity multiplier
  mouseSmooth: 0.0,    // [0..1], 0 = off
  invertY: false,
  autoFollow: true,    // trailing camera behind the character (retail-default)
  autoFollowRate: 4.0, // ease speed (1/s)
});

export function loadCameraState() {
  if (typeof localStorage === "undefined") return { ...DEFAULTS };
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

function saveCameraState(state) {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(state));
  } catch (_e) {
    /* quota — silent */
  }
}

// Guarded call to a live camera setter. The setter may not exist yet if the
// 3D camera hasn't been constructed (2D mode / pre-spawn) — persistence still
// records the choice and it applies on next construction.
function applyCam(fn, value) {
  if (typeof window === "undefined") return;
  const setter = window[fn];
  if (typeof setter !== "function") return;
  try {
    setter(value);
  } catch (_e) {
    /* setter not ready — persisted value applies on reload */
  }
}

export function renderCameraTab(containerEl, { onAnyChange } = {}) {
  const state = loadCameraState();
  const touch = () => {
    if (typeof onAnyChange === "function") onAnyChange();
  };
  const set = (key, value) => {
    state[key] = value;
    saveCameraState(state);
    touch();
  };

  containerEl.innerHTML = "";
  containerEl.classList.add("hb-graphics"); // reuse the graphics-tab styling

  // --- Follow camera -------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Follow camera"));
  containerEl.appendChild(
    boolRow("Auto-follow behind character", state.autoFollow, (v) => {
      set("autoFollow", v);
      applyCam("__setAutoFollow", v);
    }),
  );
  containerEl.appendChild(
    rangeRow({
      label: "Auto-follow speed",
      min: 1, max: 15, step: 0.5,
      value: state.autoFollowRate,
      format: (v) => v.toFixed(1),
      note: "live",
      onInput: (v) => {
        set("autoFollowRate", v);
        applyCam("__setAutoFollowRate", v);
      },
    }),
  );
  containerEl.appendChild(
    rangeRow({
      label: "Distance",
      min: 2, max: 15, step: 0.5,
      value: state.distance,
      format: (v) => `${v.toFixed(1)} m`,
      note: "live",
      onInput: (v) => {
        set("distance", v);
        applyCam("__setCamDistance", v);
      },
    }),
  );
  containerEl.appendChild(
    rangeRow({
      label: "Stiffness",
      min: 0.2857, max: 1.0, step: 0.01,
      value: state.stiffness,
      format: (v) => (v >= 1.0 ? "instant" : v.toFixed(2)),
      note: "live · retail ~0.44",
      onInput: (v) => {
        set("stiffness", v);
        applyCam("__setCamStiffness", v);
      },
    }),
  );

  // --- Mouse look ----------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Mouse look"));
  containerEl.appendChild(
    rangeRow({
      label: "Sensitivity",
      min: 0.1, max: 3.0, step: 0.05,
      value: state.mouseSens,
      format: (v) => `${v.toFixed(2)}×`,
      note: "live",
      onInput: (v) => {
        set("mouseSens", v);
        applyCam("__setMouseSens", v);
      },
    }),
  );
  containerEl.appendChild(
    rangeRow({
      label: "Smoothing",
      min: 0, max: 1.0, step: 0.05,
      value: state.mouseSmooth,
      format: (v) => (v <= 0 ? "off" : v.toFixed(2)),
      note: "live",
      onInput: (v) => {
        set("mouseSmooth", v);
        applyCam("__setMouseSmooth", v);
      },
    }),
  );
  containerEl.appendChild(
    boolRow("Invert Y axis", state.invertY, (v) => {
      set("invertY", v);
      applyCam("__setMouseInvertY", v);
    }),
  );

  // --- Reset ---------------------------------------------------------------
  const resetRow = document.createElement("div");
  resetRow.className = "hb-settings-btnrow";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "hb-settings-btn";
  resetBtn.textContent = "Reset to defaults";
  resetBtn.addEventListener("click", () => {
    const fresh = { ...DEFAULTS };
    saveCameraState(fresh);
    applyCam("__setAutoFollow", fresh.autoFollow);
    applyCam("__setAutoFollowRate", fresh.autoFollowRate);
    applyCam("__setCamDistance", fresh.distance);
    applyCam("__setCamStiffness", fresh.stiffness);
    applyCam("__setMouseSens", fresh.mouseSens);
    applyCam("__setMouseSmooth", fresh.mouseSmooth);
    applyCam("__setMouseInvertY", fresh.invertY);
    renderCameraTab(containerEl, { onAnyChange });
    touch();
  });
  resetRow.appendChild(resetBtn);
  containerEl.appendChild(resetRow);

  return function dispose() {
    // Listeners live on children of containerEl and are GC'd when it is
    // emptied/replaced. No-op kept so the activation contract is uniform.
  };
}

// --- widgets (same shape as ui/graphics_settings.js) -----------------------

function makeSectionHeader(text) {
  const h = document.createElement("div");
  h.className = "hb-graphics-section";
  h.textContent = text;
  return h;
}

function boolRow(label, value, onChange) {
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
