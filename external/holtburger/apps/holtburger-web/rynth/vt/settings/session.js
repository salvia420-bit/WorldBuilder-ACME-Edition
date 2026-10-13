// rynth/vt/settings/session.js — page-level per-character VT session (PLAN
// §3.3, §3.5; D6, D33).
//
// One VtSession per character scope (player guid as a decimal string,
// "pending" until known) for the page lifetime, kept in the registry
// `win.__rynthVtSessions` (a Map). A bot rebind on the same page (takeover,
// HUD Restart) finds the same session, so nav state, meta state, the Default
// overlay and session vars continue; a page reload starts fresh (VTank login
// semantics). Node tests pass their own `win = {}`.
//
// VtSession = { scope, charName, options, profiles,
//   stores: { nav, meta, loot } (NamedStore "rynth.vt.v1.nav." / ".meta." / ".loot."),
//   navState: {} (owned by NAV), metaState: {} (owned by META), meta: Meta|null,
//   varsSession: {} (VarStore.exportSession()), attachCount: 0, createdAt,
//   ext: {} (INT-2 per-session runtime objects) }

import { SCHEMA } from "./schema.js";
import { NamedStore } from "./named_store.js";
import { ProfileStore } from "./profile_store.js";
import { createVtOptions } from "./options.js";

export const SESSION_REGISTRY_KEY = "__rynthVtSessions";
export const NAV_STORE_PREFIX = "rynth.vt.v1.nav.";
export const META_STORE_PREFIX = "rynth.vt.v1.meta.";
export const LOOT_STORE_PREFIX = "rynth.vt.v1.loot.";

let fallbackRegistry = null; // used only when no win object is supplied

function registry(win, create) {
  if (!win || (typeof win !== "object" && typeof win !== "function")) {
    if (!fallbackRegistry && create) fallbackRegistry = new Map();
    return fallbackRegistry;
  }
  let reg = null;
  try {
    reg = win[SESSION_REGISTRY_KEY];
  } catch {
    reg = null;
  }
  if (reg instanceof Map) return reg;
  if (!create) return null;
  reg = new Map();
  try {
    win[SESSION_REGISTRY_KEY] = reg;
  } catch {
    /* frozen window stand-in: the Map still works for this call chain */
  }
  return reg;
}

/** Scope = player guid as a decimal string (`x >>> 0`, the botScopeOf /
 *  rynthBotOperatorStop:<guid> convention), else "pending". A decimal string
 *  is normalised the same way, so "-5", -5 and "4294967291" are one session. */
export function normaliseScope(scope) {
  if (typeof scope === "number" && Number.isFinite(scope)) {
    const g = scope >>> 0;
    return g ? String(g) : "pending";
  }
  if (typeof scope === "string") {
    const s = scope.trim();
    if (/^[+-]?\d+$/.test(s)) {
      const g = Number(s) >>> 0;
      return g ? String(g) : "pending";
    }
    if (s) return s;
  }
  return "pending";
}

function defaultStorage(win) {
  try {
    const ls = win && win.localStorage;
    return ls && typeof ls.getItem === "function" ? ls : null;
  } catch {
    return null;
  }
}

/**
 * The session for `scope`, created on first use.
 * `storage` undefined ⇒ win.localStorage (guarded); null ⇒ in-memory.
 */
export function getVtSession(win, scope, { storage, charName = "", now = Date.now, log } = {}) {
  const reg = registry(win, true);
  const sc = normaliseScope(scope);
  const existing = reg.get(sc);
  if (existing) {
    if (typeof charName === "string" && charName && !existing.charName) {
      existing.charName = charName;
      try {
        existing.profiles.setCharName?.(charName);
      } catch {
        /* ignore */
      }
    }
    return existing;
  }
  const clock = typeof now === "function" ? now : Date.now;
  const st = storage === undefined ? defaultStorage(win) : storage;
  const name = typeof charName === "string" ? charName : "";
  const profiles = new ProfileStore({ storage: st, scope: sc, charName: name, now: clock, log, win: win || null });
  const options = createVtOptions({ schema: SCHEMA, profiles, log, now: clock });
  const session = {
    scope: sc,
    charName: name,
    options,
    profiles,
    stores: {
      nav: new NamedStore({ storage: st, prefix: NAV_STORE_PREFIX, now: clock, log }),
      meta: new NamedStore({ storage: st, prefix: META_STORE_PREFIX, now: clock, log }),
      loot: new NamedStore({ storage: st, prefix: LOOT_STORE_PREFIX, now: clock, log }),
    },
    navState: {},
    metaState: {},
    meta: null,
    varsSession: {},
    attachCount: 0,
    createdAt: clock(),
    ext: {},
  };
  reg.set(sc, session);
  return session;
}

/** The existing session for `scope`, or null (never creates). */
export function peekVtSession(win, scope) {
  const reg = registry(win, false);
  if (!reg) return null;
  return reg.get(normaliseScope(scope)) || null;
}
