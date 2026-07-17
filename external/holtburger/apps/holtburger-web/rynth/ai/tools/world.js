// tools/world.js — the playtester's general "hands" for the world: use/interact
// with ANY nearby object by name or guid (enter a portal, talk to/open an NPC,
// open a door or chest, pull a lever, read a sign). This is a GENERAL primitive,
// not a scripted path: it resolves a nearby object and calls the host's
// UseObject; the LLM decides what to interact with (from its "nearby"
// perception line, observe_ext.js probeNearbyObjects).
//
// Complements economy.open_vendor (the specialized vendor-profile flow) — for
// non-vendor interactions (the "Exit to Holtburg" portal, generic NPCs, doors)
// use_object is the tool. Same additive registration shape as economy.js.
//
// Survival invariant: every apply degrades to { ok:false, error }.

import { parseGuid } from "./economy.js";

const JOURNAL_CLIP = 800;
const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const hex = (g) => `0x${(g >>> 0).toString(16).toUpperCase()}`;

function journalNote(ctx, text) {
  try {
    ctx.journal?.add?.("note", clip(String(text), JOURNAL_CLIP));
  } catch {}
}

function makeApply(def, run) {
  return async function apply(bot, a, ctx = {}) {
    const fail = (error) => {
      try { ctx.log && ctx.log(`[ai] action ${def.type}: ${error}`); } catch {}
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

const baseValidate = (type) => (a) => {
  if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
  if (a.type !== type) return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
  return { ok: true };
};

// Resolve a nearby object by guid (wins) or case-insensitive name substring.
// -> { guid, name } | { error }
function resolveNearby(h, ref) {
  const g = parseGuid(ref);
  if (g) {
    const name = (typeof h.TryGetObjectName === "function" ? h.TryGetObjectName(g) : null) || "?";
    return { guid: g, name };
  }
  const want = typeof ref === "string" ? ref.trim().toLowerCase() : "";
  if (!want) return { error: "object must be a name or guid" };
  const hits = [];
  for (const gg of h.NearbyGuids?.() ?? []) {
    let name = null;
    try { name = h.TryGetObjectName(gg); } catch {}
    if (name && name.toLowerCase().includes(want)) hits.push({ guid: gg >>> 0, name });
  }
  if (!hits.length) return { error: `no nearby object matching "${ref}" — check your 'nearby' perception list` };
  const exact = hits.filter((x) => x.name.toLowerCase() === want);
  if (exact.length === 1) return exact[0];
  if (hits.length === 1) return hits[0];
  return { error: `ambiguous "${ref}": ${hits.slice(0, 5).map((x) => `${x.name} ${hex(x.guid)}`).join(", ")}` };
}

/** "use_object" — interact with a nearby world object (portal, NPC, door, sign…). */
export function useObjectAction() {
  const def = {
    type: "use_object",
    params: { object: "name (substring) or guid of a nearby object from your 'nearby' perception line" },
    desc: "walk up to and use/interact with a nearby world object: enter a portal, talk to or open an NPC, open a door or chest, pull a lever, read a sign. This is how you move between areas and start interactions.",
    validate(a) {
      const b = baseValidate("use_object")(a);
      if (!b.ok) return b;
      if ((typeof a.object !== "string" || !a.object.trim()) && !parseGuid(a.object))
        return { ok: false, error: "object must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.UseObject !== "function" || typeof h?.NearbyGuids !== "function") return fail("unavailable");
    const res = resolveNearby(h, a.object);
    if (res.error) return fail(res.error);
    if (!h.UseObject(res.guid)) return fail("use request failed to send");
    journalNote(ctx, `use_object ${res.name} (${hex(res.guid)}) — walking over to interact; confirm result on next check-in`);
    return { type: def.type, ok: true, result: { object: res.name, guid: hex(res.guid) } };
  });
  return def;
}

export function worldActions() {
  return [useObjectAction()];
}

/** Integrator seam, registerEconomy-shaped. */
export function registerWorld(actionsMap) {
  if (!actionsMap || typeof actionsMap !== "object" || Array.isArray(actionsMap))
    throw new TypeError("registerWorld: actionsMap must be a mutable object (e.g. { ...ACTIONS })");
  const defs = worldActions();
  for (const def of defs) actionsMap[def.type] = def;
  return defs;
}
