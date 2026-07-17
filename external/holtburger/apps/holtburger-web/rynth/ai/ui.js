// ui.js — minimal key-entry/status panel for the AI director (plain DOM, no
// framework; narrow DOM surface so a hand-rolled document stub can unit-test
// it). INTERFACE FROZEN — see rynth/ai/SPEC.md §ui.
//
// Deliberately does NOT import llm_client.js (parallel-build isolation): the
// key helpers arrive duck-typed via the second param as
// { loadKey(), saveKey(k), clearKey() }. Every director/client touch is
// try/caught — a broken or absent director must never break the page
// (SPEC "Cost & safety": failure paths degrade to the bot grinding untouched).

// Palette matches the app's overlay look — plugins/debug-overlay.js:84-101.
const CSS_ROOT =
  "position:fixed;right:8px;bottom:8px;width:280px;z-index:10000;" +
  "box-sizing:border-box;padding:6px 8px;" +
  "background:rgba(0,0,0,0.72);border:1px solid var(--hb-border-brass,#8a7544);" +
  "color:var(--hb-text-cream,#f0d8a0);" +
  "font-family:var(--hb-font-mono,ui-monospace,Menlo,Consolas,monospace);" +
  "font-size:11px;line-height:1.4;";
const CSS_TITLE = "font-weight:bold;letter-spacing:1px;margin-bottom:4px;";
const CSS_INPUT =
  "width:100%;box-sizing:border-box;margin:2px 0;padding:2px 4px;" +
  "background:rgba(0,0,0,0.5);color:inherit;font:inherit;" +
  "border:1px solid var(--hb-border-brass-deep,#5a4a28);";
const CSS_INPUT_SM =
  "width:56px;box-sizing:border-box;padding:2px 4px;" +
  "background:rgba(0,0,0,0.5);color:inherit;font:inherit;" +
  "border:1px solid var(--hb-border-brass-deep,#5a4a28);";
const CSS_BTN =
  "margin:2px 6px 2px 0;padding:2px 8px;cursor:pointer;" +
  "background:rgba(0,0,0,0.5);color:inherit;font:inherit;" +
  "border:1px solid var(--hb-border-brass,#8a7544);";
const CSS_ROW = "display:flex;align-items:center;gap:6px;margin:2px 0;";
const CSS_STATUS = "margin-top:4px;white-space:pre-wrap;word-break:break-word;";
const CSS_JOURNAL =
  "margin-top:2px;white-space:pre-wrap;word-break:break-word;opacity:0.8;";

// SPEC §ui: "datalist of a few OpenRouter ids". Fallback when the caller
// doesn't pass a providers.js-derived list (additive `models` option below).
const MODEL_SUGGESTIONS = [
  "openai/gpt-oss-120b",
  "meta-llama/llama-3.1-8b-instruct",
  "anthropic/claude-haiku-4.5",
  "anthropic/claude-sonnet-4.6",
  "openai/gpt-4o-mini",
  "google/gemini-2.0-flash-001",
];

let mountSeq = 0; // unique datalist id per mount (panel is remountable)

/** Mount the panel. -> { el, destroy() }
 * `models` (optional, additive): datalist suggestions — e.g.
 * providers.js modelsFor(DEFAULT_PROVIDER) ids; invalid/empty -> the
 * hardcoded fallback. */
