// Landblock-cross system message. Listens for the `landblockChanged`
// bus event (api.js emits it from local-player move + LB-arrival
// detection at index.html:6199/6282) and appends a chat-log line so
// the player gets a transient "Entering …" notice on each zone cross —
// mirrors retail ClientUISystem's landblock-entered messaging.
//
// Landblock names aren't surfaced from wasm or shipped as a JSON
// manifest yet, so the message renders as a hex identifier
// ("Entering Landblock 0xA9B4"). When a name source lands (DAT
// extract or server-side push), `formatLandblockMessage` is the only
// hook that needs to swap to the friendly name.
//
// References:
//   - plugins/api.js coverage table: landblockChanged is IMPLEMENTED
//   - index.html appendChatLine (category 10 = system; not globalised,
//     so we append directly into #chat-log to keep the diff scoped to
//     a new plugin file rather than touching index.html)

const CHAT_LOG_ID = "chat-log";
const SYSTEM_CHAT_CATEGORY = 10; // routes to li.cat-10 styling

let _seenLb = 0;
let _unsub = null;

function formatLandblockMessage(lbId) {
  const id = (lbId >>> 0);
  if (!id) return null;
  const lb = (id >>> 16) & 0xFFFF;
  const lbX = (lb >> 8) & 0xFF;
  const lbY = lb & 0xFF;
  return `Entering Landblock 0x${lb.toString(16).toUpperCase().padStart(4, "0")} (${lbX}, ${lbY})`;
}

function appendSystemLine(text) {
  if (typeof document === "undefined") return;
  const log = document.getElementById(CHAT_LOG_ID);
  if (!log) return;
  // Drop the empty-state placeholder on first real message — matches
  // appendChatLine in index.html:7462.
  const empty = log.querySelector("li.empty");
  if (empty) empty.remove();
  const li = document.createElement("li");
  li.className = `cat-${SYSTEM_CHAT_CATEGORY}`;
  li.dataset.cat = String(SYSTEM_CHAT_CATEGORY);
  li.dataset.landblockMessage = "1";
  li.textContent = text;
  log.appendChild(li);
  // Cap our own growth defensively — the host appendChatLine has a
  // CHAT_LOG_LIMIT but if our path bypasses it we don't want to
  // contribute to runaway DOM.
  while (log.childElementCount > 500) {
    log.firstElementChild.remove();
  }
}

function onLandblockChanged(detail) {
  const lbId = (detail?.lbId >>> 0) || 0;
  if (!lbId || lbId === _seenLb) return;
  _seenLb = lbId;
  const text = formatLandblockMessage(lbId);
  if (text) appendSystemLine(text);
}

export const manifest = {
  id: "landblock-messages",
  name: "Landblock Messages",
  icon: "▣",
  iconHidden: true,
  version: "0.1.0",
  description: "Chat-log notice on each landblock cross (Entering Landblock 0x…).",
};

export function mount(ctx) {
  if (typeof window === "undefined") return () => {};
  const client = ctx?.client ?? window.__pluginClient ?? null;
  try {
    if (typeof client?.events?.on === "function") {
      _unsub = client.events.on("landblockChanged", onLandblockChanged);
    }
  } catch (e) {
    console.warn("[landblock-messages] subscribe failed:", e);
  }
  return () => {
    try {
      if (typeof _unsub === "function") _unsub();
      else if (_unsub?.off) _unsub.off();
    } catch (_) {}
    _unsub = null;
    _seenLb = 0;
  };
}
