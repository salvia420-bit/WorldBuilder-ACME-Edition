// nav_file.js — VTank / uTank2 ".nav" (+ embedded ".af" NAV) interop for the
// route atlas (NavAtlas W2.4). A JS port of the FIXED upstream parser
// (rynthsuite NavRouteParser.cs, validated 934/934 real routes round-trip,
// Nav_DeepDive §0b) — the trailer TABLE + reader/writer, NOT NavigationEngine.
// Binary ".met" is explicitly OUT of scope (SPEC §5).
//
// This makes "the already-coded asset native": import player-authored VTank
// routes into the atlas as experience (SPEC §0 — community-authored nav files
// are player-tier knowledge), and export atlas routes back to ".nav" so humans
// can inspect/edit them in VTank tooling.
//
// ── Format (Nav_DeepDive §0b) ──────────────────────────────────────────────
// Header line "uTank2 NAV 1.2", then RouteType (Circular=1,Linear=2,Follow=3,
// Once=4), then point count. Each point: a 5-line prologue (Type, EW, NS, Z,
// flag) then a per-type trailer whose length is the SINGLE-SOURCE table below
// (the drift between reader and counter is what corrupted Portal routes
// pre-2026-06-15). EW/NS are /loc degrees, Z is raw/240 (see coord helpers).
//
// ── Coordinate conversion (verified this session) ──────────────────────────
// RynthAiCommands.cs:2598-2603 + observe.js: globalX=(EW*10+1019.5)*24,
// globalY=(NS*10+1019.5)*24, worldZ=navZ*240. Outdoor cell (lib.rs:14463):
// landblock_high | (cellX*8 + cellY + 1), cell=floor(local/24) clamp[0,7].
//
// ── Extended types (2026-07-20, nav_import corpus survey) ───────────────────
// PortalLegacy(1)/Checkpoint(8)/Jump(9) were previously "unknown" here (parse
// would abort past them, mid-route). Canonical field layouts cross-checked
// against the metaf project source (Navigation/NavNodes/{NPortal,NCheckpoint,
// NJump}.cs — the upstream NTypeID enum): PortalLegacy trailer=1 (guid, VTank
// deprecated in favor of PortalNPC/"ptl"), Checkpoint trailer=0 (same shape as
// Point — a script waypoint, not a coordinate-bearing node), Jump trailer=3
// (headingDeg, holdShift "True"/"False", delayMs). Real VTank corpus files
// (met-corpus/mudzereli-metaf-sample/{vr-bridge-jump,VRTreeJump500Rat}.nav) use
// both 8 and 9 — this is not theoretical.

export const NavRouteType = { Circular: 1, Linear: 2, Follow: 3, Once: 4 };
export const NavPointType = {
  Point: 0,
  PortalLegacy: 1, // deprecated in VTank ("prt" in .af token form); one coord + a guid
  Recall: 2,
  Pause: 3,
  Chat: 4,
  OpenVendor: 5,
  PortalNPC: 6,
  Npc: 7,
  Checkpoint: 8, // script waypoint, no trailer (metaf "chk")
  Jump: 9, // scripted forward-jump maneuver, not a teleport (metaf "jmp")
};

// NavPointType -> metaf's M_NTypeID token name (Core/Enums.cs), the canonical
// short name used in .af NAV: sections and good for compact route/leg
// annotations (nav_import.js meta.navType). Single source of truth so nothing
// downstream re-derives its own copy of this mapping.
export const NavPointTypeToken = {
  0: "pnt",
  1: "prt",
  2: "rcl",
  3: "pau",
  4: "cht",
  5: "vnd",
  6: "ptl",
  7: "tlk",
  8: "chk",
  9: "jmp",
};

