// rynth/vt/nav/nav_profiles.js — VTank nav profiles (W1-6 NAV, PLAN §3.8, D15).
//
// The VT layer's own named route store: VTank semantics (overwrite on save,
// empty routes allowed, typed points kept losslessly) — deliberately NOT the
// route atlas, which rejects empty routes and auto-renames collisions (U3 §7).
//
// `.nav` / `.af` interop wraps rynth/nav_file.js without editing it (D15, V-15):
//   * parseNavVt   — adds the Follow form `uTank2 NAV 1.2 / 3 / <name> / <guid>`
//                    (no point-count line; metaf Nav.cs + NavNodes/NFollow.cs),
//                    which nav_file.parseNav reads as "malformed header" (U7b H8).
//   * parseAfNavsVt — nav_file.parseAfNavs + the three `.af` fixes: `vnd` → type 5
//                    with its hex vendor guid, `tlk` → type 7 with the object
//                    position/class/name of the metaf `tlk` layout (nav_file reads
//                    both as PortalNPC 6, U7b H9), the hex `prt` guid (nav_file
//                    reads it as decimal), and `flw <hexGuid> {name}` → a Follow
//                    route (nav_file drops it).
//   * writeNavVt   — nav_file.writeNav (raw lines verbatim ⇒ byte-stable), the
//                    Follow form, signed Int32 guids for freshly-made points
//                    (VTank/metaf Int32.Parse, U7b H18), and `ext.*` dropped with a
//                    warning (no known `.nav` encoding for the jump direction, Q3).
//
// The store is injected (a SET NamedStore with prefix "rynth.vt.v1.nav.").

import { parseNav, writeNav, parseAfNavs } from "../../nav_file.js";
import { normalizePoint, normalizeRouteType, normalizeFollowTarget, makeRoute, clonePoint, POINT, ROUTE } from "./route_model.js";

const HEADER = "uTank2 NAV 1.2";
const NAME_MAX = 80;

function makeLog(log, now) {
  const base = typeof log === "function" ? log : (m) => console.log(`[vt:nav] ${m}`);
  const seen = new Map();
  return (msg) => {
    const m = String(msg);
    const t = now();
    const prev = seen.get(m);
    if (prev !== undefined && t - prev < 10_000) return;
    seen.set(m, t);
    if (seen.size > 256) seen.delete(seen.keys().next().value);
    try {
      base(m);
    } catch (_) {
      /* a logger must never throw into nav */
    }
  };
}

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

// Why route_model.normalizePoint refused a point, for the drop warning
// (RYNTH-2 follow-up, 2026-10-18: a non-numeric position is refused, not 0).
function refusal(p) {
  const t = p && typeof p === "object" ? Number(p.type) : NaN;
  if (!Number.isInteger(t) || t < 0 || t > 9) return `unknown waypoint type ${p && p.type}`;
  return `non-numeric position (${p.ew}, ${p.ns}, ${p.z})`;
}

/** Name rule for nav profiles: non-empty, ≤ 80 chars, no path separators or control chars. */
export function validateNavName(name) {
  if (typeof name !== "string") return { ok: false, error: "a nav profile needs a name" };
  const n = name.trim();
  if (!n) return { ok: false, error: "a nav profile needs a name" };
  if (n.length > NAME_MAX) return { ok: false, error: `nav profile name is longer than ${NAME_MAX} characters` };
  if (/[\\/\u0000-\u001f]/.test(n)) return { ok: false, error: `nav profile name "${n}" may not contain / \\ or control characters` };
  return { ok: true, name: n };
}

/**
 * Parse `.nav` text. Follow files: `uTank2 NAV 1.2 / 3 / <targetName> /
 * <targetGuid>` (no count line). Anything else goes through nav_file.parseNav
 * (raw lines kept per point) and its stop-early warning is surfaced.
 * → { ok, route?: { routeType, points, followTarget }, warnings, error?, file? }
 *   (`file` = { eol, trailingEol, tail } for a byte-stable writeNavVt).
 */
