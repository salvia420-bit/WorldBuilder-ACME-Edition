// tools/knowledge.js — provider-agnostic acpedia/quest knowledge lookup for
// the rynth AI director: the SPEC.md:19 / README.md "Roadmap" item, built as
// the v2 layer. A KnowledgeBase fronts a duck-typed provider
// { search(query, limit) -> Promise<rows> }; FileKnowledgeProvider is the
// offline JSON-corpus implementation (the fleet's acpedia wikidump / SQL
// index implements the same duck type later, online). Nothing here touches
// the frozen v1 files: knowledgeAction()/registerKnowledge hand the
// integrator an actions.js-shaped "lookup" action to wire into a COPY of the
// ACTIONS map.
//
// Same survival invariant as actions.js: every entry point degrades to empty
// results / ok:false — nothing here ever throws into the director loop.

export const QUERY_MAX_CHARS = 200;
const SUMMARY_MAX_CHARS = 240;

// Ranking tiers: exact title > title substring > alias > body, ties broken
// by title (the exact tier keeps "Olthoi Soldier" above "An Olthoi Soldier
// Nest" on a 24k-article corpus).
const SCORE_EXACT = 6;
const SCORE_TITLE = 5;
const SCORE_TITLE_WORDS = 4; // every query word in the title, any order/gaps
const SCORE_ALIAS = 3;
const SCORE_BODY = 2;
const SCORE_BODY_WORDS = 1; // every query word somewhere in title+text

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s); // llm_client.js:77 shape

// Whitelist copy like journal.js sanitizeEntries, but per-entry skip instead
// of all-or-nothing: a hand-maintained corpus with one bad row should still
// serve the good rows.
function sanitizeEntries(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const e of raw) {
    if (!e || typeof e !== "object" || Array.isArray(e)) continue;
    if (typeof e.title !== "string" || !e.title.trim()) continue;
    out.push({
      title: e.title.trim(),
      aliases: Array.isArray(e.aliases)
        ? e.aliases.filter((a) => typeof a === "string" && a.trim())
        : [],
      text: typeof e.text === "string" ? e.text : "",
      url: typeof e.url === "string" && e.url ? e.url : undefined,
    });
  }
  return out;
}

/**
 * File-backed provider over a small JSON corpus:
 * [{title, aliases?, text, url?}, ...]. Construct with { path } (loaded
 * lazily on first search — no fs at module top level, so the module imports
 * clean in a browser) or { entries } (inline array, no fs at all).
 * Missing/corrupt file, or no node:fs in this runtime -> empty results,
 * never a throw.
 */
export class FileKnowledgeProvider {
  constructor({ path, entries } = {}) {
    this.path = typeof path === "string" && path ? path : null;
    this._entries = Array.isArray(entries) ? sanitizeEntries(entries) : null;
    this._loading = null;
  }

  // Load once, cache forever (a broken corpus behaves as an empty one; the
  // director keeps its cadence either way). Concurrent first searches share
  // the one in-flight load.
  async _load() {
    if (this._entries) return this._entries;
    if (!this._loading) {
      this._loading = (async () => {
        try {
          const { readFile } = await import("node:fs/promises");
          this._entries = sanitizeEntries(JSON.parse(await readFile(this.path, "utf8")));
        } catch {
          this._entries = [];
        }
        return this._entries;
      })();
    }
    return this._loading;
  }

  /** Duck-typed provider surface. -> [{title, summary, url?, score}] */
  async search(query, limit = 3) {
    try {
      const q = String(query ?? "").trim().toLowerCase();
      const n = Math.floor(Number(limit));
      if (!q || !Number.isFinite(n) || n < 1) return [];
      // Word-AND fallback (2026-07-17): phrase-substring alone can never match
      // "Academy Token" against "Academy Exit Token" — observed live blocking
      // the exit-token lookup. Words shorter than 3 chars are noise (of, a).
      const words = q.split(/\s+/).filter((w) => w.length >= 3);
      const hasAllWords = (s) => words.length > 1 && words.every((w) => s.includes(w));
      const hits = [];
      for (const e of await this._load()) {
        const title = e.title.toLowerCase();
        const text = e.text.toLowerCase();
        const score = title === q ? SCORE_EXACT
          : title.includes(q) ? SCORE_TITLE
          : hasAllWords(title) ? SCORE_TITLE_WORDS
          : e.aliases.some((a) => a.toLowerCase().includes(q)) ? SCORE_ALIAS
          : text.includes(q) ? SCORE_BODY
          : hasAllWords(title + " " + text) ? SCORE_BODY_WORDS
          : 0;
        if (score) hits.push({ e, score });
      }
      // Deterministic: score desc, then title asc (case-insensitive, plain
      // codepoint compare — localeCompare varies by host locale).
      const cmp = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
      hits.sort((a, b) => b.score - a.score
        || cmp(a.e.title.toLowerCase(), b.e.title.toLowerCase())
        || cmp(a.e.title, b.e.title));
      return hits.slice(0, n).map(({ e, score }) => {
        const row = {
          title: e.title,
          summary: clip(e.text.replace(/\s+/g, " ").trim(), SUMMARY_MAX_CHARS),
          score,
        };
        if (e.url) row.url = e.url;
        return row;
      });
    } catch {
      return []; // provider surface never throws into the action path
    }
  }
}

