// observe_assemble.js — salience-tagged, budgeted observation assembler (C4-1).
//
// The director's check-in observation is composed from several subsystems
// (LOCATION, mission, scratchpad, deltas, heard-chat, the base observation).
// Historically these were concatenated raw (extensions.js `parts.join`): the
// base text is self-capped, but every section PREPENDED onto it was uncapped,
// so a fat scratchpad + a full heard-buffer + long deltas could push the whole
// block far past the director's small-context budget with no ceiling.
//
// This module puts a total-token ceiling and per-subsystem quotas on the
// assembly, and — when it must shed to fit — sheds by SALIENCE: an unchanged
// STEADY reference line yields before a CORRECTION the agent must act on.
//
// Salience tiers, highest attention → lowest (drop lowest first):
//   CORRECTION  the agent is doing something wrong right now — fix it
//   DECISION    ground truth that drives the next move (where am I, what next)
//   ANOMALY     something unexpected surfaced (new speech, an odd outcome)
//   CHANGE      routine deltas since last check-in
//   STEADY      unchanged reference state (already seen; safe to drop first)
//
// PINNED (orthogonal to tier, P1 #7): a section may set `pinned: true` to opt
// out of shedding entirely — e.g. the model's own persistent scratchpad,
// which callers document as "never dropped" and must not silently vanish
// under a small `totalTokens`. A pinned section is always kept in full; its
// token cost is deducted from the shared budget FIRST, so it is the TIERED
// sections that get squeezed when a pin and the ceiling collide, never the
// pin itself. Quotas (per-subsystem caps) also do not apply to a pinned
// section — pin means "never truncated, never dropped," full stop. A pin
// does not exempt garbage: empty/malformed text is still discarded up front
// (step 1). Generic by design: any subsystem can set it, this module
// hardcodes none.
//
// PURE module: no host, no imports, never throws on hostile input (returns a
// best-effort result) so its caller can trust `.text` and keep its own
// degrade-to-`parts.join` fallback as belt-and-suspenders. Subsystem NAMES are
// caller-supplied (this module hardcodes none) — it stays general-purpose.

"use strict";

// Ordered highest-priority → lowest. Index == drop rank (last dropped first).
export const SALIENCE_TIERS = ["CORRECTION", "DECISION", "ANOMALY", "CHANGE", "STEADY"];
const TIER_RANK = SALIENCE_TIERS.reduce((m, t, i) => ((m[t] = i), m), {});
const DEFAULT_TIER = "STEADY"; // unknown/absent tier -> least salient, shed first

// Token proxy: the real tokenizer lives server-side; ~4 chars/token is the
// standard English heuristic and keeps this module deterministic + offline.
const CHARS_PER_TOKEN = 4;

/** Deterministic token estimate for a string (0 for empty/nullish). */
export function estimateTokens(text) {
  if (text == null) return 0;
  const s = typeof text === "string" ? text : String(text);
  return s.length === 0 ? 0 : Math.ceil(s.length / CHARS_PER_TOKEN);
}

function tokensToChars(t) {
  const n = Number.isFinite(t) ? Math.floor(t) : 0;
  return n > 0 ? n * CHARS_PER_TOKEN : 0;
}

// Truncate `text` so estimateTokens(result) <= maxTokens. A one-char "…" marks
// the cut without breaking the ceiling (slice to maxChars-1, append "…" == 1
// code unit, so length lands exactly on maxChars).
function truncateToTokens(text, maxTokens) {
  const maxChars = tokensToChars(maxTokens);
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - 1) + "…";
}

// Public view of a section — no internal bookkeeping fields leak out.
function pub(s) {
  return { subsystem: s.subsystem, tier: s.tier, id: s.id, tokens: s.tokens, pinned: !!s.pinned };
}

/**
 * assembleObservation(sections, { totalTokens, quotas, separator })
 *
 *  sections: Array<{ subsystem?, tier?, pinned?, text, id? }> in INJECTION
 *            order (that order is preserved in the output; tiers/pinned
 *            govern only what is SHED). `pinned: true` -> never truncated,
 *            never dropped, exempt from quotas; see the PINNED note above.
 *  totalTokens: hard ceiling on the assembled text (default: no ceiling).
 *               A pin can push the assembled text over this ceiling (a pin
 *               always wins) — the ceiling stays airtight for everything else.
 *  quotas: { [subsystem]: maxTokens } cumulative per-subsystem cap (optional,
 *          ignored for pinned sections).
 *  separator: join string between kept sections (default "\n").
 *
 * Returns { text, kept: pub[], dropped: {..,reason}[], tokens }.
 * Never throws: malformed sections are skipped, hostile getters are caught.
 */
