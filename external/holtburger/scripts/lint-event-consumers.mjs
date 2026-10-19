#!/usr/bin/env node
// scripts/lint-event-consumers.mjs — last-mile event-consumer lint
// (test-tooling-6, 2026-10-13). Sibling of lint-url-flags.mjs.
//
// The first hops of inbound event delivery are already pinned: the Rust
// GameEvent decode match is exhaustive, `gen-client-event-kinds.mjs --check`
// keeps the ClientEvent kind table in sync, and app/client_events.js names
// every kind. The LAST hop — ClientEvent → plugin bus → a UI — had no check,
// so a server reply could be re-emitted on the bus with nobody listening and
// nobody noticing (allegianceInfo: retail prints the profile from
// ClientAllegianceSystem::Handle_Allegiance__AllegianceInfoResponseEvent; we
// emitted it into the void). This sweep is that check.
//
// Mechanical, dependency-free, deliberately heuristic. Over app/, scene3d/,
// plugins/, ui/, rynth/ and index.html's inline scripts (comments masked):
//   EMITTED     literal names passed to `emit(` / `emit?.(` on the plugin bus
//               (bare, `….events.emit(` or `bus.emit(`) — a plain string, or
//               a ternary of two strings (`emit(c ? "a" : "b", …)`)
//   SUBSCRIBED  literal names passed to `.on(` / `.on?.(` / `.once(` /
//               `.addEventListener(` / `onBus(`, plus `["name", fn]` tuples in
//               the 20 lines above a dynamic-name `.on(name, fn)` loop
// and reports:
//   NO-CONSUMER      a name is emitted but nothing in the tree subscribes,
//                    and it is in neither EXTENSION_POINTS nor KNOWN_GAPS
//   STALE-ALLOWLIST  an EXTENSION_POINTS / KNOWN_GAPS name gained a
//                    subscriber (or is no longer emitted), or a
//                    DETAIL_KNOWN_BUGS entry stopped firing — remove the
//                    entry; all three lists may only shrink
//   DETAIL-UNREAD    a bus handler (subscribed to an emitted bus name, or on a
//                    visibly-bus receiver: `….events.on(`, `bus.on(`,
//                    `onBus(`) reads payload fields off the Event itself
//                    (`(p) => p.guid`) and never touches `.detail`. The bus
//                    delivers `new CustomEvent(name, { detail: payload })`
//                    (plugins/api.js events.emit), so such a handler always
//                    sees `undefined`. Shipped twice before this lint:
//                    buffs-hud.js entityEnchantmentsUpdated (fixed 2026-08-04)
//                    and salvage-panel.js salvageResult (fixed 2026-10-05);
//                    its first run found five more (DETAIL_KNOWN_BUGS).
//
// Dynamic-name emits (`emit(payload.type, …)` for the kind=19 combat family)
// are invisible to the NO-CONSUMER sweep by construction; so are subscribers
// in tests/ (a test listener is not a consumer). Handlers built by a factory
// (`const h = make(1)`) get no DETAIL verdict. A static inventory by design,
// not a behaviour test.
//
// Exit 1 on any finding. Run:
//   node scripts/lint-event-consumers.mjs [--app apps/holtburger-web] [--verbose]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// ── EXTENSION_POINTS: emitted for plugins, no in-tree consumer needed ───────
// The bus is a documented public plugin API (plugins/api.js "Bus-emitted
// events"), so "no in-tree subscriber" is not by itself a bug. Each entry
// says why the event exists without one.
export const EXTENSION_POINTS = {
  houseStatusUpdated:
    "plugins/house-panel.js — fires when the diffed house snapshot changes so house-aware plugins need not re-diff (api.js bus list, rec #182)",
  hoverEntity:
    "plugins/hover-tooltip.js — hover edge {guid, name, source} for plugin polish; the tooltip itself renders in-module",
  animationHookDone:
    "scene3d/entities.js — AnimationDone hook (type 4) edge for LoopRepeat cycles; observer signal for combat/cast/motion plugins",
  localizationReady:
    "app/client_events.js — Login locale snapshot; in-tree readers use window.__acLocalization / __acLocalizationReady instead",
  chessUpdate:
    "app/client_events.js — drudge-chess board state (window.__chess) for a board plugin; retail draws it in gmChessUI (ClientMiniGameSystem::Handle_Game__Recv_*) — rendered board is a follow-on",
  inscriptionShown:
    "app/client_events.js — deprecated InscriptionResponse; retail has no DispatchUI for it (inscriptions arrive via appraisal, ItemExamineUI::SetInscription)",
  portalSpaceExited:
    "app/client_events.js — Chorizite Character.OnPortalSpaceExited mirror (api.js coverage row 14); portal_space.js drives the exit itself",
  serverConfirmRequest:
    "app/client_events.js — bus copy of GameEvent 0x0274; plugins/server-confirm.js consumes the window `hb:server-confirm-request` event",
  serverConfirmDone:
    "app/client_events.js — bus copy of GameEvent 0x0276; plugins/server-confirm.js consumes the window `hb:server-confirm-done` event",
  raiseVitalFailed:
    "plugins/character-info.js — local throw from handle.raiseVital (stale pkg/); the console.warn beside it is the in-tree surface",
  raiseAttributeFailed:
    "plugins/character-info.js — local throw from handle.raiseAttribute (stale pkg/); the console.warn beside it is the in-tree surface",
};

