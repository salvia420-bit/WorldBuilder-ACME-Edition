// Bottom-left chat panel — port of retail gmFloatyMainChatUI (layout
// 0x2100006F, 33 elements, 29 image DIDs).
//
// Retail size (from gmFloatyMainChatUI StateDesc): 410x100 px, with a
// 5px brass frame (9-slice: 4 corners 5x5 + 4 edges either 400x5 or
// 5x90). The retail composition uses sprites 0x060074BF-C6 for the
// frame plus various interior elements; for the first pass we reuse
// the unified panel.png 9-slice (same one we use for the vitals
// wrapper) to keep the visual style consistent. Real per-corner
// sprite swap is a follow-on.
//
// First-pass content:
//   - Lock + Move handles in the upper corners (same pattern as the
//     radar plugin).
//   - Scrollback area showing the last N lines.
//   - Lines arrive via `ctx.client.events` — for now we pipe combat
//     damage events ("damageDealt", "damageTaken", "evadedTarget",
//     "evadedAttacker") since those are already in the surface
//     inventory; real chat-message wiring needs an event we don't
//     have yet (see plugins/api.js TODOs).
//
// Channel colours (per retail wiki + the bottled-vials shot we have):
//   - Combat damage: bright red
//   - Tells: bright yellow
//   - System / global: cream
//   - You-actions (you knock X into Y): light yellow

const OVERLAY_ID = "hb-chat-panel";
const WIDTH = 410;
const HEIGHT = 100;
const MAX_LINES = 48;          // ring buffer; ~6x what fits on-screen

const COLORS = {
  damage: "#ff6a4a",
  taken: "#ff9a8a",
  miss: "#bba696",
  tell: "var(--hb-text-tell-yellow)",
  system: "var(--hb-text-cream)",
  combat: "#f0b06c",
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

function colorForKind(kind) {
  switch (kind) {
    case "damage": return COLORS.damage;
    case "taken":  return COLORS.taken;
    case "miss":   return COLORS.miss;
    case "tell":   return COLORS.tell;
    case "combat": return COLORS.combat;
    case "system":
    default:       return COLORS.system;
  }
}

export const manifest = {
  id: "chat-panel",
  name: "Chat",
  icon: "💬",
  iconHidden: true,
  version: "0.1.0",
  description: "Bottom-left chat panel (retail gmFloatyMainChatUI 0x2100006F)",
};

export function mount(ctx) {
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

  const lineRing = [];
  function appendLine(text, kind = "system") {
    const line = document.createElement("div");
    line.className = "hb-chat-line";
    line.style.color = colorForKind(kind);
    line.textContent = text;
    scroll.appendChild(line);
    lineRing.push(line);
    while (lineRing.length > MAX_LINES) {
      const old = lineRing.shift();
      old?.remove();
    }
    // Auto-scroll if already near bottom.
    if (scroll.scrollHeight - scroll.scrollTop - scroll.clientHeight < 40) {
      scroll.scrollTop = scroll.scrollHeight;
    }
  }

  // Seed with a system line so it's not empty on first paint.
  appendLine("[Chat panel — wired to combat events; real chat-message bus pending]", "system");

  // Wire to combat events from client.events. Mirrors combat-bar.js's
  // damage-feed pattern but renders in the chat scrollback instead.
  let pollTimer = null;
  let unsubFns = [];
  function tryHook() {
    const client = ctx?.client ?? window.__pluginClient ?? null;
    if (!client?.events?.on) return false;
    const onDamage = (ev) => {
      const tgt = ev?.target?.name ?? "target";
      const dmg = ev?.amount ?? "?";
      appendLine(`You deliver ${dmg} damage to ${tgt}.`, "damage");
    };
    const onTaken = (ev) => {
      const src = ev?.source?.name ?? "an attacker";
      const dmg = ev?.amount ?? "?";
      appendLine(`${src} hits you for ${dmg} damage!`, "taken");
    };
    const onEvadedTarget = (ev) => {
      const tgt = ev?.target?.name ?? "target";
      appendLine(`${tgt} evaded your attack.`, "miss");
    };
    const onEvadedAttacker = (ev) => {
      const src = ev?.source?.name ?? "an attacker";
      appendLine(`You evaded ${src}.`, "miss");
    };
    client.events.on("damageDealt", onDamage);
    client.events.on("damageTaken", onTaken);
    client.events.on("evadedTarget", onEvadedTarget);
    client.events.on("evadedAttacker", onEvadedAttacker);
    unsubFns.push(() => {
      try { client.events.off("damageDealt", onDamage); } catch (_) {}
      try { client.events.off("damageTaken", onTaken); } catch (_) {}
      try { client.events.off("evadedTarget", onEvadedTarget); } catch (_) {}
      try { client.events.off("evadedAttacker", onEvadedAttacker); } catch (_) {}
    });
    return true;
  }
  if (!tryHook()) {
    pollTimer = setInterval(() => { if (tryHook()) { clearInterval(pollTimer); pollTimer = null; } }, 500);
  }

  // Submit handler — for now just echoes locally; real client.chat.send
  // wire is a follow-on.
  input.addEventListener("keydown", (ev) => {
    if (ev.key !== "Enter") return;
    const text = input.value.trim();
    if (!text) return;
    appendLine(`You: ${text}`, "tell");
    input.value = "";
  });

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    for (const fn of unsubFns) try { fn(); } catch (_) {}
    overlay.remove();
  };
}