/**
 * Provider-agnostic front. lookup() normalizes whatever the provider returns
 * to the row contract and NEVER throws — no/broken provider -> [].
 */
export class KnowledgeBase {
  constructor({ provider } = {}) {
    this.provider = provider && typeof provider.search === "function" ? provider : null;
  }

  /** -> [{title, summary, url?, score}], at most `limit` rows. */
  async lookup(query, { limit = 3 } = {}) {
    if (!this.provider) return [];
    const n = Math.floor(Number(limit));
    const lim = Number.isFinite(n) && n >= 1 ? n : 3;
    try {
      const rows = await this.provider.search(String(query ?? ""), lim);
      if (!Array.isArray(rows)) return [];
      const out = [];
      for (const r of rows.slice(0, lim)) {
        if (!r || typeof r !== "object" || typeof r.title !== "string" || !r.title) continue;
        const row = {
          title: r.title,
          summary: typeof r.summary === "string" ? r.summary : "",
          score: Number.isFinite(r.score) ? r.score : 0,
        };
        if (typeof r.url === "string" && r.url) row.url = r.url;
        out.push(row);
      }
      return out;
    } catch {
      return [];
    }
  }
}

/**
 * The "lookup" action definition for a future actions registry. `params` and
 * `desc` are exactly the ACTIONS entry shape (actions.js:12-39) so
 * renderActionCatalog()'s rendering (actions.js:41-50) works on it unchanged;
 * `type`, `validate` and `apply` are the additive registration surface:
 * validateAction (actions.js:63) rejects unknown types, so a registered
 * action must carry its own {ok, error?} bounds check, and `apply` follows
 * executeAction's result contract + never-throws invariant
 * (actions.js:109-118).
 *
 * ctx: { kb?, journal?, log?, limit? } — ctx.kb overrides the bound kb;
 * ctx.journal (AiJournal duck type) gets a "note" with the rows so the next
 * observation's journal tail carries them back to the LLM (the director's
 * own "result" journal line is only `lookup:ok`, director.js:194).
 */
export function knowledgeAction(kb) {
  const def = {
    type: "lookup",
    params: { query: `string <= ${QUERY_MAX_CHARS} chars — quest/creature/place to look up` },
    desc: "look up acpedia/quest knowledge; rows are journaled for your next check-in",
    validate(a) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
      if (a.type !== "lookup") return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
      if (typeof a.query !== "string" || !a.query.trim()) return { ok: false, error: "query must be a non-empty string" };
      if (a.query.length > QUERY_MAX_CHARS) return { ok: false, error: `query must be <= ${QUERY_MAX_CHARS} chars` };
      return { ok: true };
    },
    async apply(bot, a, ctx = {}) {
      const fail = (error) => {
        try { ctx.log && ctx.log(`[ai] action lookup: ${error}`); } catch {}
        return { type: "lookup", ok: false, error: String(error) };
      };
      try {
        const v = def.validate(a);
        if (!v.ok) return fail(v.error);
        const base = ctx.kb ?? kb;
        if (!base || typeof base.lookup !== "function") return fail("unavailable");
        const query = a.query.trim().slice(0, QUERY_MAX_CHARS);
        const n = Math.floor(Number(ctx.limit));
        const rows = await base.lookup(query, { limit: Number.isFinite(n) && n >= 1 ? n : 3 });
        const list = Array.isArray(rows) ? rows : [];
        try {
          ctx.journal?.add?.("note", list.length
            ? `lookup "${query}": ` + list.map((r) => `${r.title} — ${r.summary}`).join(" | ")
            : `lookup "${query}": no matches`);
        } catch {} // journal loss must not fail the action (journal.js contract)
        return { type: "lookup", ok: true, result: { query, rows: list } };
      } catch (e) {
        return fail((e && e.message) || e);
      }
    },
  };
  return def;
}

/**
 * Integrator seam: mutates a PASSED-IN actions map (the shape of actions.js
 * ACTIONS — pass a copy; ES module namespaces are frozen and the real v1
 * module must never be rewritten), adding the "lookup" definition bound to
 * kb. Returns the definition. Integrator-time wiring, so bad input throws
 * loudly here instead of silently no-opping in the LLM path.
 */
export function registerKnowledge(actionsMap, kb) {
  if (!actionsMap || typeof actionsMap !== "object" || Array.isArray(actionsMap))
    throw new TypeError("registerKnowledge: actionsMap must be a mutable object (e.g. { ...ACTIONS })");
  const def = knowledgeAction(kb);
  actionsMap[def.type] = def;
  return def;
}
