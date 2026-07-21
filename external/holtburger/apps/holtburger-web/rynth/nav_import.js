// nav_import.js — the actual import PATH from a community-authored VTank/
// uTank2 .nav (or embedded .af NAV: section) into a named atlas route the
// bot's `follow_route` can walk. nav_file.js is a validated FORMAT parser
// (round-trip proven) but nothing wired it to atlas.js/bot.js before this —
// this module is that wiring.
//
// Dependency-light like atlas.js: no host/session handle, no wasm. Depends on
// nav_file.js (format) and route_flags.js (the SAME v2 portal/indoor
// derivation goto_compose.js's replay side uses — see route_flags.js header;
// this is the "reuse, don't duplicate" refactor the task called for).
//
// ── Record-type -> leg mapping ──────────────────────────────────────────────
//   pnt (Point,0)        plain leg, no meta
//   prt (PortalLegacy,1) portal leg (ground-truth); meta {navType:'prt', guid}
//   rcl (Recall,2)       portal leg (ground-truth); meta {navType:'rcl', spellId, spellName}
//   pau (Pause,3)        plain leg;                 meta {navType:'pau', pauseMs}
//   cht (Chat,4)         plain leg;                 meta {navType:'cht', text}
//   vnd (OpenVendor,5)   plain leg;                 meta {navType:'vnd', vendorId, name}
//   ptl (PortalNPC,6)    portal leg (ground-truth); meta {navType:'ptl', objName, objectClass, isTie, objPos:{lb,x,y,z}}
//   tlk (Npc,7)          plain leg (may still get portal via distance fallback);
//                                                   meta {navType:'tlk', objName, objectClass, isTie, objPos:{lb,x,y,z}}
//   chk (Checkpoint,8)   plain leg;                 meta {navType:'chk'}
//   jmp (Jump,9)         plain leg + WARNING (no walk primitive for a scripted
//                        jump maneuver — the leg is preserved, not dropped);
//                                                   meta {navType:'jmp', headingDeg, holdShift, delayMs}
//
// "Ground-truth" portal types are ALWAYS flagged portal:true regardless of
// geometry (the record says so); ALL legs then also pass through
// deriveRouteFlags in legacy mode, which independently flags any >=500m
// world-frame discontinuity — the union of both signals is kept (a record
// the file didn't mark as a portal, but which is geometrically a teleport,
// still gets caught; see route_flags.js).
//
// ptl/tlk objPos (2026-07-20, live MatronHive replay finding): a VTank ptl
// record's OWN 5-line-prologue coordinate is the RECORDING PLAYER'S approach
// point (metaf NPortal_NPC's _myx/_myy/_myz) — for a hub of several portal
// options this is often the SAME anchor point reused across all of them (the
// live leg-8 "Portal to Town Network" failure: touch-assist searched at the
// leg's own coordinate and found nothing, because the real portal entity
// sits ~27m away). The trailer's _objx/_objy/_objz (parsed as
// p.exitEW/exitNS/exitZ below — the field names predate this finding) are
// the PORTAL/NPC's OWN position, independent of the approach point. objPos
// carries that ground truth forward, world-frame converted via
// navPointToLeg just like the leg coordinate itself, so goto_compose.js's
// replay-side portal targeting can search/walk to where the object actually
// is instead of only where the recording player once stood.
//
// rcl legs have NO physical entity at all (a self-cast recall spell) — the
// leg's own coordinate is just the cast location. A route that depends on a
// recall is a real prerequisite (the character must know + be able to cast
// that spell), so each rcl record also emits an import-time warning naming
// the dependency (spellId + spellName via nav_file.js's RECALL_SPELL_NAMES).
//
// Unknown/unparseable trailer types (nav_file.js's parseNav stops cleanly on
// an unrecognized numeric type, per its own contract) surface as a warning
// and a truncated points list — never a thrown exception and never a silent
// drop of the rest of the file's meaning.

import { parseNav, parseAfNavs, navPointToLeg, NavPointType, NavPointTypeToken, RECALL_SPELL_NAMES } from "./nav_file.js";
import { deriveRouteFlags } from "./route_flags.js";

const PORTAL_TYPES = new Set([NavPointType.PortalLegacy, NavPointType.Recall, NavPointType.PortalNPC]);

const NAV_ROUTE_TYPE_NAME = { 1: "circular", 2: "linear", 3: "follow", 4: "once" };

function tokenFor(type) {
  return NavPointTypeToken[type] || `unknown(${type})`;
}

