// tools/economy.js — the playtester's economic hands: inventory/coins/gear
// awareness, vendor trade, and equipping, over the RynthWebHost economy
// plane (webhost.js 2026-07-17: TryGetPlayerInventory/TryGetCoins/
// TryGetVendorState/BuyFromVendor/SellToVendor/WieldItem/UnwieldItem).
// Same additive registration shape as tools/knowledge.js and tools/wbt.js:
// economyActions()/registerEconomy hand the integrator actions.js-shaped
// defs; extensions.js wires them default-on.
//
// Survival invariant: every apply degrades to { ok:false, error } — a host
// without the economy capabilities (older wasm) or a vendor that never
// answers can never throw into the director loop. Results are journaled so
// the next observation's journal tail carries them back to the LLM.

const JOURNAL_CLIP = 800;
const INVENTORY_TOP_N = 15; // pack items shown, by value desc
const VENDOR_TOP_N = 25; // stock rows journaled
const MAX_TRADE_ROWS = 10;
const MAX_TRADE_QTY = 500;
const VENDOR_PROFILE_TIMEOUT_MS = 5000;
const VENDOR_PROFILE_POLL_MS = 250;

const clip = (s, n) => (s.length > n ? s.slice(0, n) + "…" : s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function journalNote(ctx, text) {
  try {
    ctx.journal?.add?.("note", clip(String(text), JOURNAL_CLIP));
  } catch {} // journal loss must not fail the action (journal.js contract)
}

/** guid as number or hex/dec string -> u32, or null. */
export function parseGuid(v) {
  if (typeof v === "number" && Number.isInteger(v) && v > 0) return v >>> 0;
  if (typeof v === "string" && /^(0x)?[0-9a-f]+$/i.test(v.trim())) {
    const n = parseInt(v.trim(), /^0x/i.test(v.trim()) ? 16 : 10);
    return Number.isFinite(n) && n > 0 ? n >>> 0 : null;
  }
  return null;
}

const hex = (g) => `0x${(g >>> 0).toString(16).toUpperCase()}`;

// Resolve an item reference ({guid} wins, else case-insensitive name
// substring) against a row list. -> { row } | { error }
export function resolveItem(rows, ref) {
  const g = parseGuid(ref.guid ?? ref.item);
  if (g) {
    const row = rows.find((r) => (r.guid ?? r.itemGuid) === g);
    return row ? { row } : { error: `no item with guid ${hex(g)}` };
  }
  const name = typeof (ref.name ?? ref.item) === "string" ? (ref.name ?? ref.item).trim().toLowerCase() : "";
  if (!name) return { error: "item ref needs a guid or a name" };
  const hits = rows.filter((r) => (r.name || "").toLowerCase().includes(name));
  if (!hits.length) return { error: `no item matching "${name}"` };
  const exact = hits.filter((r) => (r.name || "").toLowerCase() === name);
  if (exact.length === 1) return { row: exact[0] };
  if (hits.length === 1) return { row: hits[0] };
  return { error: `ambiguous "${name}": ${hits.slice(0, 5).map((r) => `${r.name} ${hex(r.guid ?? r.itemGuid)}`).join(", ")}` };
}

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

const baseValidate = (type) => (a) => {
  if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
  if (a.type !== type) return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
  return { ok: true };
};

function validateTradeRows(a) {
  if (!Array.isArray(a.items) || !a.items.length) return { ok: false, error: "items must be a non-empty array" };
  if (a.items.length > MAX_TRADE_ROWS) return { ok: false, error: `at most ${MAX_TRADE_ROWS} item rows per action` };
  for (const r of a.items) {
    if (!r || typeof r !== "object") return { ok: false, error: "each item row must be an object" };
    if (r.qty != null && (!Number.isInteger(r.qty) || r.qty < 1 || r.qty > MAX_TRADE_QTY))
      return { ok: false, error: `qty must be an int 1..${MAX_TRADE_QTY}` };
  }
  return { ok: true };
}

/** "inventory" — coins, burden, free slots, worn gear, best pack items. */
export function inventoryAction(state) {
  const def = {
    type: "inventory",
    params: {},
    desc: "read your own inventory: pyreals, burden, free slots, equipped gear, most valuable pack items (journaled for your next check-in)",
    validate: baseValidate("inventory"),
  };
  def.apply = makeApply(def, async (bot, _a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.TryGetPlayerInventory !== "function") return fail("unavailable");
    const inv = h.TryGetPlayerInventory();
    if (!inv.length) return fail("inventory not streamed yet — try again next check-in");
    const coins = typeof h.TryGetCoins === "function" ? h.TryGetCoins() : null;
    const burden = typeof h.TryGetBurden === "function" ? h.TryGetBurden() : null;
    const slots = typeof h.TryGetFreeSlots === "function" ? h.TryGetFreeSlots() : null;
    const worn = inv.filter((i) => i.equipMask !== 0);
    const pack = inv
      .filter((i) => i.equipMask === 0 && i.wcid !== 273)
      .sort((x, y) => y.value - x.value)
      .slice(0, INVENTORY_TOP_N);
    const fmt = (i) => `${i.name}${i.stackSize > 1 ? ` x${i.stackSize}` : ""} (${hex(i.guid)}, val ${i.value})`;
    const summary =
      `pyreals=${coins ?? "?"} burden=${burden ?? "?"} freeSlots=${slots ?? "?"} | ` +
      `worn(${worn.length}): ${worn.map(fmt).join("; ") || "nothing"} | ` +
      `pack top: ${pack.map(fmt).join("; ") || "empty"}`;
    journalNote(ctx, `inventory: ${summary}`);
    state.lastInventoryAt = Date.now();
    return { type: def.type, ok: true, result: { coins, burden, freeSlots: slots, worn: worn.length, items: inv.length } };
  });
  return def;
}

