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

import { parseGuid, resolveItem } from "./economy.js";

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
  let g = parseGuid(ref);
  if (!g && typeof ref === "string") {
    // Models habitually write "Door 0x7860202d" (name + guid in one string);
    // a pure substring match on that fails while the guid sits in plain
    // sight. Extract an embedded 0x guid and prefer it. (Recurring live
    // failure, 3 soaks running.)
    const m = ref.match(/0x[0-9a-fA-F]{3,8}\b/);
    if (m) g = parseGuid(m[0]);
  }
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

/**
 * Walk into use range before acting. The retail contract is that the CLIENT
 * closes the distance before the server's range check — ACE answers a far
 * Use with UseDone(OutOfRange) and fires no emote. Observed live (2026-07-17):
 * Jonathan (academyguardexitholtburg) used repeatedly across three soaks with
 * a bare UseObject send; his quest registry stayed empty — every Use was
 * silently out of range. pursuitStatus low 16: 0 idle / 1 active / 2 arrived /
 * 3 failed (read-clear on >=2). Degrades to "just send" when the mover is
 * unavailable — the server error now reaches the observation either way.
 */
async function approach(h, guid, ms = 12000) {
  if (typeof h.PursueObject !== "function") return "no-mover";
  if (!h.PursueObject(guid, 1.0, 0, true)) return "no-mover";
  // Do NOT poll GetPursuitStatus here: its arrived/failed latch is READ-CLEAR
  // and the bot kernel's tick loop consumes it first, so this seam always saw
  // idle and fired the Use mid-walk from across the room (observed live twice:
  // Jonathan "used" from 25m+, no emote, walk:idle on every action). The
  // player's own pose can't be stolen — walk until the bot stops moving, then
  // act. "no-walk" = never moved (already adjacent, or pursue rejected):
  // proceed either way; the server verdict lands in the heard section.
  const pose = () => {
    try { const p = h.TryGetPlayerPose?.(); return p ? { x: p.x, y: p.y, cell: p.objCellId >>> 0 } : null; }
    catch { return null; }
  };
  let last = pose();
  if (!last) { await new Promise((r) => setTimeout(r, 1200)); return "blind"; }
  const t0 = Date.now();
  let lastMoveT = t0;
  while (Date.now() - t0 < ms) {
    await new Promise((r) => setTimeout(r, 400));
    const cur = pose();
    if (!cur) return "blind";
    const moved = cur.cell !== last.cell || Math.hypot(cur.x - last.x, cur.y - last.y) > 0.5;
    if (moved) lastMoveT = Date.now();
    last = cur;
    if (Date.now() - lastMoveT > 1600)
      return Date.now() - t0 <= 2200 ? "no-walk" : "settled";
  }
  return "timeout";
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
    const walk = await approach(h, res.guid);
    if (!h.UseObject(res.guid)) return fail("use request failed to send");
    ctx.track?.(res.guid, res.name);
    journalNote(ctx, `use_object ${res.name} (${hex(res.guid)}) — walk:${walk ?? "n/a"}, used; confirm result on next check-in`);
    return { type: def.type, ok: true, result: { object: res.name, guid: hex(res.guid), walk: walk ?? undefined } };
  });
  return def;
}

/** "goto_object" — walk to a nearby object WITHOUT using it (approach/scout). */
export function gotoObjectAction() {
  const def = {
    type: "goto_object",
    params: { object: "name (substring) or guid of a nearby object from your 'nearby' perception line — prefer the guid" },
    desc: "walk over to a nearby object or NPC without interacting: get within reach, scout what is around it, and bring new objects into your perception range. Use this to explore toward the farthest interesting thing you can see.",
    validate(a) {
      const b = baseValidate("goto_object")(a);
      if (!b.ok) return b;
      if ((typeof a.object !== "string" || !a.object.trim()) && !parseGuid(a.object))
        return { ok: false, error: "object must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.PursueObject !== "function" || typeof h?.NearbyGuids !== "function") return fail("unavailable");
    const res = resolveNearby(h, a.object);
    if (res.error) return fail(res.error);
    if (!h.PursueObject(res.guid, 1.0, 0, true)) return fail("pursue request failed to send");
    ctx.track?.(res.guid, res.name);
    journalNote(ctx, `goto_object ${res.name} (${hex(res.guid)}) — walking over; check the pos line next check-in to confirm arrival`);
    return { type: def.type, ok: true, result: { object: res.name, guid: hex(res.guid) } };
  });
  return def;
}

/** "give_item" — hand an inventory item to a nearby NPC/player (quest turn-ins). */
export function giveItemAction() {
  const def = {
    type: "give_item",
    params: {
      item: "name (substring) or guid of an item in YOUR inventory",
      target: "name (substring) or guid of a nearby NPC/player from your 'nearby' perception line — prefer the guid",
      qty: "optional int >= 1 (default 1)",
    },
    desc: "give one of your inventory items to a nearby NPC or player: quest turn-ins, handing a token or quest item to an NPC. Fire-and-forget — the server validates; confirm via chat/inventory on your next check-in.",
    validate(a) {
      const b = baseValidate("give_item")(a);
      if (!b.ok) return b;
      if ((typeof a.item !== "string" || !a.item.trim()) && !parseGuid(a.item))
        return { ok: false, error: "item must be a name or guid" };
      if ((typeof a.target !== "string" || !a.target.trim()) && !parseGuid(a.target))
        return { ok: false, error: "target must be a name or guid" };
      if (a.qty != null && (!Number.isInteger(a.qty) || a.qty < 1))
        return { ok: false, error: "qty must be an int >= 1" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.GiveObject !== "function" || typeof h?.NearbyGuids !== "function" ||
        typeof h?.TryGetPlayerInventory !== "function") return fail("unavailable");
    const tgt = resolveNearby(h, a.target);
    if (tgt.error) return fail(tgt.error);
    const rows = h.TryGetPlayerInventory();
    if (!rows || !rows.length) return fail("inventory not streamed yet — try again next check-in");
    const it = resolveItem(rows, { item: a.item });
    if (it.error) return fail(it.error);
    const itemGuid = (it.row.guid ?? it.row.itemGuid) >>> 0;
    const qty = a.qty ?? 1;
    const walk = await approach(h, tgt.guid);
    if (!h.GiveObject(tgt.guid, itemGuid, qty)) return fail("give request failed to send");
    ctx.track?.(tgt.guid, tgt.name);
    journalNote(
      ctx,
      `give_item ${it.row.name}${qty > 1 ? ` x${qty}` : ""} -> ${tgt.name} (${hex(tgt.guid)}) — server validates; confirm via chat/inventory next check-in`
    );
    return { type: def.type, ok: true, result: { item: it.row.name, guid: hex(itemGuid), target: tgt.name, targetGuid: hex(tgt.guid), qty, walk: walk ?? undefined } };
  });
  return def;
}

export function worldActions() {
  return [useObjectAction(), giveItemAction(), gotoObjectAction()];
}

/** Integrator seam, registerEconomy-shaped. */
export function registerWorld(actionsMap) {
  if (!actionsMap || typeof actionsMap !== "object" || Array.isArray(actionsMap))
    throw new TypeError("registerWorld: actionsMap must be a mutable object (e.g. { ...ACTIONS })");
  const defs = worldActions();
  for (const def of defs) actionsMap[def.type] = def;
  return defs;
}
