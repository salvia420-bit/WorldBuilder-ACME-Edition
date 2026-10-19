// Barber panel — maps-chargen-barber-1 (2026-10-13): retail gmBarberUI.
//
// Vanilla ACE barbers (Ealdred, Nawaf, Haruko, Bertrand) take an MMD note
// and run EmoteType.StartBarber → GameEventStartBarber (0x0075); the
// developer command `@barbershop` opens it without a note. Before this
// panel the event was only logged, ACE's BarberActive stayed set and the
// note was gone.
//
// Retail page (acclient.c): RecvNotice_StartBarberNotice (:271178) →
// InitializePage (:270582) → rows Hair / Eyes / Nose / Mouth / Skin with
// −/+ arrows, a colour wheel (SetSelection :269647, SetColor :269542), a
// shade scroll (SetShade :269141), one heritage checkbox (Empyrean
// "Suppress Levitation", Undead "Suppress Flames", Umbraen / Penumbraen
// "Suppress Crown"), Apply and Cancel (ListenToElementMessage :269886).
// The 3D preview (gmCG3DView) is not ported; the player's own model
// updates when ACE answers with ObjDescEvent.
//
// The page rules are ui/ac_barber.js (BarberPage / applyBarber); the face
// mapping, DID rebuild and ACE checks are Rust (holtburger_core::barber,
// via SessionHandle.barberInit / barberApply); the send is
// SessionHandle.finishBarber (GameAction 0x0311).
//
// Apply's local effects (retail, Undead / Shadow / Empyrean only):
// destroy_particle_manager + play_script on the player run with the page
// (`?barber=off` turns both off); the Empyrean motion-table swap runs by
// default (`?barberMotionTable=off` skips it).
//
// Open paths: bus `startBarber` {fields} (app/client_events.js, from the
// UI_EVENT "barber" tag), window.__openBarberPanel(fields),
// window.__closeBarberPanel(). Window events: hb:barber-opened,
// hb:barber-closed, hb:barber-applied {fields, effects}.

import { acString, loadStringTable } from "../ui/ac_strings.js";
import { computeStrHash } from "../app/login_ui_rules.js";
import { ownerRegistry, particleOwnerOn } from "../scene3d/particles/owner_registry.js";
import {
  BarberPage, BARBER_PARTS, BARBER_WINDOW_ID, BARBER_OPTION_STRING_TABLE,
  BARBER_ROW_STRING_TABLE, applyBarber, barberEnabled, barberMotionTableEnabled,
  barberOptionLabel, barberProblemText, barberRowLabels, parseStartBarberFields,
} from "../ui/ac_barber.js";
import { createKitWindow, kitButton, KIT_COLOR } from "./commerce_window.js";

const OVERLAY_ID = "hb-barber-panel";
const STYLE_ID = "hb-barber-panel-style";

const state = {
  win: null,
  refs: null,
  page: null,
  client: null,
  applying: false,
  openSeq: 0,
  unsub: null,
};

function handle() {
  return (typeof window !== "undefined" ? window.__sessionHandle : null) ?? null;
}

function localPlayerGuid() {
  try {
    const g = handle()?.playerGuid?.() ?? window.getLocalPlayerGuid?.() ?? 0;
    return g >>> 0;
  } catch (_) { return 0; }
}

/** StringTable lookup by retail token (compute_str_hash). */
function lookupString(tableId, token) {
  return acString(tableId, computeStrHash(token));
}