// One nav point -> { leg, warning? }. `leg` always has {lb,x,y,z} (router leg
// frame, via navPointToLeg) plus optional label/meta/portal. Never throws —
// a point this function doesn't recognize still produces a leg (meta.navType
// records the raw numeric type) plus a warning, so the caller's route never
// silently loses a waypoint.
function pointToLeg(p, i) {
  const leg = navPointToLeg(p.ew || 0, p.ns || 0, p.z || 0);
  let warning = null;
  switch (p.type) {
    case NavPointType.Point:
      break;
    case NavPointType.PortalLegacy:
      leg.portal = true;
      leg.label = `portal:${(p.guid ?? 0) >>> 0}`;
      leg.meta = { navType: "prt", guid: (p.guid ?? 0) >>> 0 };
      break;
    case NavPointType.Recall: {
      const spellId = p.spellId ?? 0;
      const spellName = RECALL_SPELL_NAMES[spellId] || null;
      leg.portal = true;
      leg.label = `recall:${spellId}`;
      leg.meta = { navType: "rcl", spellId, spellName };
      // Route-level dependency notice (task: "importer emits a route-level
      // warning listing recall dependencies at import time") — one per rcl
      // record, collected into the caller's warnings[] alongside any real
      // parse anomalies; never blocks the import.
      warning = `leg ${i}: route depends on recall spell ${spellName ? `"${spellName}"` : `id ${spellId}`} — replay requires the character to know and successfully cast it`;
      break;
    }
    case NavPointType.Pause:
      leg.label = `pause:${p.pauseMs ?? 0}`;
      leg.meta = { navType: "pau", pauseMs: p.pauseMs ?? 0 };
      break;
    case NavPointType.Chat:
      leg.label = `chat ${p.chat || ""}`.trim();
      leg.meta = { navType: "cht", text: p.chat || "" };
      break;
    case NavPointType.OpenVendor:
      leg.label = `vendor ${p.name || ""}`.trim();
      leg.meta = { navType: "vnd", vendorId: (p.vendorId ?? 0) >>> 0, name: p.name || "" };
      break;
    case NavPointType.PortalNPC:
      leg.portal = true;
      leg.label = p.name ? `portal ${p.name}` : "portal";
      leg.meta = {
        navType: "ptl",
        objName: p.name || "",
        objectClass: p.objectClass ?? 0,
        isTie: !!p.isTie,
        // Object's OWN position (metaf _objx/_objy/_objz), world-frame
        // converted like the leg coordinate itself — see the header note
        // above. Distinct from the leg's {lb,x,y,z} (the approach point).
        objPos: navPointToLeg(p.exitEW ?? 0, p.exitNS ?? 0, p.exitZ ?? 0),
      };
      break;
    case NavPointType.Npc:
      leg.label = p.name ? `npc ${p.name}` : "npc";
      leg.meta = {
        navType: "tlk",
        objName: p.name || "",
        objectClass: p.objectClass ?? 0,
        isTie: !!p.isTie,
        objPos: navPointToLeg(p.exitEW ?? 0, p.exitNS ?? 0, p.exitZ ?? 0),
      };
      break;
    case NavPointType.Checkpoint:
      leg.meta = { navType: "chk" };
      break;
    case NavPointType.Jump: {
      leg.meta = { navType: "jmp", headingDeg: p.headingDeg ?? 0, holdShift: !!p.holdShift, delayMs: p.delayMs ?? 0 };
      leg.label = `jump:${p.headingDeg ?? 0}`;
      warning = `leg ${i}: Jump record (heading ${p.headingDeg ?? 0}°, delay ${p.delayMs ?? 0}ms) has no bot walk primitive — preserved as meta, replay may stall on this leg`;
      break;
    }
    default:
      leg.meta = { navType: tokenFor(p.type), rawType: p.type };
      warning = `leg ${i}: unrecognized nav point type ${p.type} — preserved as a plain leg with meta.navType, no semantic mapping applied`;
      break;
  }
  return { leg, warning };
}

/**
 * Convert a nav_file.js `parseNav`/`parseAfNavData`/`parseAfNavSection`-shaped
 * parsed structure ({ routeType, points, warning? }) into atlas legs + v2
 * flags + warnings. Pure — no atlas/IO. Returns { legs, portalsUsed,
 * warnings, navType }.
 */
