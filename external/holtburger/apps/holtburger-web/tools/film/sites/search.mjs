// tools/film/sites/search.mjs — film-mode SITE SEARCH: lyric/script words → ranked gazetteer sites.
//
// WHY
// ---
// Film mode (`?filmMode=on`, DEFAULT OFF): the Claude Code director turns a lyric line ("lonely snowy
// mountain at dawn") into a shortlist of places to shoot, then JEV scores the top few (jev_tasks
// scoreSiteForLine). Lyrics rarely name AC places, so plain keyword search is not enough: each query word
// is expanded through tools/film/data/concept_lexicon.json (lyric imagery → AC terrain / biome / feature
// tags / preferred site kinds, plus a suggested look and camera techniques).
//
// WHAT
// ----
//   loadGazetteer(path=DEFAULT_GAZETTEER_PATH) → Site[]          (JSONL written by build.mjs writeGazetteer)
//   loadLexicon(path=DEFAULT_LEXICON_PATH) → lexicon
//   searchSites(sites, query, {kind, indoor, near:{ns, ew, radiusKm=5}, culture, limit=20, lexicon})
//     → [{site, score, why:[matched terms]}]      BM25F over name(×3) / aliases(×2) / kind / region / culture /
//        biome / terrain / tags(+notes) / lore, expansion terms down-weighted, a boost for sites whose kind the
//        matched concepts prefer. `lexicon` undefined → the default file; null → no expansion.
//   expandQuery(query, lexicon) → {tokens, terms:[{term, weight, from}], concepts:[{id, matched, kinds, look,
//     techniques}]}   — the director also reads the concepts' look/techniques suggestions from here.
//   explainSite(site) → one paragraph of words for the director / JEV;  siteWords(site) → compact word list.
//
// Node-only (node:fs). Deterministic: ties break on kind, then name.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { foldText, stripBom, formatMap, compactKey } from "./sources.mjs";
import { DEFAULT_GAZETTEER_PATH } from "./build.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_LEXICON_PATH = path.resolve(HERE, "../data/concept_lexicon.json");
export { DEFAULT_GAZETTEER_PATH };

const KIND_RANK = Object.freeze({ town: 6, dungeon: 5, poi: 4, landmark: 3, region: 2, wilderness: 1 });
const KM_PER_DEG = 0.24;

// ── loading ──────────────────────────────────────────────────────────────────────────────────────────
/** Sites from a gazetteer JSONL file (BOM-tolerant; malformed lines skipped). Throws when unreadable. */
export function loadGazetteer(file = DEFAULT_GAZETTEER_PATH) {
  const text = stripBom(fs.readFileSync(file, "utf8"));
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const s = JSON.parse(line);
      if (s && typeof s.name === "string" && s.teleport) out.push(s);
    } catch {
      /* malformed line: skip */
    }
  }
  return out;
}
let _defaultLexicon = null;
export function loadLexicon(file = DEFAULT_LEXICON_PATH) {
  const data = JSON.parse(stripBom(fs.readFileSync(file, "utf8")));
  if (!data || typeof data.concepts !== "object") throw new Error(`lexicon ${file}: missing "concepts"`);
  return data;
}
function defaultLexicon() {
  if (_defaultLexicon === null) {
    try {
      _defaultLexicon = loadLexicon();
    } catch {
      _defaultLexicon = false;
    }
  }
  return _defaultLexicon || null;
}

