// thought_overlay.js — stream-facing "teleprompter" for AI-director thoughts
// (?thoughtOverlay=1). Watches the director journal for new `plan` entries and
// reveals each one character-by-character at a reading pace computed to finish
// comfortably before the next check-in:
//
//   cps = max(MIN_CPS, chars / (checkInIntervalSec * BUDGET_FRACTION))
//
// MIN_CPS 17 ≈ 200 wpm (normal reading speed); the acceleration arm only
// engages when a thought is long enough that 200 wpm would not finish inside
// the check-in gap. A fully revealed thought stays on screen (dimmed) until
// the next plan replaces it, so stream viewers always see the bot's current
// intent. Plain DOM like ui.js (no framework); every touch is try/caught —
// a broken overlay must never take down the client (same contract as the AI
// panel, SPEC "Cost & safety").
//
// Palette matches rynth/ai/ui.js / plugins/debug-overlay.js.

const MIN_CPS = 17; // ~200 wpm
const BUDGET_FRACTION = 0.8; // finish within 80% of the check-in gap
const POLL_MS = 1000; // journal poll cadence
const TICK_MS = 100; // reveal cadence

const CSS_ROOT =
  "position:fixed;left:18%;right:18%;bottom:110px;z-index:9990;" +
  "box-sizing:border-box;padding:8px 14px;pointer-events:none;" +
  "background:rgba(0,0,0,0.62);border:1px solid var(--hb-border-brass,#8a7544);" +
  "border-radius:3px;color:var(--hb-text-cream,#f0d8a0);" +
  "font-family:Georgia,'Times New Roman',serif;font-size:15px;line-height:1.45;" +
  "max-height:7.5em;overflow:hidden;display:none;" +
  "transition:opacity 1.2s ease;";
const CSS_HEAD =
  "font-family:var(--hb-font-mono,ui-monospace,Menlo,Consolas,monospace);" +
  "font-size:10px;letter-spacing:2px;opacity:0.65;margin-bottom:3px;";
const CSS_BODY = "white-space:pre-wrap;word-break:break-word;";

/** Mount the overlay. `journal` duck-typed ({tail(n)}); `intervalMinutes`
 * feeds the pacing budget (falls back to the director default of 5). Returns
 * {unmount} — caller-owned lifecycle, nothing global. */
export function mountThoughtOverlay(journal, { doc = globalThis.document, intervalMinutes = 5 } = {}) {
  if (!doc || !journal || typeof journal.tail !== "function") return { unmount() {} };

  const root = doc.createElement("div");
  root.setAttribute("style", CSS_ROOT);
  const head = doc.createElement("div");
  head.setAttribute("style", CSS_HEAD);
  head.textContent = "DIRECTOR";
  const body = doc.createElement("div");
  body.setAttribute("style", CSS_BODY);
  root.appendChild(head);
  root.appendChild(body);
  try { doc.body.appendChild(root); } catch { return { unmount() {} }; }

  let lastT = 0; // newest journal timestamp already shown
  let text = ""; // thought being revealed
  let shown = 0; // chars revealed so far
  let cps = MIN_CPS;

  const pollTimer = setInterval(() => {
    try {
      const entries = journal.tail(8);
      // Newest plan entry we have not shown yet (tail is oldest→newest).
      for (let i = entries.length - 1; i >= 0; i--) {
        const e = entries[i];
        if (e.kind === "plan" && e.t > lastT && e.text && e.text.trim()) {
          lastT = e.t;
          text = e.text.trim();
          shown = 0;
          const budgetSec = Math.max(30, intervalMinutes * 60 * BUDGET_FRACTION);
          cps = Math.max(MIN_CPS, text.length / budgetSec);
          root.style.display = "block";
          root.style.opacity = "1";
          break;
        }
      }
    } catch { /* journal read failure = keep current display */ }
  }, POLL_MS);

  const revealTimer = setInterval(() => {
    try {
      if (!text || shown >= text.length) return;
      shown = Math.min(text.length, shown + Math.max(1, Math.round(cps * (TICK_MS / 1000))));
      body.textContent = text.slice(0, shown);
      root.scrollTop = root.scrollHeight; // newest lines stay visible
      if (shown >= text.length) root.style.opacity = "0.55"; // done: dim, keep context
    } catch { /* never throw into the page */ }
  }, TICK_MS);

  return {
    unmount() {
      try { clearInterval(pollTimer); clearInterval(revealTimer); root.remove(); } catch { /* gone */ }
    },
  };
}

export default mountThoughtOverlay;
