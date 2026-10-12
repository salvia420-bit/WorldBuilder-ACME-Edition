// rynth/vt/meta/actions.js — the meta ACTION table (PLAN §2.9, §3.12,
// Appendix B). One function per metaf keyword, run over the per-pass run
// context built by engine.js (see conditions.js for the shared members).
// No imports, no side effects at load.
//
// Action-only run-context members:
//   rc.meta                  the loaded Meta (navs for EmbedNav)
//   rc.enterState(name, why) the engine's ONLY state writer
//   rc.callState(to, ret)    push ret (or the current state) + enter `to`
//   rc.returnFromCall()      pop + enter; empty stack ⇒ error + EnableMeta off
//   rc.setWatchdog(spec)     { state, dist (m), secs } — replaces any watchdog
//   rc.clearWatchdog()
//   rc.chatRun(line)         ctx.chat.run: the local /rs /vt /ra /mt /ub
//                            dispatcher first (synchronous), then the game
//   rc.echoError(msg)        lastError + one chat line per (rule, message)
//   rc.recordError(msg)      lastError only (debug strip; printed in debug)
//
// Fixes over RynthAi (U5 §9): CallState honours the explicit return state
// (B2/B8); Return on an empty stack disables the meta (GUIDE:283); an EMPTY
// embedded nav clears the route (B3); ChatExpr never sends an error result
// (B18); GetOpt/SetOpt reach the real option authority, unknown names go to
// the meta-only bag (B10/D19); DoAll never bails early (U5 §1.4).

export const MAX_ACTION_DEPTH = 64;
const WATCHDOG_DEFAULT_DIST_M = 5; // MetaManager.cs:797-798 defaults
const WATCHDOG_DEFAULT_SECS = 5;

function text(x) {
  if (x === null || x === undefined) return "";
  return typeof x === "string" ? x : String(x);
}

function errText(e) {
  return e && e.message ? e.message : text(e);
}

function msgOfErr(v) {
  return v && typeof v === "object" && v.msg ? text(v.msg) : "expression error";
}

// A Value as a raw option input: primitives pass through (VtOptions.coerce
// parses true/false/on/off/numbers), anything else is stringified.
function rawOf(v, rc) {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return rc.values.toStr(v);
  return v;
}

function settings(rc) {
  return rc.ctx && rc.ctx.settings ? rc.ctx.settings : null;
}

function findNav(meta, tag) {
  const navs = meta && meta.navs && typeof meta.navs === "object" ? meta.navs : null;
  if (!navs) return null;
  if (Object.prototype.hasOwnProperty.call(navs, tag)) return navs[tag];
  const low = tag.toLowerCase();
  for (const k of Object.keys(navs)) if (k.toLowerCase() === low) return navs[k];
  return null;
}

function row(met, label, run) {
  return Object.freeze({ met, label, run });
}