// ── KNOWN_GAPS: retail consumes the wire event, we only emit it ─────────────
// A visible backlog that may only SHRINK: wiring a consumer makes the entry
// STALE and fails the lint until it is removed. Each names the retail handler
// (acclient.c) the missing consumer should port.
export const KNOWN_GAPS = {
  allegianceInfo: [
    "AllegianceInfoResponse 0x027C → ClientAllegianceSystem::Handle_Allegiance__AllegianceInfoResponseEvent (acclient.c ~407159, via CM_Allegiance::DispatchUI_AllegianceInfoResponseEvent) prints the profile; payload is handle.lastAllegianceInfoResponse()",
  ],
  uiEvent: [
    "channellist: ChannelList 0x0148 → ClientCommunicationSystem::Handle_Communication__ChannelList",
    "channelindex: ChannelIndex 0x0149 → ClientCommunicationSystem::Handle_Communication__ChannelIndex",
    "har: UpdateHAR 0x0257 → ClientHousingSystem::Handle_House__Recv_UpdateHAR",
    "houses: AvailableHouses 0x0271 → ClientHousingSystem::Handle_House__Recv_AvailableHouses",
    "(the `age` tag IS consumed — client_events.js routes it to chat before the emit)",
    "(the `barber` tag IS consumed — client_events.js also emits it as the `startBarber` bus event → plugins/barber-panel.js, the gmBarberUI::RecvNotice_StartBarberNotice port, acclient.c ~271178)",
  ],
};

// ── DETAIL_KNOWN_BUGS: `file:eventName` → why it is still open ─────────────
// REAL DETAIL-UNREAD bugs the lint proved on its first run (2026-10-13), left
// in the app because app code is out of scope for the change that wired this
// gate (same contract as lint-url-flags' PRESENCE-DIVERGENT list). NOT
// known-good: each names the fix. An entry whose finding disappears is
// reported STALE so the list cannot outlive its bug.
export const DETAIL_KNOWN_BUGS = {
  // The four blood/carnage entries below are FIXED ON THE DEFAULT PAGE: the
  // `?combatFxBus` unwrap went DEFAULT ON 2026-10-19 (ahead of its 1070 eye
  // test, which is still owed). Each module's `onBus` helper hands the handler
  // `ev.detail` unless `?combatFxBus=off` (also 0/false/no), and then the raw
  // Event. The handler text, which is all this static check sees, still reads
  // off its argument, so the finding still fires and the entries stay. Remove
  // the four together when the escape is retired and the unwrap moves into the
  // handlers themselves.
  "scene3d/blood_decals.js:playEffect":
    "destructures {targetGuid, scriptId} off its argument. Default arm (?combatFxBus DEFAULT ON 2026-10-19): onBus unwraps ev.detail first, so a real hit reaches _splatterFromHit. Only the ?combatFxBus=off escape hands it the Event → decodeSplatterId(undefined) is null → no stamp (tests/combat_fx_bus_detail.test.mjs pins both arms)",
  "scene3d/blood_decals.js:damageDealt":
    "crit latch reads dd.criticalHit / dd.defenderName off its argument. Default arm (?combatFxBus DEFAULT ON 2026-10-19): the same onBus unwrap as the playEffect handler above, so it latches. Only the ?combatFxBus=off escape reads the Event and never latches",
  "scene3d/carnage.js:playEffect":
    "destructures {targetGuid, scriptId} off its argument; tests/carnage_hit_guard.test.mjs's fake bus passes the raw payload, which hid the original bug. Default arm (?combatFxBus DEFAULT ON 2026-10-19): onBus unwraps ev.detail first, so the limb automation and the finisher see real splatter. Only the ?combatFxBus=off escape hands it the Event and nothing fires (tests/combat_fx_bus_detail.test.mjs pins both arms)",
  "scene3d/carnage.js:damageDealt":
    "crit latch reads d.criticalHit / d.defenderName off its argument. Default arm (?combatFxBus DEFAULT ON 2026-10-19): kill_impulse.js's `d?.detail ?? d` unwrap, via onBus, so it latches. Only the ?combatFxBus=off escape reads the Event and never latches",
};

