// Emote palette — a main-panel view (Shift+F2) of the retail soul emotes.
//
// HUD overhaul 2026-10-05 — why the old palette showed "0 of 0 actions":
// it rendered `handle.getEmoteTaxonomy()`, which (a) crosses the wasm
// boundary via serde_wasm_bindgen::to_value(serde_json::Value), so the
// object arrives as a JS **Map** and `tax.types` was undefined → the view
// never cached a taxonomy and rendered its empty state; and (b) even when
// read correctly it is the wrong data — the 122 server-side EmoteType
// script opcodes NPC weenies use (AwardXP, InqQuest, SetIntStat…), none of
// which a player can perform.
//
// What players actually have is retail's soul-emote set: the DAT
// ChatPoseTable (0x0E000007, 309 tokens → 74 poses; `/wave`, `/bow`,
// `/sit` …; ACE Entity/SoulEmote.cs lists the same 74 MotionCommands).
// This palette groups those poses the way players think about them, one
// click per emote. Dispatch goes through the SAME path as typing the
// slash command in chat (`window.__routeSlashCommand`, app/
// slash_commands.js → resolveSoulEmote → sendSoulEmote (0x01E1) +
// broadcastEmoteMotion + local motion prediction), so the panel can never
// drift from chat behaviour. Tokens with a space (e.g. "warm hands") use
// the same wasm calls directly. The free-text box at the bottom is
// retail's `/me` (GameAction Emote 0x01DF).
//
// Kit chrome: hbk-input filter, hbk-section-title categories, hbk-row
// is-clickable entries in a two-column grid, hbk-scroll list.

import { setAcText, COMPACT_FONT_ID } from "../ui/ac_font.js";

const STYLE_ID = "hb-emote-panel-style";
const SP = "./data/ui-sprites";