export function parseNavVt(text) {
  const warnings = [];
  if (typeof text !== "string" || !text.trim()) return { ok: false, warnings, error: "empty .nav text" };
  const src = stripBom(text);
  const eol = src.includes("\r\n") ? "\r\n" : src.includes("\r") ? "\r" : "\n";
  const trailingEol = /\r\n$|\r$|\n$/.test(src);
  const lines = src.split(/\r\n|\r|\n/);
  if (trailingEol && lines[lines.length - 1] === "") lines.pop();
  if (!(lines[0] || "").toLowerCase().includes(HEADER.toLowerCase())) {
    return { ok: false, warnings, error: "not a uTank2 NAV 1.2 file" };
  }
  const rt = parseInt(lines[1], 10);
  if (rt === ROUTE.Follow) {
    if (lines.length < 4) return { ok: false, warnings, error: "Follow nav is missing its target name/guid lines" };
    const name = lines[2] ?? "";
    const guidN = parseInt(lines[3], 10);
    if (!Number.isFinite(guidN)) return { ok: false, warnings, error: "Follow nav target guid is not an integer" };
    if (lines.length > 4) warnings.push(`ignored ${lines.length - 4} line(s) after the Follow target`);
    return {
      ok: true,
      route: { routeType: ROUTE.Follow, points: [], followTarget: { guid: guidN >>> 0, name } },
      warnings,
      file: { eol, trailingEol, tail: [] },
    };
  }
  const parsed = parseNav(src);
  if (!parsed.routeType) return { ok: false, warnings, error: parsed.warning || "malformed .nav header" };
  if (parsed.warning) warnings.push(parsed.warning);
  else if (parsed.points.length < parsed.pointCount) {
    warnings.push(`file ended after ${parsed.points.length} of ${parsed.pointCount} points`);
  }
  let routeType = parsed.routeType;
  if (routeType < 1 || routeType > 4) {
    warnings.push(`unknown route type ${routeType}; using Circular`);
    routeType = ROUTE.Circular;
  }
  const points = [];
  parsed.points.forEach((p, i) => {
    const n = normalizePoint(p);
    if (n) points.push(n);
    else warnings.push(`point ${i + 1}: ${refusal(p)}; dropped`);
  });
  return { ok: true, route: { routeType, points, followTarget: null }, warnings, file: { eol, trailingEol, tail: parsed.tail || [] } };
}

/**
 * Re-type an `.af` NAV point that nav_file.parseAfNavs collapsed into
 * PortalNPC (6): objectClass 12 (vendor) → OpenVendor (5), objectClass 37
 * (NPC) → NpcTalk (7). Only points with the parser's zero object position
 * (`vnd`/`tlk` lines) are touched — a real `ptl` carries its object position.
 */
export function retypeAfPoint(p) {
  if (!p || p.type !== POINT.PortalNPC) return p;
  const zero = !Number(p.exitEW) && !Number(p.exitNS) && !Number(p.exitZ);
  if (!zero) return p;
  if (p.objectClass === 12) {
    const { objectClass: _c, isTie: _t, exitEW: _x, exitNS: _y, exitZ: _z, ...rest } = p;
    return { ...rest, type: POINT.OpenVendor, vendorId: (Number(p.vendorId) || 0) >>> 0, name: p.name ?? "" };
  }
  if (p.objectClass === 37) return { ...p, type: POINT.NpcTalk };
  return p;
}

// {brace groups} are single tokens (AfFileParser.SplitNavTokens port; same
// rule as nav_file.js splitNavTokens, which is module-private).
function splitNavTokens(line) {
  const tokens = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && (line[i] === " " || line[i] === "\t")) i++;
    if (i >= line.length) break;
    if (line[i] === "{") {
      let depth = 0;
      const start = i + 1;
      for (; i < line.length; i++) {
        if (line[i] === "{") depth++;
        else if (line[i] === "}") {
          depth--;
          if (depth === 0) {
            i++;
            break;
          }
        }
      }
      tokens.push(line.slice(start, Math.max(start, i - 1)));
    } else {
      const start = i;
      while (i < line.length && line[i] !== " " && line[i] !== "\t" && line[i] !== "{") i++;
      tokens.push(line.slice(start, i));
    }
  }
  return tokens;
}

const stripComment = (s) => {
  const c = s.indexOf("~~");
  return c >= 0 ? s.slice(0, c).trimEnd() : s;
};

