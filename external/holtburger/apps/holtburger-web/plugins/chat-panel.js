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
    #${OVERLAY_ID} .hb-chat-scroll {
      position: absolute;
      top: 4px;
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

  // Scrollback area
  const scroll = document.createElement("div");
  scroll.className = "hb-chat-scroll";
  overlay.appendChild(scroll);

  // Input row: channel tab + text input
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
    if (srcLi.classList.contains("echo")) {
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
