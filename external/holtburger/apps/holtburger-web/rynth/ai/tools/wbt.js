// tools/wbt.js — WorldBuilder.Terminal oracle for the rynth AI director:
// gives the LLM playtester read access to the 216-command WBT REPL (weenies,
// spells, landblock descriptions, asset graphs, validators, ACE-DB probes)
// through the wbt-sidecar (apps/wbt-sidecar, :8768), plus playtest-ticket
// filing. Same additive registration shape as tools/knowledge.js: nothing
// here touches the frozen v1 files; wbtActions()/registerWbt hand the
// integrator actions.js-shaped definitions to wire into a COPY of the
// ACTIONS map (extensions.js does that wiring default-on).
//
// Same survival invariant as actions.js: every entry point degrades to
// { ok:false, error } — a down sidecar, bad JSON, or a hostile response can
// never throw into the director loop. Results flow back to the LLM the same
// way lookup rows do: journaled as a "note" so the next observation's
// journal tail carries them (director.js:194 only journals `type:ok`).

export const DEFAULT_ENDPOINT = "http://127.0.0.1:8768";
export const COMMAND_MAX_CHARS = 64;
const JOURNAL_CLIP = 800; // in line with lookup's ~750-char worst case
const RESULT_CLIP = 4000; // action-result payload cap (LLM never sees it raw)
const STRING_FIELD_CLIP = 200; // per-string cap inside responses (base64 PNGs…)
const CATALOG_MAX_ROWS = 40;
const TICKET_TITLE_MAX = 200;
const TICKET_BODY_MAX = 2000;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);

/** JSON.stringify with every string value capped — render-preview style
 * base64 blobs must not detonate the journal or the action result. */
export function compactJson(obj, { stringCap = STRING_FIELD_CLIP, totalCap = RESULT_CLIP } = {}) {
  try {
    const s = JSON.stringify(obj, (_k, v) => (typeof v === "string" && v.length > stringCap ? clip(v, stringCap) : v));
    return clip(String(s), totalCap);
  } catch {
    return "(unserializable)";
  }
}

/**
 * Fetch client for the wbt-sidecar. Duck-typed and injectable (tests pass
 * { fetchFn }); every method resolves { ok, ... } and never throws.
 */
export class WbtOracle {
  constructor({ endpoint = DEFAULT_ENDPOINT, fetchFn } = {}) {
    this.endpoint = typeof endpoint === "string" && endpoint ? endpoint.replace(/\/+$/, "") : DEFAULT_ENDPOINT;
    this._fetch = typeof fetchFn === "function" ? fetchFn : typeof fetch === "function" ? fetch.bind(globalThis) : null;
  }

  async _req(path, init) {
    if (!this._fetch) return { ok: false, error: "fetch unavailable in this runtime" };
    let res;
    try {
      res = await this._fetch(`${this.endpoint}${path}`, init);
    } catch (e) {
      return { ok: false, error: `wbt sidecar unreachable at ${this.endpoint} (${e?.message ?? e})` };
    }
    let body;
    try {
      body = await res.json();
    } catch (e) {
      return { ok: false, error: `bad JSON from wbt sidecar (${e?.message ?? e})` };
    }
    if (!body || typeof body !== "object") return { ok: false, error: "empty response from wbt sidecar" };
    return body.ok === true ? body : { ok: false, error: String(body.error ?? `sidecar HTTP ${res.status}`) };
  }

  /** -> { ok, ready?, ... } */
  health() {
    return this._req("/health");
  }

  /** -> { ok, commands?: [{name,args,description,allowed}] } */
  catalog(filter) {
    const q = typeof filter === "string" && filter.trim() ? `?filter=${encodeURIComponent(filter.trim())}` : "";
    return this._req(`/catalog${q}`);
  }

  /** cmdObj = flat WBT command object ({command, ...params}).
   * -> { ok, response? } */
  query(cmdObj) {
    return this._req("/command", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(cmdObj),
    });
  }

  /** -> { ok, id?, file? } */
  fileTicket(ticket) {
    return this._req("/ticket", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(ticket),
    });
  }
}

