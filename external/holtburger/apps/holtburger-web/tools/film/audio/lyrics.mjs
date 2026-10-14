// tools/film/audio/lyrics.mjs — lyrics parsing (LRC + plain text) and lyric→section alignment for the film-mode
// song analyser.
//
// WHY: film mode (`?filmMode=on`, DEFAULT OFF) cuts music videos; the director (a Claude Code session) wants to know
// which words are sung in which section ("the second chorus starts on 'hold the line'"). Lyrics arrive either as LRC
// (timed lines) or as plain text (stanzas, often with Genius-style [Chorus] headers). Everything here is pure and
// deterministic; no network, no dependencies.
//
// LRC rules (parseLrcDocument / parseLrc):
//   - time tags [mm:ss], [mm:ss.x], [mm:ss.xx], [mm:ss.xxx] and [mm:ss:xx] (the last field is a decimal fraction of
//     a second, so ':xx' reads as hundredths); minutes may exceed 59; several tags on one line give one entry each.
//   - [offset:±ms] shifts every line: t = stamp − offset/1000 (the LRC convention: a positive offset makes lyrics
//     appear sooner), clamped at 0. Other metadata tags ([ar:], [ti:], [al:], [by:], [length:], [re:], [ve:], …)
//     are collected into `meta` and never produce lines; untimed lines are ignored.
//   - enhanced-LRC word stamps <mm:ss.xx> are stripped from the text; text is trimmed; an empty timed line (a vocal
//     gap marker) is kept with text "". Lines are sorted by t (stable for equal t).
// Plain rules (parsePlainLyrics):
//   - stanzas are separated by blank lines; a header line — "[anything]", "(Chorus)", "Chorus:", or a bare
//     "Verse 2" — is removed and kept as the stanza's `hint` (with `hintRole` when it names a known section kind);
//     a header in the middle of a block starts a new stanza.
//   - a header-only block attaches to the following block when that block has no header of its own; otherwise it
//     is a repeat reference ("[Chorus]" alone) and copies the lines of the latest earlier stanza with the same hint
//     (or, for chorus/prechorus hints, the same hint role) as `repeat: true`; it is dropped when there is none.
// Alignment (alignLyrics):
//   - LRC: each line goes to the section containing its time (the last section also owns t == durationSec and up to
//     0.5 s past the end).
//   - plain: stanzas are grouped (identical normalised text, ≥ 60 % shared lines, or two [Chorus]-type hints) and
//     mapped onto sections by a monotone dynamic programme: every stanza goes to one section, in order, several may
//     share a section, sections may stay empty. Each repeated stanza group is bound to one repeated section label
//     (or to none) — all bindings are enumerated (the 4 most repeated groups × the 6 most repeated labels, so the
//     search stays ≤ 7⁴ alignments) — so identical stanzas land on sections with the same label. Score:
//     +3/−3 for a bound group on/off its label, −2 for a one-off stanza on a chorus/prechorus section,
//     +2/−1 for a header hint that matches/contradicts the section role, −2 for any stanza on an intro/outro/
//     instrumental section unless its hint says so, −1 per empty vocal section, −1.5 per extra stanza stacked in a
//     section (−0.5 when the section is ≥ 16 bars). Highest score wins; ties go to the first binding enumerated.

/** Roles a header hint can name (subset of structure.mjs SECTION_ROLES). */
export const HINT_ROLES = Object.freeze(["intro", "verse", "prechorus", "chorus", "bridge", "instrumental", "outro"]);

