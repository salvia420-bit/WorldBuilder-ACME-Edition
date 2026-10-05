// app/chat_log.js — the chat log pane: category-classed line append (with
// the DOM cap + pinned-to-bottom autoscroll), tab filter switching, and the
// window.__appendChatLine exposure. Extracted verbatim from index.html's
// inline script (2026-10-05); index.html calls initChatLog() at the same point
// the code used to run.

export function initChatLog(D) {
  const { chatLog, chatTabs } = D;
  const CHAT_LOG_LIMIT = 400;
  // Phase 4 step 4: append a chat line keyed by the wasm-bundle's
  // CHAT_CATEGORY_* id (`category` is `evt.u32Payload2`). The id
  // becomes a `cat-N` CSS class which paints the line in its
  // category-specific colour (see #chat-log li.cat-N rules) and
  // also lets the data-tab filter on #chat-log show/hide whole
  // category clusters. Outbound user echo passes `category=null`
  // (or any non-number) which routes to the `.echo` neutral
  // class and is always visible regardless of active tab.
  function appendChatLine(text, category) {
    // Drop the empty-state placeholder on first real message.
    const empty = chatLog.querySelector("li.empty");
    if (empty) empty.remove();
    const li = document.createElement("li");
    if (typeof category === "number") {
      li.className = `cat-${category}`;
      li.dataset.cat = String(category);
    } else {
      li.className = "echo";
    }
    li.textContent = text;
    // Trim to prevent unbounded DOM growth in long sessions.
    chatLog.appendChild(li);
    while (chatLog.childElementCount > CHAT_LOG_LIMIT) {
      chatLog.firstElementChild.remove();
    }
    // Auto-scroll only if the user was already pinned to the
    // bottom — don't yank scroll position when they're reading
    // backscroll.
    const nearBottom =
      chatLog.scrollHeight - chatLog.scrollTop - chatLog.clientHeight < 40;
    if (nearBottom) chatLog.scrollTop = chatLog.scrollHeight;
  }
  // P6.1 (2026-07-27): expose for client.ui.writeToChat — the retail
  // IAsheronsCall::WriteToChat analogue (display echo only; local
  // echoes deliberately do NOT traverse the chat.incoming hook,
  // retail's sendToAPI=false rule).
  window.__appendChatLine = appendChatLine;
  // Phase 4 step 4: tab switching. Updates `data-tab` on #chat-log
  // (which CSS uses to filter visible <li>s) and the `.active`
  // class on the chosen button. Layout-only — no per-message work.
  function setChatTab(tab) {
    chatLog.dataset.tab = tab;
    for (const btn of chatTabs.querySelectorAll("button")) {
      btn.classList.toggle("active", btn.dataset.tab === tab);
    }
  }
  chatTabs.addEventListener("click", (ev) => {
    const btn = ev.target.closest("button[data-tab]");
    if (!btn) return;
    setChatTab(btn.dataset.tab);
    // Re-pin to bottom when switching tabs so the user sees the
    // most recent line in the new filter without scrolling.
    chatLog.scrollTop = chatLog.scrollHeight;
  });
  return { appendChatLine };
}