export function parsedNavToLegs(parsed) {
  const warnings = [];
  if (parsed && parsed.warning) warnings.push(`parser: ${parsed.warning}`);
  const points = (parsed && parsed.points) || [];
  const rawLegs = [];
  for (let i = 0; i < points.length; i++) {
    const { leg, warning } = pointToLeg(points[i], i);
    if (warning) warnings.push(warning);
    rawLegs.push(leg);
  }
  // Ground-truth portal flags are already set on rawLegs (PORTAL_TYPES). Run
  // the SAME legacy derivation goto_compose.js's replay side uses (distance +
  // isEnvCellId) and UNION the two signals — a record the file didn't mark as
  // a portal but which is geometrically a teleport still gets caught, and a
  // ground-truth portal that happens to sit close to its neighbour (the
  // MatronHive "portal hub" pattern: several PortalNPC options recorded at the
  // same anchor point) is never lost to the distance heuristic missing it.
  const derived = deriveRouteFlags(rawLegs, undefined);
  const legs = derived.map((l, i) => {
    const out = { ...l };
    if (PORTAL_TYPES.has(points[i]?.type)) out.portal = true;
    return out;
  });
  const portalsUsed = legs.filter((l) => l.portal).length;
  const navType = NAV_ROUTE_TYPE_NAME[parsed?.routeType] || `unknown(${parsed?.routeType})`;
  return { legs, portalsUsed, warnings, navType };
}

/**
 * Build an atlas-shaped route object (NOT yet saved) from parsed legs.
 * Mirrors the shape RouteRecorder.finish()/nav_file.navToRoute() produce so
 * atlas.saveRoute() accepts it unchanged.
 */
function legsToRoute(legs, portalsUsed, { name, fileName, navType } = {}) {
  if (!legs.length) return null;
  const first = legs[0];
  const last = legs[legs.length - 1];
  return {
    fmt: 2, // legs already carry TRUSTED v2 flags (ground-truth + derived union) — see parsedNavToLegs
    name: name || null,
    from: { lb: first.lb, x: first.x, y: first.y, z: first.z },
    to: { lb: last.lb, x: last.x, y: last.y, z: last.z },
    legs,
    portalsUsed,
    source: "vtank-nav",
    navType,
    fileName: fileName || null,
    importedAt: Date.now(),
    recordedAt: Date.now(),
  };
}

/**
 * Import ONE plain-text ".nav" (uTank2 NAV 1.2) file's contents into a route.
 *
 *   const { route, warnings } = importNavText(text, { name: "holtburg-run" });
 *   atlas.saveRoute(route); // or pass {atlas} to do this in one call
 *
 * opts: { name, atlas, fileName }. If `atlas` is given (an Atlas instance),
 * the built route is saveRoute()'d and the RETURNED route is the saved one
 * (id/name filled in by the atlas); otherwise `route` is the bare, unsaved
 * route object (or null if the file yielded zero legs — never a throw).
 */
export function importNavText(text, { name, atlas, fileName } = {}) {
  const parsed = parseNav(text);
  const { legs, portalsUsed, warnings, navType } = parsedNavToLegs(parsed);
  let route = legsToRoute(legs, portalsUsed, { name, fileName, navType });
  if (route) route.provenance = { source: "vtank-nav", importedAt: route.importedAt, fileName: fileName || null };
  if (!route) warnings.push("no legs produced (empty or fully-unparsed file) — nothing to import");
  if (route && atlas) {
    try {
      route = atlas.saveRoute(route);
    } catch (e) {
      warnings.push(`atlas.saveRoute failed: ${e.message}`);
    }
  }
  return { route, warnings };
}

/**
 * Import an embedded ".af" file's NAV sections (metaf NAVDATA:/NAV: blocks —
 * parseAfNavs handles both forms). A single .af can carry multiple named
 * routes; each becomes its own atlas route. opts: { atlas, fileName,
 * namePrefix }. Returns { routes: [{ name, route, warnings }], warnings }
 * (top-level warnings cover the whole-file parse; per-route warnings are
 * nested).
 */
export function importAfText(text, { atlas, fileName, namePrefix } = {}) {
  const warnings = [];
  let navs = {};
  try {
    navs = parseAfNavs(text) || {};
  } catch (e) {
    warnings.push(`parseAfNavs failed: ${e.message}`);
    return { routes: [], warnings };
  }
  const names = Object.keys(navs);
  if (!names.length) warnings.push("no NAV:/NAVDATA: sections found in .af text");
  const routes = names.map((navName) => {
    const parsed = navs[navName];
    const { legs, portalsUsed, warnings: w, navType } = parsedNavToLegs(parsed);
    const routeName = namePrefix ? `${namePrefix}:${navName}` : navName;
    let route = legsToRoute(legs, portalsUsed, { name: routeName, fileName, navType });
    if (route) route.provenance = { source: "vtank-nav", importedAt: route.importedAt, fileName: fileName || null };
    if (!route) w.push(`section '${navName}': no legs produced`);
    if (route && atlas) {
      try {
        route = atlas.saveRoute(route);
      } catch (e) {
        w.push(`atlas.saveRoute failed: ${e.message}`);
      }
    }
    return { name: routeName, route, warnings: w };
  });
  return { routes, warnings };
}

export default { importNavText, importAfText, parsedNavToLegs };