// Scan the .af for what nav_file.parseAfNavs drops or mis-types: per NAV:
// section the `flw` target and the vnd/tlk lines (metaf layouts), per
// NAVDATA: block the raw lines (a Follow NAVDATA has no count line).
function scanAfSections(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = new Map();
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trimStart();
    if (t.startsWith("NAVDATA:")) {
      const body = stripComment(t.slice("NAVDATA:".length)).trim();
      const sp = body.lastIndexOf(" ");
      const name = sp > 0 ? body.slice(0, sp).trim() : body;
      const count = sp > 0 ? parseInt(body.slice(sp + 1), 10) || 0 : 0;
      i++;
      const navLines = [];
      for (let k = 0; k < count && i < lines.length; k++) navLines.push(lines[i++]);
      if (i < lines.length && lines[i].trim() === "~~ }") i++;
      if (name) out.set(name, { kind: "NAVDATA", navLines, flw: null, fixes: [] });
      continue;
    }
    if (t.startsWith("NAV:")) {
      const parts = stripComment(t.slice("NAV:".length)).trim().split(/\s+/).filter(Boolean);
      const name = parts[0] || "";
      const sec = { kind: "NAV", flw: null, fixes: [], prt: [] };
      i++;
      while (i < lines.length) {
        const b = lines[i].trimStart();
        if (b === "~~ }" || b.startsWith("STATE:") || b.startsWith("NAV:") || b.startsWith("NAVDATA:")) {
          if (b === "~~ }") i++;
          break;
        }
        if (b && !b.startsWith("~~")) {
          const tok = splitNavTokens(b);
          if (tok[0] === "flw" && tok.length >= 3) {
            const g = parseInt(tok[1], 16);
            sec.flw = { guid: Number.isFinite(g) ? g >>> 0 : 0, name: tok[2] };
          } else if (tok[0] === "vnd" && tok.length >= 5) {
            // metaf NOpenVendor: vnd myx myy myz tgtGUID(hex) {tgtName}
            const g = parseInt(tok[4], 16);
            sec.fixes.push({ kw: "vnd", vendorId: Number.isFinite(g) ? g >>> 0 : 0, name: tok.length >= 6 ? tok[5] : null });
          } else if (tok[0] === "prt" && tok.length >= 5) {
            // metaf NPortal: prt myx myy myz GUIDHEX (`{_guid:X8}`, NPortal.cs:54/60);
            // nav_file reads that guid as DECIMAL.
            const g = parseInt(tok[4], 16);
            sec.prt.push(Number.isFinite(g) ? g >>> 0 : 0);
          } else if (tok[0] === "tlk" && tok.length >= 5) {
            // metaf NNPCTalk: tlk myx myy myz tgtx tgty tgtz tgtObjectClass {tgtName}
            sec.fixes.push(
              tok.length >= 9
                ? { kw: "tlk", exitEW: Number(tok[4]), exitNS: Number(tok[5]), exitZ: Number(tok[6]), objectClass: parseInt(tok[7], 10) || 37, name: tok[8] }
                : { kw: "tlk" },
            );
          }
        }
        i++;
      }
      if (name) out.set(name, sec);
      continue;
    }
    i++;
  }
  return out;
}

/**
 * Every NAV:/NAVDATA: route in a metaf `.af` text, re-typed for the VT
 * executors. → { [name]: { routeType, points, followTarget, warnings } }
 * (`warnings`: points dropped for a non-numeric position, a NAVDATA block's
 * parse stop — RYNTH-2 follow-up, 2026-10-18).
 */
export function parseAfNavsVt(text) {
  const out = {};
  if (typeof text !== "string" || !text) return out;
  const src = stripBom(text);
  let base = {};
  try {
    base = parseAfNavs(src) || {};
  } catch (_) {
    base = {};
  }
  const sections = scanAfSections(src);
  const names = new Set([...Object.keys(base), ...sections.keys()]);
  for (const name of names) {
    const sec = sections.get(name) || null;
    if (sec && sec.kind === "NAVDATA") {
      const r = parseNavVt(sec.navLines.join("\r\n") + "\r\n");
      if (r.ok) out[name] = { routeType: r.route.routeType, points: r.route.points, followTarget: r.route.followTarget, warnings: r.warnings };
      continue;
    }
    const parsed = base[name];
    if (!parsed && !(sec && sec.flw)) continue;
    const fixes = sec ? sec.fixes.slice() : [];
    const prts = sec && Array.isArray(sec.prt) ? sec.prt.slice() : [];
    const points = [];
    const warnings = [];
    (parsed ? parsed.points : []).forEach((p0, i) => {
      let p = retypeAfPoint(p0);
      if (p0.type === POINT.PortalLegacy && prts.length) p = { ...p, guid: prts.shift() };
      if (p !== p0 && fixes.length) {
        const f = fixes[0];
        if ((f.kw === "vnd" && p.type === POINT.OpenVendor) || (f.kw === "tlk" && p.type === POINT.NpcTalk)) {
          fixes.shift();
          if (f.kw === "vnd") {
            p = { ...p, vendorId: f.vendorId };
            if (f.name != null) p.name = f.name;
          } else if (f.name != null) {
            p = { ...p, exitEW: f.exitEW, exitNS: f.exitNS, exitZ: f.exitZ, objectClass: f.objectClass, name: f.name };
          }
        }
      }
      const n = normalizePoint(p);
      if (n) points.push(n);
      else warnings.push(`point ${i + 1}: ${refusal(p)}; dropped`);
    });
    const followTarget = sec && sec.flw ? normalizeFollowTarget(sec.flw) : null;
    const routeType = followTarget ? ROUTE.Follow : normalizeRouteType(parsed ? parsed.routeType : ROUTE.Circular);
    out[name] = { routeType, points, followTarget, warnings };
  }
  return out;
}