// Properties a handler may legitimately read off the Event object itself.
const EVENT_PROPS = new Set([
  "detail", "type", "target", "currentTarget", "srcElement", "timeStamp",
  "isTrusted", "bubbles", "cancelable", "composed", "defaultPrevented",
  "eventPhase", "returnValue", "cancelBubble", "preventDefault",
  "stopPropagation", "stopImmediatePropagation", "composedPath",
  "initCustomEvent", "initEvent",
  // EatableBus (plugins/loader.js) events
  "eat", "eaten",
]);

const NAME = String.raw`[A-Za-z_$][\w$:.\-]*`;
const IDENT_RE = /^[A-Za-z_$][\w$]*/;

// ── lexical masking ─────────────────────────────────────────────────────────
// Returns two views the same length as `src` (offsets/lines line up):
//   code  comments blanked, strings/regexes intact (literal-name matching)
//   skel  comments AND string/template/regex contents blanked, quotes kept
//         (bracket matching that cannot be fooled by "{" inside a string)
// Newlines are always preserved.
const REGEX_PREV_CHARS = new Set("(,=:[!&|?{};+-*%<>~^}".split(""));
const REGEX_PREV_WORDS = new Set([
  "return", "typeof", "case", "do", "else", "in", "of", "new", "delete",
  "void", "throw", "instanceof", "yield", "await",
]);
export function maskJs(src) {
  const n = src.length;
  const code = new Array(n);
  const skel = new Array(n);
  const blank = (c) => (c === "\n" || c === "\r" ? c : " ");
  const put = (j, c, s) => { code[j] = c; skel[j] = s; };
  let i = 0;
  if (src.startsWith("#!")) {
    while (i < n && src[i] !== "\n") { put(i, " ", " "); i += 1; }
  }
  let mode = "code"; // code | line | block | str | tpl | re
  let quote = "";
  let reClass = false;
  const tplDepth = []; // brace depth inside each open `${ … }`
  const regexAllowed = () => {
    let j = i - 1;
    while (j >= 0 && /\s/.test(code[j])) j -= 1;
    if (j < 0) return true;
    const c = code[j];
    if (/[\w$]/.test(c)) {
      let k = j;
      while (k >= 0 && /[\w$]/.test(code[k])) k -= 1;
      return REGEX_PREV_WORDS.has(code.slice(k + 1, j + 1).join(""));
    }
    return REGEX_PREV_CHARS.has(c);
  };
  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (mode === "code") {
      if (c === "/" && d === "/") { mode = "line"; continue; }
      if (c === "/" && d === "*") { put(i, " ", " "); put(i + 1, " ", " "); i += 2; mode = "block"; continue; }
      if (c === "/" && regexAllowed()) { put(i, c, " "); i += 1; mode = "re"; reClass = false; continue; }
      if (c === '"' || c === "'") { put(i, c, c); i += 1; mode = "str"; quote = c; continue; }
      if (c === "`") { put(i, c, c); i += 1; mode = "tpl"; continue; }
      if (tplDepth.length) {
        if (c === "{") tplDepth[tplDepth.length - 1] += 1;
        else if (c === "}") {
          if (tplDepth[tplDepth.length - 1] === 0) { tplDepth.pop(); put(i, c, c); i += 1; mode = "tpl"; continue; }
          tplDepth[tplDepth.length - 1] -= 1;
        }
      }
      put(i, c, c); i += 1; continue;
    }
    if (mode === "line") {
      if (c === "\n") { put(i, c, c); mode = "code"; } else put(i, " ", " ");
      i += 1; continue;
    }
    if (mode === "block") {
      if (c === "*" && d === "/") { put(i, " ", " "); put(i + 1, " ", " "); i += 2; mode = "code"; continue; }
      put(i, blank(c), blank(c)); i += 1; continue;
    }
    if (mode === "str" || mode === "tpl" || mode === "re") {
      if (c === "\\" && i + 1 < n) { put(i, c, " "); put(i + 1, d, blank(d)); i += 2; continue; }
    }
    if (mode === "str") {
      if (c === quote) { put(i, c, c); mode = "code"; }
      else if (c === "\n") { put(i, c, c); mode = "code"; } // unterminated — recover
      else put(i, c, blank(c));
      i += 1; continue;
    }
    if (mode === "tpl") {
      if (c === "`") { put(i, c, c); i += 1; mode = "code"; continue; }
      if (c === "$" && d === "{") { put(i, c, c); put(i + 1, d, d); i += 2; tplDepth.push(0); mode = "code"; continue; }
      put(i, c, blank(c)); i += 1; continue;
    }
    // mode === "re"
    if (c === "\n") { put(i, c, c); i += 1; mode = "code"; continue; } // was a division — recover
    if (c === "[") reClass = true;
    else if (c === "]") reClass = false;
    else if (c === "/" && !reClass) {
      put(i, c, " "); i += 1;
      while (i < n && /[a-z]/i.test(src[i])) { put(i, src[i], " "); i += 1; }
      mode = "code"; continue;
    }
    put(i, c, " "); i += 1;
  }
  return { code: code.join(""), skel: skel.join("") };
}