/** "open_vendor" — use a vendor (by name or guid) and journal its stock. */
export function openVendorAction(state) {
  const def = {
    type: "open_vendor",
    params: { vendor: "vendor NPC name (substring) or guid — must be nearby" },
    desc: "approach-open a vendor and read its stock and prices (journaled); required before buy_items/sell_items",
    validate(a) {
      const b = baseValidate("open_vendor")(a);
      if (!b.ok) return b;
      if ((typeof a.vendor !== "string" || !a.vendor.trim()) && !parseGuid(a.vendor))
        return { ok: false, error: "vendor must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.TryGetVendorState !== "function" || typeof h?.UseObject !== "function") return fail("unavailable");
    // Resolve the vendor among nearby non-attackable entities.
    let guid = parseGuid(a.vendor);
    if (!guid) {
      const want = String(a.vendor).trim().toLowerCase();
      const hits = [];
      for (const g of h.NearbyGuids?.() ?? []) {
        try {
          if (h.ObjectIsPlayer?.(g)) continue;
          const name = h.TryGetObjectName(g);
          if (name && name.toLowerCase().includes(want)) hits.push({ guid: g >>> 0, name });
        } catch {}
      }
      if (!hits.length) return fail(`no nearby entity matching "${a.vendor}"`);
      guid = hits[0].guid;
    }
    h.UseObject(guid); // walks over + requests the vendor profile
    let vs = null;
    const t0 = Date.now();
    while (Date.now() - t0 < VENDOR_PROFILE_TIMEOUT_MS) {
      vs = h.TryGetVendorState(guid);
      if (vs && vs.items.length) break;
      await sleep(VENDOR_PROFILE_POLL_MS);
    }
    if (!vs) return fail(`vendor profile did not arrive from ${hex(guid)} — is it a vendor, and close enough?`);
    state.vendorGuid = vs.vendorGuid;
    state.vendorName = vs.vendorName;
    const price = (v) => Math.ceil(v * vs.buyMultiplier);
    const rows = vs.items.slice(0, VENDOR_TOP_N).map((i) => `${i.name} @${price(i.value)}`);
    journalNote(
      ctx,
      `vendor ${vs.vendorName} (${hex(vs.vendorGuid)}) buy×${vs.buyMultiplier} sell×${vs.sellMultiplier}, ` +
        `${vs.items.length} items: ${rows.join("; ")}`
    );
    return { type: def.type, ok: true, result: { vendorGuid: hex(vs.vendorGuid), vendorName: vs.vendorName, items: vs.items.length } };
  });
  return def;
}

/** "buy_items" — buy from the last-opened vendor by item name/guid. */
export function buyItemsAction(state) {
  const def = {
    type: "buy_items",
    params: { items: `array (max ${MAX_TRADE_ROWS}) of {name or guid, qty?} — names from the open_vendor stock listing` },
    desc: "buy from the vendor you last opened with open_vendor (checks your pyreals first)",
    validate(a) {
      const b = baseValidate("buy_items")(a);
      return b.ok ? validateTradeRows(a) : b;
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.BuyFromVendor !== "function") return fail("unavailable");
    if (!state.vendorGuid) return fail("no vendor open — open_vendor first");
    const vs = h.TryGetVendorState(state.vendorGuid);
    if (!vs || !vs.items.length) return fail(`vendor ${state.vendorName ?? ""} state gone — open_vendor again`);
    const rows = [];
    let cost = 0;
    for (const r of a.items) {
      const res = resolveItem(vs.items, r);
      if (res.error) return fail(res.error);
      const qty = r.qty ?? 1;
      rows.push({ itemGuid: res.row.itemGuid, amount: qty, name: res.row.name });
      cost += Math.ceil(res.row.value * vs.buyMultiplier) * qty;
    }
    const coins = typeof h.TryGetCoins === "function" ? h.TryGetCoins() : null;
    if (coins != null && cost > coins) return fail(`estimated cost ${cost} exceeds your ${coins} pyreals`);
    if (!h.BuyFromVendor(vs.vendorGuid, rows)) return fail("buy request failed to send");
    await sleep(1500); // let the transaction land before reading coins back
    const after = typeof h.TryGetCoins === "function" ? h.TryGetCoins() : null;
    journalNote(
      ctx,
      `buy from ${vs.vendorName}: ${rows.map((r) => `${r.name} x${r.amount}`).join(", ")} ~${cost}p ` +
        `(pyreals ${coins ?? "?"} -> ${after ?? "?"})`
    );
    return { type: def.type, ok: true, result: { bought: rows.map((r) => ({ name: r.name, qty: r.amount })), estCost: cost, coinsAfter: after } };
  });
  return def;
}