function ensureStyles() {
  if (typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) return;
  const s = document.createElement("style");
  s.id = STYLE_ID;
  s.textContent = `
    #${OVERLAY_ID} { width: 300px; }
    #${OVERLAY_ID} .hbb-rows { display: flex; flex-direction: column; gap: 3px; padding: 8px 10px 4px; }
    #${OVERLAY_ID} .hbb-row {
      display: grid; grid-template-columns: 22px minmax(0, 1fr) 22px; align-items: center; gap: 4px;
      padding: 2px 2px; border: 1px solid transparent; cursor: pointer;
    }
    #${OVERLAY_ID} .hbb-row[hidden] { display: none; }
    #${OVERLAY_ID} .hbb-row.is-selected { border-color: var(--hbk-gold-dim); background: rgba(243, 210, 122, 0.07); }
    #${OVERLAY_ID} .hbb-row .hbb-label { display: flex; justify-content: space-between; gap: 6px; color: var(--hbk-text); font-size: 12px; }
    #${OVERLAY_ID} .hbb-row .hbb-count { color: var(--hbk-text-dim); font-variant-numeric: tabular-nums; font-size: 11px; }
    #${OVERLAY_ID} .hbb-arrow { min-width: 22px; padding: 0; }
    #${OVERLAY_ID} .hbb-wheel { display: flex; flex-direction: column; gap: 6px; padding: 4px 10px 6px; }
    #${OVERLAY_ID} .hbb-spots { display: flex; flex-wrap: wrap; gap: 4px; min-height: 22px; }
    #${OVERLAY_ID} .hbb-spot {
      width: 20px; height: 20px; padding: 0; border: 1px solid #000; border-radius: 50%;
      box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.6); cursor: pointer;
    }
    #${OVERLAY_ID} .hbb-spot.is-current { outline: 2px solid var(--hbk-gold-bright); outline-offset: 1px; }
    #${OVERLAY_ID} .hbb-spot.is-unknown { background: repeating-linear-gradient(45deg, #333 0 3px, #222 3px 6px); }
    #${OVERLAY_ID} .hbb-shade { width: 100%; }
    #${OVERLAY_ID} .hbb-shade[hidden] { display: none; }
    #${OVERLAY_ID} .hbb-option { display: flex; align-items: center; gap: 6px; padding: 2px 10px; color: var(--hbk-text); font-size: 12px; }
    #${OVERLAY_ID} .hbb-option[hidden] { display: none; }
    #${OVERLAY_ID} .hbb-status { min-height: 16px; padding: 2px 10px 4px; color: var(--hbk-text-dim); font-size: 11px; line-height: 13px; }
    #${OVERLAY_ID} .hbb-status.is-bad { color: var(--hbk-warn); }
  `;
  document.head.appendChild(s);
}

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.appendChild(e);
  return e;
}

function setStatus(text, bad = false) {
  const r = state.refs;
  if (!r) return;
  r.status.textContent = String(text ?? "");
  r.status.classList.toggle("is-bad", !!bad);
}

// ── world sinks for Apply's local effects ───────────────────────────────────

/**
 * Retail CPhysicsObj::destroy_particle_manager / play_script /
 * SetMotionTableID on the local player, over the EntityManager's existing
 * paths (the despawn teardown in entities.js remove(); the H2 chain walker
 * `_attachParticleChainForEntity`; the rig meta's `mtableId`). Each is a
 * no-op when the scene is not up.
 */
export function playerEffectSinks(env = {}) {
  const em = env.entityManager ?? (typeof window !== "undefined" ? window.liveScene3d?.entityManager : null) ?? null;
  const guid = (env.playerGuid ?? localPlayerGuid()) >>> 0;
  const registry = env.ownerRegistry ?? ownerRegistry;
  const ownerOn = env.particleOwnerOn ?? particleOwnerOn;
  return {
    destroyParticles() {
      if (!em || !guid) return;
      const ids = em._particleEmittersForGuid?.get?.(guid);
      if (ids && em._worldParticleManager) {
        for (const id of ids) {
          try { em._worldParticleManager.destroyParticleEmitter(id); } catch (_) {}
        }
        em._particleEmittersForGuid.delete(guid);
      }
      if (ownerOn()) {
        try { registry.destroyAllForOwner(guid); } catch (_) {}
      }
    },
    playScript(did) {
      const inst = em?.entityMap?.get?.(guid);
      if (!inst || typeof em._attachParticleChainForEntity !== "function") return;
      em._attachParticleChainForEntity(guid, inst.root, did >>> 0).catch?.(() => {});
    },
    setMotionTable(id) {
      const inst = em?.entityMap?.get?.(guid);
      if (inst?.meta) inst.meta.mtableId = id >>> 0;
      const sh = handle();
      if (typeof sh?.ingestMotionLengths === "function") {
        try { sh.ingestMotionLengths(id >>> 0); } catch (_) {}
      }
    },
  };
}

