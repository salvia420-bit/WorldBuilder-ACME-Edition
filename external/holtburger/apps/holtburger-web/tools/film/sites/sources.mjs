// tools/film/sites/sources.mjs — film-mode SITE GAZETTEER: one loader per data source.
//
// WHY
// ---
// Film mode (`?filmMode=on`, DEFAULT OFF) lets a Claude Code director match lyrics and script beats to
// places in Dereth, then teleport the hidden player (the streaming dolly, SPEC §0) there before a take.
// The director needs an OFFLINE, searchable list of sites that each carry a ready teleport string. That
// list is joined from data files that already exist and were verified on 2026-10-13 (no WBT, no browser,
// no network, no ACE): Locations.txt, the @telepoi destinations, rynth's towns.js, the RetailSmoke
// town/region/POI gazetteers, the atlas_describe_v1 whole-world describe, the acpedia knowledge corpus,
// object-tags.json and (opt-in, `--spawns`) the 255 MB ACE spawn dump.
//
// WHAT
// ----
// One loader per source. Every loader returns NORMALISED rows, strips a UTF-8 BOM, and treats a
// missing or unreadable file as "no rows": it reports through the injected `log(msg)` and never throws,
// so a partial checkout still builds a partial gazetteer. The spawn dump is STREAMED line by line
// (readline) and never loaded whole. Pure helpers for AC coordinates (SPEC §1: wx = lbX·192 + localX,
// ns = wy/240 − 101.95), coordinate-text parsing, name keys and wikitext stripping are exported for
// build.mjs, search.mjs and the tests.
//
// Node-only (node:fs / node:readline). The page never imports this file.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { pathToFileURL } from "node:url";
import { worldToOutdoorCell } from "../../../rynth/nav_frame.js";

// ── AC frame (SPEC §1) ─────────────────────────────────────────────────────
export const LB_SIZE = 192;
export const CELL_SIZE = 24;
export const WORLD_SIZE_M = 256 * LB_SIZE;
const DEG_OFFSET = 101.95;
const M_PER_DEG = 240;

/** Map coordinates (E/N positive) of a world point. */
export function mapFromWorld(wx, wy) {
  return { ns: wy / M_PER_DEG - DEG_OFFSET, ew: wx / M_PER_DEG - DEG_OFFSET };
}
/** World metres [wx, wy] of a map coordinate. */
export function worldFromMap(ns, ew) {
  return [(ew + DEG_OFFSET) * M_PER_DEG, (ns + DEG_OFFSET) * M_PER_DEG];
}
export function isIndoorCell(cell) {
  return ((cell >>> 0) & 0xffff) >= 0x100;
}
/** 16-bit landblock number (0xXXYY) of a full cell id. */
export function lbOfCell(cell) {
  return (cell >>> 16) & 0xffff;
}
export function cellHex(cell) {
  return "0x" + (cell >>> 0).toString(16).toUpperCase().padStart(8, "0");
}
export function lbHex(lb) {
  return "0x" + lbHex4(lb);
}
export function lbHex4(lb) {
  return (lb & 0xffff).toString(16).toUpperCase().padStart(4, "0");
}
/** World metres of a cell-local point (the SPEC frame; for an EnvCell this is the dungeon frame). */
export function worldFromCellLocal(cell, x, y) {
  return [((cell >>> 24) & 0xff) * LB_SIZE + x, ((cell >>> 16) & 0xff) * LB_SIZE + y];
}
export function inWorld(wx, wy) {
  return Number.isFinite(wx) && Number.isFinite(wy) && wx >= 0 && wy >= 0 && wx < WORLD_SIZE_M && wy < WORLD_SIZE_M;
}
/** 16-bit landblock containing a world point (clamped to the 256×256 grid). */
export function lbOfWorld(wx, wy) {
  const x = Math.max(0, Math.min(255, Math.floor(wx / LB_SIZE)));
  const y = Math.max(0, Math.min(255, Math.floor(wy / LB_SIZE)));
  return (x << 8) | y;
}
/** Full outdoor cell id + LB-local x/y of a world point (rynth/nav_frame.js worldToOutdoorCell). */
export function outdoorCellOfWorld(wx, wy, z = 0) {
  const c = worldToOutdoorCell(wx, wy, z);
  return { cell: c.lb >>> 0, x: c.x, y: c.y, z: c.z };
}
/** "42.1N 33.6E". */
export function formatMap(ns, ew, dp = 1) {
  const n = Number(ns), e = Number(ew);
  return `${Math.abs(n).toFixed(dp)}${n < 0 ? "S" : "N"} ${Math.abs(e).toFixed(dp)}${e < 0 ? "W" : "E"}`;
}
/** Compass heading (degrees clockwise from north, [0,360)) of an @teleloc quaternion (qw=cos θ/2, qz=−sin θ/2). */
export function headingDegFromQuat(q) {
  if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)) return null;
  const theta = -2 * Math.atan2(q[3], q[0]);
  let deg = (theta * 180) / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return Math.round(deg * 10) / 10;
}

