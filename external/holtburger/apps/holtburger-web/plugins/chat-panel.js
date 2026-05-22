// Bottom-left chat panel — retail-styled mirror of the existing
// `#chat-log` `<ul>` defined in index.html (Phase 4 step 4). The
// non-agent-mode page already does all the heavy lifting:
//
//   - `appendChatLine(text, category)` (index.html:5926) is the
//     canonical entry point.
//   - The recv loop's kind=2 ChatReceived handler (index.html:7160+)
//     formats every chat-bearing variant and tags it with a
//     CHAT_CATEGORY_* id (0=system, 1=local, 2=tell, 3=channel,
//     4=emote, 5=combat, 6=death, 7=magic, 8=advancement, 9=transient).
//   - `#chat-log li.cat-N` per-category CSS colours already exist.
//   - Outgoing chat goes through `#chat-input` (index.html:6755+).
//
// Agent-mode `display:none`s the original `#chat-panel`, so this
// plugin is the visible chat for agent-mode + wireframe sessions.
// We mirror every `<li>` from `#chat-log` into our retail-framed
// panel via MutationObserver, and forward our input's Enter key
// to the existing `#chat-input` so all send paths stay in one
// place (no duplicated wasm/ACE wiring).
//
// Retail layout source: gmFloatyMainChatUI (0x2100006F) StateDesc
// has Width=410, Height=100. Per the Chat Interface wiki page
// (acpedia), the actual retail panel is RESIZABLE — 410x100 is
// just the default; resize-handle is a follow-on.

const OVERLAY_ID = "hb-chat-panel";
const WIDTH = 410;
const HEIGHT = 100;
const MAX_LINES = 48;          // ring buffer; ~6x what fits on-screen

