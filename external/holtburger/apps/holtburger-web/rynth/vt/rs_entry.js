// rynth/vt/rs_entry.js — the page-side entry of the VTank layer (PLAN §3.15,
// INT-2): window.__rynthVt, the ONE object every page caller reaches the
// `/rs` command layer through.
//
//   route(handle, line)   the slash-router entry (INT-3's routeSlashCommand
//                         branch for /rs /vt /ra /mt /ub, and through it every
//                         host.InvokeChatParser line). Synchronous decision;
//                         ALWAYS answers { dispatched: true, echo: null } — the
//                         dispatcher prints every result line (errors
//                         included) through its own print, so returning the
//                         error here would print it twice (CMD review §5.2).
//   dispatch(line, opts)  run one line: the live layer's dispatcher (its /ub
//                         delay queue is pumped by the layer's pre-tick), else
//                         a page-level dispatcher that works without a bot for
//                         `opt` / `settings` (the character's page session); it
//                         cannot queue (no pump), so delay/give/loot-retry verbs
//                         answer "needs the VTank layer" there.
//   session(scope?)       the VtSession of the current character (or `scope`),
//                         created on first use (settings/session.js registry).
//   hudProvider(handle?)  what the RynthSuite HUD (INT-3) asks a profile:
//                         { isUserProfileActive, hudBootOverrides,
//                           noteLegacyEdit, statusLine } — null while the
//                         character is unknown.
//   openPanel(tab?)       lazy import of plugins/rynth-vt/panel.js (URL
//                         relative to location.href, I-26) → openVtPanel.
//
// installRsEntry(win) is idempotent: a second call (another module instance,
// the lazy slash-branch import, a bot rebind) returns the installed object.
// No top-level side effects; window/location are read only through `win`
// (C1). Never throws from route/dispatch/hudProvider (C9).

import { createRsDispatcher } from "./cmd/index.js";
import { getVtSession, peekVtSession } from "./settings/index.js";

export const RS_ENTRY_VERSION = 1;
const PANEL_PATH = "plugins/rynth-vt/panel.js";
const VIEWS_PATH = "plugins/rynth-vt/meta_views.js";
const CAT_SYSTEM = 0;
const CAT_ERROR = 10;

const errText = (e) => String(e && e.message ? e.message : e);

function safe(fn, dflt = null) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
}

/** A module URL resolved against the page (location.href), or null off-page. */
export function pageModuleUrl(win, path) {
  const href = safe(() => win && win.location && win.location.href, null);
  if (typeof href !== "string" || !href) return null;
  try {
    return new URL(path, href).href;
  } catch {
    return null;
  }
}

/** Open the VT panel (lazy). → Promise<void>; rejects off-page. */
export function openVtPanel(win, tab, importer = (u) => import(u)) {
  const url = pageModuleUrl(win, PANEL_PATH);
  if (!url) return Promise.reject(new Error("the VT panel needs a page (no location.href)"));
  return Promise.resolve()
    .then(() => importer(url))
    .then((m) => {
      if (!m || typeof m.openVtPanel !== "function") throw new Error("panel module has no openVtPanel");
      return m.openVtPanel({ tab });
    });
}

/** The meta-view DOM renderer factory (lazy). → Promise<createViewRenderer>|null off-page. */
export function loadViewRendererFactory(win, importer = (u) => import(u)) {
  const url = pageModuleUrl(win, VIEWS_PATH);
  if (!url || !safe(() => win.document, null)) return null;
  return Promise.resolve()
    .then(() => importer(url))
    .then((m) => (m && typeof m.createViewRenderer === "function" ? m.createViewRenderer : null));
}

/** The character guid behind a session handle (or the page's own). 0 = unknown. */
function guidOf(handle) {
  const g = safe(() => (handle && typeof handle.playerGuid === "function" ? Number(handle.playerGuid()) : 0), 0);
  return Number.isFinite(g) ? g >>> 0 : 0;
}

/**
 * Install (once) and return window.__rynthVt.
 * @param {object} win  the page window (node tests: a plain object)
 * @param {{ importer?: (url:string) => Promise<object> }} [opts]
 */