const fmtNum = (n) => String(Number.isFinite(Number(n)) ? Number(n) : 0);
const oneLine = (s) => String(s ?? "").replace(/[\r\n]+/g, " ");
const signed32 = (g) => (Number(g) || 0) | 0;

// Fresh (non-raw) point → its .nav lines, with SIGNED guids (VTank writes
// Int32; nav_file.writeNav would emit the unsigned form).
function freshRaw(p) {
  const lines = [String(p.type), fmtNum(p.ew), fmtNum(p.ns), fmtNum(p.z), p.flag != null ? String(p.flag) : "0"];
  switch (p.type) {
    case POINT.PortalLegacy:
      lines.push(String(signed32(p.guid)));
      break;
    case POINT.Recall:
      lines.push(String(Math.trunc(Number(p.spellId) || 0)));
      break;
    case POINT.Pause:
      lines.push(String(Math.max(0, Math.round(Number(p.pauseMs) || 0))));
      break;
    case POINT.Chat:
      lines.push(oneLine(p.chat));
      break;
    case POINT.OpenVendor:
      lines.push(String(signed32(p.vendorId)));
      lines.push(oneLine(p.name));
      break;
    case POINT.PortalNPC:
    case POINT.NpcTalk:
      lines.push(oneLine(p.name));
      lines.push(String(Math.trunc(Number(p.objectClass) || 0)));
      lines.push(p.isTie ? "True" : "False");
      lines.push(fmtNum(p.exitEW));
      lines.push(fmtNum(p.exitNS));
      lines.push(fmtNum(p.exitZ));
      break;
    case POINT.Jump:
      lines.push(fmtNum(p.headingDeg));
      lines.push(p.holdShift ? "True" : "False");
      lines.push(fmtNum(p.delayMs));
      break;
    default:
      break;
  }
  return lines;
}

/**
 * RouteState / NavProfile → `.nav` text. Points carrying `raw` are written
 * verbatim (byte-stable round trip); fresh points get signed Int32 guids.
 * `ext.*` has no `.nav` encoding: dropped with one warning per point.
 * opts.file = { eol, trailingEol, tail } from parseNavVt (default CRLF + EOL).
 * → { text, warnings }
 */
export function writeNavVt(route, { file = null } = {}) {
  const warnings = [];
  const eol = (file && file.eol) || "\r\n";
  const trailingEol = !(file && file.trailingEol === false);
  const routeType = normalizeRouteType(route && route.routeType);
  if (routeType === ROUTE.Follow) {
    const t = normalizeFollowTarget(route && route.followTarget) || { guid: 0, name: "" };
    if (route && Array.isArray(route.points) && route.points.length) {
      warnings.push(`Follow nav: ${route.points.length} point(s) not written (a Follow .nav holds only its target)`);
    }
    const text = [HEADER, "3", oneLine(t.name), String(signed32(t.guid))].join(eol) + (trailingEol ? eol : "");
    return { text, warnings };
  }
  const points = [];
  (route && Array.isArray(route.points) ? route.points : []).forEach((p0, i) => {
    const p = normalizePoint(p0);
    if (!p) {
      warnings.push(`point ${i + 1}: ${refusal(p0)} not written`);
      return;
    }
    if (p.ext && Object.keys(p.ext).length) {
      warnings.push(`point ${i + 1}: ${Object.entries(p.ext).map(([k, v]) => `${k}=${v}`).join(", ")} has no .nav encoding (dropped)`);
    }
    points.push({ ...p, raw: p.raw && p.raw.length ? p.raw : freshRaw(p) });
  });
  const text = writeNav({ routeType, points, eol, trailingEol, tail: (file && file.tail) || [] });
  return { text, warnings };
}

function looksLikeAf(text) {
  return /^\s*(NAV|NAVDATA):/m.test(text);
}