// index.html: keep only the classic/module inline <script> bodies (the
// importmap JSON and the markup become blanks, newlines kept).
export function htmlScripts(html) {
  const out = html.replace(/[^\n\r]/g, " ").split("");
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(re)) {
    const attrs = m[1];
    if (/\bsrc\s*=/.test(attrs)) continue;
    const t = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
    if (t && !/^(module|text\/javascript|application\/javascript)$/i.test(t[1])) continue;
    const start = m.index + m[0].indexOf(">") + 1;
    for (let j = 0; j < m[2].length; j += 1) out[start + j] = m[2][j];
  }
  return out.join("");
}

// ── small parsers over a masked view ────────────────────────────────────────
const OPEN = { "(": ")", "[": "]", "{": "}" };
function matchClose(skel, open) {
  const stack = [];
  for (let j = open; j < skel.length; j += 1) {
    const c = skel[j];
    if (OPEN[c]) stack.push(OPEN[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return -1;
      if (!stack.length) return j;
    }
  }
  return -1;
}
// End of the expression starting at `p`: first depth-0 `,` `)` `]` `}` `;`.
function exprEnd(skel, p) {
  let depth = 0;
  for (let j = p; j < skel.length; j += 1) {
    const c = skel[j];
    if (OPEN[c]) depth += 1;
    else if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) return j;
      depth -= 1;
    } else if ((c === "," || c === ";") && depth === 0) return j;
  }
  return skel.length;
}
function skipWs(s, p) {
  while (p < s.length && /\s/.test(s[p])) p += 1;
  return p;
}
function splitTopLevel(skel, code, a, b) {
  const parts = [];
  let depth = 0;
  let from = a;
  for (let j = a; j < b; j += 1) {
    const c = skel[j];
    if (OPEN[c]) depth += 1;
    else if (c === ")" || c === "]" || c === "}") depth -= 1;
    else if (c === "," && depth === 0) { parts.push(code.slice(from, j).trim()); from = j + 1; }
  }
  parts.push(code.slice(from, b).trim());
  return parts.filter((x) => x.length);
}