// CHAT_CATEGORY_* colours — mirror the index.html `#chat-log .cat-N`
// palette but adjusted for legibility against our dark stone background
// (the index.html version sits on a light #fafafa, ours on dark).
const CAT_COLORS = {
  0: "#90d090",                            // system   (was #1a7f1a)
  1: "var(--hb-text-cream)",               // local
  2: "var(--hb-text-tell-yellow)",         // tell     (yellow per retail wiki)
  3: "#7da6e0",                            // channel  (blue-grey per retail wiki)
  4: "#bba696",                            // emote    (italic-grey)
  5: "#ff6a4a",                            // combat
  6: "#ff5050",                            // death
  7: "#c060ff",                            // magic
  8: "#f0c060",                            // advancement
  9: "#888070",                            // transient
  10: "#ff8080",                           // send-error
};

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected) return;
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = "hb-chat-panel-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed;
      bottom: 8px;
      left: 8px;
      z-index: 50;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      box-sizing: border-box;
      pointer-events: none;
      font-family: var(--hb-font-serif);
      background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
      border: 6px solid transparent;
      border-image: url("./sprites/acsprites/panel.png") 6 / 6px / 0 stretch;
      box-shadow: var(--hb-shadow-panel);
      color: var(--hb-text-cream);
    }
    /* Tab strip — mirrors index.html's #chat-tabs filter set (line 626-633). */
    #${OVERLAY_ID} .hb-chat-tabs {
      position: absolute;
      top: 2px;
      left: 4px;
      right: 4px;
      height: 16px;
      display: flex;
      gap: 1px;
      pointer-events: auto;
      align-items: stretch;
      border-bottom: 1px solid var(--hb-border-brass-dim);
    }
    #${OVERLAY_ID} .hb-chat-tab-btn {
      flex: 0 1 auto;
      padding: 1px 5px;
      font-size: 9px;
      font-family: var(--hb-font-serif);
      color: var(--hb-text-cream-bright);
      background: rgba(0, 0, 0, 0.35);
      border: 1px solid var(--hb-border-brass-dim);
      border-bottom: none;
      cursor: pointer;
      user-select: none;
      text-transform: uppercase;
      letter-spacing: 0.04em;
    }
    #${OVERLAY_ID} .hb-chat-tab-btn:hover {
      background: var(--hb-overlay-hover);
    }
    #${OVERLAY_ID} .hb-chat-tab-btn.active {
      background: var(--hb-overlay-active);
      color: var(--hb-text-gold);
      border-color: var(--hb-border-brass);
    }
    #${OVERLAY_ID} .hb-chat-scroll {
      position: absolute;
      top: 24px;
      left: 4px;
      right: 4px;
      bottom: 22px;
      overflow-y: auto;
      overflow-x: hidden;
      padding: 0 4px;
      font-size: 11px;
      line-height: 13px;
      color: var(--hb-text-cream);
      pointer-events: auto;
      scrollbar-width: thin;
      scrollbar-color: var(--hb-border-brass) rgba(0, 0, 0, 0.4);
    }
    #${OVERLAY_ID} .hb-chat-line {
      margin: 0;
      padding: 0;
      white-space: pre-wrap;
      word-break: break-word;
      text-shadow: 0 1px 0 rgba(0, 0, 0, 0.85);
    }
    /* Mirror the index.html tab filter rules exactly — same cat-N
       classes are applied to .hb-chat-line in mirrorOne(), so the
       :not() exclusion chains line up. */
    #${OVERLAY_ID} .hb-chat-scroll[data-tab="local"] .hb-chat-line:not(.cat-1):not(.cat-4):not(.echo) { display: none; }
    #${OVERLAY_ID} .hb-chat-scroll[data-tab="combat"] .hb-chat-line:not(.cat-5):not(.cat-6):not(.echo) { display: none; }
    #${OVERLAY_ID} .hb-chat-scroll[data-tab="channels"] .hb-chat-line:not(.cat-3):not(.cat-12):not(.cat-13):not(.cat-14):not(.cat-15):not(.cat-16):not(.cat-17):not(.cat-22):not(.cat-23):not(.echo) { display: none; }
    #${OVERLAY_ID} .hb-chat-scroll[data-tab="tell"] .hb-chat-line:not(.cat-2):not(.echo) { display: none; }
    #${OVERLAY_ID} .hb-chat-scroll[data-tab="magic"] .hb-chat-line:not(.cat-7):not(.echo) { display: none; }
    #${OVERLAY_ID} .hb-chat-scroll[data-tab="system"] .hb-chat-line:not(.cat-0):not(.cat-8):not(.cat-9):not(.cat-10):not(.cat-11):not(.cat-18):not(.cat-19):not(.cat-20):not(.cat-21):not(.echo) { display: none; }
    /* Resize handle — bottom-right corner, drag to grow/shrink. Wiki
       says retail chat windows are resizable, with size persisted
       per-character. Persistence is a follow-on. */
    #${OVERLAY_ID} .hb-chat-resize {
      position: absolute;
      right: 0;
      bottom: 0;
      width: 12px;
      height: 12px;
      cursor: nwse-resize;
      pointer-events: auto;
      background:
        linear-gradient(135deg, transparent 0%, transparent 40%, var(--hb-border-brass) 40%, var(--hb-border-brass) 50%, transparent 50%, transparent 60%, var(--hb-border-brass) 60%, var(--hb-border-brass) 70%, transparent 70%);
      opacity: 0.7;
      z-index: 4;
    }
    #${OVERLAY_ID} .hb-chat-resize:hover { opacity: 1; }
    #${OVERLAY_ID} .hb-chat-input-row {
      position: absolute;
      bottom: 2px;
      left: 4px;
      right: 4px;
      height: 18px;
      display: flex;
      align-items: center;
      gap: 4px;
      font-size: 10px;
      color: var(--hb-text-cream);
    }
    #${OVERLAY_ID} .hb-chat-tab {
      padding: 2px 6px;
      font-size: 10px;
      color: var(--hb-text-cream);
      background: rgba(0, 0, 0, 0.4);
      border: 1px solid var(--hb-border-brass-dim);
    }
    #${OVERLAY_ID} .hb-chat-input {
      flex: 1;
      background: rgba(0, 0, 0, 0.55);
      border: 1px solid var(--hb-border-brass-dim);
      color: var(--hb-text-cream);
      font-family: var(--hb-font-serif);
      font-size: 10px;
      padding: 1px 4px;
      outline: none;
      pointer-events: auto;
    }
    #${OVERLAY_ID} .hb-chat-input:focus {
      border-color: var(--hb-border-brass);
    }
    /* Chrome handles — lock + move, same pattern as radar. */
    #${OVERLAY_ID} .hb-chat-lock,
    #${OVERLAY_ID} .hb-chat-move {
      position: absolute;
      top: -3px;
      width: 16px;
      height: 16px;
      background-repeat: no-repeat;
      background-size: contain;
      background-position: center;
      pointer-events: auto;
      filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.8));
    }
    #${OVERLAY_ID} .hb-chat-lock {
      left: -3px;
      background-image: url("./data/ui-sprites/0x060074B7.png");
      cursor: pointer;
    }
    #${OVERLAY_ID} .hb-chat-move {
      right: -3px;
      background-image: url("./data/ui-sprites/0x06006119.png");
      cursor: move;
    }
  `;
  document.head.appendChild(style);
}

function colorForCategory(catStr) {
  // catStr is the dataset.cat attribute from the source <li> ("0".."9")
  // or null/undefined for the .echo neutral class (outgoing local-echo).
  if (catStr == null) return "var(--hb-text-cream-bright)";
  const c = CAT_COLORS[catStr];
  return c || "var(--hb-text-cream)";
}

export const manifest = {
  id: "chat-panel",
  name: "Chat",
  icon: "💬",
  iconHidden: true,
  version: "0.1.0",
  description: "Bottom-left chat panel (retail gmFloatyMainChatUI 0x2100006F)",
};

export function mount(_ctx) {
  ensureStyles();
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();

  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;

  // Tab strip — same set + order as index.html:625-633.
  const TABS = [
    { id: "all",      label: "All" },
    { id: "local",    label: "Local" },
    { id: "tell",     label: "Tells" },
    { id: "channels", label: "Channels" },
    { id: "combat",   label: "Combat" },
    { id: "magic",    label: "Magic" },
    { id: "system",   label: "System" },
  ];
  const tabsEl = document.createElement("div");
  tabsEl.className = "hb-chat-tabs";
  const tabBtns = {};
  for (const t of TABS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "hb-chat-tab-btn" + (t.id === "all" ? " active" : "");
    btn.dataset.tab = t.id;
    btn.textContent = t.label;
    tabsEl.appendChild(btn);
    tabBtns[t.id] = btn;
  }
  overlay.appendChild(tabsEl);

  // Scrollback area — its [data-tab] drives the CSS filter chains
  // defined alongside this block in ensureStyles().
  const scroll = document.createElement("div");
  scroll.className = "hb-chat-scroll";
  scroll.dataset.tab = "all";
  overlay.appendChild(scroll);

  function setTab(tabId) {
    scroll.dataset.tab = tabId;
    for (const id of Object.keys(tabBtns)) {
      tabBtns[id].classList.toggle("active", id === tabId);
    }
    // Mirror the selection to the source #chat-log so the filter
    // stays in sync if the agent-mode hide rule is ever removed.
    const src = document.getElementById("chat-log");
    if (src) src.dataset.tab = tabId;
    // Re-pin to bottom on tab change.
    scroll.scrollTop = scroll.scrollHeight;
  }
  tabsEl.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-tab]");
    if (!btn) return;
    setTab(btn.dataset.tab);
  });

  // Input row
  const inputRow = document.createElement("div");
  inputRow.className = "hb-chat-input-row";
  const tab = document.createElement("span");
  tab.className = "hb-chat-tab";
  tab.textContent = "Local";
  inputRow.appendChild(tab);
  const input = document.createElement("input");
  input.className = "hb-chat-input";
  input.type = "text";
  input.placeholder = "type here…";
  inputRow.appendChild(input);
  overlay.appendChild(inputRow);

  // Resize handle (bottom-right) — pointer-capture drag to adjust
  // panel width + height. Min/max clamps prevent escaping the viewport.
  const resizeHandle = document.createElement("div");
  resizeHandle.className = "hb-chat-resize";
  resizeHandle.setAttribute("aria-label", "Resize chat");
  let resizeDrag = null;
  resizeHandle.addEventListener("pointerdown", (ev) => {
    if (locked) return;
    ev.preventDefault();
    const rect = overlay.getBoundingClientRect();
    resizeDrag = { startX: ev.clientX, startY: ev.clientY, w0: rect.width, h0: rect.height };
    try { resizeHandle.setPointerCapture(ev.pointerId); } catch (_) {}
  });
  resizeHandle.addEventListener("pointermove", (ev) => {
    if (!resizeDrag) return;
    const w = Math.max(220, Math.min(900, resizeDrag.w0 + (ev.clientX - resizeDrag.startX)));
    const h = Math.max(70, Math.min(500, resizeDrag.h0 + (ev.clientY - resizeDrag.startY)));
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
  });
  resizeHandle.addEventListener("pointerup", (ev) => {
    resizeDrag = null;
    try { resizeHandle.releasePointerCapture(ev.pointerId); } catch (_) {}
  });
  resizeHandle.addEventListener("pointercancel", () => { resizeDrag = null; });
  overlay.appendChild(resizeHandle);

  // Lock + Move handles
  let locked = false;
  const lockBtn = document.createElement("div");
  lockBtn.className = "hb-chat-lock";
  lockBtn.setAttribute("role", "button");
  lockBtn.setAttribute("aria-label", "Lock chat");
  lockBtn.addEventListener("click", () => {
    locked = !locked;
    lockBtn.style.backgroundImage = locked
      ? "url('./data/ui-sprites/0x060074B8.png')"
      : "url('./data/ui-sprites/0x060074B7.png')";
  });
  overlay.appendChild(lockBtn);

  const moveBtn = document.createElement("div");
  moveBtn.className = "hb-chat-move";
  moveBtn.setAttribute("role", "button");
  moveBtn.setAttribute("aria-label", "Move chat");
  let drag = null;
  moveBtn.addEventListener("pointerdown", (ev) => {
    if (locked) return;
    ev.preventDefault();
    const rect = overlay.getBoundingClientRect();
    drag = { ox: ev.clientX - rect.left, oy: ev.clientY - rect.top };
    try { moveBtn.setPointerCapture(ev.pointerId); } catch (_) {}
  });
  moveBtn.addEventListener("pointermove", (ev) => {
    if (!drag) return;
    overlay.style.left = `${ev.clientX - drag.ox}px`;
    overlay.style.top = `${ev.clientY - drag.oy}px`;
    overlay.style.bottom = "auto";
    overlay.style.right = "auto";
  });
  moveBtn.addEventListener("pointerup", (ev) => {
    drag = null;
    try { moveBtn.releasePointerCapture(ev.pointerId); } catch (_) {}
  });
  moveBtn.addEventListener("pointercancel", () => { drag = null; });
  overlay.appendChild(moveBtn);

  document.body.appendChild(overlay);

  // Mirror an <li> from #chat-log into our retail scrollback. We tag
  // each mirrored line with `data-empty` if the source was the empty
  // placeholder so we can drop it the first time a real message lands
  // (matches index.html's behaviour at line 5928).
  function mirrorOne(srcLi) {
    const isEmpty = srcLi.classList.contains("empty");
    if (!isEmpty) {
      // Drop any stale empty placeholders before appending the first
      // real line — source #chat-log does the same.
      scroll.querySelectorAll('[data-empty="1"]').forEach((el) => el.remove());
    }
    const line = document.createElement("div");
    line.className = "hb-chat-line";
    const cat = srcLi.dataset?.cat ?? null;
    line.style.color = colorForCategory(cat);
    if (cat != null) {
      line.classList.add(`cat-${cat}`);
      line.dataset.cat = cat;
    }
    if (srcLi.classList.contains("echo")) {
      line.classList.add("echo");
      line.style.color = "var(--hb-text-cream-bright)";
    } else if (isEmpty) {
      line.dataset.empty = "1";
      line.style.opacity = "0.55";
      line.style.fontStyle = "italic";
    }
    line.textContent = srcLi.textContent || "";
    scroll.appendChild(line);
    // Auto-scroll if pinned to bottom.
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40) {
      scroll.scrollTop = scroll.scrollHeight;
    }
    // Cap our own mirror at MAX_LINES (insurance vs source-log resets).
    while (scroll.childElementCount > MAX_LINES) {
      scroll.firstElementChild.remove();
    }
  }

  // Initial sync — pull whatever's already in #chat-log when we mount.
  const sourceLog = document.getElementById("chat-log");
  if (sourceLog) {
    for (const li of sourceLog.children) mirrorOne(li);
  }

  // MutationObserver watches for new <li>s appended by appendChatLine.
  let observer = null;
  if (sourceLog) {
    observer = new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node?.tagName === "LI") mirrorOne(node);
        }
      }
    });
    observer.observe(sourceLog, { childList: true });
  } else {
    // index.html hasn't mounted #chat-log yet (we ran first); retry.
    const retry = setInterval(() => {
      const log = document.getElementById("chat-log");
      if (!log) return;
      clearInterval(retry);
      for (const li of log.children) mirrorOne(li);
      observer = new MutationObserver((records) => {
        for (const r of records) {
          for (const node of r.addedNodes) {
            if (node?.tagName === "LI") mirrorOne(node);
          }
        }
      });
      observer.observe(log, { childList: true });
    }, 250);
  }

  // Send: forward our input to the existing #chat-input so all the
  // wasm/ACE wiring (Talk packet, error handling, local echo) stays in
  // one place. Keypress on Enter mirrors index.html's Submit form
  // behaviour at line 6755+.
  input.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    const srcInput = document.getElementById("chat-input");
    const srcForm = document.getElementById("chat-form");
    if (srcInput && srcForm) {
      srcInput.value = text;
      // Dispatch submit on the source form so all listeners (the
      // existing Talk packet sender) fire.
      const submitEv = new Event("submit", { bubbles: true, cancelable: true });
      srcForm.dispatchEvent(submitEv);
      input.value = "";
    } else {
      // Fallback: no source input found yet, just clear ours.
      input.value = "";
    }
  });
  // Stop the global keydown-driven movement from firing while typing.
  input.addEventListener("keydown", (ev) => ev.stopPropagation(), true);

  return () => {
    if (observer) observer.disconnect();
    overlay.remove();
  };
}