// Recall spellID -> canonical display name (metaf Navigation/NavNodes/
// NRecall.cs `_recallSpells`, ~26 known values, 2026-07-20 nav_import corpus
// survey). nav_import.js's Recall('rcl') case uses this to stamp
// meta.spellName so an imported route's recall dependency is human-readable
// (import-time warning + replay-time cast-target naming) instead of a bare
// numeric id. Deliberately separate from recallNameToSpellId's (name->id)
// map below: that one is the .af NAVDATA text-token importer (a handful of
// common aliases), this one is the FULL retail table keyed the other way.
export const RECALL_SPELL_NAMES = {
  48: "Primary Portal Recall",
  2647: "Secondary Portal Recall",
  1635: "Lifestone Recall",
  1636: "Lifestone Sending",
  2645: "Portal Recall",
  2931: "Recall Aphus Lassel",
  2023: "Recall the Sanctuary",
  2943: "Recall to the Singularity Caul",
  3865: "Glenden Wood Recall",
  2041: "Aerlinthe Recall",
  2813: "Mount Lethe Recall",
  2941: "Ulgrim's Recall",
  4084: "Bur Recall",
  4198: "Paradox-touched Olthoi Infested Area Recall",
  4128: "Call of the Mhoire Forge",
  4213: "Colosseum Recall",
  5175: "Facility Hub Recall",
  5330: "Gear Knight Invasion Area Camp Recall",
  5541: "Lost City of Neftet Recall",
  4214: "Return to the Keep",
  6150: "Rynthid Recall",
  6321: "Viridian Rise Recall",
  6322: "Viridian Rise Great Tree Recall",
  6325: "Celestial Hand Stronghold Recall",
  6327: "Radiant Blood Stronghold Recall",
  6326: "Eldrytch Web Stronghold Recall",
};

const HEADER = "uTank2 NAV 1.2";

// Single source of truth: trailer lines AFTER the 5-line prologue, per type.
// Reader, writer, and any external counter share THIS table so they can't
// drift (the pre-2026-06-15 bug). Point(0)/Checkpoint(8)/unknown = 0.
export function trailerLineCount(type) {
  switch (type) {
    case NavPointType.PortalLegacy:
      return 1;
    case NavPointType.Recall:
    case NavPointType.Pause:
    case NavPointType.Chat:
      return 1;
    case NavPointType.OpenVendor:
      return 2;
    case NavPointType.PortalNPC:
    case NavPointType.Npc:
      return 6;
    case NavPointType.Checkpoint:
      return 0; // same shape as Point — explicit for documentation
    case NavPointType.Jump:
      return 3;
    default:
      return 0;
  }
}

export function isKnownType(t) {
  return t === 0 || t === 1 || t === 2 || t === 3 || t === 4 || t === 5 || t === 6 || t === 7 || t === 8 || t === 9;
}