// ── rendering ───────────────────────────────────────────────────────────────

function rgbCss(c) {
  if (!Array.isArray(c) || c.length < 3) return null;
  return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
}

function render() {
  const r = state.refs;
  const page = state.page;
  if (!r || !page) return;
  const labels = barberRowLabels(page.heritage, lookupString);
  for (const part of BARBER_PARTS) {
    const row = r.rows[part];
    if (!row) continue;
    row.box.hidden = !page.rowVisible(part);
    row.box.classList.toggle("is-selected", page.part === part);
    row.name.textContent = labels[part];
    const n = page.choiceCount(part);
    row.count.textContent = n > 0 ? `${page.choice(part) + 1}/${n}` : "";
    const arrows = page.arrowsEnabled(part);
    row.prev.disabled = !arrows;
    row.next.disabled = !arrows;
  }
  const wheel = page.wheel();
  r.spots.textContent = "";
  wheel.spots.forEach((c, i) => {
    const b = el("button", "hbb-spot", r.spots);
    b.type = "button";
    b.dataset.index = String(i);
    const css = rgbCss(c);
    if (css) b.style.background = css;
    else b.classList.add("is-unknown");
    b.classList.toggle("is-current", i === wheel.current);
    b.title = `Colour ${i + 1}`;
    b.addEventListener("click", (ev) => {
      ev.stopPropagation?.();
      page.pickSpot(i);
      render();
    });
  });
  r.shade.hidden = !wheel.shadeVisible;
  r.shade.value = String(wheel.shade);
  const optLabel = barberOptionLabel(page.optionToken, (t, token) => lookupString(t, token));
  r.optionBox.hidden = !optLabel;
  r.optionText.textContent = optLabel ?? "";
  r.optionInput.checked = !!page.face.option;
  r.applyBtn.disabled = state.applying;
}

function makeRow(parent, part) {
  const box = el("div", "hbb-row", parent);
  box.dataset.part = String(part);
  const prev = kitButton("<", "hbk-btn-small hbb-arrow", () => { state.page?.step(part, -1); render(); });
  prev.dataset.dir = "-1";
  prev.title = "Previous";
  box.appendChild(prev);
  const label = el("div", "hbb-label", box);
  const name = el("span", "hbb-name", label);
  const count = el("span", "hbb-count", label);
  const next = kitButton(">", "hbk-btn-small hbb-arrow", () => { state.page?.step(part, 1); render(); });
  next.dataset.dir = "1";
  next.title = "Next";
  box.appendChild(next);
  box.addEventListener("click", () => { state.page?.select(part); render(); });
  return { box, prev, next, name, count };
}