// Parse a function value at `p`: `function (…) {…}`, `(…) => …`, `x => …`
// (each optionally `async`). Returns {params:[…], bodyStart, bodyEnd}, a
// {ref: "name"} for a bare identifier argument, or null for anything else.
function parseFn(view, p) {
  const { code, skel } = view;
  p = skipWs(code, p);
  const asyncM = /^async\b\s*/.exec(code.slice(p, p + 16));
  if (asyncM && !/^async\s*[,)]/.test(code.slice(p, p + 16))) p += asyncM[0].length;
  const head = code.slice(p, p + 200);
  let paramsOpen;
  let afterParams;
  let isArrow = false;
  if (/^function\b/.test(head)) {
    paramsOpen = code.indexOf("(", p);
    if (paramsOpen < 0) return null;
    afterParams = matchClose(skel, paramsOpen);
    if (afterParams < 0) return null;
  } else if (code[p] === "(") {
    paramsOpen = p;
    afterParams = matchClose(skel, p);
    if (afterParams < 0) return null;
    const q = skipWs(code, afterParams + 1);
    if (code.slice(q, q + 2) !== "=>") return null;
    isArrow = true;
  } else {
    const id = IDENT_RE.exec(head);
    if (!id) return null;
    const q = skipWs(code, p + id[0].length);
    if (code.slice(q, q + 2) === "=>") {
      const b = skipWs(code, q + 2);
      const end = code[b] === "{" ? matchClose(skel, b) : exprEnd(skel, b);
      if (end < 0) return null;
      return { params: [id[0]], bodyStart: b, bodyEnd: end };
    }
    if (code[q] === "," || code[q] === ")" || code[q] === ";") return { ref: id[0] };
    return null;
  }
  const params = splitTopLevel(skel, code, paramsOpen + 1, afterParams);
  let b = skipWs(code, afterParams + 1);
  if (isArrow) b = skipWs(code, b + 2);
  if (code[b] === "{") {
    const end = matchClose(skel, b);
    if (end < 0) return null;
    return { params, bodyStart: b, bodyEnd: end };
  }
  if (!isArrow) return null;
  return { params, bodyStart: b, bodyEnd: exprEnd(skel, b) };
}

// Resolve a handler passed by name to its definition in the same file:
// `function NAME(`, `const|let|var NAME = <fn>` or a later `NAME = <fn>`
// assignment — the nearest parseable one before the subscription site, else
// the first after it. `NAME = otherName;` follows one more hop. Factories
// (`const h = make(1)`) stay unresolved — no verdict, never a finding.
function resolveRef(view, name, site, hops = 2) {
  const { code, skel } = view;
  const defs = [];
  const esc = name.replace(/\$/g, "\\$");
  for (const m of code.matchAll(new RegExp(String.raw`\bfunction\s*\*?\s*${esc}\s*\(`, "g"))) {
    defs.push(m.index);
  }
  for (const m of code.matchAll(new RegExp(String.raw`(?<![\w$.])${esc}\s*=(?![=>])\s*`, "g"))) {
    defs.push(m.index + m[0].length);
  }
  const live = defs.filter((x) => skel[x] === code[x]).sort((a, b) => a - b);
  const order = [...live.filter((x) => x < site).reverse(), ...live.filter((x) => x >= site)];
  for (const at of order) {
    const fn = parseFn(view, at);
    if (!fn) continue;
    if (!fn.ref) return fn;
    if (hops > 0 && fn.ref !== name) {
      const next = resolveRef(view, fn.ref, at, hops - 1);
      if (next) return next;
    }
  }
  return null;
}