// Token = the ChatPoseTable key (verified against the DAT 2026-10-05).
// `pose` = the ChatPoseTable pose (ACE MotionCommand name), kept for
// tests/tooltips. `held` marks *State poses that persist until you move.
export const EMOTE_CATALOG = Object.freeze([
  { category: "Greetings", items: [
    { label: "Wave", token: "wave", pose: "Wave" },
    { label: "Wave High", token: "wavehigh", pose: "WaveHigh" },
    { label: "Wave Low", token: "wavelow", pose: "WaveLow" },
    { label: "Waving", token: "waving", pose: "WaveState", held: true },
    { label: "Beckon", token: "beckon", pose: "Beckon" },
    { label: "Be Seeing You", token: "beseeingyou", pose: "BeSeeingYou" },
    { label: "Bow", token: "bow", pose: "BowDeepState", held: true },
    { label: "Curtsey", token: "curtsey", pose: "CurtseyState", held: true },
    { label: "Salute", token: "salute", pose: "SaluteState", held: true },
    { label: "Blow Kiss", token: "blowkiss", pose: "BlowKiss" },
    { label: "Nod", token: "nod", pose: "Nod" },
    { label: "Shake Head", token: "no", pose: "ShakeHead" },
    { label: "Helper", token: "helper", pose: "Helper" },
    { label: "Have a Seat", token: "haveaseat", pose: "HaveASeatState", held: true },
  ] },
  { category: "Reactions", items: [
    { label: "Cheer", token: "cheer", pose: "Cheer" },
    { label: "Laugh", token: "laugh", pose: "Laugh" },
    { label: "Hearty Laugh", token: "heartylaugh", pose: "HeartyLaugh" },
    { label: "Mock", token: "mock", pose: "Mock" },
    { label: "Clap", token: "clap", pose: "ClapHands" },
    { label: "Applaud", token: "clapping", pose: "ClapHandsState", held: true },
    { label: "Cry", token: "cry", pose: "Cry" },
    { label: "Cringe", token: "cringe", pose: "Cringe" },
    { label: "Shrug", token: "shrug", pose: "Shrug" },
    { label: "Scratch Head", token: "huh?", pose: "ScratchHead" },
    { label: "Ponder", token: "hmm", pose: "ScratchHeadState", held: true },
    { label: "Smack Head", token: "doh", pose: "SmackHead" },
    { label: "Shake Fist", token: "shakefist", pose: "ShakeFist" },
    { label: "Fume", token: "shakingfist", pose: "ShakeFistState", held: true },
    { label: "Shiver", token: "shiver", pose: "Shiver" },
    { label: "Warm Hands", token: "warm hands", pose: "WarmHands" },
    { label: "Yawn", token: "yawn", pose: "YawnStretch" },
    { label: "Spit", token: "spit", pose: "Spit" },
    { label: "Plead", token: "plead", pose: "PleadState", held: true },
    { label: "Surrender", token: "surrender", pose: "SurrenderState", held: true },
    { label: "Tap Foot", token: "tapfoot", pose: "TapFootState", held: true },
    { label: "Winded", token: "winded", pose: "WindedState", held: true },
    { label: "Whoa", token: "whoa", pose: "WoahState", held: true },
    { label: "Talk to the Hand", token: "talktothehand", pose: "TalktotheHandState", held: true },
    { label: "Shoo", token: "shoo", pose: "Shoo" },
  ] },
  { category: "Pointing", items: [
    { label: "Point", token: "point", pose: "PointState", held: true },
    { label: "Point Left", token: "pointleft", pose: "PointLeft" },
    { label: "Point Right", token: "pointright", pose: "PointRight" },
    { label: "Point Down", token: "pointdown", pose: "PointDown" },
    { label: "Nudge Left", token: "nudgeleft", pose: "NudgeLeft" },
    { label: "Nudge Right", token: "nudgeright", pose: "NudgeRight" },
    { label: "Scan Horizon", token: "scan", pose: "ScanHorizon" },
    { label: "Knock", token: "knock", pose: "Knock" },
  ] },
  { category: "Poses", items: [
    { label: "Sit", token: "sit", pose: "SitState", held: true },
    { label: "Sit Back", token: "sitback", pose: "SitBackState", held: true },
    { label: "Cross-Legged", token: "sitcrosslegged", pose: "SitCrossleggedState", held: true },
    { label: "Kneel", token: "kneel", pose: "KneelState", held: true },
    { label: "Pray", token: "pray", pose: "PrayState", held: true },
    { label: "Meditate", token: "meditate", pose: "MeditateState", held: true },
    { label: "Think", token: "think", pose: "ThinkerState", held: true },
    { label: "Read", token: "read", pose: "ReadState", held: true },
    { label: "Lean", token: "lean", pose: "LeanState", held: true },
    { label: "Akimbo", token: "akimbo", pose: "AkimboState", held: true },
    { label: "At Ease", token: "atease", pose: "AtEaseState", held: true },
    { label: "Cross Arms", token: "crossarms", pose: "CrossArmsState", held: true },
    { label: "Slouch", token: "slouch", pose: "SlouchState", held: true },
    { label: "Play Dead", token: "playdead", pose: "PossumState", held: true },
    { label: "Snow Angel", token: "snowangel", pose: "SnowAngelState", held: true },
    { label: "Away (AFK)", token: "away", pose: "AFKState", held: true },
  ] },
  { category: "Fun", items: [
    { label: "Dance", token: "dance", pose: "DrudgeDanceState", held: true },
    { label: "Dance Step", token: "dancestep", pose: "DrudgeDance" },
    { label: "YMCA", token: "ymca", pose: "YMCA" },
    { label: "Teapot", token: "teapot", pose: "Teapot" },
    { label: "Drink", token: "drink", pose: "MimeDrink" },
    { label: "Eat", token: "eat", pose: "MimeEat" },
    { label: "Musical Chair", token: "musicalchair", pose: "HaveASeat" },
    { label: "ATOYOT", token: "atoyot", pose: "ATOYOT" },
  ] },
]);

