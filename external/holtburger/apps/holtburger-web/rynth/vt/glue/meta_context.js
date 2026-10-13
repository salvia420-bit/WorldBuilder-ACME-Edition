// rynth/vt/glue/meta_context.js — the MetaContext (PLAN §3.12) the meta
// engine runs against, built over the live bot and the VT layer (INT-2,
// §3.15). Every read is guarded and every member is resolved LIVE through
// `layer` (the composition fills it in order; nothing is read at build time),
// so the context survives the layer's own construction order.
//
// Contract notes (META review §6, binding):
//   settings.get(name)  = options.get(name, { vtUnits: true }) — GetOpt and
//                         setting_X read VTank units (lbf ⇒ metres ÷ 240);
//   settings.disableMeta(reason) = options.set("EnableMeta", false) + a log;
//   bagGet/bagSet        = options.bag.get/set (unknown, meta-only options);
//   player.itemCount     = stack-aware, exact name, case-insensitive;
//   world.monsters()     = live creatures {guid, name, dist, hf (-1 unknown,
//                          0 dead), attackable}, memo per host snapshot seq;
//   player.selfEnchantments() rows {spellId, remainingS, permanent, …}.

import { worldX, worldY } from "../../nav_frame.js";
import { portalSpaceActive } from "../../portal_gate.js";

const ITEM_TYPE_CREATURE = 16;
const PLAYER_GUID_MIN = 0x50000000;
const PLAYER_GUID_MAX = 0x5fffffff;

function safe(fn, dflt = null) {
  try {
    const v = fn();
    return v === undefined ? dflt : v;
  } catch {
    return dflt;
  }
}

const finite = (x) => typeof x === "number" && Number.isFinite(x);

/**
 * @param {{ bot: object, host?: object, layer: object }} deps
 *   layer = the VtLayer under construction: options, nav, planner, views,
 *   now(), log(), print(), runChat() are read when a member is called.
 */
export function buildMetaContext({ bot = null, host = null, layer } = {}) {
  const L = () => layer || {};
  const H = () => safe(() => bot?.host ?? null, null) || host || null;
  const call = (name, ...args) => {
    const h = H();
    const f = h && h[name];
    if (typeof f !== "function") return undefined;
    try {
      return f.apply(h, args);
    } catch {
      return undefined;
    }
  };
  const options = () => L().options || null;
  const log = (m) => safe(() => L().log?.(m));

  let monMemo = { seq: undefined, rows: [] };

  function inventory() {
    const h = H();
    if (!h) return [];
    const rows = typeof h.TryGetPlayerInventoryCached === "function" ? call("TryGetPlayerInventoryCached") : call("TryGetPlayerInventory");
    return Array.isArray(rows) ? rows : [];
  }

  function pose() {
    const p = call("TryGetPlayerPose");
    if (!p || typeof p !== "object") return null;
    const objCellId = Number(p.objCellId) >>> 0;
    const x = Number(p.x);
    const y = Number(p.y);
    const z = Number(p.z);
    if (!finite(x) || !finite(y)) return null;
    return { objCellId, x, y, z: finite(z) ? z : 0 };
  }

  function monsters() {
    const seq = safe(() => H()?.snap?.seq, undefined);
    if (seq !== undefined && seq !== null && monMemo.seq === seq) return monMemo.rows;
    const rows = [];
    const me = Number(call("GetPlayerId")) >>> 0;
    const list = call("NearbyGuids");
    for (const g0 of Array.isArray(list) ? list : []) {
      const g = Number(g0) >>> 0;
      if (!g || g === me) continue;
      if (g >= PLAYER_GUID_MIN && g <= PLAYER_GUID_MAX) continue;
      if (call("ObjectIsPlayer", g) === true) continue;
      if (Number(call("TryGetObjectIntProperty", g, 1)) !== ITEM_TYPE_CREATURE) continue;
      const dist = Number(call("TryGetObjectDistance", g));
      if (!finite(dist)) continue;
      const hfRaw = Number(call("TryGetTargetHealthFraction", g));
      rows.push({
        guid: g,
        name: String(call("TryGetObjectName", g) ?? ""),
        dist,
        hf: finite(hfRaw) ? hfRaw : -1,
        attackable: call("ObjectIsAttackable", g) !== false,
      });
    }
    monMemo = { seq, rows };
    return rows;
  }

  return {
    now: () => safe(() => L().now(), Date.now()),
    log: (m) => log(m),
    print: (text, category = 0) => safe(() => L().print?.(text, category)),
    settings: {
      get: (name) => safe(() => options().get(name, { vtUnits: true }), { ok: false, error: "settings unavailable" }),
      set: (name, raw, opts = {}) =>
        safe(() => options().set(name, raw, { ...(opts && typeof opts === "object" ? opts : {}), source: "meta" }), {
          ok: false,
          error: "settings unavailable",
        }),
      getValue: (key) => safe(() => options().getValue(key), undefined),
      bagGet: (name) => safe(() => options().bag.get(name), undefined),
      bagSet: (name, v) => safe(() => options().bag.set(name, v), { ok: false }),
      disableMeta: (reason) => {
        safe(() => options().set("EnableMeta", false, { source: "meta" }));
        log(`meta disabled: ${reason}`);
      },
    },
    chat: {
      run: (line) => safe(() => L().runChat?.(line, { source: "meta" })),
    },
    player: {
      guid: () => Number(call("GetPlayerId")) >>> 0,
      pose: () => pose(),
      world: () => {
        const p = pose();
        if (!p) return null;
        return { wx: worldX(p.objCellId, p.x), wy: worldY(p.objCellId, p.y), z: p.z };
      },
      packFreeMain: () => {
        const h = H();
        const room = h && typeof h.TryGetPackRoomCached === "function" ? call("TryGetPackRoomCached") : call("TryGetPackRoom");
        const free = room && room.main ? Number(room.main.free) : NaN;
        return finite(free) ? free : null;
      },
      burdenPct: () => {
        const b = Number(call("TryGetBurden"));
        return finite(b) ? b : null;
      },
      itemCount: (name) => {
        const want = String(name ?? "").trim().toLowerCase();
        if (!want) return 0;
        let n = 0;
        for (const r of inventory()) {
          if (String(r && r.name ? r.name : "").trim().toLowerCase() !== want) continue;
          const s = Number(r.stackSize);
          n += finite(s) && s > 0 ? s : 1;
        }
        return n;
      },
      selfEnchantments: () => {
        const rows = call("TryGetSelfEnchantments");
        return Array.isArray(rows) ? rows : [];
      },
    },
    world: { monsters: () => monsters() },
    nav: {
      isEmpty: () => safe(() => (L().nav ? L().nav.isEmpty() === true : true), true),
      minDistToAnyPointM: () => safe(() => (L().nav ? L().nav.minDistToAnyPointM() : Infinity), Infinity),
      loadEmbedded: (tag, metaNav) =>
        safe(() => (L().nav ? L().nav.loadEmbedded(tag, metaNav) : { ok: false, error: "navigation is not available" }), {
          ok: false,
          error: "navigation is not available",
        }),
    },
    // NeedToBuff ≡ the kernel's own "needs buffing" predicate (INT-1 C10).
    buff: { needsBuff: () => safe(() => bot?.buff?.needsBuff?.() === true, false) },
    monsters: { priorityOf: (guid) => safe(() => L().planner.priorityOf(guid), 1) },
    portal: { active: () => safe(() => portalSpaceActive(H()) === true, false) },
    get views() {
      return safe(() => L().views ?? null, null);
    },
  };
}

export default buildMetaContext;