// The DETAIL-UNREAD verdict for one parsed handler: null when fine, else the
// list of non-Event properties it reads off its first parameter.
function detailVerdict(view, fn) {
  const first = fn.params[0];
  if (!first || first.startsWith("...") || first.startsWith("[")) return null;
  const body = view.code.slice(fn.bodyStart, fn.bodyEnd + 1);
  if (first.startsWith("{")) {
    const keys = [...first.matchAll(/([A-Za-z_$][\w$]*)\s*(?=[:,=}])/g)].map((m) => m[1]);
    if (keys.includes("detail")) return null;
    const bad = keys.filter((k) => !EVENT_PROPS.has(k));
    return bad.length ? bad : null;
  }
  const id = IDENT_RE.exec(first);
  if (!id) return null;
  if (/\bdetail\b/.test(body)) return null;
  const esc = id[0].replace(/\$/g, "\\$");
  const reads = new Set();
  for (const m of body.matchAll(new RegExp(String.raw`(?<![\w$.])${esc}\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)`, "g"))) {
    if (!EVENT_PROPS.has(m[1])) reads.add(m[1]);
  }
  return reads.size ? [...reads] : null;
}

// ── the scan ────────────────────────────────────────────────────────────────
/**
 * @param {Array<{file: string, text: string}>} sources  `.html` files are
 *   reduced to their inline scripts; everything else is treated as JS.
 * @param {{extensionPoints?: object, knownGaps?: object, detailKnownBugs?: object}} [opts]
 *   override the module's lists (tests pass `{}`s to start from a clean slate)
 * @returns {{emitted: Map<string, string[]>, subscribed: Map<string, string[]>,
 *   findings: Array<{kind: string, name: string, where: string, detail: string}>,
 *   allowlisted: Array<{name: string, list: string}>, knownBugs: string[],
 *   handlers: {bus: number, parsed: number}}}
 *   `findings` is exactly what fails the lint; `handlers` counts the bus
 *   subscriptions the DETAIL check saw and how many it could parse.
 */