/** Store record (NavProfile, PLAN §3.2) from any route-like object. */
function toProfile(name, route, savedAt) {
  const r = makeRoute({
    name,
    routeType: route && route.routeType,
    points: route && Array.isArray(route.points) ? route.points : [],
    followTarget: route && route.followTarget,
  });
  return { v: 1, name, routeType: r.routeType, points: r.points.map(clonePoint), followTarget: r.followTarget, savedAt };
}

export class NavProfiles {
  /** @param {{ store: { list(), get(name), put(name, value), remove(name) }, now?: () => number, log?: (m: string) => void }} deps */
  constructor({ store = null, now = Date.now, log } = {}) {
    this.store = store;
    this.now = typeof now === "function" ? now : Date.now;
    this.log = makeLog(log, () => this.now());
  }

  /** → Array<{ name, savedAt, bytes }> (the store's order: by name). */
  list() {
    try {
      const l = this.store && typeof this.store.list === "function" ? this.store.list() : [];
      return Array.isArray(l) ? l : [];
    } catch (e) {
      this.log(`list failed: ${e && e.message ? e.message : e}`);
      return [];
    }
  }

  /** → NavProfile (a fresh copy) or null. */
  get(name) {
    const v = validateNavName(name);
    if (!v.ok || !this.store) return null;
    let rec = null;
    try {
      rec = this.store.get(v.name);
    } catch (_) {
      rec = null;
    }
    if (!rec || typeof rec !== "object" || !Array.isArray(rec.points)) return null;
    const p = toProfile(typeof rec.name === "string" && rec.name ? rec.name : v.name, rec, Number(rec.savedAt) || 0);
    return p;
  }

  /** Save (OVERWRITE; an empty route is legal). → { ok, error? } */
  put(name, route) {
    const v = validateNavName(name);
    if (!v.ok) return { ok: false, error: v.error };
    if (!this.store) return { ok: false, error: "no nav profile store" };
    const profile = toProfile(v.name, route, this.now());
    try {
      const r = this.store.put(v.name, profile);
      return r && r.ok === false ? { ok: false, error: r.error || "save failed" } : { ok: true };
    } catch (e) {
      return { ok: false, error: `save failed: ${e && e.message ? e.message : e}` };
    }
  }

  remove(name) {
    const v = validateNavName(name);
    if (!v.ok) return { ok: false, error: v.error };
    if (!this.store) return { ok: false, error: "no nav profile store" };
    try {
      const r = this.store.remove(v.name);
      return r && r.ok === false ? { ok: false, error: r.error || "remove failed" } : { ok: true };
    } catch (e) {
      return { ok: false, error: `remove failed: ${e && e.message ? e.message : e}` };
    }
  }

  /**
   * Import `.nav` text, or a metaf `.af` text (its NAV/NAVDATA section named
   * `name`, else the first one), and save it under `name`.
   * → { ok, warnings, error? }
   */
  importText(name, text) {
    const v = validateNavName(name);
    if (!v.ok) return { ok: false, warnings: [], error: v.error };
    if (typeof text !== "string" || !text.trim()) return { ok: false, warnings: [], error: "nothing to import" };
    let route = null;
    let warnings = [];
    if (looksLikeAf(text)) {
      const navs = parseAfNavsVt(text);
      const keys = Object.keys(navs);
      if (!keys.length) return { ok: false, warnings, error: "no NAV: or NAVDATA: section in the .af text" };
      const key = keys.find((k) => k.toLowerCase() === v.name.toLowerCase()) || keys[0];
      if (keys.length > 1) warnings.push(`imported NAV "${key}"; ${keys.length - 1} other section(s) ignored`);
      route = navs[key];
      if (Array.isArray(route.warnings)) warnings.push(...route.warnings);
    } else {
      const r = parseNavVt(text);
      if (!r.ok) return { ok: false, warnings: r.warnings, error: r.error };
      route = r.route;
      warnings = r.warnings;
    }
    const put = this.put(v.name, route);
    return put.ok ? { ok: true, warnings } : { ok: false, warnings, error: put.error };
  }

  /** → { ok, text?, warnings, error? } (CRLF `.nav`, VTank's own format). */
  exportText(name) {
    const p = this.get(name);
    if (!p) return { ok: false, warnings: [], error: `no nav profile named "${String(name ?? "").trim()}"` };
    const { text, warnings } = writeNavVt(p);
    return { ok: true, text, warnings };
  }
}

export default { parseNavVt, retypeAfPoint, parseAfNavsVt, writeNavVt, validateNavName, NavProfiles };