/** Case-insensitive filter over label + token; empty categories drop. */
export function filterEmotes(catalog, text) {
  const q = String(text ?? "").trim().toLowerCase();
  const out = [];
  for (const cat of catalog) {
    const items = q
      ? cat.items.filter((e) => e.label.toLowerCase().includes(q) || e.token.includes(q))
      : cat.items.slice();
    if (items.length) out.push({ category: cat.category, items });
  }
  return out;
}

/**
 * Perform one emote. Returns `{ ok, echo?, error? }`.
 *
 * Single-word tokens go through `route(handle, "/token")` — the exact
 * chat slash path (app/slash_commands.js routeSlashCommand). Tokens that
 * contain a space cannot be typed as a slash command, so they replay the
 * same three wasm calls directly: resolveSoulEmote → sendSoulEmote(other
 * text) → broadcastEmoteMotion(motion).
 */
export function performEmote(entry, handle, route, predict) {
  if (!handle) return { ok: false, error: "Enter the world to use emotes." };
  const token = entry?.token ?? "";
  if (!token) return { ok: false, error: "Unknown emote." };
  // Pre-check against the DAT catalog: routeSlashCommand forwards an
  // UNKNOWN token to the server as `@token`, which must never happen from
  // a button (catalog not loaded yet / older client data).
  if (typeof handle.resolveSoulEmote === "function") {
    let probe = null;
    try { probe = handle.resolveSoulEmote(token); } catch (_) { probe = null; }
    const known = !!probe;
    try { probe?.free?.(); } catch (_) {}
    if (!known) return { ok: false, error: `${entry.label} is not available yet.` };
  }
  if (!/\s/.test(token) && typeof route === "function") {
    let r;
    try { r = route(handle, `/${token}`); } catch (e) { return { ok: false, error: String(e?.message ?? e) }; }
    if (r?.error) return { ok: false, error: r.error };
    if (r?.dispatched) return { ok: true, echo: r.echo ?? null };
    // Not a soul emote on this client — routeSlashCommand already sent it
    // as a server command; report it rather than pretending.
    return { ok: false, error: `/${token} is not available.` };
  }
  if (typeof handle.resolveSoulEmote !== "function") return { ok: false, error: "Emotes need a newer client build." };
  let res = null;
  try {
    res = handle.resolveSoulEmote(token);
    if (!res) return { ok: false, error: `${entry.label} is not available.` };
    const other = res.otherEmote || token;
    const mine = res.myEmote;
    const motion = res.motionFull >>> 0;
    const held = !!res.held;
    handle.sendSoulEmote(other);
    if (motion && typeof handle.broadcastEmoteMotion === "function") {
      try { handle.broadcastEmoteMotion(motion); } catch (_) { /* chat already sent */ }
    }
    if (motion && typeof predict === "function") {
      try { predict(motion, held); } catch (_) {}
    }
    return { ok: true, echo: mine ? `You ${mine}` : null };
  } catch (e) {
    return { ok: false, error: String(e?.message ?? e) };
  } finally {
    try { res?.free?.(); } catch (_) {}
  }
}

// Local motion prediction for the direct path — the same calls
// app/slash_commands.js makes (held *State poses loop via setMotion,
// one-shots play via setSwingMotion).
function predictLocal(motion, held) {
  const em = window.liveScene3d?.entityManager;
  const guid = typeof window.getLocalPlayerGuid === "function" ? window.getLocalPlayerGuid() : null;
  if (!em || guid == null) return;
  const g = guid >>> 0;
  if (held) {
    const NONCOMBAT_STANCE = 0x8000003D;
    const stance = (typeof em.getStance === "function" ? em.getStance(g) >>> 0 : 0) || NONCOMBAT_STANCE;
    em.setMotion?.(g, motion, stance);
  } else {
    em.setSwingMotion?.(g, motion);
  }
}