// ── coordinate helpers ──────────────────────────────────────────────────────
export function degToWorld(ew, ns) {
  return { wx: (ew * 10 + 1019.5) * 24, wy: (ns * 10 + 1019.5) * 24 };
}
export function worldToDeg(wx, wy) {
  return { ew: (wx / 24 - 1019.5) / 10, ns: (wy / 24 - 1019.5) / 10 };
}
function outdoorCell(localX, localY) {
  const cx = Math.min(7, Math.max(0, Math.floor(localX / 24)));
  const cy = Math.min(7, Math.max(0, Math.floor(localY / 24)));
  return cx * 8 + cy + 1;
}
// AC's outdoor grid is 256x256 landblocks x 192m — world coords are bounded
// [0, MAP_SIZE_M). Exported so callers (nav_import.js sentinel/wraparound
// cleanup) can reason about the same bound without re-deriving 256*192.
export const MAP_SIZE_M = 256 * 192; // 49152
// (EW,NS deg, navZ) -> router leg frame {lb (full objCellId), x, y, z metres}
export function navPointToLeg(ew, ns, navZ) {
  const { wx, wy } = degToWorld(ew, ns);
  // Real corpus waypoints occasionally land a hair outside [0, MAP_SIZE_M) —
  // floating-point noise right at the map boundary (2026-07-21 nav_import
  // sentinel-cleanup survey: aerbax-south-gate.nav point 475, EW=-101.958914…
  // converts to wx=-2.14, a real recorded waypoint essentially AT the west
  // edge of the map, not actually off it). `Math.floor(wx/192) & 0xff` on a
  // negative landblock index WRAPS via JS's int32 bitwise coercion (floor(-2/
  // 192)=-1, -1&0xff=255) to landblock byte 255 — the OPPOSITE edge of the
  // map — producing a ~49,000m false "teleport" leg (corpus: aerbax-south-
  // gate leg 475, stone-of-rezarel-class wraparound). Clamping the WORLD
  // coordinate into range before deriving the landblock index turns that
  // boundary artifact into landblock 0/255 (whichever edge it actually is),
  // not a wrap to the far side — zero effect on any already-in-range
  // coordinate (every legitimate waypoint in the corpus).
  const cwx = Math.min(Math.max(wx, 0), MAP_SIZE_M - 1e-6);
  const cwy = Math.min(Math.max(wy, 0), MAP_SIZE_M - 1e-6);
  const lbX = Math.floor(cwx / 192) & 0xff;
  const lbY = Math.floor(cwy / 192) & 0xff;
  const localX = cwx - Math.floor(cwx / 192) * 192;
  const localY = cwy - Math.floor(cwy / 192) * 192;
  const lb = (((lbX << 24) | (lbY << 16) | outdoorCell(localX, localY)) >>> 0) >>> 0;
  return { lb, x: localX, y: localY, z: navZ * 240 };
}
// router leg frame -> (EW,NS deg, navZ)
export function legToNavPoint(lb, x, y, z) {
  const wx = ((lb >>> 24) & 0xff) * 192 + x;
  const wy = ((lb >>> 16) & 0xff) * 192 + y;
  const { ew, ns } = worldToDeg(wx, wy);
  return { ew, ns, navZ: z / 240 };
}

// ── .nav reader (port of NavRouteParser.LoadFromLines) ──────────────────────
// Returns { header, routeType, pointCount, points, eol, trailingEol, warning }.
// Each point preserves its exact source lines in `raw` so writeNav() can round-
// trip byte-for-byte; parsed numeric fields (ew/ns/z + trailer) are for
// conversion. A point past pointCount or an unknown type stops cleanly with a
// warning (never desyncs the rest of the file).
export function parseNav(text) {
  const eol = text.includes("\r\n") ? "\r\n" : text.includes("\r") ? "\r" : "\n";
  const trailingEol = /\r\n$|\r$|\n$/.test(text);
  const lines = text.split(/\r\n|\r|\n/);
  if (trailingEol && lines[lines.length - 1] === "") lines.pop(); // drop split artifact
  const out = {
    header: lines[0] || "",
    routeType: 0,
    routeTypeLine: null,
    pointCount: 0,
    pointCountLine: null,
    points: [],
    eol,
    trailingEol,
    warning: null,
    tail: [],
  };
  if (lines.length < 3 || !(lines[0] || "").toLowerCase().includes(HEADER.toLowerCase())) {
    out.warning = "not a uTank2 NAV 1.2 file";
    return out;
  }
  const rt = parseInt(lines[1], 10);
  const pc = parseInt(lines[2], 10);
  if (!Number.isFinite(rt) || !Number.isFinite(pc)) {
    out.warning = "malformed header (route-type / point-count not integers)";
    return out;
  }
  out.routeType = rt;
  out.routeTypeLine = lines[1];
  out.pointCountLine = lines[2];
  out.pointCount = pc;
  let idx = 3;
  for (let i = 0; i < pc && idx < lines.length; i++) {
    const start = idx;
    try {
      const typeRaw = parseInt(lines[idx], 10);
      if (!isKnownType(typeRaw)) {
        out.warning = `unknown waypoint type ${lines[idx]} at point ${i + 1} (line ${start}); stopped (${out.points.length} pts)`;
        break;
      }
      const p = { type: typeRaw, raw: [] };
      const take = () => {
        p.raw.push(lines[idx]);
        return lines[idx++];
      };
      take(); // type
      p.ew = parseFloat(take());
      p.ns = parseFloat(take());
      p.z = parseFloat(take());
      p.flag = take(); // skipped flag/colour line (preserved raw)
      switch (typeRaw) {
        case NavPointType.PortalLegacy:
          p.guid = parseInt(take(), 10) >>> 0;
          break;
        case NavPointType.Recall:
          p.spellId = parseInt(take(), 10);
          break;
        case NavPointType.Pause:
          p.pauseMs = parseInt(take(), 10);
          break;
        case NavPointType.Chat:
          p.chat = take();
          break;
        case NavPointType.OpenVendor:
          p.vendorId = parseInt(take(), 10) >>> 0;
          p.name = take();
          break;
        case NavPointType.PortalNPC:
        case NavPointType.Npc:
          p.name = take();
          p.objectClass = parseInt(take(), 10);
          p.isTie = parseTie(take());
          p.exitEW = parseFloat(take());
          p.exitNS = parseFloat(take());
          p.exitZ = parseFloat(take());
          break;
        case NavPointType.Jump:
          p.headingDeg = parseFloat(take());
          p.holdShift = parseTie(take());
          p.delayMs = parseFloat(take());
          break;
        default:
          break; // Point(0)/Checkpoint(8): no trailer
      }
      out.points.push(p);
    } catch (e) {
      out.warning = `parse error at point ${i + 1} (line ${start}): ${e.message}; stopped (${out.points.length} pts)`;
      break;
    }
  }
  // Preserve any lines after the last consumed point (real VTank files can
  // carry trailing blank lines) so writeNav round-trips byte-for-byte.
  out.tail = lines.slice(idx);
  return out;
}