// ── text helpers ───────────────────────────────────────────────────────────
export function stripBom(s) {
  return typeof s === "string" && s.charCodeAt(0) === 0xfeff ? s.slice(1) : s;
}
export function foldText(s) {
  return String(s ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
}
/** Identity key of a place name: case/diacritic/punctuation/space-free, leading "the" dropped. */
export function compactKey(name) {
  return foldText(name).toLowerCase().trim().replace(/^the\s+/, "").replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, "");
}
const NAME_STOP = new Set(["the", "of", "a", "an", "to", "and", "in", "at", "on"]);
/** Lower-case word tokens of a place name (apostrophes dropped, a few stop words removed). */
export function nameTokens(name) {
  return foldText(name).toLowerCase().replace(/['’`]/g, "").split(/[^a-z0-9]+/).filter((t) => t && !NAME_STOP.has(t));
}
export function slugify(s) {
  return foldText(s).toLowerCase().replace(/['’`]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "site";
}

const COORD_NUM = String.raw`(\d{1,3}(?:\.\d+)?)`;
const COORD_RE = new RegExp(COORD_NUM + String.raw`\s*([NS])[\s.,;/]*` + COORD_NUM + String.raw`\s*([EW])`, "i");
const TITLE_COORD_RE = new RegExp(
  "^" + COORD_NUM + String.raw`\s*([NS])\s*[,.]?\s*` + COORD_NUM + String.raw`\s*([EW])\s*[-–—:]+\s*(.+)$`,
  "i",
);
function coordsFrom(m, iNs, iNsDir, iEw, iEwDir) {
  const ns = Number(m[iNs]) * (m[iNsDir].toUpperCase() === "S" ? -1 : 1);
  const ew = Number(m[iEw]) * (m[iEwDir].toUpperCase() === "W" ? -1 : 1);
  const [wx, wy] = worldFromMap(ns, ew);
  return inWorld(wx, wy) ? { ns, ew } : null;
}
/** First "42.1N, 33.6E"-style coordinate in a text, or null. */
export function parseCoordText(text) {
  const m = COORD_RE.exec(String(text ?? ""));
  return m ? coordsFrom(m, 1, 2, 3, 4) : null;
}
/** "31.7N, 27.9E - Road Block" → {ns, ew, rest:"Road Block"}; null when the title has no coordinate prefix. */
export function parseTitleCoords(title) {
  const m = TITLE_COORD_RE.exec(String(title ?? "").trim());
  if (!m) return null;
  const c = coordsFrom(m, 1, 2, 3, 4);
  return c ? { ...c, rest: m[5].trim() } : null;
}
/** Text after "Coordinates:" (acpedia infobox), parsed; null for "Random", "See …", etc. */
export function parseInfoboxCoords(text) {
  const i = String(text ?? "").indexOf("Coordinates:");
  if (i < 0) return null;
  return parseCoordText(String(text).slice(i + 12, i + 60));
}

/**
 * Strip MediaWiki markup to plain prose: headings (with their text), templates, tables, links, HTML,
 * bold/italic quotes, magic words, list markers, Category:/Image: references. Returns "" when nothing
 * readable is left (fewer than 12 characters or no letters).
 */
export function stripWikitext(src) {
  if (src == null) return "";
  let t = String(src);
  t = t.replace(/<!--[\s\S]*?-->/g, " ");
  for (let i = 0; i < 4 && /\{\{[^{}]*\}\}/.test(t); i++) t = t.replace(/\{\{[^{}]*\}\}/g, " ");
  t = t.replace(/\{\|[\s\S]*?(?:\|\}|$)/g, " ");
  t = t.replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, "$1");
  t = t.replace(/\[(?:https?:)?\/\/\S+\s*([^\]]*)\]/g, "$1");
  t = t.replace(/={2,}[^=\n]*={2,}/g, " ");
  t = t.replace(/<br\s*\/?>/gi, " ");
  t = t.replace(/<\/?[a-z][^>]*>/gi, " ");
  t = t.replace(/'{2,}/g, "");
  t = t.replace(/__[A-Z]+__/g, " ");
  t = t.replace(/\b(?:Image|File):.*?\.(?:png|jpe?g|gif|svg|bmp)\b/gi, " ");
  t = t.replace(/\bCategory:[\s\S]*$/i, " ");
  t = t.replace(/\{\{|\}\}|\{\||\|\}/g, " ");
  t = t.replace(/(^|\s)[:*#;]+(?=\s|$)/g, " ");
  t = t.replace(/\s*\|\s*/g, " ");
  t = t.replace(/\s+/g, " ").trim();
  t = t.replace(/^[\s:;,.\-–—]+/, "").trim();
  if (t.length < 12 || !/[A-Za-z]{3}/.test(t)) return "";
  return t;
}

// ── file access (never throws) ─────────────────────────────────────────────
function say(log, msg) {
  if (typeof log === "function") log(msg);
}
export function readTextSafe(file, label, log) {
  if (!file) {
    say(log, `[sites] ${label}: no path configured — source skipped`);
    return null;
  }
  try {
    return stripBom(fs.readFileSync(file, "utf8"));
  } catch (e) {
    say(log, `[sites] ${label}: cannot read ${file} (${e.code || e.message}) — source skipped`);
    return null;
  }
}
export function readJsonSafe(file, label, log) {
  const text = readTextSafe(file, label, log);
  if (text == null) return null;
  try {
    return JSON.parse(text);
  } catch (e) {
    say(log, `[sites] ${label}: ${file} is not valid JSON (${e.message}) — source skipped`);
    return null;
  }
}
function finiteAll(...v) {
  return v.every((n) => Number.isFinite(n));
}

// ── Locations.txt — "Name | Type | 0xCELLID [x y z] qw qx qy qz" ─────────
const LOC_NUM = String.raw`([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)`;
const LOC_RE = new RegExp(
  String.raw`^(.+?)\s*\|\s*([A-Za-z]+)\s*\|\s*0x([0-9a-fA-F]{1,8})\s*\[?\s*` +
    LOC_NUM + String.raw`[\s,]+` + LOC_NUM + String.raw`[\s,]+` + LOC_NUM + String.raw`\s*\]?\s*` +
    LOC_NUM + String.raw`\s+` + LOC_NUM + String.raw`\s+` + LOC_NUM + String.raw`\s+` + LOC_NUM + String.raw`\s*$`,
);
/** Parse Locations.txt text (ACViewer location DB). Brackets around xyz are optional (one real row has none). */
export function parseLocationsText(text, { log } = {}) {
  const rows = [];
  let bad = 0;
  const lines = String(stripBom(text ?? "")).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith("#")) continue;
    const m = LOC_RE.exec(line);
    if (!m) {
      bad++;
      continue;
    }
    const cell = parseInt(m[3], 16) >>> 0;
    const n = m.slice(4, 11).map(Number);
    if (!finiteAll(...n)) {
      bad++;
      continue;
    }
    rows.push({
      source: "locations",
      line: i + 1,
      name: m[1].trim(),
      type: m[2],
      cell,
      lb: lbOfCell(cell),
      indoor: isIndoorCell(cell),
      local: { x: n[0], y: n[1], z: n[2] },
      quat: [n[3], n[4], n[5], n[6]],
    });
  }
  if (bad) say(log, `[sites] locations: ${bad} unparseable line(s) skipped`);
  return rows;
}
export function loadLocations(file, { log } = {}) {
  const text = readTextSafe(file, "locations", log);
  return text == null ? [] : parseLocationsText(text, { log });
}

// ── poi-destinations.json — the 62 @telepoi names ─────────────────────────
export function loadPoiDestinations(file, { log } = {}) {
  const data = readJsonSafe(file, "poi-destinations", log);
  if (data == null) return [];
  if (!Array.isArray(data)) {
    say(log, "[sites] poi-destinations: expected a JSON array — source skipped");
    return [];
  }
  const rows = [];
  for (const r of data) {
    if (!r || typeof r.name !== "string" || !r.name.trim()) continue;
    let cell = Number.isFinite(r.cell) ? r.cell >>> 0 : parseInt(String(r.cellHex ?? "").replace(/^0x/i, ""), 16) >>> 0;
    const x = Number(r.x), y = Number(r.y), z = Number(r.z);
    const q = [Number(r.qw), Number(r.qx), Number(r.qy), Number(r.qz)];
    if (!cell || !finiteAll(x, y, z)) continue;
    rows.push({
      source: "poi-destinations",
      name: r.name.trim(),
      cell,
      lb: lbOfCell(cell),
      indoor: isIndoorCell(cell),
      local: { x, y, z },
      quat: finiteAll(...q) ? q : null,
    });
  }
  return rows;
}

// ── towns.js — export const TOWNS = [{name, ns, ew}] ──────────────────────
const TOWN_ROW_RE = /\{\s*name:\s*(["'])((?:\\.|(?!\1).)*)\1\s*,\s*ns:\s*([-+]?\d+(?:\.\d+)?)\s*,\s*ew:\s*([-+]?\d+(?:\.\d+)?)\s*\}/g;
function normTowns(arr) {
  const out = [];
  for (const t of arr) {
    const name = String(t?.name ?? "").trim();
    const ns = Number(t?.ns), ew = Number(t?.ew);
    if (name && finiteAll(ns, ew)) out.push({ source: "towns.js", name, ns, ew });
  }
  return out;
}
/**
 * towns.js rows. `src` is the module path (parsed as TEXT first — a data file is not executed unless the
 * text form is unrecognisable, then it is imported) or an already-imported TOWNS array.
 */
export async function loadTowns(src, { log } = {}) {
  if (Array.isArray(src)) return normTowns(src);
  const text = readTextSafe(src, "towns", log);
  if (text == null) return [];
  const parsed = [];
  for (const m of text.matchAll(TOWN_ROW_RE)) parsed.push({ name: m[2].replace(/\\(.)/g, "$1"), ns: Number(m[3]), ew: Number(m[4]) });
  if (parsed.length) return normTowns(parsed);
  try {
    const mod = await import(pathToFileURL(path.resolve(src)).href);
    const arr = mod.TOWNS ?? mod.default;
    if (Array.isArray(arr)) return normTowns(arr);
  } catch (e) {
    say(log, `[sites] towns: cannot import ${src} (${e.message}) — source skipped`);
    return [];
  }
  say(log, `[sites] towns: no TOWNS rows found in ${src} — source skipped`);
  return [];
}

// ── town_gazetteer.json — {name: {lb_key, lb_hex, culture, notes, …}} ──────
/** "Old Yanshi (dungeon)" → "Old Yanshi". */
export function cleanTownName(name) {
  return String(name ?? "").replace(/\s*\((?:dungeon|town|area|settlement|village)\)\s*$/i, "").trim();
}
export function loadTownGazetteer(file, { log } = {}) {
  const data = readJsonSafe(file, "town-gazetteer", log);
  if (data == null) return [];
  if (typeof data !== "object" || Array.isArray(data)) {
    say(log, "[sites] town-gazetteer: expected a JSON object — source skipped");
    return [];
  }
  const rows = [];
  for (const [rawName, v] of Object.entries(data)) {
    const name = cleanTownName(rawName);
    if (!name) continue;
    let lb = Number.isInteger(v?.lb_key) ? v.lb_key : null;
    if (lb == null && typeof v?.lb_hex === "string") {
      const p = parseInt(v.lb_hex.replace(/^0x/i, ""), 16);
      lb = Number.isInteger(p) ? p : null;
    }
    rows.push({
      source: "town-gazetteer",
      name,
      rawName,
      lb: lb != null && lb >= 0 && lb <= 0xffff ? lb : null,
      culture: typeof v?.culture === "string" && v.culture ? v.culture : null,
      notes: typeof v?.notes === "string" ? v.notes.trim() : "",
      provenance: v?.source ?? null,
    });
  }
  return rows;
}

// ── region_gazetteer.json — {regions, town_to_region, town_anchors} ────────
export function loadRegionGazetteer(file, { log } = {}) {
  const empty = { regions: [], townToRegion: new Map(), anchors: [] };
  const data = readJsonSafe(file, "region-gazetteer", log);
  if (data == null) return empty;
  if (typeof data !== "object" || Array.isArray(data)) {
    say(log, "[sites] region-gazetteer: expected a JSON object — source skipped");
    return empty;
  }
  const regions = [];
  for (const [name, v] of Object.entries(data.regions ?? {})) {
    regions.push({
      name,
      culture: typeof v?.culture === "string" ? v.culture : null,
      biome: typeof v?.biome === "string" ? v.biome : null,
      description: typeof v?.description === "string" ? v.description.trim() : "",
    });
  }
  const townToRegion = new Map();
  for (const [town, region] of Object.entries(data.town_to_region ?? {})) {
    if (typeof region === "string") townToRegion.set(compactKey(cleanTownName(town)), region);
  }
  const anchors = [];
  for (const a of Array.isArray(data.town_anchors) ? data.town_anchors : []) {
    if (a && typeof a.name === "string" && Number.isInteger(a.lb_x) && Number.isInteger(a.lb_y)) {
      anchors.push({ name: cleanTownName(a.name), lbX: a.lb_x, lbY: a.lb_y, region: a.region ?? null });
    }
  }
  return { regions, townToRegion, anchors };
}

// ── poi_gazetteer.json — {"0xLLLL": [{title, lat, lat_dir, lng, lng_dir, categories, description}]} ─
export const PLACE_CATEGORIES = Object.freeze([
  "Town", "Major POI", "Minor POI", "Geographic Area", "Dungeon", "Historical Site", "Settlement", "Location", "Landmark",
]);
const PLACE_SET = new Set(PLACE_CATEGORIES);
/** List/meta pages that carry place categories but are not one place. */
const META_TITLES = new Set([
  "dungeons", "locations", "monster camps", "rock formations", "points of interest", "towns", "meeting hall",
  "festival grounds", "point of interest",
]);
/** "Tou-Tou/Archive" → "Tou-Tou"; "Hoshino Fortress (area)" → "Hoshino Fortress". */
export function cleanPoiName(name) {
  return String(name ?? "")
    .replace(/\/(?:archive|old|retired)$/i, "")
    .replace(/\s*\((?:area|settlement|location|landmark)\)\s*$/i, "")
    .trim();
}
function poiRowCoords(r) {
  const lat = Number(r?.lat), lng = Number(r?.lng);
  if (!finiteAll(lat, lng)) return null;
  const ns = lat * (String(r.lat_dir).toUpperCase() === "S" ? -1 : 1);
  const ew = lng * (String(r.lng_dir).toUpperCase() === "W" ? -1 : 1);
  const [wx, wy] = worldFromMap(ns, ew);
  return inWorld(wx, wy) ? { ns, ew } : null;
}
/**
 * Place-like POIs only (PLACE_CATEGORIES), de-duplicated by title. The coordinate comes from a
 * "NN.NN, EE.EE - Name" title prefix when present (the field lat/lng are often parsed from the body and
 * wrong), otherwise the most frequent field pair across the title's rows; the landblock is recomputed
 * from that coordinate (never taken from the dict key). Descriptions are wikitext-stripped.
 */
export function loadPoiGazetteer(file, { log } = {}) {
  const data = readJsonSafe(file, "poi-gazetteer", log);
  if (data == null) return [];
  if (typeof data !== "object" || Array.isArray(data)) {
    say(log, "[sites] poi-gazetteer: expected a JSON object — source skipped");
    return [];
  }
  const groups = new Map();
  for (const list of Object.values(data)) {
    if (!Array.isArray(list)) continue;
    for (const r of list) {
      const cats = Array.isArray(r?.categories) ? r.categories.filter((c) => typeof c === "string") : [];
      if (!cats.some((c) => PLACE_SET.has(c))) continue;
      const title = String(r?.title ?? "").trim();
      if (!title || /template/i.test(title) || cats.includes("Page Template") || cats.includes("Disambiguation")) continue;
      let g = groups.get(title);
      if (!g) groups.set(title, (g = { title, rows: [] }));
      g.rows.push({ coords: poiRowCoords(r), categories: cats, description: stripWikitext(r.description) });
    }
  }
  const out = [];
  for (const g of groups.values()) {
    const tc = parseTitleCoords(g.title);
    const name = cleanPoiName(tc ? tc.rest : g.title);
    if (!name || META_TITLES.has(name.toLowerCase())) continue;
    let coords = tc ? { ns: tc.ns, ew: tc.ew } : null;
    let coordSource = tc ? "title" : "fields";
    if (!coords) {
      const tally = new Map();
      for (const r of g.rows) {
        if (!r.coords) continue;
        const k = `${r.coords.ns.toFixed(1)},${r.coords.ew.toFixed(1)}`;
        const e = tally.get(k);
        if (e) e.n++;
        else tally.set(k, { n: 1, coords: r.coords });
      }
      let best = null;
      for (const e of tally.values()) if (!best || e.n > best.n) best = e;
      coords = best ? best.coords : null;
    }
    if (!coords) continue;
    const categories = [...new Set(g.rows.flatMap((r) => r.categories))].sort();
    const description = g.rows.map((r) => r.description).reduce((a, b) => (b.length > a.length ? b : a), "");
    const [wx, wy] = worldFromMap(coords.ns, coords.ew);
    out.push({
      source: "poi-gazetteer",
      title: g.title,
      name,
      ns: coords.ns,
      ew: coords.ew,
      lb: lbOfWorld(wx, wy),
      categories,
      description,
      coordSource,
      variants: g.rows.length,
    });
  }
  out.sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : 0));
  return out;
}

// ── atlas_describe_v1.jsonl — one compact Living-Atlas describe per landblock ─
/**
 * Map<lb16, AtlasRow>. AtlasRow = {lb, lbX, lbY, region, biome, hasRoad, settlementHint, architecture,
 * structureCount, terrain:[{type, name, share}], townName, culture, notes, roofs:{shape:count}, maxStories}.
 * knownPois are dropped (they duplicate poi_gazetteer).
 */
export function parseAtlasText(text, { log } = {}) {
  const map = new Map();
  let bad = 0;
  for (const line of String(stripBom(text ?? "")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    let d;
    try {
      d = JSON.parse(stripBom(line));
    } catch {
      bad++;
      continue;
    }
    const lbX = d?.lbX, lbY = d?.lbY;
    if (!Number.isInteger(lbX) || !Number.isInteger(lbY) || lbX < 0 || lbX > 255 || lbY < 0 || lbY > 255) {
      bad++;
      continue;
    }
    const c = d.context ?? {};
    const roofs = {};
    let maxStories = 0;
    for (const s of Array.isArray(d.body_structures) ? d.body_structures : []) {
      if (s?.roofShape) roofs[s.roofShape] = (roofs[s.roofShape] ?? 0) + 1;
      if (Number.isFinite(s?.stories)) maxStories = Math.max(maxStories, s.stories);
    }
    const lb = (lbX << 8) | lbY;
    map.set(lb, {
      lb,
      lbX,
      lbY,
      region: c.regionName ?? null,
      biome: c.biome ?? null,
      hasRoad: !!c.hasRoad,
      settlementHint: c.settlementHint ?? null,
      architecture: c.dominantArchitecture ?? null,
      structureCount: Number.isFinite(c.structureCount) ? c.structureCount : 0,
      terrain: (Array.isArray(c.dominantTerrainTypes) ? c.dominantTerrainTypes : [])
        .filter((t) => t && typeof t.name === "string" && Number.isFinite(t.share))
        .map((t) => ({ type: t.type, name: t.name, share: t.share })),
      townName: c.townName ?? null,
      culture: c.culture ?? null,
      notes: c.gazetteerNotes ?? null,
      roofs,
      maxStories,
    });
  }
  if (bad) say(log, `[sites] atlas: ${bad} unparseable row(s) skipped`);
  return map;
}
export function loadAtlas(file, { log } = {}) {
  const text = readTextSafe(file, "atlas", log);
  return text == null ? new Map() : parseAtlasText(text, { log });
}

// ── knowledge.acpedia.json — [{title, text≤300, aliases?}] ────────────────
const LB_ALIAS_RE = /^[0-9A-F]{4}$/;
/** acpedia prose: drop the "Location: Landscape." lead, trailing categories and image boilerplate. */
export function cleanLoreText(text) {
  let t = String(text ?? "");
  t = t.replace(/^\s*Location:\s*(?:Landscape|Point of Interest)\.\s*/i, "");
  t = t.replace(/\bCategory:[\s\S]*$/i, "");
  t = t.replace(/(?:Wiki Map:[^.]*?)?Click image for full size version\.?/gi, " ");
  t = t.replace(/\s+/g, " ").trim();
  return t;
}
export function loadAcpedia(file, { log } = {}) {
  const data = readJsonSafe(file, "acpedia", log);
  if (data == null) return [];
  if (!Array.isArray(data)) {
    say(log, "[sites] acpedia: expected a JSON array — source skipped");
    return [];
  }
  const rows = [];
  for (const r of data) {
    const title = String(r?.title ?? "").trim();
    if (!title) continue;
    const raw = String(r?.text ?? "");
    const tc = parseTitleCoords(title);
    const aliases = [];
    const lbAliases = [];
    for (const a of Array.isArray(r?.aliases) ? r.aliases : []) {
      const s = String(a ?? "").trim();
      if (!s) continue;
      if (LB_ALIAS_RE.test(s)) lbAliases.push(parseInt(s, 16));
      else if (!parseTitleCoords(s)) aliases.push(s);
    }
    const loc = /Location:\s*([A-Za-z][A-Za-z ]*?)\s*(?:[|.]|$)/.exec(raw);
    rows.push({
      title,
      name: tc ? tc.rest : title,
      text: cleanLoreText(raw),
      aliases,
      lbAliases,
      coords: tc ? { ns: tc.ns, ew: tc.ew } : parseInfoboxCoords(raw),
      location: loc ? loc[1].trim() : null,
    });
  }
  return rows;
}

// ── object-tags.json — {"0100XXXX": [keywords] | "keyword"} ───────────────
export function loadObjectTags(file, { log } = {}) {
  const data = readJsonSafe(file, "object-tags", log);
  const map = new Map();
  if (data == null || typeof data !== "object" || Array.isArray(data)) return map;
  for (const [k, v] of Object.entries(data)) {
    const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
    map.set(k.toUpperCase().replace(/^0X/, "").padStart(8, "0"), list.filter((s) => typeof s === "string").map((s) => s.toLowerCase()));
  }
  return map;
}

// ── streamed JSONL helpers ─────────────────────────────────────────────────
async function forEachLine(file, label, log, fn) {
  if (!file) {
    say(log, `[sites] ${label}: no path configured — source skipped`);
    return false;
  }
  try {
    await fs.promises.access(file, fs.constants.R_OK);
  } catch (e) {
    say(log, `[sites] ${label}: cannot read ${file} (${e.code || e.message}) — source skipped`);
    return false;
  }
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  let first = true;
  for await (let line of rl) {
    if (first) {
      line = stripBom(line);
      first = false;
    }
    fn(line);
  }
  return true;
}

/** weenie_index.jsonl (streamed) → Map<wcid, setupDid> for the requested wcids only. */
export async function loadWeenieSetups(file, wcids, { log } = {}) {
  const want = wcids instanceof Set ? wcids : new Set(wcids ?? []);
  const out = new Map();
  if (!want.size) return out;
  await forEachLine(file, "weenie-index", log, (line) => {
    const m = /"wcid"\s*:\s*(\d+)/.exec(line);
    if (!m || !want.has(Number(m[1]))) return;
    try {
      const r = JSON.parse(line);
      if (Number.isFinite(r.setupDid)) out.set(r.wcid, r.setupDid >>> 0);
    } catch {
      /* malformed row: ignore */
    }
  });
  return out;
}

// ── ace_spawn_records.jsonl (255 MB) — STREAMED landmarks + outdoor elevation ─
export const LANDMARK_NAME_RE = /\b(statue|fountain|shrine|totem|altar|obelisk)s?\b/i;
const GENERIC_PORTAL_NAMES = new Set([
  "surface", "portal", "surface portal", "exit", "exit portal", "gateway", "portal space", "exit to surface",
  "exit to the surface", "surface exit", "gateway portal", "magical portal", "cavern exit",
]);
const SPAWN_POS_RE = /"landblockId"\s*:\s*(\d+)\s*,\s*"cell"\s*:\s*(\d+)\s*,\s*"x"\s*:\s*([-\d.eE+]+)\s*,\s*"y"\s*:\s*([-\d.eE+]+)\s*,\s*"z"\s*:\s*([-\d.eE+]+)/;
/** Landmark type of a spawn row, or null. */
export function landmarkTypeOf(r) {
  const name = String(r?.name ?? "");
  if (r?.weenieType === 25) return "lifestone";
  if (r?.weenieType === 7) return GENERIC_PORTAL_NAMES.has(name.trim().toLowerCase()) || !name.trim() ? null : "portal";
  const m = LANDMARK_NAME_RE.exec(name);
  return m ? m[1].toLowerCase() : null;
}
/**
 * Full cell id of a spawn row: landblockId is the 16-bit key and `cell` the low word; an outdoor row with
 * cell == 0 is rebuilt with nav_frame.worldToOutdoorCell from the LB-local x/y.
 */
export function spawnCellOf(lb16, cellLow, x, y) {
  if (Number.isInteger(cellLow) && cellLow > 0) return ((lb16 << 16) | (cellLow & 0xffff)) >>> 0;
  return outdoorCellOfWorld(((lb16 >>> 8) & 0xff) * LB_SIZE + x, (lb16 & 0xff) * LB_SIZE + y).cell;
}
/**
 * Stream the ACE spawn dump: landmark rows (life stones weenieType 25, portals weenieType 7, names with
 * Statue/Fountain/Shrine/Totem/Altar/Obelisk) plus per-landblock outdoor elevation stats (z of every
 * outdoor spawn, ≈ ground height). Returns null when the file is unavailable.
 */
export async function streamSpawns(file, { log } = {}) {
  const landmarks = [];
  const elevation = new Map();
  let lines = 0, bad = 0;
  const ok = await forEachLine(file, "spawns", log, (line) => {
    if (!line) return;
    lines++;
    const pm = SPAWN_POS_RE.exec(line);
    if (pm) {
      const cellLow = Number(pm[2]);
      const z = Number(pm[5]);
      if (cellLow < 0x100 && Number.isFinite(z)) {
        let lb = Number(pm[1]) & 0xffff;
        if (cellLow === 0) {
          const x = Number(pm[3]), y = Number(pm[4]);
          if (Number.isFinite(x) && Number.isFinite(y)) lb = lbOfCell(spawnCellOf(lb, 0, x, y));
        }
        const e = elevation.get(lb);
        if (e) {
          e.n++;
          e.sum += z;
          if (z < e.min) e.min = z;
          if (z > e.max) e.max = z;
        } else elevation.set(lb, { n: 1, sum: z, min: z, max: z });
      }
    }
    if (!(line.includes('"weenieType":25') || line.includes('"weenieType":7,') || LANDMARK_NAME_RE.test(line))) return;
    let r;
    try {
      r = JSON.parse(line);
    } catch {
      bad++;
      return;
    }
    const type = landmarkTypeOf(r);
    if (!type) return;
    const lb16 = Number(r.landblockId) & 0xffff;
    const x = Number(r.x), y = Number(r.y), z = Number(r.z);
    if (!finiteAll(lb16, x, y, z)) return;
    const cell = spawnCellOf(lb16, Number(r.cell), x, y);
    let local = { x, y, z };
    if (!(Number(r.cell) > 0)) {
      const oc = outdoorCellOfWorld(((lb16 >>> 8) & 0xff) * LB_SIZE + x, (lb16 & 0xff) * LB_SIZE + y, z);
      local = { x: oc.x, y: oc.y, z };
    }
    const q = [Number(r.qw), Number(r.qx), Number(r.qy), Number(r.qz)];
    landmarks.push({
      source: "spawns",
      name: String(r.name).trim(),
      type,
      wcid: Number(r.wcid),
      weenieType: Number(r.weenieType),
      category: r.category ?? null,
      cell,
      lb: lbOfCell(cell),
      indoor: isIndoorCell(cell),
      local,
      quat: finiteAll(...q) ? q : null,
    });
  });
  if (!ok) return null;
  if (bad) say(log, `[sites] spawns: ${bad} malformed landmark line(s) skipped`);
  return { landmarks, elevation, lines };
}