function ensurePanel() {
  if (state.win) return state.win;
  ensureStyles();
  const win = createKitWindow({
    id: OVERLAY_ID,
    title: "Barber",
    windowId: BARBER_WINDOW_ID,
    // Retail places the page at (20, 20) of the 3D view (smartbox slot
    // 0x2100000f:0x10000598).
    defaultPos: { left: "20px", top: "20px", right: "auto", bottom: "auto" },
    className: "hb-barber",
    onHide: () => {
      // The X / Esc paths call win.close() directly (not closePanel), so the
      // hide itself invalidates a pending open or an in-flight Apply.
      state.openSeq += 1;
      state.applying = false;
      try { window.dispatchEvent(new CustomEvent("hb:barber-closed")); } catch (_) {}
    },
  });
  state.win = win;
  const rowsBox = el("div", "hbb-rows", win.body);
  const rows = {};
  for (const part of BARBER_PARTS) rows[part] = makeRow(rowsBox, part);
  const wheelBox = el("div", "hbb-wheel", win.body);
  const spots = el("div", "hbb-spots", wheelBox);
  const shade = el("input", "hbb-shade", wheelBox);
  shade.type = "range";
  shade.min = "0";
  shade.max = "1";
  shade.step = "any";
  shade.title = "Shade";
  shade.addEventListener("input", () => {
    state.page?.setShade(Number(shade.value));
  });
  const optionBox = el("label", "hbb-option", win.body);
  const optionInput = el("input", "hbb-option-input", optionBox);
  optionInput.type = "checkbox";
  const optionText = el("span", "hbb-option-text", optionBox);
  optionInput.addEventListener("change", () => {
    state.page?.setOption(!!optionInput.checked);
  });
  const status = el("div", "hbb-status", win.body);
  const footer = el("div", "hbk-footer", win.body);
  const cancelBtn = kitButton("Cancel", "hbk-btn", () => closePanel());
  cancelBtn.dataset.action = "cancel";
  const applyBtn = kitButton("Apply", "hbk-btn", () => { applyNow(); }, KIT_COLOR.gold);
  applyBtn.dataset.action = "apply";
  footer.appendChild(cancelBtn);
  footer.appendChild(applyBtn);
  state.refs = { rows, spots, shade, optionBox, optionInput, optionText, status, applyBtn, cancelBtn };
  return win;
}

// ── open / apply / close ────────────────────────────────────────────────────

/**
 * Open the page for the 16 StartBarber fields. Resolves true when it
 * opened. Stays closed with `?barber=off`, on a stale pkg/ (no
 * `barberInit`), or when the player's heritage / gender is unknown.
 */
export async function openPanel(fields) {
  if (!barberEnabled()) return false;
  if (typeof document === "undefined") return false;
  const sh = handle();
  if (typeof sh?.barberInit !== "function" || typeof sh?.barberApply !== "function"
    || typeof sh?.finishBarber !== "function") {
    console.warn("[barber-panel] barberInit/barberApply/finishBarber missing (stale pkg/) — barber not shown");
    return false;
  }
  const values = Array.isArray(fields) || ArrayBuffer.isView(fields) ? Array.from(fields, (v) => v >>> 0) : null;
  if (!values || values.length !== 16) {
    console.warn("[barber-panel] StartBarber needs 16 fields, got", fields);
    return false;
  }
  const guid = localPlayerGuid();
  let heritage = 0;
  let gender = 0;
  try {
    heritage = (sh.objectIntProperty?.(guid, 188) ?? 0) >>> 0; // PropertyInt.HeritageGroup
    gender = (sh.objectIntProperty?.(guid, 113) ?? 0) >>> 0; // PropertyInt.Gender
  } catch (_) { /* unknown → refused below */ }
  if (!heritage || !gender) {
    console.warn(`[barber-panel] player heritage/gender unknown (${heritage}/${gender}) — barber not shown`);
    return false;
  }
  const seq = ++state.openSeq;
  let init;
  try {
    const json = await sh.barberInit(heritage, gender, Uint32Array.from(values));
    init = typeof json === "string" ? JSON.parse(json) : json;
  } catch (e) {
    console.warn("[barber-panel] barberInit failed:", e);
    return false;
  }
  if (seq !== state.openSeq) return false; // superseded by a newer StartBarber
  // Warm the label tables (the English values show until they land).
  loadStringTable(BARBER_OPTION_STRING_TABLE).then(() => render()).catch(() => {});
  if (init?.gearOlthoi) loadStringTable(BARBER_ROW_STRING_TABLE).then(() => render()).catch(() => {});
  const win = ensurePanel();
  state.page = new BarberPage(init);
  state.applying = false;
  setStatus("");
  render();
  win.open();
  try {
    window.dispatchEvent(new CustomEvent("hb:barber-opened", { detail: { heritage, gender } }));
  } catch (_) {}
  return true;
}