/** "sell_items" — sell pack items to the last-opened vendor. */
export function sellItemsAction(state) {
  const def = {
    type: "sell_items",
    params: { items: `array (max ${MAX_TRADE_ROWS}) of {name or guid, qty?} — from your own inventory` },
    desc: "sell pack items to the vendor you last opened with open_vendor",
    validate(a) {
      const b = baseValidate("sell_items")(a);
      return b.ok ? validateTradeRows(a) : b;
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.SellToVendor !== "function") return fail("unavailable");
    if (!state.vendorGuid) return fail("no vendor open — open_vendor first");
    const inv = h.TryGetPlayerInventory?.() ?? [];
    if (!inv.length) return fail("inventory not streamed yet");
    const rows = [];
    for (const r of a.items) {
      const res = resolveItem(inv.filter((i) => i.equipMask === 0 && i.wcid !== 273), r);
      if (res.error) return fail(res.error);
      rows.push({ itemGuid: res.row.guid, amount: r.qty ?? 1, name: res.row.name });
    }
    if (!h.SellToVendor(state.vendorGuid, rows)) return fail("sell request failed to send");
    await sleep(1500);
    const after = typeof h.TryGetCoins === "function" ? h.TryGetCoins() : null;
    journalNote(ctx, `sell to ${state.vendorName ?? "vendor"}: ${rows.map((r) => `${r.name} x${r.amount}`).join(", ")} (pyreals now ${after ?? "?"})`);
    return { type: def.type, ok: true, result: { sold: rows.map((r) => ({ name: r.name, qty: r.amount })), coinsAfter: after } };
  });
  return def;
}