export const ACTIONS = Object.freeze({
  None: row(0, "None", () => {}),

  SetState: row(1, "Set Meta State", (a, rc) => {
    // Same state re-arms (the vtsetmetastate[vtgetmetastate[]] idiom).
    if (!rc.enterState(a.state, "set")) rc.echoError("SetState: empty state name");
  }),

  Chat: row(2, "Chat Command", (a, rc) => {
    const line = text(a.text).trim();
    if (line) rc.chatRun(line);
  }),

  DoAll: row(3, "All", (a, rc, d) => {
    // Every child in order — no early bail even when a child changes state
    // (U5 §1.4, Discord utilitybelt 2022-02-20). A throwing child is recorded
    // and the remaining children still run.
    const ch = Array.isArray(a.children) ? a.children : [];
    for (const child of ch) {
      try {
        runAction(child, rc, d + 1);
      } catch (e) {
        rc.recordError(`${child && child.t ? child.t : "action"}: ${errText(e)}`);
      }
    }
  }),

  EmbedNav: row(4, "Load Embedded Navroute", (a, rc) => {
    const tag = text(a.tag).trim();
    const nav = rc.ctx && rc.ctx.nav;
    const mn = tag ? findNav(rc.meta, tag) : null;
    if (!mn) {
      rc.echoError(`EmbedNav: the meta has no embedded route "${tag}"`);
      return;
    }
    if (!nav || typeof nav.loadEmbedded !== "function") {
      rc.echoError("EmbedNav: navigation is not available");
      return;
    }
    // An empty route (navText "") CLEARS the active nav (B3). EnableNavigation
    // is not touched (Q6).
    const r = nav.loadEmbedded(tag, mn);
    if (r && r.ok === false) rc.echoError(`EmbedNav ${tag}: ${text(r.error) || "load failed"}`);
  }),

  CallState: row(5, "Call Meta State", (a, rc) => {
    rc.callState(a.state, a.ret);
  }),

  Return: row(6, "Return From Call", (a, rc) => {
    rc.returnFromCall();
  }),

  DoExpr: row(7, "Expression Action", (a, rc) => {
    const src = text(a.expr);
    if (!src.trim()) return;
    const v = rc.evaluate(src);
    if (rc.values.isErr(v)) rc.recordError(`DoExpr: ${msgOfErr(v)}`); // debug strip only
  }),

  ChatExpr: row(8, "Chat Expression", (a, rc) => {
    const src = text(a.expr);
    if (!src.trim()) return;
    const v = rc.evaluate(src);
    if (rc.values.isErr(v)) {
      rc.recordError(`ChatExpr: ${msgOfErr(v)}`); // never sent to chat (B18)
      return;
    }
    const line = text(rc.values.toStr(v)).trim();
    if (line) rc.chatRun(line);
  }),

  SetWatchdog: row(9, "Set Watchdog", (a, rc) => {
    const dist = Number(a.dist);
    const secs = Number(a.secs);
    const ok = rc.setWatchdog({
      state: a.state,
      dist: Number.isFinite(dist) && dist >= 0 ? dist : WATCHDOG_DEFAULT_DIST_M,
      secs: Number.isFinite(secs) && secs > 0 ? secs : WATCHDOG_DEFAULT_SECS,
    });
    if (!ok) rc.echoError("SetWatchdog: empty target state");
  }),

  ClearWatchdog: row(10, "Clear Watchdog", (a, rc) => {
    rc.clearWatchdog();
  }),

  GetOpt: row(11, "Get VT Option", (a, rc) => {
    const opt = text(a.opt).trim();
    const name = text(a.var).trim();
    if (!opt || !name) {
      rc.echoError("GetOpt: option and variable names are required");
      return;
    }
    const s = settings(rc);
    const r = s && typeof s.get === "function" ? s.get(opt) : null;
    if (r && r.ok) {
      rc.setVar(name, r.value === undefined ? null : r.value);
      return;
    }
    // Unknown name ⇒ the meta-only option bag (D19); never set ⇒ 0.
    const bagged = s && typeof s.bagGet === "function" ? s.bagGet(opt) : undefined;
    if (bagged === undefined) rc.warnOnce(`getopt:${opt.toLowerCase()}`, `[Meta] GetOpt: unknown option "${opt}" (reads 0)`);
    rc.setVar(name, bagged === undefined ? 0 : bagged);
  }),

  SetOpt: row(12, "Set VT Option", (a, rc) => {
    const opt = text(a.opt).trim();
    if (!opt) {
      rc.echoError("SetOpt: option name is required");
      return;
    }
    const v = rc.evaluate(text(a.expr)); // "based on the return value of an expression" (GUIDE:289)
    if (rc.values.isErr(v)) {
      rc.echoError(`SetOpt ${opt}: ${msgOfErr(v)}`);
      return;
    }
    const s = settings(rc);
    if (!s) {
      rc.echoError("SetOpt: settings are not available");
      return;
    }
    const known = typeof s.get === "function" ? s.get(opt) : null;
    if (known && known.ok) {
      const r = typeof s.set === "function" ? s.set(opt, rawOf(v, rc), { source: "meta" }) : null;
      if (!r || r.ok === false) rc.echoError(`SetOpt ${opt}: ${text(r && r.error) || "rejected"}`);
      return;
    }
    if (typeof s.bagSet === "function") s.bagSet(opt, v);
    rc.warnOnce(`setopt:${opt.toLowerCase()}`, `[Meta] SetOpt: unknown option "${opt}" kept for this meta session only`);
  }),

  CreateView: row(13, "Create View", (a, rc) => {
    const views = rc.ctx && rc.ctx.views;
    const name = text(a.view).trim();
    if (!views || typeof views.create !== "function") {
      rc.echoError("CreateView: meta views are not available");
      return;
    }
    const r = views.create(name, text(a.xml));
    if (!r || r.ok === false) rc.echoError(`CreateView ${name}: ${text(r && r.error) || "failed"}`);
  }),

  DestroyView: row(14, "Destroy View", (a, rc) => {
    const views = rc.ctx && rc.ctx.views;
    if (views && typeof views.destroy === "function") views.destroy(text(a.view).trim());
  }),

  DestroyAllViews: row(15, "Destroy All Views", (a, rc) => {
    const views = rc.ctx && rc.ctx.views;
    if (views && typeof views.destroyAll === "function") views.destroyAll();
  }),
});