/** Apply: build, self-check, run the local effects, send FinishBarber once. */
export async function applyNow() {
  const page = state.page;
  const sh = handle();
  if (!page || state.applying || !state.win?.isOpen()) return null;
  state.applying = true;
  render();
  // Cancel / Esc / X / a newer StartBarber bump openSeq while barberApply is
  // pending; applyBarber then runs no local effects and sends nothing.
  const seq = state.openSeq;
  const stillOpen = () => seq === state.openSeq && !!state.win?.isOpen();
  let out;
  try {
    out = await applyBarber(page, {
      barberApply: (h, g, face) => sh.barberApply(h, g, face),
      finishBarber: (f) => sh.finishBarber(f),
      sinks: playerEffectSinks(),
      motionTable: barberMotionTableEnabled(),
      stillOpen,
    });
  } catch (e) {
    console.warn("[barber-panel] apply failed:", e);
    out = { sent: false, reason: "error" };
  }
  if (!out.sent && !stillOpen()) {
    // Closed (onHide already cleared `applying`) or a newer page owns the
    // panel now — touch nothing. Only when a newer StartBarber's open is
    // still pending is this page on screen: un-stick its Apply button.
    if (state.page === page && state.applying) {
      state.applying = false;
      render();
    }
    return { sent: false, reason: "cancelled" };
  }
  state.applying = false;
  if (out.sent) {
    try {
      window.dispatchEvent(new CustomEvent("hb:barber-applied", { detail: { fields: out.fields, effects: out.effects } }));
    } catch (_) {}
    closePanel();
  } else if (out.reason === "rejected") {
    setStatus(barberProblemText(out.problems), true);
    render();
  } else {
    setStatus("The barber could not build that look. Nothing was sent.", true);
    render();
  }
  return out;
}

/** Cancel / Esc: hide the page; nothing is sent (retail 0x100005A7). */
export function closePanel() {
  state.openSeq += 1;
  if (!state.win?.isOpen()) return;
  state.win.close();
}

/** Bus `startBarber` {rest: "f0,…,f15"} (app/client_events.js) — or {fields}. */
function onStartBarber(ev) {
  const d = ev?.detail ?? {};
  const fields = Array.isArray(d.fields) ? d.fields : parseStartBarberFields(d.rest);
  if (!fields) {
    console.warn("[barber-panel] malformed StartBarber payload:", d.rest);
    return;
  }
  openPanel(fields).catch((e) => console.warn("[barber-panel] open failed:", e));
}

export const manifest = {
  id: "barber-panel",
  name: "Barber",
  icon: "✂",
  iconHidden: true,
  version: "0.1.0",
  description: "Retail barber page (gmBarberUI): StartBarber → face editor → FinishBarber",
};

export function mount(ctx) {
  if (typeof document === "undefined" || typeof window === "undefined") {
    return () => {};
  }
  ensureStyles();
  // The bar mounts this at page load with ctx.client null; the bus exists
  // only after login, so subscribe through __pluginClientReady (2026-10-18:
  // bound at mount only, no barber page ever opened).
  let disposed = false;
  const subscribe = (client) => {
    if (disposed || state.unsub || !client?.events?.on) return;
    state.client = client;
    try {
      client.events.on("startBarber", onStartBarber);
      state.unsub = () => client.events.off?.("startBarber", onStartBarber);
    } catch (e) {
      console.warn("[barber-panel] startBarber subscribe failed:", e);
    }
  };
  const client = ctx?.client ?? window.__pluginClient ?? null;
  if (client?.events?.on) subscribe(client);
  else window.__pluginClientReady?.then?.((c) => subscribe(c ?? window.__pluginClient));
  return () => {
    disposed = true;
    try { state.unsub?.(); } catch (_) {}
    state.unsub = null;
    state.client = null;
    closePanel();
  };
}

if (typeof window !== "undefined") {
  window.__openBarberPanel = (fields) => openPanel(fields);
  window.__closeBarberPanel = () => closePanel();
}

// Test-only access to the live page model.
export function _barberPageForTests() {
  return state.page;
}