export function assembleObservation(sections, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const list = Array.isArray(sections) ? sections : [];
  const totalTokens = Number.isFinite(o.totalTokens) ? Math.max(0, o.totalTokens) : Infinity;
  const quotas = o.quotas && typeof o.quotas === "object" ? o.quotas : {};
  const sep = typeof o.separator === "string" ? o.separator : "\n";

  // 1) Normalize: keep only sections with non-empty string text. Reading a
  //    section's fields may throw (hostile getter) — skip those, never bubble.
  const norm = [];
  for (let i = 0; i < list.length; i++) {
    let s, text, tier, subsystem, id, pinned;
    try {
      s = list[i];
      if (!s || typeof s !== "object") continue;
      text = typeof s.text === "string" ? s.text : s.text == null ? "" : String(s.text);
      if (!text) continue;
      tier = TIER_RANK[s.tier] != null ? s.tier : DEFAULT_TIER;
      subsystem =
        typeof s.subsystem === "string" && s.subsystem
          ? s.subsystem
          : typeof s.id === "string" && s.id
            ? s.id
            : "misc";
      id = typeof s.id === "string" && s.id ? s.id : subsystem;
      pinned = s.pinned === true;
    } catch {
      continue;
    }
    norm.push({ subsystem, tier, text, id, pinned, index: i, tokens: estimateTokens(text) });
  }

  const dropped = [];

  // 2) Per-subsystem quota: a cumulative token cap per subsystem. Over-quota
  //    sections are truncated (or dropped whole once the subsystem is spent).
  //    Pinned sections are exempt (a pin overrides quota same as it overrides
  //    the total budget in step 3) and do not consume the subsystem's quota.
  const usedBySub = new Map();
  for (const s of norm) {
    if (s.pinned) continue;
    const q = quotas[s.subsystem];
    if (!Number.isFinite(q)) continue;
    const used = usedBySub.get(s.subsystem) || 0;
    const remain = q - used;
    if (remain <= 0) {
      s.text = "";
      s.tokens = 0;
      dropped.push({ ...pub(s), reason: "quota" });
      continue;
    }
    if (s.tokens > remain) {
      s.text = truncateToTokens(s.text, remain);
      s.tokens = estimateTokens(s.text);
    }
    usedBySub.set(s.subsystem, used + s.tokens);
  }
  const alive = norm.filter((s) => s.text);

  // 3) Total budget: PINNED sections are kept whole first and unconditionally
  //    — never truncated, never dropped — with their token cost deducted from
  //    the shared budget up front (remaining may go negative: a pin can
  //    exceed the ceiling on its own, see step 4). Everything else then fills
  //    by KEEP priority (tier rank asc, then injection order) against
  //    whatever budget the pins left behind, so the most salient TIERED
  //    sections claim it first and the least salient (STEADY, last) get the
  //    remainder — truncated or shed. This is what makes "drop STEADY first"
  //    fall out for free, with "never drop a pin" strictly senior to it.
  const keep = new Set();
  let remaining = totalTokens;
  for (const s of alive) {
    if (!s.pinned) continue;
    keep.add(s);
    remaining -= s.tokens;
  }
  const byPriority = alive
    .filter((s) => !s.pinned)
    .sort((a, b) => TIER_RANK[a.tier] - TIER_RANK[b.tier] || a.index - b.index);
  for (const s of byPriority) {
    const budget = Math.max(0, remaining);
    if (budget <= 0) {
      dropped.push({ ...pub(s), reason: "budget" });
      continue;
    }
    if (s.tokens <= budget) {
      keep.add(s);
      remaining -= s.tokens;
    } else {
      s.text = truncateToTokens(s.text, budget);
      s.tokens = estimateTokens(s.text);
      if (s.text) {
        keep.add(s);
        remaining -= s.tokens;
      } else {
        dropped.push({ ...pub(s), reason: "budget" });
      }
    }
  }

  // 4) Emit in INJECTION order. A final hard slice makes the ceiling airtight
  //    regardless of separator overhead (mirrors observe.js's own last-resort
  //    slice); in the common under-budget case nothing is cut here. Pinned
  //    sections must never be touched by this safety net (that would just be
  //    step 3's truncation reintroduced through the back door), so any
  //    trimming needed to fit comes out of the non-pinned kept sections,
  //    least-salient-first (same order as step 3) — never the pins.
  const maxChars = Number.isFinite(totalTokens) ? tokensToChars(totalTokens) : Infinity;
  let text = alive.filter((s) => keep.has(s)).map((s) => s.text).join(sep);
  if (text.length > maxChars) {
    let overflow = text.length - maxChars;
    for (let i = byPriority.length - 1; i >= 0 && overflow > 0; i--) {
      const s = byPriority[i];
      if (!keep.has(s) || !s.text) continue;
      if (s.text.length <= overflow) {
        overflow -= s.text.length;
        dropped.push({ ...pub(s), reason: "budget" });
        s.text = "";
        s.tokens = 0;
        keep.delete(s);
      } else {
        s.text = s.text.slice(0, s.text.length - overflow);
        s.tokens = estimateTokens(s.text);
        overflow = 0;
      }
    }
    text = alive.filter((s) => keep.has(s)).map((s) => s.text).join(sep);
  }
  const kept = alive.filter((s) => keep.has(s));

  return { text, kept: kept.map(pub), dropped, tokens: estimateTokens(text) };
}