/** "equip_item" / "unequip_item" / "use_item" — gear + consumables. */
export function equipItemAction() {
  const def = {
    type: "equip_item",
    params: { item: "pack item name or guid (see inventory)" },
    desc: "wield/wear a pack item where it fits (weapon, wand, armor, shield…)",
    validate(a) {
      const b = baseValidate("equip_item")(a);
      if (!b.ok) return b;
      if ((typeof a.item !== "string" || !a.item.trim()) && !parseGuid(a.item)) return { ok: false, error: "item must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.WieldItem !== "function") return fail("unavailable");
    const inv = (h.TryGetPlayerInventory?.() ?? []).filter((i) => i.equipMask === 0);
    const res = resolveItem(inv, { item: a.item });
    if (res.error) return fail(res.error);
    if (!res.row.validLocations) return fail(`${res.row.name} is not equippable`);
    if (!h.WieldItem(res.row.guid)) return fail("wield request failed to send");
    journalNote(ctx, `equipping ${res.row.name} (${hex(res.row.guid)}) — confirm with inventory next check-in`);
    return { type: def.type, ok: true, result: { item: res.row.name } };
  });
  return def;
}

export function unequipItemAction() {
  const def = {
    type: "unequip_item",
    params: { item: "worn item name or guid" },
    desc: "take off a worn/wielded item back into your pack",
    validate(a) {
      const b = baseValidate("unequip_item")(a);
      if (!b.ok) return b;
      if ((typeof a.item !== "string" || !a.item.trim()) && !parseGuid(a.item)) return { ok: false, error: "item must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.UnwieldItem !== "function") return fail("unavailable");
    const worn = h.TryGetEquipment?.() ?? [];
    const res = resolveItem(worn, { item: a.item });
    if (res.error) return fail(res.error);
    if (!h.UnwieldItem(res.row.guid)) return fail("unwield request failed to send");
    journalNote(ctx, `unequipping ${res.row.name} (${hex(res.row.guid)})`);
    return { type: def.type, ok: true, result: { item: res.row.name } };
  });
  return def;
}

export function useItemAction() {
  const def = {
    type: "use_item",
    params: { item: "inventory item name or guid (food, potion, key…)" },
    desc: "use an inventory item on yourself (eat, drink, apply)",
    validate(a) {
      const b = baseValidate("use_item")(a);
      if (!b.ok) return b;
      if ((typeof a.item !== "string" || !a.item.trim()) && !parseGuid(a.item)) return { ok: false, error: "item must be a name or guid" };
      return { ok: true };
    },
  };
  def.apply = makeApply(def, async (bot, a, ctx, fail) => {
    const h = bot?.host;
    if (typeof h?.UseObject !== "function") return fail("unavailable");
    const inv = h.TryGetPlayerInventory?.() ?? [];
    const res = resolveItem(inv, { item: a.item });
    if (res.error) return fail(res.error);
    if (!h.UseObject(res.row.guid)) return fail("use request failed to send");
    journalNote(ctx, `using ${res.row.name} (${hex(res.row.guid)})`);
    return { type: def.type, ok: true, result: { item: res.row.name } };
  });
  return def;
}

/** All economy defs sharing one vendor-session state. */
export function economyActions() {
  const state = {}; // { vendorGuid, vendorName, lastInventoryAt }
  return [
    inventoryAction(state),
    openVendorAction(state),
    buyItemsAction(state),
    sellItemsAction(state),
    equipItemAction(),
    unequipItemAction(),
    useItemAction(),
  ];
}

/**
 * Integrator seam, registerKnowledge-shaped: mutates a PASSED-IN copy of the
 * ACTIONS map. Returns the defs. Throws loudly on programmer error.
 */
export function registerEconomy(actionsMap) {
  if (!actionsMap || typeof actionsMap !== "object" || Array.isArray(actionsMap))
    throw new TypeError("registerEconomy: actionsMap must be a mutable object (e.g. { ...ACTIONS })");
  const defs = economyActions();
  for (const def of defs) actionsMap[def.type] = def;
  return defs;
}