function parseTie(s) {
  if (s == null) return false;
  const t = String(s).trim().toLowerCase();
  return t === "true" || t === "1";
}

// ── .nav writer (port of NavRouteParser.Save) ───────────────────────────────
// If points carry their `raw` source lines (from parseNav), they are emitted
// verbatim for a byte-stable round-trip; otherwise fields are formatted fresh
// (atlas -> .nav export). eol/trailingEol default to CRLF + trailing (VTank).
export function writeNav(parsed) {
  const eol = parsed.eol || "\r\n";
  const trailingEol = parsed.trailingEol !== false;
  const lines = [];
  lines.push(parsed.header || HEADER);
  lines.push(parsed.routeTypeLine != null ? parsed.routeTypeLine : String(parsed.routeType ?? NavRouteType.Linear));
  lines.push(parsed.pointCountLine != null ? parsed.pointCountLine : String(parsed.points.length));
  for (const p of parsed.points) {
    if (p.raw && p.raw.length) {
      for (const l of p.raw) lines.push(l);
      continue;
    }
    lines.push(String(p.type));
    lines.push(fmt(p.ew));
    lines.push(fmt(p.ns));
    lines.push(fmt(p.z));
    lines.push(p.flag != null ? String(p.flag) : "0");
    switch (p.type) {
      case NavPointType.PortalLegacy:
        lines.push(String((p.guid ?? 0) >>> 0));
        break;
      case NavPointType.Recall:
        lines.push(String(p.spellId ?? 0));
        break;
      case NavPointType.Pause:
        lines.push(String(p.pauseMs ?? 0));
        break;
      case NavPointType.Chat:
        lines.push(p.chat ?? "");
        break;
      case NavPointType.OpenVendor:
        lines.push(String((p.vendorId ?? 0) >>> 0));
        lines.push(p.name ?? "");
        break;
      case NavPointType.PortalNPC:
      case NavPointType.Npc:
        lines.push(p.name ?? "");
        lines.push(String(p.objectClass ?? 0));
        lines.push(p.isTie ? "True" : "False");
        lines.push(fmt(p.exitEW ?? 0));
        lines.push(fmt(p.exitNS ?? 0));
        lines.push(fmt(p.exitZ ?? 0));
        break;
      case NavPointType.Jump:
        lines.push(fmt(p.headingDeg ?? 0));
        lines.push(p.holdShift ? "True" : "False");
        lines.push(fmt(p.delayMs ?? 0));
        break;
      default:
        break; // Point(0)/Checkpoint(8): no trailer
    }
  }
  if (parsed.tail && parsed.tail.length) for (const l of parsed.tail) lines.push(l);
  return lines.join(eol) + (trailingEol ? eol : "");
}