export function installRsEntry(win = globalThis, opts = {}) {
  const w = win && (typeof win === "object" || typeof win === "function") ? win : globalThis;
  const cur = safe(() => w.__rynthVt, null);
  if (cur && cur.version === RS_ENTRY_VERSION && typeof cur.route === "function" && typeof cur.dispatch === "function") return cur;
  const importer = opts && typeof opts.importer === "function" ? opts.importer : (u) => import(u);

  const bot = () => safe(() => w.__bot ?? null, null);
  const layer = () => safe(() => bot()?.vt ?? null, null);
  const pageHandle = () => safe(() => w.__sessionHandle ?? null, null);
  let lastHandle = null; // the handle of the line being routed (bot-less session lookup)

  function sessionFor(scope) {
    const l = layer();
    if (scope === undefined || scope === null || scope === "") {
      if (l && l.session) return l.session;
      const g = guidOf(lastHandle) || guidOf(pageHandle()) || (Number(safe(() => bot()?.host?.GetPlayerId?.(), 0)) >>> 0);
      if (!g) return null;
      scope = String(g);
    }
    const sc = String(scope);
    if (l && l.session && l.session.scope === sc) return l.session;
    return safe(() => peekVtSession(w, sc) || getVtSession(w, sc, {}), null);
  }

  function print(text, category = CAT_SYSTEM) {
    try {
      const append = w.__appendChatLine;
      if (typeof append === "function") {
        append(String(text), category);
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      const h = bot()?.host;
      if (h && typeof h.WriteToChatWindow === "function" && h.WriteToChatWindow(String(text), category)) return;
    } catch {
      /* fall through */
    }
    try {
      console.log(`[RynthSuite] ${text}`);
    } catch {
      /* no console */
    }
  }

  function invokeChatParser(line) {
    const h = safe(() => bot()?.host ?? null, null);
    if (h && typeof h.InvokeChatParser === "function") {
      try {
        return h.InvokeChatParser(line) !== false;
      } catch {
        return false;
      }
    }
    // No bot: the page's own slash router (never ourselves — the /rs family
    // never reaches invokeChatParser, the dispatcher handles it locally).
    const route = safe(() => w.__routeSlashCommand, null);
    const handle = lastHandle || pageHandle();
    if (typeof route === "function" && handle) {
      try {
        const r = route(handle, String(line));
        return !!(r && r.dispatched);
      } catch {
        return false;
      }
    }
    return false;
  }

  // The page-level dispatcher (no bot, or a bot without the layer): the same
  // command table, its context resolved live per call. canQueue false: nothing
  // pumps this dispatcher (only the layer's pre-tick pumps the layer's own, and a
  // page timer would break V-8 and act on a ?botVt=off page), so the verbs that
  // queue — `/ub delay`, a multi-stack `/ra give…`, a `/mt loot` retry — refuse
  // with "needs the VTank layer" instead of reporting work that never runs
  // (review runtime-5 / wiring-4).
  const pageCtx = {
    print: (text, category) => print(text, category),
    now: () => Date.now(),
    bot: () => bot(),
    vt: () => layer(),
    session: () => sessionFor(),
    hud: () => safe(() => w.__rynthHud?.bridge ?? null, null),
    host: () => safe(() => bot()?.host ?? null, null),
    operatorHeld: () => safe(() => bot()?.kernel?.operatorHeld === true, false),
    openPanel: (tab) => api.openPanel(tab),
    invokeChatParser: (line) => invokeChatParser(line),
  };
  const pageRs = createRsDispatcher({ getCtx: () => pageCtx, canQueue: false });

  function dispatch(line, { source = "chat" } = {}) {
    try {
      const l = layer();
      const d = l && l.rs && typeof l.rs.run === "function" ? l.rs : pageRs;
      return d.run(String(line ?? ""), { source });
    } catch (e) {
      const msg = `[RynthSuite] command failed: ${errText(e)}`;
      if (source !== "tell") print(msg, CAT_ERROR);
      return { handled: true, lines: [{ text: msg, category: CAT_ERROR }], error: msg };
    }
  }

  const api = {
    version: RS_ENTRY_VERSION,
    /** The slash-router entry: synchronous, always dispatched, never echoes. */
    route(handle, line) {
      const prev = lastHandle;
      lastHandle = handle || null;
      try {
        dispatch(line, { source: "chat" });
      } finally {
        lastHandle = prev;
      }
      return { dispatched: true, echo: null };
    },
    dispatch,
    session(scope) {
      return sessionFor(scope);
    },
    hudProvider(handle) {
      try {
        const g = guidOf(handle);
        const s = g ? sessionFor(String(g)) : sessionFor();
        if (!s || !s.options) return null;
        return {
          scope: s.scope,
          isUserProfileActive: () => safe(() => s.profiles.isUserProfileActive() === true, false),
          hudBootOverrides: () => safe(() => s.options.hudBootOverrides(), null),
          noteLegacyEdit: (field, value) => safe(() => s.options.noteLegacyEdit(field, value), { ok: false, error: "unavailable" }),
          statusLine: () => {
            const l = layer();
            return l && l.session === s && typeof l.statusLine === "function" ? safe(() => String(l.statusLine()), "") : "";
          },
        };
      } catch {
        return null;
      }
    },
    openPanel(tab) {
      return openVtPanel(w, tab, importer);
    },
    /** The live layer of the page's bot (diagnostics), or null. */
    layer() {
      return layer();
    },
    /** The page-level dispatcher (tests / console). */
    pageDispatcher: pageRs,
  };
  try {
    w.__rynthVt = api;
  } catch {
    /* a frozen window stand-in: the object still works for this caller */
  }
  return api;
}

export default installRsEntry;
