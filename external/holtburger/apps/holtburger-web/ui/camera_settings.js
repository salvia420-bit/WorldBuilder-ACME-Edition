// Camera settings — rendered by the Options view's Gameplay tab
// ("Mouse & Camera", plugins/options-panel.js) and the legacy bar gear
// popover (ui/bar.js).
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

// HUD overhaul 2026-10-05 — the row widgets are the shared kit-styled
// ones from graphics_settings.js (retail orb checkbox, kit slider, <label
// for>), not a private copy.
import { boolRow, rangeRow, makeSectionHeader } from "./graphics_settings.js";

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

/**
 * Push a camera-settings object onto the live camera (every setter is
 * guarded). Used by Restore defaults and by the Options view's Cancel,
 * which restores the on-open snapshot (HUD overhaul 2026-10-05).
 */
export function applyCameraState(s) {
  const st = { ...DEFAULTS, ...(s || {}) };
  applyCam("__setAutoFollow", st.autoFollow);
  applyCam("__setAutoFollowRate", st.autoFollowRate);
  applyCam("__setCamDistance", st.distance);
  applyCam("__setCamStiffness", st.stiffness);
  applyCam("__setMouseSens", st.mouseSens);
  applyCam("__setMouseSmooth", st.mouseSmooth);
  applyCam("__setMouseInvertY", st.invertY);
}

// `extraMouseRows` (optional) returns extra row elements to place at the
// top of the "Mouse look" section — the Options view puts the
// server-side "Use mouse turning" CharacterOption there. It is a
// function so a Restore-defaults re-render rebuilds fresh rows.
export function renderCameraTab(containerEl, { onAnyChange, extraMouseRows } = {}) {
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
  containerEl.appendChild(makeSectionHeader("Camera"));
  containerEl.appendChild(
    boolRow("Follow behind character", state.autoFollow, (v) => {
      set("autoFollow", v);
      applyCam("__setAutoFollow", v);
    }),
  );
  containerEl.appendChild(
    rangeRow({
      label: "Follow speed",
      min: 1, max: 15, step: 0.5,
      value: state.autoFollowRate,
      format: (v) => v.toFixed(1),
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
      hint: "Lower values let the camera trail more smoothly. Retail default ≈ 0.44.",
      onInput: (v) => {
        set("stiffness", v);
        applyCam("__setCamStiffness", v);
      },
    }),
  );

  // --- Mouse look ----------------------------------------------------------
  containerEl.appendChild(makeSectionHeader("Mouse look"));
  if (typeof extraMouseRows === "function") {
    try {
      for (const row of extraMouseRows() || []) {
        if (row) containerEl.appendChild(row);
      }
    } catch (_e) { /* caller rows are best-effort */ }
  }
  containerEl.appendChild(
    rangeRow({
      label: "Sensitivity",
      min: 0.1, max: 3.0, step: 0.05,
      value: state.mouseSens,
      format: (v) => `${v.toFixed(2)}×`,
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
  resetRow.className = "hb-settings-btnrow hb-graphics-resetrow";
  const resetBtn = document.createElement("button");
  resetBtn.type = "button";
  resetBtn.className = "hbk-btn-small hbk-brown";
  resetBtn.textContent = "Restore defaults";
  resetBtn.addEventListener("click", () => {
    const fresh = { ...DEFAULTS };
    saveCameraState(fresh);
    applyCameraState(fresh);
    renderCameraTab(containerEl, { onAnyChange, extraMouseRows });
    touch();
  });
  resetRow.appendChild(resetBtn);
  containerEl.appendChild(resetRow);

  return function dispose() {
    // Listeners live on children of containerEl and are GC'd when it is
    // emptied/replaced. No-op kept so the activation contract is uniform.
  };
}