function fmt(n) {
  // Shortest round-trippable JS representation (matches invariant-culture
  // doubles closely enough for fresh atlas exports; raw preservation covers
  // the byte-stable import path).
  return String(n);
}

// ── .nav <-> atlas route ────────────────────────────────────────────────────
// Import: parsed nav -> atlas route. Every point becomes a leg (coords via
// navPointToLeg); Recall/PortalNPC -> portal legs (teleport), OpenVendor/Npc/
// Chat -> labelled legs (vendor dwell etc.), Pause -> a labelled dwell leg.
export function navToRoute(parsed, { name } = {}) {
  const legs = [];
  for (const p of parsed.points) {
    const leg = navPointToLeg(p.ew || 0, p.ns || 0, p.z || 0);
    switch (p.type) {
      case NavPointType.PortalLegacy:
        leg.portal = true;
        leg.label = `portal:${(p.guid ?? 0) >>> 0}`;
        break;
      case NavPointType.Recall:
        leg.portal = true;
        leg.label = `recall:${p.spellId ?? 0}`;
        break;
      case NavPointType.PortalNPC:
        leg.portal = true;
        leg.label = p.name ? `portal ${p.name}` : "portal";
        break;
      case NavPointType.Npc:
        leg.label = p.name ? `npc ${p.name}` : "npc";
        break;
      case NavPointType.OpenVendor:
        leg.label = `vendor ${p.name || ""}`.trim();
        break;
      case NavPointType.Chat:
        leg.label = `chat ${p.chat || ""}`.trim();
        break;
      case NavPointType.Pause:
        leg.label = `pause:${p.pauseMs ?? 0}`;
        break;
      case NavPointType.Jump:
        leg.label = `jump:${p.headingDeg ?? 0}`;
        break;
      default:
        break; // Point / Checkpoint
    }
    legs.push(leg);
  }
  if (!legs.length) return null;
  const first = legs[0];
  const last = legs[legs.length - 1];
  return {
    name: name || null,
    from: { lb: first.lb, x: first.x, y: first.y, z: first.z },
    to: { lb: last.lb, x: last.x, y: last.y, z: last.z },
    legs,
    portalsUsed: legs.filter((l) => l.portal).length,
    source: "import-nav",
    recordedAt: Date.now(),
  };
}

// Export: atlas route -> parsed nav (feed to writeNav). Portal legs -> a
// PortalNPC waypoint (name from label); vendor-labelled legs -> OpenVendor;
// everything else -> a plain Point. RouteType defaults Linear.
// Recorded-format v2 route/leg flags (`fmt`, per-leg `indoor`) have NO .nav
// representation and are intentionally DROPPED here: this reads only lb/x/y/z +
// portal/label, so a v2 route exports byte-identically to the same route without
// those flags (the VTank .nav byte-stable acceptance is unaffected).
export function routeToNav(route, { routeType = NavRouteType.Linear } = {}) {
  const points = (route.legs || []).map((l) => {
    const { ew, ns, navZ } = legToNavPoint(l.lb, l.x, l.y, l.z);
    const label = l.label || "";
    if (l.portal) {
      return { type: NavPointType.PortalNPC, ew, ns, z: navZ, flag: "0", name: label.replace(/^portal\s*/i, "") || "Portal", objectClass: 14, isTie: false, exitEW: 0, exitNS: 0, exitZ: 0 };
    }
    if (/^vendor/i.test(label)) {
      return { type: NavPointType.OpenVendor, ew, ns, z: navZ, flag: "0", vendorId: 0, name: label.replace(/^vendor\s*/i, "") };
    }
    return { type: NavPointType.Point, ew, ns, z: navZ, flag: "0" };
  });
  return { header: HEADER, routeType, points, eol: "\r\n", trailingEol: true };
}