export const ACTION_KEYWORDS = Object.freeze(Object.keys(ACTIONS));

/**
 * Run one action tree. Unknown keywords are no-ops (FMT maps them to None +
 * unknownKeyword) with one warning. Depth is capped at 64. Exceptions from the
 * context propagate to the engine (DoAll catches per child), which records
 * lastError and keeps the rule fired (B14).
 */
export function runAction(act, rc, depth = 0) {
  if (!act || typeof act !== "object") return;
  if (depth > MAX_ACTION_DEPTH) {
    rc.recordError(`action nesting deeper than ${MAX_ACTION_DEPTH}`);
    return;
  }
  const r = Object.prototype.hasOwnProperty.call(ACTIONS, act.t) ? ACTIONS[act.t] : null;
  if (!r) {
    const kw = text(act.unknownKeyword || act.t);
    rc.warnOnce(`act:${kw}`, `[Meta] unsupported action "${kw}" is ignored`);
    return;
  }
  r.run(act, rc, depth);
}

// ── human-readable form (debug lines, MetaSnapshot.lastFired) ─────────────

function clip(s, n = 60) {
  const t = text(s);
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

export function describeAction(a, depth = 0) {
  if (!a || typeof a !== "object") return "?";
  switch (a.t) {
    case "SetState":
      return `SetState {${a.state}}`;
    case "Chat":
      return `Chat {${clip(a.text)}}`;
    case "DoAll": {
      if (depth > 4) return "DoAll…";
      const ch = (Array.isArray(a.children) ? a.children : []).map((k) => describeAction(k, depth + 1));
      return clip(`DoAll(${ch.join("; ")})`, 160);
    }
    case "EmbedNav":
      return `EmbedNav ${a.tag}${a.displayName ? ` {${clip(a.displayName)}}` : ""}`;
    case "CallState":
      return `CallState {${a.state}}${a.ret ? ` {${a.ret}}` : ""}`;
    case "DoExpr":
    case "ChatExpr":
      return `${a.t} {${clip(a.expr)}}`;
    case "SetWatchdog":
      return `SetWatchdog ${a.dist} ${a.secs} {${a.state}}`;
    case "GetOpt":
      return `GetOpt {${a.opt}} {${a.var}}`;
    case "SetOpt":
      return `SetOpt {${a.opt}} {${clip(a.expr)}}`;
    case "CreateView":
    case "DestroyView":
      return `${a.t} {${a.view}}`;
    default:
      return text(a.unknownKeyword || a.t);
  }
}