export function scan(sources, opts = {}) {
  const extensionPoints = opts.extensionPoints ?? EXTENSION_POINTS;
  const knownGaps = opts.knownGaps ?? KNOWN_GAPS;
  const detailKnownBugs = opts.detailKnownBugs ?? DETAIL_KNOWN_BUGS;
  const emitted = new Map();
  const subscribed = new Map();
  const subSites = []; // {view, file, name, at, line, handlerAt, busRecv}
  const add = (map, name, where) => {
    const list = map.get(name) || [];
    list.push(where);
    map.set(name, list);
  };
  for (const { file, text } of sources) {
    const view = maskJs(/\.html?$/i.test(file) ? htmlScripts(text) : text);
    const { code, skel } = view;
    const lineStarts = [0];
    for (let j = 0; j < code.length; j += 1) if (code[j] === "\n") lineStarts.push(j + 1);
    const lineOf = (off) => {
      let lo = 0;
      let hi = lineStarts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (lineStarts[mid] <= off) lo = mid; else hi = mid - 1;
      }
      return lo + 1;
    };
    // EMITTED
    // (`skel[at] !== code[at]` = the match starts inside a string/regex.)
    for (const m of code.matchAll(/\bemit\s*(?:\?\.\s*)?\(/g)) {
      if (skel[m.index] !== code[m.index]) continue;
      // Receiver: a bare `emit(` or `….events.emit(` / `bus.emit(` is the
      // plugin bus. Any other receiver is another bus — e.g. the chat hooks'
      // EatableBus (`__chatHooks.incoming.emit("chatIncoming")`), which
      // spreads the payload INTO the event, so its handlers rightly read
      // `ev.text` and must not meet the DETAIL check.
      const before = code.slice(Math.max(0, m.index - 80), m.index).replace(/\s+$/, "");
      if (/\??\.$/.test(before)) {
        const recv = before.replace(/\??\.$/, "").replace(/[\s?]+$/, "");
        if (!/(?:^|[^\w$])(?:events|bus)$/.test(recv)) continue;
      }
      const a = skipWs(code, m.index + m[0].length);
      const arg = code.slice(a, exprEnd(skel, a)).trim();
      const names = [];
      const lit = new RegExp(String.raw`^(["'\`])(${NAME})\1$`).exec(arg);
      if (lit) names.push(lit[2]);
      else {
        const tern = new RegExp(String.raw`\?\s*(["'\`])(${NAME})\1\s*:\s*(["'\`])(${NAME})\3$`).exec(arg);
        if (tern) names.push(tern[2], tern[4]);
      }
      for (const n of names) add(emitted, n, `${file}:${lineOf(m.index)}`);
    }
    // SUBSCRIBED (literal names)
    const subRe = new RegExp(
      String.raw`(?:\.\s*(?:on|once|addEventListener)|\bonBus)\s*(?:\?\.\s*)?\(\s*(["'\`])(${NAME})\1\s*,?`,
      "g",
    );
    for (const m of code.matchAll(subRe)) {
      if (skel[m.index] !== code[m.index]) continue;
      add(subscribed, m[2], `${file}:${lineOf(m.index)}`);
      if (m[0].endsWith(",")) {
        // Receiver is visibly the plugin bus: `….events.on(`, `bus.on(`,
        // `onBus(` — lets the DETAIL check cover dynamically-emitted names
        // (the kind=19 damageDealt/… family) too.
        const recv = code.slice(Math.max(0, m.index - 40), m.index).replace(/[\s?]+$/, "");
        const busRecv = /^\s*onBus/.test(m[0]) ||
          (/^\.\s*(?:on|once)\b/.test(m[0]) && /(?:^|[^\w$])(?:events|bus)$/.test(recv));
        subSites.push({
          view, file, name: m[2], at: m.index, line: lineOf(m.index),
          handlerAt: m.index + m[0].length, busRecv,
        });
      }
    }
    // SUBSCRIBED (tuple idiom): `for (const [name, fn] of [["x", f], …])
    // bus.on(name, fn)` — literal tuples in the 20 lines above a
    // dynamic-name subscription count as subscribers.
    const dynRe = /(?:\.\s*(?:on|once|addEventListener)|\bonBus)\s*(?:\?\.\s*)?\(\s*[A-Za-z_$][\w$]*\s*,/g;
    for (const m of code.matchAll(dynRe)) {
      if (skel[m.index] !== code[m.index]) continue;
      const line = lineOf(m.index);
      const from = lineStarts[Math.max(0, line - 21)];
      const above = code.slice(from, m.index);
      for (const t of above.matchAll(new RegExp(String.raw`\[\s*(["'\`])(${NAME})\1\s*,\s*[A-Za-z_$(]`, "g"))) {
        add(subscribed, t[2], `${file}:${lineOf(from + t.index)} (tuple)`);
      }
    }
  }

  const findings = [];
  const allowlisted = [];
  const lists = [["EXTENSION_POINTS", extensionPoints], ["KNOWN_GAPS", knownGaps]];
  for (const [name, sites] of emitted) {
    if (subscribed.has(name)) continue;
    const hit = lists.find(([, l]) => Object.prototype.hasOwnProperty.call(l, name));
    if (hit) allowlisted.push({ name, list: hit[0] });
    else {
      findings.push({
        kind: "NO-CONSUMER", name, where: sites.join(", "),
        detail: "emitted on the plugin bus, nothing subscribes — wire a consumer, or add it to EXTENSION_POINTS (plugin API) / KNOWN_GAPS (retail handler) with a reason",
      });
    }
  }
  for (const [listName, list] of lists) {
    for (const name of Object.keys(list)) {
      if (subscribed.has(name)) {
        findings.push({
          kind: "STALE-ALLOWLIST", name, where: subscribed.get(name).join(", "),
          detail: `${listName} entry now has a subscriber — remove it (the list only shrinks)`,
        });
      } else if (!emitted.has(name)) {
        findings.push({
          kind: "STALE-ALLOWLIST", name, where: "-",
          detail: `${listName} entry is no longer emitted anywhere — remove it`,
        });
      }
    }
  }
  // DETAIL-UNREAD — only for plugin-bus subscriptions (a name emitted in the
  // tree, or a visibly-bus receiver), so DOM `addEventListener("click",
  // (e) => e.clientX)` is never checked.
  const knownBugHits = new Set();
  const handlers = { bus: 0, parsed: 0 };
  for (const s of subSites) {
    if (!emitted.has(s.name) && !s.busRecv) continue;
    handlers.bus += 1;
    let fn = parseFn(s.view, s.handlerAt);
    if (fn?.ref) fn = resolveRef(s.view, fn.ref, s.at);
    if (!fn) continue;
    handlers.parsed += 1;
    const bad = detailVerdict(s.view, fn);
    if (!bad) continue;
    const key = `${s.file}:${s.name}`;
    if (Object.prototype.hasOwnProperty.call(detailKnownBugs, key)) {
      knownBugHits.add(key);
      continue;
    }
    findings.push({
      kind: "DETAIL-UNREAD", name: s.name, where: `${s.file}:${s.line}`,
      detail: `handler reads ${bad.map((p) => `.${p}`).join(", ")} off the Event and never .detail — the bus delivers CustomEvent{detail: payload}`,
    });
  }
  for (const key of Object.keys(detailKnownBugs)) {
    if (knownBugHits.has(key)) continue;
    findings.push({
      kind: "STALE-ALLOWLIST", name: key, where: "-",
      detail: "DETAIL_KNOWN_BUGS entry no longer fires — remove it (bug fixed?)",
    });
  }
  return { emitted, subscribed, findings, allowlisted, knownBugs: [...knownBugHits], handlers };
}

// ── tree collection ─────────────────────────────────────────────────────────
const SKIP_DIRS = new Set(["node_modules", "dist", "legacy", "vendor", "testdata", "tests", "assets"]);
export function collectSources(appDir) {
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || /^pkg(?:-|$)/.test(e.name)) continue;
        walk(p);
      } else if (/\.(?:js|mjs|cjs)$/.test(e.name) && !/(?:^test_|[._]test\.[cm]?js$)/.test(e.name)) {
        files.push(p);
      }
    }
  };
  for (const sub of ["app", "scene3d", "plugins", "ui", "rynth"]) {
    const d = path.join(appDir, sub);
    if (fs.existsSync(d)) walk(d);
  }
  files.push(path.join(appDir, "index.html"));
  return files.map((f) => ({ file: path.relative(appDir, f), text: fs.readFileSync(f, "utf8") }));
}