// ── embedded .af NAV extraction (subset: NAVDATA + NAV:) ─────────────────────
// Extracts nav routes from a metaf .af file WITHOUT parsing the STATE/IF/DO
// meta engine. Two forms (AfFileParser.cs): a count-prefixed `NAVDATA: <name>
// <count> ~~ {` block of verbatim uTank2 nav lines, and a token `NAV: <name>
// <type> ~~ {` section. Returns { [name]: parsedNav }.
export function parseAfNavs(text) {
  const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
  const out = {};
  let i = 0;
  while (i < lines.length) {
    const t = lines[i].trimStart();
    if (t.startsWith("NAVDATA:")) {
      i = parseAfNavData(lines, i, out);
    } else if (t.startsWith("NAV:")) {
      i = parseAfNavSection(lines, i, out);
    } else {
      i++;
    }
  }
  return out;
}

function stripComment(s) {
  const c = s.indexOf("~~");
  return c >= 0 ? s.slice(0, c).trimEnd() : s;
}

function parseAfNavData(lines, idx, out) {
  let body = stripComment(lines[idx].trimStart().slice("NAVDATA:".length)).trim();
  const sp = body.lastIndexOf(" ");
  const name = sp > 0 ? body.slice(0, sp).trim() : body;
  const count = sp > 0 ? parseInt(body.slice(sp + 1), 10) || 0 : 0;
  idx++;
  const navLines = [];
  for (let k = 0; k < count && idx < lines.length; k++) navLines.push(lines[idx++]);
  if (idx < lines.length && lines[idx].trim() === "~~ }") idx++;
  if (name && navLines.length >= 3) out[name] = parseNav(navLines.join("\r\n") + "\r\n");
  return idx;
}