// Shared apply plumbing: validate via the def, journal a note, never throw.
function makeApply(def, run) {
  return async function apply(bot, a, ctx = {}) {
    const fail = (error) => {
      try {
        ctx.log && ctx.log(`[ai] action ${def.type}: ${error}`);
      } catch {}
      return { type: def.type, ok: false, error: String(error) };
    };
    try {
      const v = def.validate(a);
      if (!v.ok) return fail(v.error);
      return await run(bot, a, ctx, fail);
    } catch (e) {
      return fail((e && e.message) || e);
    }
  };
}

function journalNote(ctx, text) {
  try {
    ctx.journal?.add?.("note", clip(String(text), JOURNAL_CLIP));
  } catch {} // journal loss must not fail the action (journal.js contract)
}

/** The "wbt_query" action — run one read-only WBT oracle command. */
export function wbtQueryAction(oracle) {
  const def = {
    type: "wbt_query",
    params: {
      command: `string <= ${COMMAND_MAX_CHARS} chars — a WBT command name (discover via wbt_catalog)`,
      args: "optional object of that command's parameters (flat, e.g. {\"lbX\": 42, \"lbY\": 33})",
    },
    desc: "query the WorldBuilder world oracle (weenies, spells, landblocks, assets, validators); the result is journaled for your next check-in",
    validate(a) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
      if (a.type !== "wbt_query") return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
      if (typeof a.command !== "string" || !a.command.trim()) return { ok: false, error: "command must be a non-empty string" };
      if (a.command.length > COMMAND_MAX_CHARS) return { ok: false, error: `command must be <= ${COMMAND_MAX_CHARS} chars` };
      if (a.args != null && (typeof a.args !== "object" || Array.isArray(a.args)))
        return { ok: false, error: "args must be an object when given" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (_bot, a, ctx, fail) => {
    const o = ctx.oracle ?? oracle;
    if (!o || typeof o.query !== "function") return fail("unavailable");
    const command = a.command.trim();
    const r = await o.query({ command, ...(a.args ?? {}) });
    if (!r.ok) {
      journalNote(ctx, `wbt ${command}: FAILED ${r.error}`);
      return fail(r.error);
    }
    const summary = compactJson(r.response);
    journalNote(ctx, `wbt ${command}: ${summary}`);
    return { type: def.type, ok: true, result: { command, response: summary } };
  });
  return def;
}

/** The "wbt_catalog" action — discover what the oracle can answer. */
export function wbtCatalogAction(oracle) {
  const def = {
    type: "wbt_catalog",
    params: { filter: "optional substring to match against command names/descriptions" },
    desc: "list WorldBuilder oracle commands you may call with wbt_query (name, args, description)",
    validate(a) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
      if (a.type !== "wbt_catalog") return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
      if (a.filter != null && typeof a.filter !== "string") return { ok: false, error: "filter must be a string when given" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (_bot, a, ctx, fail) => {
    const o = ctx.oracle ?? oracle;
    if (!o || typeof o.catalog !== "function") return fail("unavailable");
    const r = await o.catalog(a.filter);
    if (!r.ok) {
      journalNote(ctx, `wbt_catalog: FAILED ${r.error}`);
      return fail(r.error);
    }
    const rows = (Array.isArray(r.commands) ? r.commands : []).filter((c) => c && c.allowed !== false);
    const shown = rows.slice(0, CATALOG_MAX_ROWS);
    const text = shown.length
      ? shown.map((c) => `${c.name} {${c.args ?? ""}} — ${c.description ?? ""}`).join("\n")
      : "no matching commands";
    journalNote(
      ctx,
      `wbt_catalog${a.filter ? ` "${a.filter}"` : ""}: ${rows.length} commands` +
        (rows.length > shown.length ? ` (first ${shown.length})` : "") +
        ` | ${shown.map((c) => c.name).join(", ") || "none"}`
    );
    return { type: def.type, ok: true, result: { total: rows.length, catalog: clip(text, RESULT_CLIP) } };
  });
  return def;
}

/** The "file_ticket" action — the playtester's bug report. Auto-attaches the
 * character position (and name when the host exposes one). */
export function fileTicketAction(oracle) {
  const def = {
    type: "file_ticket",
    params: {
      title: `string <= ${TICKET_TITLE_MAX} chars — one-line summary of the problem`,
      body: `string <= ${TICKET_BODY_MAX} chars — what happened, what you expected, how to reproduce`,
      severity: 'optional: "low" | "medium" | "high" | "critical"',
    },
    desc: "file a playtest ticket when you hit a bug, blocker, imbalance, or anything that feels wrong — your position is attached automatically",
    validate(a) {
      if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
      if (a.type !== "file_ticket") return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
      if (typeof a.title !== "string" || !a.title.trim()) return { ok: false, error: "title must be a non-empty string" };
      if (a.title.length > TICKET_TITLE_MAX) return { ok: false, error: `title must be <= ${TICKET_TITLE_MAX} chars` };
      if (typeof a.body !== "string" || !a.body.trim()) return { ok: false, error: "body must be a non-empty string" };
      if (a.body.length > TICKET_BODY_MAX) return { ok: false, error: `body must be <= ${TICKET_BODY_MAX} chars` };
      if (a.severity != null && !["low", "medium", "high", "critical"].includes(a.severity))
        return { ok: false, error: 'severity must be one of "low"|"medium"|"high"|"critical"' };
      return { ok: true };
    },
  };
  // Dedupe by normalized title for this session — a bug the model keeps
  // rediscovering (its journal forgot the filing) must not spam the tracker.
  const filed = new Set();
  const sig = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const o = ctx.oracle ?? oracle;
    if (!o || typeof o.fileTicket !== "function") return fail("unavailable");
    if (filed.has(sig(a.title)))
      return fail(`already filed this session: "${clip(a.title.trim(), 80)}" — no need to re-file, it is in the tracker`);
    let position = null;
    try {
      const p = bot?.host?.TryGetPlayerPose?.();
      if (p) position = { objCellId: p.objCellId >>> 0, x: p.x, y: p.y, z: p.z };
    } catch {}
    let character = null;
    try {
      const name = bot?.host?.TryGetPlayerName?.();
      if (typeof name === "string" && name) character = name;
    } catch {}
    const r = await o.fileTicket({
      title: a.title.trim(),
      body: a.body.trim(),
      severity: a.severity,
      character,
      position,
    });
    if (!r.ok) {
      journalNote(ctx, `file_ticket: FAILED ${r.error}`);
      return fail(r.error);
    }
    filed.add(sig(a.title));
    journalNote(ctx, `ticket filed (${r.id}): ${clip(a.title.trim(), 120)}`);
    return { type: def.type, ok: true, result: { id: r.id } };
  });
  return def;
}

/** All three defs bound to one oracle. */
export function wbtActions(oracle) {
  return [wbtQueryAction(oracle), wbtCatalogAction(oracle), fileTicketAction(oracle)];
}

/**
 * Integrator seam, registerKnowledge-shaped (knowledge.js:215): mutates a
 * PASSED-IN copy of the ACTIONS map, adding wbt_query / wbt_catalog /
 * file_ticket bound to the oracle. Integrator-time wiring — bad input throws
 * loudly here instead of silently no-opping in the LLM path.
 */
export function registerWbt(actionsMap, oracle) {
  if (!actionsMap || typeof actionsMap !== "object" || Array.isArray(actionsMap))
    throw new TypeError("registerWbt: actionsMap must be a mutable object (e.g. { ...ACTIONS })");
  const defs = wbtActions(oracle);
  for (const def of defs) actionsMap[def.type] = def;
  return defs;
}