function echo(text, category = null) {
  try { window.__appendChatLine?.(text, category); } catch (_) {}
}

let stylesInjected = false;
function ensureStyles() {
  if (stylesInjected || typeof document === "undefined") return;
  if (document.getElementById(STYLE_ID)) { stylesInjected = true; return; }
  stylesInjected = true;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .hb-ep-root {
      position: absolute; inset: 0;
      display: flex; flex-direction: column; box-sizing: border-box;
      pointer-events: auto; user-select: none; overflow: hidden;
      color: var(--hbk-text); font-family: var(--hbk-font); font-size: 12px;
      background: url("${SP}/0x06004CC2.png") repeat, var(--hbk-ink, #0b0c10);
    }
    .hb-ep-toolbar { flex: 0 0 auto; display: flex; gap: 6px; padding: 5px 8px 4px; }
    .hb-ep-toolbar .hbk-input { flex: 1 1 auto; min-width: 0; }
    .hb-ep-list { flex: 1 1 auto; min-height: 40px; }
    .hb-ep-section { margin: 0; }
    .hb-ep-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 2px; padding: 1px 2px 3px; }
    .hb-ep-item { min-width: 0; height: 20px; box-sizing: border-box; padding: 0 6px; }
    .hb-ep-item:nth-child(even) { background: transparent; }
    .hb-ep-item:hover { background: var(--hbk-hover); }
    .hb-ep-item:active { background: var(--hbk-sel); }
    .hb-ep-item > .hbk-grow { display: flex; align-items: center; }
    .hb-ep-held { flex: 0 0 auto; width: 5px; height: 5px; border-radius: 50%; background: var(--hbk-gold-dim); opacity: 0.8; }
    .hb-ep-foot { flex: 0 0 auto; display: flex; flex-direction: column; gap: 4px; padding: 4px 8px 6px; border-top: 1px solid var(--hbk-gold-deep); background: rgba(0, 0, 0, 0.35); }
    .hb-ep-status { height: 12px; overflow: hidden; display: flex; align-items: center; }
    .hb-ep-me { display: flex; gap: 6px; align-items: center; }
    .hb-ep-me .hbk-input { flex: 1 1 auto; min-width: 0; }
  `;
  document.head.appendChild(style);
}

export const manifest = {
  id: "emote-panel",
  name: "Emote Palette",
  icon: "☺",
  // No dedicated retail "emote" button sprite exists (chat triggers emotes
  // via slash). The spellbook-style scroll sprite is a neutral DAT-themed
  // placeholder; the emoji remains the load-fallback.
  iconSprite: "0x06001AAF",
  version: "0.2.0",
  description: "Retail soul-emote palette (ChatPoseTable) — click to /wave, /bow, /sit … Shift+F2.",
};

export const view = {
  name: "Emotes",
  nameFor: () => "Emotes",
  mount(parentEl, ctx) {
    ensureStyles();
    const getHandle = () => ctx?.handle ?? window.__sessionHandle ?? null;

    const root = document.createElement("div");
    root.className = "hb-ep-root";

    const toolbar = document.createElement("div");
    toolbar.className = "hb-ep-toolbar";
    const filterInput = document.createElement("input");
    filterInput.type = "text";
    filterInput.className = "hbk-input";
    filterInput.placeholder = "Find an emote…";
    filterInput.spellcheck = false;
    filterInput.autocomplete = "off";
    toolbar.appendChild(filterInput);
    root.appendChild(toolbar);

    const list = document.createElement("div");
    list.className = "hbk-scroll hb-ep-list";
    root.appendChild(list);

    const foot = document.createElement("div");
    foot.className = "hb-ep-foot";
    const status = document.createElement("div");
    status.className = "hb-ep-status";
    const meRow = document.createElement("form");
    meRow.className = "hb-ep-me";
    const meInput = document.createElement("input");
    meInput.type = "text";
    meInput.className = "hbk-input";
    meInput.placeholder = "Custom emote (/me)…";
    meInput.maxLength = 200;
    meInput.spellcheck = false;
    meInput.autocomplete = "off";
    const meBtn = document.createElement("button");
    meBtn.type = "submit";
    meBtn.className = "hbk-btn-small";
    meBtn.textContent = "Emote";
    meRow.append(meInput, meBtn);
    foot.append(status, meRow);
    root.appendChild(foot);

    function setStatus(text, color = "#a8a090") {
      setAcText(status, text, { color, fontId: COMPACT_FONT_ID, fit: true });
    }
    setStatus("Click an emote to perform it — or type /wave, /bow … in chat.");

    function run(entry) {
      const r = performEmote(entry, getHandle(), window.__routeSlashCommand, predictLocal);
      if (r.ok) {
        if (r.echo) echo(r.echo, null);
        setStatus(r.echo ?? `/${entry.token}`, "#e8dfc8");
      } else {
        setStatus(r.error ?? "Could not perform that emote.", "#ff8a70");
      }
    }

    function render() {
      list.replaceChildren();
      const groups = filterEmotes(EMOTE_CATALOG, filterInput.value);
      if (!groups.length) {
        const e = document.createElement("div");
        e.className = "hbk-empty";
        e.textContent = "No emote matches that name.";
        list.appendChild(e);
        return;
      }
      for (const g of groups) {
        const section = document.createElement("section");
        section.className = "hb-ep-section";
        const head = document.createElement("div");
        head.className = "hbk-section-title";
        head.textContent = g.category;
        const count = document.createElement("span");
        count.className = "hbk-muted";
        count.textContent = String(g.items.length);
        head.appendChild(count);
        section.appendChild(head);
        const grid = document.createElement("div");
        grid.className = "hb-ep-grid";
        for (const entry of g.items) {
          const row = document.createElement("div");
          row.className = "hbk-row is-clickable hb-ep-item";
          row.setAttribute("role", "button");
          row.tabIndex = 0;
          row.dataset.token = entry.token;
          row.title = /\s/.test(entry.token)
            ? `${entry.label}${entry.held ? " (held until you move)" : ""}`
            : `/${entry.token}${entry.held ? " — held until you move" : ""}`;
          const label = document.createElement("span");
          label.className = "hbk-grow";
          setAcText(label, entry.label, { color: "#eadfc4", fit: true });
          row.appendChild(label);
          if (entry.held) {
            const dot = document.createElement("span");
            dot.className = "hb-ep-held";
            row.appendChild(dot);
          }
          row.addEventListener("click", () => run(entry));
          row.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" || ev.key === " ") { ev.preventDefault(); run(entry); }
          });
          grid.appendChild(row);
        }
        section.appendChild(grid);
        list.appendChild(section);
      }
    }

    filterInput.addEventListener("input", render);
    filterInput.addEventListener("keydown", (ev) => {
      if (ev.key === "Escape") { filterInput.value = ""; render(); filterInput.blur(); }
      if (ev.key === "Enter") {
        const first = filterEmotes(EMOTE_CATALOG, filterInput.value)[0]?.items?.[0];
        if (first) run(first);
      }
    });
    meRow.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const text = meInput.value.trim();
      if (!text) return;
      const handle = getHandle();
      if (!handle?.sendEmote) { setStatus("Enter the world to use emotes.", "#ff8a70"); return; }
      try {
        handle.sendEmote(text);
        echo(`> ${text}`, null);
        setStatus(`You ${text}`, "#e8dfc8");
        meInput.value = "";
      } catch (e) {
        setStatus(`Emote failed: ${e?.message ?? e}`, "#ff8a70");
      }
    });

    render();
    parentEl.appendChild(root);
    return () => root.remove();
  },
};

// Test seam (tests/emote_table.test.cjs).
export const __test = { EMOTE_CATALOG, filterEmotes, performEmote };