const TIME_TAG = /^(\d{1,3}):(\d{1,2})(?:([.:])(\d{1,3}))?$/;
const META_TAG = /^([A-Za-z#][A-Za-z0-9#_-]*)\s*:(.*)$/s;
const WORD_STAMP = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/g;

function roundMs(t) {
  return Math.round(t * 1000) / 1000;
}

/**
 * Parses one LRC time tag body ("01:02.34", "1:02:34", "00:05") to seconds, or null when it is not a time tag.
 * @param {string} inner text between the brackets
 * @returns {number|null}
 */
export function parseLrcTimestamp(inner) {
  const m = TIME_TAG.exec(inner.trim());
  if (!m) return null;
  const min = Number(m[1]);
  const sec = Number(m[2]);
  const frac = m[4] ? Number(m[4]) / Math.pow(10, m[4].length) : 0;
  return min * 60 + sec + frac;
}

/**
 * @typedef {object} LrcDocument
 * @property {{t:number, text:string}[]} lines sorted by t (seconds, offset applied, ms precision)
 * @property {Object<string,string>} meta lower-cased metadata tags (ti, ar, al, by, length, offset, …)
 * @property {number} offsetMs the [offset:] value applied (0 when absent)
 */

/**
 * Full LRC parse: timed lines plus metadata (see the header for the rules).
 * @param {string} text
 * @returns {LrcDocument}
 */
export function parseLrcDocument(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  const meta = {};
  const raw = [];
  let order = 0;
  for (const line of src.split(/\r\n|\r|\n/)) {
    let rest = line.trim();
    const stamps = [];
    while (rest.startsWith("[")) {
      const close = rest.indexOf("]");
      if (close < 0) break;
      const inner = rest.slice(1, close);
      const t = parseLrcTimestamp(inner);
      if (t !== null) {
        stamps.push(t);
      } else {
        const mm = META_TAG.exec(inner);
        if (!mm || stamps.length) break;
        meta[mm[1].toLowerCase()] = mm[2].trim();
      }
      rest = rest.slice(close + 1).trimStart();
    }
    if (!stamps.length) continue;
    const body = rest.replace(WORD_STAMP, "").replace(/\s+/g, " ").trim();
    for (const t of stamps) raw.push({ t, text: body, order: order++ });
  }
  let offsetMs = 0;
  if (meta.offset !== undefined) {
    const v = Number.parseInt(meta.offset.replace(/\s+/g, ""), 10);
    if (Number.isFinite(v)) offsetMs = v;
  }
  raw.sort((a, b) => a.t - b.t || a.order - b.order);
  const lines = raw.map(({ t, text: s }) => ({ t: roundMs(Math.max(0, t - offsetMs / 1000)), text: s }));
  return { lines, meta, offsetMs };
}

/**
 * Timed lines of an LRC document: [{t, text}] sorted by t.
 * @param {string} text
 * @returns {{t:number, text:string}[]}
 */
export function parseLrc(text) {
  return parseLrcDocument(text).lines;
}

/**
 * 'lrc' when at least one line starts with an LRC time tag, else 'plain'.
 * @param {string} text
 * @returns {'lrc'|'plain'}
 */
export function detectLyricsFormat(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  for (const line of src.split(/\r\n|\r|\n/)) {
    const m = /^\s*\[([^\]]*)\]/.exec(line);
    if (m && parseLrcTimestamp(m[1]) !== null) return "lrc";
  }
  return "plain";
}

/**
 * Section role named by a header hint ("Verse 2", "Pre-Chorus", "Chorus: Artist", "Guitar Solo"), or null.
 * @param {string|null|undefined} hint
 * @returns {string|null} one of HINT_ROLES or null
 */
export function sectionHintRole(hint) {
  if (!hint) return null;
  const h = String(hint).toLowerCase().split(":")[0].replace(/[^a-z0-9 -]+/g, " ").replace(/\s+/g, " ").trim();
  if (!h) return null;
  if (/\bpost[- ]?(chorus|hook)\b/.test(h)) return null;
  if (/\bpre[- ]?(chorus|hook)\b|\bbuild[- ]?up\b|\bbuild\b|\blift\b/.test(h)) return "prechorus";
  if (/\b(chorus|refrain|hook)\b/.test(h)) return "chorus";
  if (/\bverse\b/.test(h)) return "verse";
  if (/\bbridge\b|\bmiddle (8|eight)\b/.test(h)) return "bridge";
  if (/\bintro\b/.test(h)) return "intro";
  if (/\b(outro|coda|ending|fade)\b/.test(h)) return "outro";
  if (/\b(instrumental|solo|interlude|break)\b/.test(h)) return "instrumental";
  return null;
}

const KNOWN_HEADER_WORD = /^(intro|verse|pre[- ]?chorus|pre[- ]?hook|chorus|refrain|hook|post[- ]?chorus|bridge|middle (8|eight)|outro|coda|instrumental|interlude|solo|guitar solo|break|breakdown)(\s+\d+)?(\s*[x×]\s*\d+)?$/i;

/**
 * Header text when `line` is a stanza header, else null (see the header for the accepted shapes).
 * @param {string} line
 * @returns {string|null}
 */
export function parseLyricHeader(line) {
  const s = line.trim();
  if (!s) return null;
  let m = /^\[(.+)\]$/.exec(s);
  if (m) return m[1].trim();
  m = /^\((.+)\)$/.exec(s);
  if (m && sectionHintRole(m[1]) !== null && m[1].trim().split(/\s+/).length <= 4) return m[1].trim();
  m = /^([A-Za-z][A-Za-z0-9 '’-]{0,30}):$/.exec(s);
  if (m && sectionHintRole(m[1]) !== null) return m[1].trim();
  if (KNOWN_HEADER_WORD.test(s)) return s;
  return null;
}

/**
 * @typedef {object} Stanza
 * @property {string[]} lines lyric lines (trimmed, non-empty)
 * @property {string} [hint] header text, e.g. "Chorus" or "Verse 2"
 * @property {string} [hintRole] role named by the hint (HINT_ROLES)
 * @property {boolean} [repeat] true when the stanza is a copied "[Chorus]"-style repeat reference
 */

/**
 * Plain lyrics → stanzas (see the header for header/repeat handling).
 * @param {string} text
 * @returns {Stanza[]}
 */
export function parsePlainLyrics(text) {
  const src = String(text ?? "").replace(/^﻿/, "");
  /** @type {{hint:string|null, lines:string[]}[]} */
  const blocks = [];
  let cur = null;
  const flush = () => {
    if (cur && (cur.hint !== null || cur.lines.length)) blocks.push(cur);
    cur = null;
  };
  for (const raw of src.split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) {
      flush();
      continue;
    }
    const hint = parseLyricHeader(line);
    if (hint !== null) {
      if (cur && cur.lines.length) flush();
      if (!cur) cur = { hint, lines: [] };
      else cur.hint = hint; // two headers in a row: the later one names the stanza
      continue;
    }
    if (!cur) cur = { hint: null, lines: [] };
    cur.lines.push(line.replace(/\s+/g, " "));
  }
  flush();
  /** @type {Stanza[]} */
  const out = [];
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.lines.length) {
      out.push(makeStanza(b.lines, b.hint));
      continue;
    }
    const next = blocks[k + 1];
    if (next && next.hint === null && next.lines.length) {
      next.hint = b.hint;
      continue;
    }
    const src = findRepeatSource(out, b.hint);
    if (src) out.push({ ...makeStanza(src.lines.slice(), b.hint), repeat: true });
  }
  return out;
}