// Token NAV: section -> synthesized .nav (ported from AfFileParser.ParseNavSection,
// common tokens). Produces a parsed structure (writeNav-able, navToRoute-able).
function parseAfNavSection(lines, idx, out) {
  const after = stripComment(lines[idx].trimStart().slice("NAV:".length)).trim();
  const parts = after.split(/\s+/).filter(Boolean);
  const navName = parts[0] || "";
  const navType = (parts[1] || "circular").toLowerCase();
  const routeType = { circular: 1, linear: 2, follow: 3, once: 4 }[navType] || 1;
  idx++;
  const pointLines = [];
  while (idx < lines.length) {
    const t = lines[idx].trimStart();
    if (t === "~~ }" || t.startsWith("STATE:") || t.startsWith("NAV:")) {
      if (t === "~~ }") idx++;
      break;
    }
    if (t && !t.startsWith("~~")) pointLines.push(t);
    idx++;
  }
  const points = [];
  for (const line of pointLines) {
    const tok = splitNavTokens(line);
    if (!tok.length) continue;
    const num = (s) => parseFloat(s);
    switch (tok[0]) {
      case "pnt":
        if (tok.length >= 4) points.push({ type: 0, ew: num(tok[1]), ns: num(tok[2]), z: num(tok[3]), flag: "0" });
        break;
      case "rcl":
        if (tok.length >= 4) points.push({ type: 2, ew: num(tok[1]), ns: num(tok[2]), z: num(tok[3]), flag: "0", spellId: recallNameToSpellId(tok[4] || "") });
        break;
      case "pau": // metaf NPause.ImportFromMetAF: "pau myx myy myz PauseInMilliseconds"
        // (2026-07-21 nav_import sentinel-cleanup survey) FIXED a real bug
        // here: this used to hardcode ew:0,ns:0,z:0 and read tok[1] (the
        // x-coordinate!) as pauseMs*1000 — the real corpus (BGAugGem0.af)
        // carries genuine non-zero pau coordinates the old code silently
        // discarded, producing a fake (24468,24468) "teleport" leg on
        // import. Real format per metaf source is 4 numeric args.
        if (tok.length >= 5) points.push({ type: 3, ew: num(tok[1]), ns: num(tok[2]), z: num(tok[3]), flag: "0", pauseMs: Math.round(num(tok[4]) || 0) });
        break;
      case "cht":
        if (tok.length >= 5) points.push({ type: 4, ew: num(tok[1]), ns: num(tok[2]), z: num(tok[3]), flag: "0", chat: tok[4] });
        break;
      case "ptl":
        if (tok.length >= 8) points.push({ type: 6, ew: num(tok[1]), ns: num(tok[2]), z: num(tok[3]), flag: "0", name: tok.length >= 9 ? tok[8] : tok[7], objectClass: parseInt(tok[7], 10) || 14, isTie: false, exitEW: num(tok[4]), exitNS: num(tok[5]), exitZ: num(tok[6]) });
        break;
      case "vnd":
        if (tok.length >= 5) points.push({ type: 6, ew: num(tok[1]), ns: num(tok[2]), z: num(tok[3]), flag: "0", name: tok.length >= 6 ? tok[5] : "Vendor", objectClass: 12, isTie: false, exitEW: 0, exitNS: 0, exitZ: 0 });
        break;
      case "tlk":
        if (tok.length >= 5) points.push({ type: 6, ew: num(tok[1]), ns: num(tok[2]), z: num(tok[3]), flag: "0", name: tok.length >= 6 ? tok[5] : "NPC", objectClass: 37, isTie: false, exitEW: 0, exitNS: 0, exitZ: 0 });
        break;
      case "chk": // metaf NCheckpoint.ImportFromMetAF: "chk x y z"
        if (tok.length >= 4) points.push({ type: 8, ew: num(tok[1]), ns: num(tok[2]), z: num(tok[3]), flag: "0" });
        break;
      case "jmp": // metaf NJump.ImportFromMetAF: "jmp x y z headingDeg {holdShift} delayMs"
        if (tok.length >= 7)
          points.push({
            type: 9,
            ew: num(tok[1]),
            ns: num(tok[2]),
            z: num(tok[3]),
            flag: "0",
            headingDeg: num(tok[4]),
            holdShift: tok[5] === "True",
            delayMs: num(tok[6]),
          });
        break;
      case "prt": // metaf NPortal.ImportFromMetAF (deprecated): "prt x y z guid"
        if (tok.length >= 5) points.push({ type: 1, ew: num(tok[1]), ns: num(tok[2]), z: num(tok[3]), flag: "0", guid: parseInt(tok[4], 10) || 0 });
        break;
      default:
        break; // flw: pseudo-node, no xyz (whole-nav "follow player" — not a waypoint)
    }
  }
  if (navName) out[navName] = { header: HEADER, routeType, points, eol: "\r\n", trailingEol: true };
  return idx;
}

// {brace groups} are single tokens (AfFileParser.SplitNavTokens port).
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

// Common recall names -> spell ids (AfFileParser.RecallNameToSpellId port).
function recallNameToSpellId(name) {
  const map = {
    "recall aphus lassel": 2931, "aphus lassel recall": 2931,
    "lifestone recall": 1635, lifestone: 1635, "lifestone sending": 1635, "lifestone tie": 1635,
    "primary portal recall": 48, "primary portal": 48,
    "secondary portal recall": 2647, "secondary portal": 2647,
    "portal recall": 2645,
    "recall the sanctuary": 2023, "sanctuary recall": 2023,
    "call of the mhoire forge": 4213, "mhoire forge": 4213,
    "glenden wood recall": 3865, "glenden wood": 3865,
    "aerlinthe recall": 2041, aerlinthe: 2041,
    "colosseum recall": 4084, colosseum: 4084,
    "facility hub recall": 5541, "facility hub": 5541,
    "gear knight recall": 5542, "gear knight": 5542,
    "neftet recall": 5543, neftet: 5543,
    "rynthid recall": 6321, rynthid: 6321,
    "viridian rise recall": 6322, "viridian rise": 6322,
  };
  return map[String(name).toLowerCase()] || 0;
}

export default { parseNav, writeNav, navToRoute, routeToNav, parseAfNavs, trailerLineCount, NavRouteType, NavPointType, NavPointTypeToken, RECALL_SPELL_NAMES };