// ── tokens ───────────────────────────────────────────────────────────────────────────────────────────
const STOP = new Set(
  ("a an the and or but nor of to in on at by for with from into onto upon as is are was were be been being am " +
    "i im ive id ill me my mine you youre your yours we us our ours they them their theirs he him his she her hers " +
    "it its itll this that these those there here so just oh ooh ah yeah yea la na da hey baby gonna wanna gotta " +
    "cant dont wont aint will would could should can do does did doing have has had not no all some any every " +
    "what when where who whom why how if then than too very now again ever like get got let lets come came " +
    "know knew say said tell told make made take took give gave one ones s t ll d re ve m o").split(" "),
);
/** Light English plural stemmer (shared by documents and queries). */
export function stemToken(w) {
  if (w.length <= 3) return w;
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (/(?:ss|us|is|ys|as|os)$/.test(w)) return w;
  if (/(?:sses|xes|ches|shes)$/.test(w)) return w.slice(0, -2);
  if (w.endsWith("s")) return w.slice(0, -1);
  return w;
}
/** Folded, lower-cased, apostrophe-free, stemmed tokens; stop words dropped unless `keepStop`. */
export function tokenize(text, { keepStop = false } = {}) {
  const out = [];
  for (const w of foldText(text).toLowerCase().replace(/['’`]/g, "").split(/[^a-z0-9]+/)) {
    if (!w) continue;
    if (!keepStop && STOP.has(w)) continue;
    out.push(stemToken(w));
  }
  return out;
}

// ── lexicon → phrase index ───────────────────────────────────────────────────────────────────────────
const _lexIndex = new WeakMap();
function lexiconIndex(lexicon) {
  let idx = _lexIndex.get(lexicon);
  if (idx) return idx;
  const phrases = new Map(); // first token → [{toks, id}]
  const add = (text, id) => {
    const toks = tokenize(text, { keepStop: true });
    if (!toks.length) return;
    let l = phrases.get(toks[0]);
    if (!l) phrases.set(toks[0], (l = []));
    if (!l.some((p) => p.id === id && p.toks.join(" ") === toks.join(" "))) l.push({ toks, id });
  };
  for (const [id, c] of Object.entries(lexicon.concepts ?? {})) {
    for (const part of id.split(/[\/_]/)) add(part.replace(/-/g, " "), id);
    for (const w of c.words ?? []) add(w, id);
  }
  for (const l of phrases.values()) l.sort((a, b) => b.toks.length - a.toks.length);
  idx = { phrases };
  _lexIndex.set(lexicon, idx);
  return idx;
}

const W_DIRECT = 1.0;
const W_FEATURE = 0.6; // concept tags / terrain / biome
const W_SYNONYM = 0.4; // concept words
/**
 * Query terms + matched lexicon concepts.
 * @returns {{tokens: string[], terms: {term: string, weight: number, from: string|null}[], concepts: object[]}}
 */
export function expandQuery(query, lexicon) {
  const lex = lexicon === undefined ? defaultLexicon() : lexicon;
  const tokens = tokenize(query);
  const terms = new Map();
  const add = (term, weight, from) => {
    const e = terms.get(term);
    if (!e || weight > e.weight) terms.set(term, { term, weight, from });
  };
  for (const t of tokens) add(t, W_DIRECT, null);
  const concepts = [];
  if (lex && lex.concepts) {
    const { phrases } = lexiconIndex(lex);
    const raw = tokenize(query, { keepStop: true });
    const hit = new Map(); // id → matched phrase
    for (let i = 0; i < raw.length; i++) {
      for (const p of phrases.get(raw[i]) ?? []) {
        if (p.toks.every((t, j) => raw[i + j] === t)) {
          if (!hit.has(p.id)) hit.set(p.id, p.toks.join(" "));
        }
      }
    }
    for (const [id, matched] of hit) {
      const c = lex.concepts[id];
      concepts.push({ id, matched, kinds: c.kinds ?? [], look: c.look ?? {}, techniques: c.techniques ?? [] });
      for (const w of c.words ?? []) {
        const toks = tokenize(w);
        if (toks.length === 1) add(toks[0], W_SYNONYM, id);
      }
      for (const w of [...(c.tags ?? []), ...(c.terrain ?? []), ...(c.biome ?? [])]) for (const t of tokenize(w)) add(t, W_FEATURE, id);
    }
  }
  return { tokens, terms: [...terms.values()], concepts };
}

// ── BM25F index ──────────────────────────────────────────────────────────────────────────────────────
const FIELDS = ["name", "aliases", "kind", "region", "culture", "biome", "terrain", "tags", "lore"];
const FIELD_W = { name: 3, aliases: 2, kind: 1, region: 1, culture: 1, biome: 1, terrain: 1, tags: 1, lore: 1 };
const FIELD_B = { name: 0.5, aliases: 0.5, kind: 0, region: 0.3, culture: 0.3, biome: 0.3, terrain: 0.3, tags: 0.5, lore: 0.75 };
const K1 = 1.2;
const CONCEPT_REST = 0.3;
function fieldText(site, f) {
  switch (f) {
    case "name": return site.name ?? "";
    case "aliases": return (site.aliases ?? []).join(" ");
    case "kind": return site.kind ?? "";
    case "region": return site.region ?? "";
    case "culture": return site.culture ?? "";
    case "biome": return site.biome ?? "";
    case "terrain": return [...(site.terrain ?? []), site.hasRoad ? "road" : ""].join(" ");
    case "tags": return [...(site.tags ?? []), site.notes ?? ""].join(" ");
    case "lore": return site.lore ?? "";
    default: return "";
  }
}
const _index = new WeakMap();
function buildIndex(sites) {
  let idx = _index.get(sites);
  if (idx && idx.n === sites.length) return idx;
  const docs = [];
  const df = new Map();
  const totLen = Object.fromEntries(FIELDS.map((f) => [f, 0]));
  for (const s of sites) {
    const fields = {};
    const len = {};
    const seen = new Set();
    for (const f of FIELDS) {
      const toks = tokenize(fieldText(s, f));
      const tf = new Map();
      for (const t of toks) {
        tf.set(t, (tf.get(t) ?? 0) + 1);
        seen.add(t);
      }
      fields[f] = tf;
      len[f] = toks.length;
      totLen[f] += toks.length;
    }
    for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
    docs.push({ fields, len });
  }
  const n = sites.length;
  const avg = Object.fromEntries(FIELDS.map((f) => [f, n ? totLen[f] / n || 1 : 1]));
  idx = { n, docs, df, avg };
  _index.set(sites, idx);
  return idx;
}
function idf(idx, t) {
  const d = idx.df.get(t) ?? 0;
  return Math.log(1 + (idx.n - d + 0.5) / (d + 0.5));
}
function termScore(idx, doc, t) {
  let tfw = 0;
  for (const f of FIELDS) {
    const tf = doc.fields[f].get(t);
    if (!tf) continue;
    const norm = 1 - FIELD_B[f] + FIELD_B[f] * (doc.len[f] / idx.avg[f]);
    tfw += (FIELD_W[f] * tf) / norm;
  }
  if (!tfw) return 0;
  return (idf(idx, t) * tfw * (K1 + 1)) / (K1 + tfw);
}

// ── filters ──────────────────────────────────────────────────────────────────────────────────────────
function asList(v) {
  return v == null ? null : (Array.isArray(v) ? v : [v]).map((x) => String(x).toLowerCase());
}
function mapDistKm(a, b) {
  return Math.hypot(a.ns - b.ns, a.ew - b.ew) * KM_PER_DEG;
}
function passes(site, { kinds, indoor, near, cultures }) {
  if (kinds && !kinds.includes(site.kind)) return false;
  if (typeof indoor === "boolean" && !!site.indoor !== indoor) return false;
  if (cultures && !cultures.includes(String(site.culture ?? "").toLowerCase())) return false;
  if (near) {
    if (!site.map || !Number.isFinite(site.map.ns)) return false;
    if (mapDistKm(site.map, near) > near.radiusKm) return false;
  }
  return true;
}

/**
 * Ranked sites for a free-text query (lyric line, beat description, place name).
 * @returns {{site: object, score: number, why: string[]}[]}
 */
export function searchSites(sites, query, { kind, indoor, near, culture, limit = 20, lexicon } = {}) {
  if (!Array.isArray(sites)) throw new TypeError("searchSites: sites must be an array");
  const kinds = asList(kind);
  const cultures = asList(culture);
  const nearF = near && Number.isFinite(Number(near.ns)) && Number.isFinite(Number(near.ew))
    ? { ns: Number(near.ns), ew: Number(near.ew), radiusKm: Number.isFinite(Number(near.radiusKm)) ? Number(near.radiusKm) : 5 }
    : null;
  const filter = { kinds, indoor, near: nearF, cultures };
  const max = Math.max(1, Math.floor(Number(limit) || 20));
  const { terms, concepts } = expandQuery(String(query ?? ""), lexicon);
  const byRank = (a, b) => b.score - a.score || KIND_RANK[b.site.kind] - KIND_RANK[a.site.kind] || (a.site.name < b.site.name ? -1 : a.site.name > b.site.name ? 1 : 0);
  if (!terms.length) {
    // filter-only listing
    return sites.filter((s) => passes(s, filter)).map((site) => ({ site, score: 0, why: [] })).sort(byRank).slice(0, max);
  }
  const idx = buildIndex(sites);
  const kindConcepts = concepts.filter((c) => c.kinds.length);
  const qKey = compactKey(String(query ?? ""));
  const results = [];
  for (let i = 0; i < sites.length; i++) {
    const site = sites[i];
    if (!passes(site, filter)) continue;
    const doc = idx.docs[i];
    let score = 0;
    const parts = [];
    // Direct query words count fully; each concept's expansion terms saturate (best term + 30% of the
    // rest) so one concept with many synonyms cannot drown the others.
    const perConcept = new Map();
    for (const { term, weight, from } of terms) {
      const s = termScore(idx, doc, term);
      if (!s) continue;
      const v = weight * s;
      parts.push({ s: v, label: from ? `${term}←${from}` : term });
      if (!from) score += v;
      else {
        const c = perConcept.get(from) ?? { max: 0, sum: 0 };
        c.max = Math.max(c.max, v);
        c.sum += v;
        perConcept.set(from, c);
      }
    }
    for (const c of perConcept.values()) score += c.max + CONCEPT_REST * (c.sum - c.max);
    if (!score) continue;
    if (qKey && (compactKey(site.name) === qKey || (site.aliases ?? []).some((a) => compactKey(a) === qKey))) {
      score *= 2;
      parts.push({ s: Infinity, label: "exact name" });
    }
    if (kindConcepts.length) {
      const fav = kindConcepts.filter((c) => c.kinds.includes(site.kind));
      if (fav.length) {
        score *= 1 + 0.5 * (fav.length / kindConcepts.length);
        parts.push({ s: 0, label: `kind:${site.kind}←${fav.map((c) => c.id).join("+")}` });
      }
    }
    parts.sort((a, b) => b.s - a.s);
    results.push({ site, score: Math.round(score * 1e4) / 1e4, why: parts.slice(0, 8).map((p) => p.label) });
  }
  results.sort(byRank);
  return results.slice(0, max);
}

// ── words for humans / JEV ───────────────────────────────────────────────────────────────────────────
const KIND_PHRASE = { town: "a town", dungeon: "a dungeon", poi: "a point of interest", landmark: "a landmark", region: "a region", wilderness: "a stretch of wilderness" };
function listWords(arr, n = 6) {
  const a = (arr ?? []).slice(0, n);
  if (a.length <= 1) return a.join("");
  return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}
/** Compact distinctive words of a site (kind, culture, region, biome, terrain, tags). */
export function siteWords(site) {
  const out = [];
  const push = (w) => {
    const s = String(w ?? "").trim();
    if (s && !out.includes(s)) out.push(s);
  };
  push(site.kind);
  push(site.indoor ? "indoors" : "outdoors");
  push(site.culture);
  push(site.region);
  push(site.biome);
  for (const t of site.terrain ?? []) push(t);
  for (const t of site.tags ?? []) if (!["indoor", "outdoor", site.kind].includes(t)) push(t);
  return out.slice(0, 32);
}
/** One paragraph describing a site: what, where, what it looks like, lore, how to get there. */
export function explainSite(site) {
  if (!site) return "";
  const bits = [];
  const where = [];
  if (site.map && Number.isFinite(site.map.ns)) where.push(`at ${formatMap(site.map.ns, site.map.ew, 2)}${site.indoor ? " (entrance)" : ""}`);
  where.push(`landblock ${site.lb}`);
  if (site.region) where.push(`in ${site.region}`);
  let first = `${site.name} is ${KIND_PHRASE[site.kind] ?? site.kind}${site.indoor ? " (indoors)" : " (outdoors)"} ${where.join(", ")}`;
  if (site.near && site.near.town && site.kind !== "town") first += `, ${site.near.km} km ${site.near.dir} of ${site.near.town}`;
  bits.push(first + ".");
  const look = [];
  if (site.culture) look.push(`${site.culture} culture`);
  if (site.biome) look.push(`a ${site.biome} landscape`);
  if (site.terrain?.length) look.push(`terrain of ${listWords(site.terrain)}`);
  if (site.hasRoad) look.push("a road runs through");
  if (Number.isFinite(site.structures) && site.structures > 0) look.push(`${site.structures} structure${site.structures === 1 ? "" : "s"} in the landblock`);
  if (look.length) bits.push(`${look.join("; ")}.`.replace(/^./, (c) => c.toUpperCase()));
  const feats = (site.tags ?? []).filter((t) => !["indoor", "outdoor", site.kind].includes(t));
  if (feats.length) bits.push(`Features: ${feats.slice(0, 16).join(", ")}.`);
  if (site.notes) bits.push(`Notes: ${site.notes}.`);
  if (site.lore) {
    let lore = site.lore.length > 320 ? site.lore.slice(0, 317).replace(/\s+\S*$/, "") : site.lore;
    if (lore !== site.lore || !/[.!?…"”')\]]$/.test(lore)) lore = lore.replace(/[\s,;:]+$/, "") + "…"; // corpus text is capped mid-sentence
    bits.push(`Lore: ${lore}`);
  }
  const t = site.teleport ?? {};
  const alt = ["teleloc", "telepoi", "teledungeon", "tele"].map((k) => t[k]).filter((c) => c && c !== t.best);
  bits.push(`Teleport: ${t.best}${alt.length ? ` (also ${alt.join(" | ")})` : ""}.`);
  return bits.join(" ");
}