export function mountAiPanel(director, { client, models } = {}) {
  const modelIds = Array.isArray(models) && models.some((m) => typeof m === "string" && m)
    ? models.filter((m) => typeof m === "string" && m)
    : MODEL_SUGGESTIONS;
  const make = (tag, css, text) => {
    const el = document.createElement(tag);
    if (css) try { el.style.cssText = css; } catch { /* styleless stub doc */ }
    if (text != null) el.textContent = text;
    return el;
  };

  const root = make("div", CSS_ROOT);
  root.appendChild(make("div", CSS_TITLE, "AI DIRECTOR"));

  // --- API key: masked input + Save/Clear ---
  const keyInput = make("input", CSS_INPUT);
  keyInput.type = "password";
  keyInput.placeholder = "OpenRouter API key (sk-or-...)";
  try {
    const k = client && client.loadKey ? client.loadKey() : null;
    if (k) keyInput.value = k;
  } catch { /* keep empty */ }
  root.appendChild(keyInput);

  const keyRow = make("div", CSS_ROW);
  const btnSave = make("button", CSS_BTN, "Save");
  btnSave.type = "button";
  btnSave.addEventListener("click", () => {
    try { if (client && client.saveKey) client.saveKey(keyInput.value); } catch {}
  });
  const btnClear = make("button", CSS_BTN, "Clear");
  btnClear.type = "button";
  btnClear.addEventListener("click", () => {
    try { if (client && client.clearKey) client.clearKey(); } catch {}
    keyInput.value = "";
  });
  keyRow.appendChild(btnSave);
  keyRow.appendChild(btnClear);
  root.appendChild(keyRow);

  // --- model text input + datalist ---
  const listId = "hb-ai-models-" + ++mountSeq;
  const modelInput = make("input", CSS_INPUT);
  modelInput.type = "text";
  modelInput.placeholder = "model (OpenRouter id)";
  try { modelInput.setAttribute("list", listId); } catch {}
  try {
    if (director && director.client && typeof director.client.model === "string")
      modelInput.value = director.client.model;
  } catch {}
  modelInput.addEventListener("change", () => {
    try {
      if (director && director.client && modelInput.value)
        director.client.model = modelInput.value;
    } catch {}
  });
  const datalist = make("datalist");
  datalist.id = listId;
  for (const m of modelIds) {
    const opt = make("option");
    opt.value = m;
    datalist.appendChild(opt);
  }
  root.appendChild(modelInput);
  root.appendChild(datalist);

  // --- check-in interval (minutes) ---
  const intervalRow = make("div", CSS_ROW);
  intervalRow.appendChild(make("span", null, "check-in (min)"));
  const intervalInput = make("input", CSS_INPUT_SM);
  intervalInput.type = "number";
  try {
    if (director && typeof director.intervalMinutes === "number")
      intervalInput.value = String(director.intervalMinutes);
  } catch {}
  intervalInput.addEventListener("change", () => {
    const n = Number(intervalInput.value);
    if (!Number.isFinite(n)) return;
    const v = Math.max(1, Math.min(30, Math.round(n))); // SPEC §director bounds 1..30
    intervalInput.value = String(v);
    try { if (director) director.intervalMinutes = v; } catch {}
  });
  intervalRow.appendChild(intervalInput);
  root.appendChild(intervalRow);

  // --- Enable checkbox + Check now ---
  const runRow = make("div", CSS_ROW);
  const enableCb = make("input");
  enableCb.type = "checkbox";
  try { enableCb.checked = !!(director && director.status && director.status.enabled); } catch {}
  enableCb.addEventListener("change", () => {
    try {
      if (director) (enableCb.checked ? director.start() : director.stop());
    } catch {}
    renderStatus();
  });
  runRow.appendChild(enableCb);
  runRow.appendChild(make("span", null, "Enable"));
  const btnNow = make("button", CSS_BTN, "Check now");
  btnNow.type = "button";
  btnNow.addEventListener("click", () => {
    // Fire-and-forget (SPEC §ui): a failed check-in journals itself in the
    // director; the panel must never surface a rejection.
    try {
      const p = director && director.checkNow ? director.checkNow() : null;
      if (p && typeof p.then === "function") p.then(renderStatus).catch(() => {});
    } catch {}
  });
  runRow.appendChild(btnNow);
  root.appendChild(runRow);

  // --- status line + last-3 journal lines ---
  const statusEl = make("div", CSS_STATUS, "status: n/a");
  const journalEl = make("div", CSS_JOURNAL);
  root.appendChild(statusEl);
  root.appendChild(journalEl);

  function renderStatus() {
    let line = "status: n/a";
    try {
      const s = director ? director.status : null;
      if (s) {
        const next = s.nextCheckAt
          ? Math.max(0, Math.round((s.nextCheckAt - Date.now()) / 1000)) + "s"
          : "-";
        line =
          (s.enabled ? "on" : "off") +
          (s.running ? " (checking)" : "") +
          " calls=" + (s.calls ?? 0) +
          " errs=" + (s.consecutiveErrors ?? 0) +
          " next=" + next;
        if (s.lastSummary) line += "\n" + String(s.lastSummary).slice(0, 120);
        enableCb.checked = !!s.enabled; // director may self-disable on errors
      }
    } catch { /* broken status getter -> keep n/a */ }
    statusEl.textContent = line;
    let tail = "";
    try {
      if (director && director.journal && typeof director.journal.tail === "function") {
        const entries = director.journal.tail(3);
        if (Array.isArray(entries))
          tail = entries
            .map((e) => "[" + e.kind + "] " + String(e.text).slice(0, 90))
            .join("\n");
      }
    } catch { /* journal optional */ }
    journalEl.textContent = tail;
  }

  try { if (document.body) document.body.appendChild(root); } catch {}
  renderStatus();
  const timer = setInterval(renderStatus, 5000); // SPEC §ui: 5 s status refresh

  let destroyed = false;
  function destroy() {
    if (destroyed) return;
    destroyed = true;
    try { clearInterval(timer); } catch {}
    try { root.remove(); } catch {}
  }

  return { el: root, destroy };
}