/** Latest earlier stanza with the same normalised hint; for chorus/prechorus hints, else the latest of that role. */
function findRepeatSource(stanzas, hint) {
  const key = normHint(hint);
  for (let j = stanzas.length - 1; j >= 0; j--) {
    if (stanzas[j].hint !== undefined && normHint(stanzas[j].hint) === key) return stanzas[j];
  }
  const role = sectionHintRole(hint);
  if (role === "chorus" || role === "prechorus") {
    for (let j = stanzas.length - 1; j >= 0; j--) if (stanzas[j].hintRole === role) return stanzas[j];
  }
  return null;
}

function normHint(h) {
  return String(h ?? "")
    .toLowerCase()
    .split(":")[0]
    .replace(/[x×]\s*\d+\s*$/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function makeStanza(lines, hint) {
  /** @type {Stanza} */
  const s = { lines };
  if (hint !== null && hint !== undefined) {
    s.hint = hint;
    const role = sectionHintRole(hint);
    if (role) s.hintRole = role;
  }
  return s;
}

/**
 * Normalised line for matching: lower case, letters/digits/apostrophe-free words, single spaces.
 * @param {string} line
 * @returns {string}
 */
export function normalizeLyricLine(line) {
  return String(line)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * Line-set similarity of two stanzas: |shared normalised lines| / |union| (1 for identical text).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
export function stanzaSimilarity(a, b) {
  const A = new Set(a.map(normalizeLyricLine).filter(Boolean));
  const B = new Set(b.map(normalizeLyricLine).filter(Boolean));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

/**
 * Groups stanzas that are the same lyric: identical/≥ 60 %-shared text, or both chorus-hinted.
 * @param {Stanza[]} stanzas
 * @param {{minSimilarity?:number}} [opts]
 * @returns {number[]} group id per stanza, numbered by first appearance
 */
export function groupStanzas(stanzas, { minSimilarity = 0.6 } = {}) {
  const ids = [];
  let next = 0;
  for (let i = 0; i < stanzas.length; i++) {
    let g = -1;
    for (let j = 0; j < i && g < 0; j++) {
      const bothChorus = stanzas[i].hintRole === "chorus" && stanzas[j].hintRole === "chorus";
      if (bothChorus || stanzaSimilarity(stanzas[i].lines, stanzas[j].lines) >= minSimilarity) g = ids[j];
    }
    ids.push(g >= 0 ? g : next++);
  }
  return ids;
}

const NON_VOCAL = new Set(["intro", "outro", "instrumental"]);
/** Enumeration caps for assignStanzas: the most repeated stanza groups / section labels that get bound. */
const MAX_BOUND_GROUPS = 4;
const MAX_BOUND_LABELS = 6;

/**
 * Monotone stanza → section assignment (see the header for the score). Exposed for tests and the CLI.
 * @param {Stanza[]} stanzas
 * @param {{i:number, label:string, role:string, startBar:number, endBar:number}[]} sections
 * @returns {{assignment:number[], score:number, binding:Object<string,string|null>}} assignment[k] = index into
 *   `sections` for stanza k (empty when there are no sections)
 */
export function assignStanzas(stanzas, sections) {
  const S = stanzas.length;
  const V = sections.length;
  if (S === 0 || V === 0) return { assignment: [], score: 0, binding: {} };
  const groups = groupStanzas(stanzas);
  const gCount = new Map();
  for (const g of groups) gCount.set(g, (gCount.get(g) ?? 0) + 1);
  const repGroups = [...gCount.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX_BOUND_GROUPS)
    .map(([g]) => g)
    .sort((a, b) => a - b);
  const lCount = new Map();
  for (const s of sections) lCount.set(s.label, (lCount.get(s.label) ?? 0) + 1);
  const firstIdx = new Map();
  sections.forEach((s, k) => firstIdx.has(s.label) || firstIdx.set(s.label, k));
  const repLabels = [...lCount.entries()]
    .filter(([, c]) => c >= 2)
    .sort((a, b) => b[1] - a[1] || firstIdx.get(a[0]) - firstIdx.get(b[0]))
    .slice(0, MAX_BOUND_LABELS)
    .map(([L]) => L)
    .sort((a, b) => firstIdx.get(a) - firstIdx.get(b));
  let best = null;
  const binding = new Array(repGroups.length).fill(null);
  const used = new Set();
  const visit = (k) => {
    if (k === repGroups.length) {
      const res = alignWithBinding(stanzas, sections, groups, repGroups, binding);
      if (!best || res.score > best.score + 1e-9) best = { ...res, binding: Object.fromEntries(repGroups.map((g, q) => [String(g), binding[q]])) };
      return;
    }
    for (const L of repLabels) {
      if (used.has(L)) continue;
      used.add(L);
      binding[k] = L;
      visit(k + 1);
      used.delete(L);
    }
    binding[k] = null;
    visit(k + 1);
  };
  visit(0);
  return best;
}

function alignWithBinding(stanzas, sections, groups, repGroups, binding) {
  const S = stanzas.length;
  const V = sections.length;
  const bound = new Map();
  repGroups.forEach((g, q) => bound.set(g, binding[q]));
  const compat = (i, j) => {
    const st = stanzas[i];
    const sec = sections[j];
    let s = 0;
    const g = groups[i];
    if (bound.has(g)) {
      const L = bound.get(g);
      if (L !== null) s += sec.label === L ? 3 : -3;
    } else if ((sec.role === "chorus" || sec.role === "prechorus") && st.hintRole !== sec.role) {
      s -= 2; // a one-off lyric on the chorus/prechorus is unlikely (repeats are the chorus's lyric)
    }
    if (st.hintRole) {
      if (st.hintRole === sec.role) s += 2;
      else if (sec.role && sec.role !== "unknown") s -= 1;
    }
    if (NON_VOCAL.has(sec.role) && st.hintRole !== sec.role) s -= 2;
    return s;
  };
  const skipCost = (j) => (NON_VOCAL.has(sections[j].role) ? 0 : 1);
  const stackCost = (j) => (sections[j].endBar - sections[j].startBar >= 16 ? 0.5 : 1.5);
  // skipPrefix[j] = Σ skipCost over sections [0, j)
  const skipPrefix = new Float64Array(V + 1);
  for (let j = 0; j < V; j++) skipPrefix[j + 1] = skipPrefix[j] + skipCost(j);
  const f = Array.from({ length: S }, () => new Float64Array(V).fill(-Infinity));
  const back = Array.from({ length: S }, () => new Int32Array(V).fill(-1));
  for (let j = 0; j < V; j++) f[0][j] = compat(0, j) - skipPrefix[j];
  for (let i = 1; i < S; i++) {
    for (let j = 0; j < V; j++) {
      let bv = f[i - 1][j] - stackCost(j);
      let bj = j;
      for (let jp = 0; jp < j; jp++) {
        const v = f[i - 1][jp] - (skipPrefix[j] - skipPrefix[jp + 1]);
        if (v > bv + 1e-12) {
          bv = v;
          bj = jp;
        }
      }
      f[i][j] = compat(i, j) + bv;
      back[i][j] = bj;
    }
  }
  let bestJ = 0;
  let bestV = -Infinity;
  for (let j = 0; j < V; j++) {
    const v = f[S - 1][j] - (skipPrefix[V] - skipPrefix[j + 1]);
    if (v > bestV + 1e-12) {
      bestV = v;
      bestJ = j;
    }
  }
  const assignment = new Array(S);
  assignment[S - 1] = bestJ;
  for (let i = S - 1; i > 0; i--) assignment[i - 1] = back[i][assignment[i]];
  return { assignment, score: bestV };
}

/**
 * @typedef {object} LyricLine
 * @property {number} [t] seconds (LRC only)
 * @property {string} text
 * @property {number} [section] index into SongAnalysis.sections
 * @property {number} [stanza] stanza index (plain only)
 * @property {string} [hint] stanza header (plain only, when present)
 */

/**
 * Aligns lyrics to an analysis's sections (see the header).
 * @param {{durationSec:number, sections:{i:number, start:number, end:number, startBar:number, endBar:number,
 *   label:string, role:string}[]}} analysis
 * @param {{text:string, format?:'lrc'|'plain'}} lyrics format auto-detected when omitted
 * @returns {{format:'lrc'|'plain', lines:LyricLine[]}}
 */
export function alignLyrics(analysis, lyrics) {
  const text = String(lyrics?.text ?? "");
  const format = lyrics?.format === "lrc" || lyrics?.format === "plain" ? lyrics.format : detectLyricsFormat(text);
  const sections = Array.isArray(analysis?.sections) ? analysis.sections : [];
  const durationSec = Number(analysis?.durationSec) || 0;
  if (format === "lrc") {
    const lines = parseLrc(text).map(({ t, text: s }) => {
      /** @type {LyricLine} */
      const line = { t, text: s };
      const k = sectionAt(sections, t, durationSec);
      if (k >= 0) line.section = sections[k].i;
      return line;
    });
    return { format, lines };
  }
  const stanzas = parsePlainLyrics(text);
  const { assignment } = assignStanzas(stanzas, sections);
  /** @type {LyricLine[]} */
  const lines = [];
  stanzas.forEach((st, k) => {
    for (const s of st.lines) {
      /** @type {LyricLine} */
      const line = { text: s, stanza: k };
      if (assignment.length) line.section = sections[assignment[k]].i;
      if (st.hint !== undefined) line.hint = st.hint;
      lines.push(line);
    }
  });
  return { format, lines };
}

/**
 * Index (into `sections`) of the section containing time t; the last section also owns [end, end + 0.5 s].
 * @param {{start:number, end:number}[]} sections
 * @param {number} t
 * @param {number} [durationSec]
 * @returns {number} −1 when none
 */
export function sectionAt(sections, t, durationSec = 0) {
  for (let k = 0; k < sections.length; k++) {
    if (t >= sections[k].start && t < sections[k].end) return k;
  }
  const last = sections.length - 1;
  if (last >= 0 && t >= sections[last].start && t <= Math.max(sections[last].end, durationSec) + 0.5) return last;
  return -1;
}

/**
 * Timed, non-empty LRC lines for role assignment (structure.mjs `timedLyrics`), or null for plain/absent lyrics.
 * @param {{text:string, format?:'lrc'|'plain'}|null|undefined} lyrics
 * @returns {{t:number, text:string}[]|null}
 */
export function timedLyricLines(lyrics) {
  if (!lyrics || typeof lyrics.text !== "string") return null;
  const format = lyrics.format === "lrc" || lyrics.format === "plain" ? lyrics.format : detectLyricsFormat(lyrics.text);
  if (format !== "lrc") return null;
  const lines = parseLrc(lyrics.text).filter((l) => l.text.length > 0);
  return lines.length ? lines : null;
}