function main() {
  const argIdx = process.argv.indexOf("--app");
  const APP = argIdx >= 0 ? process.argv[argIdx + 1] : "apps/holtburger-web";
  const VERBOSE = process.argv.includes("--verbose");
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const appDir = path.resolve(ROOT, APP);
  const sources = collectSources(appDir);
  const { emitted, subscribed, findings, allowlisted, knownBugs, handlers } = scan(sources);
  const gaps = allowlisted.filter((a) => a.list === "KNOWN_GAPS");
  console.log(
    `lint-event-consumers: ${sources.length} files, ${emitted.size} emitted bus names, ` +
      `${subscribed.size} subscribed names; ${allowlisted.length} unconsumed allowlisted ` +
      `(${allowlisted.length - gaps.length} extension points, ${gaps.length} known gaps); ` +
      `${handlers.parsed}/${handlers.bus} bus handlers checked for .detail ` +
      `(${knownBugs.length} known bug(s)); ${findings.length} finding(s)`,
  );
  if (VERBOSE) {
    console.log("\n— census (emitted name → subscribers) —");
    for (const [name, sites] of [...emitted].sort((a, b) => a[0].localeCompare(b[0]))) {
      const subs = subscribed.get(name);
      console.log(`  ${name}  emit@ ${sites.join(", ")}  →  ${subs ? subs.join(", ") : "(none)"}`);
    }
    console.log("\n— EXTENSION_POINTS —");
    for (const [n, why] of Object.entries(EXTENSION_POINTS)) console.log(`  ${n}: ${why}`);
    console.log("\n— KNOWN_GAPS (backlog; shrink-only) —");
    for (const [n, rows] of Object.entries(KNOWN_GAPS)) {
      console.log(`  ${n}`);
      for (const r of rows) console.log(`    - ${r}`);
    }
    console.log("\n— DETAIL_KNOWN_BUGS (shrink-only) —");
    for (const [k, why] of Object.entries(DETAIL_KNOWN_BUGS)) console.log(`  ${k}: ${why}`);
    console.log("");
  }
  for (const f of findings.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))) {
    console.log(`${f.kind}  ${f.name}  ${f.where}  ${f.detail}`);
  }
  process.exit(findings.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) main();
