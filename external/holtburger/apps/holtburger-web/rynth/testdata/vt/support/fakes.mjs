// rynth/testdata/vt/support/fakes.mjs — fakes for the W1-9 SUP suites
// (tests/rynth_vt_support_*.test.mjs). Everything outside rynth/vt/support/ is
// a fake implementing only the documented contract (C2/C10): a RynthWebHost-
// shaped host (the §3.10 members the support modules call, with the seam's
// item-token semantics), the §3.2 signals bus, VtOptions (getValue/getList/
// setList), an ItemsModel, a buff loop and a combat loop.

/** Schema defaults (PLAN §4.2) for every key the support modules read. */
export const DEFAULTS = Object.freeze({
  EnableCombat: true,
  EnableBuffing: true,
  EnableLooting: true,
  EnableNavigation: false,
  MonsterRange: 40,
  RingRange: 5,
  ApproachRange: 4,
  EnableAutostack: false,
  EnableAutocram: false,
  UseDispelItems: false,
  CastDispelSelf: false,
  AutoFellowMgmt: false,
  ManaChargesWhenOff: false,
  PeaceModeWhenIdle: false,
  RebuffWhenIdle: false,
  SummonPets: false,
  CustomPetRangeEnabled: false,
  CustomPetRange: 5,
  PetMinMonsters: 1,
  HealAt: 60,
  GetManaAt: 40,
  RestamAt: 30,
  TopOffHP: 95,
  TopOffMana: 95,
  TopOffStam: 95,
  RebuffSecondsRemaining: 300,
  IdleRebuffWindowSec: 600,
  OpenDoors: false,
  OpenDoorRange: 5,
  AutoUnlockDoors: false,
  EnableManaTapping: false,
  RefillWornMana: false,
  RefillWornManaItemManaPercent: 25,
  ManaTankMinimumMana: 2500,
  ManaStoneLootCount: 5,
  MinimumHealKitSuccessChance: 0,
  SplitPeas: false,
  GrenadeMinMonsters: 0,
  PetAutoRefill: true,
});

export function makeClock(t0 = 1_000_000) {
  const c = { t: t0 };
  c.now = () => c.t;
  c.advance = (ms) => {
    c.t += ms;
    return c.t;
  };
  return c;
}

export function makeOptions(values = {}, lists = {}) {
  const v = { ...DEFAULTS, ...values };
  const l = JSON.parse(JSON.stringify(lists));
  return {
    _v: v,
    _l: l,
    getValue: (k) => v[k],
    get: (k) => (k in v ? { ok: true, value: v[k] } : { ok: false, error: `unknown option ${k}` }),
    set(k, val) {
      v[k] = val;
      return { ok: true, value: val };
    },
    getList: (n) => JSON.parse(JSON.stringify(l[n] ?? [])),
    setList(n, val) {
      l[n] = JSON.parse(JSON.stringify(val));
      return { ok: true };
    },
  };
}

export function makeBus() {
  const subs = new Map();
  return {
    on(type, fn) {
      if (!subs.has(type)) subs.set(type, new Set());
      subs.get(type).add(fn);
      return () => subs.get(type)?.delete(fn);
    },
    emit(sig) {
      for (const fn of [...(subs.get(sig.type) || []), ...(subs.get("*") || [])]) fn(sig);
    },
    count(type) {
      return subs.get(type)?.size ?? 0;
    },
  };
}

export function makeItems(entries = []) {
  const list = entries.map((e) => ({ noBuffs: false, element: null, ...e }));
  return {
    list: () => list.map((e) => ({ ...e })),
    ofKind: (k) => list.filter((e) => e.kind === k).map((e) => ({ ...e })),
    resolveGuid: (e) => Number(e && e.guid) >>> 0,
  };
}

/** Inventory row in the TryGetPlayerInventory shape. */
export function row(guid, name, extra = {}) {
  return {
    guid,
    name,
    wcid: 0,
    value: 0,
    stackSize: 1,
    maxStackSize: 0,
    equipMask: 0,
    validLocations: 0,
    itemType: 0x80,
    containerId: 0,
    placement: -1,
    itemsCapacity: 0,
    containersCapacity: 0,
    requiresBackpackSlot: false,
    attuned: 0,
    bonded: 0,
    ...extra,
  };
}

const ITEM_TOKEN_TIMEOUT_MS = 8000;

/**
 * A RynthWebHost-shaped fake. `calls` records every action ([name, ...args]).
 * The item token follows the seam (A19): same-owner re-claim re-arms,
 * minIntervalMs per owner, 8 s timeout, cleared by answer().
 */
export function makeHost(clock, init = {}) {
  const h = {
    me: 0x50000001,
    myName: "Tester",
    inv: [],
    stats: {
      vitals: { 1: { current: 100, max: 100 }, 3: { current: 100, max: 100 }, 5: { current: 100, max: 100 } },
      skills: {},
    },
    ench: [],
    mode: 1,
    busy: 0,
    castBusy: 0,
    portal: false,
    ints: new Map(),
    bools: new Map(),
    dids: new Map(),
    mana: new Map(),
    appraised: new Set(),
    appraisals: new Map(),
    lastId: new Map(),
    spells: new Map(),
    known: [],
    nearby: [],
    names: new Map(),
    dist: new Map(),
    desc: new Map(),
    physState: new Map(),
    petOwner: new Map(),
    fellowship: null,
    groundContainer: 0,
    calls: [],
    _item: null,
    _claims: new Map(),
    _cast: null,
    useDoneSeq: 0,
    sendOk: true,
    ...init,
  };
  const rec = (name, ...args) => {
    h.calls.push([name, ...args]);
    return h.sendOk;
  };
  const key = (g, p) => `${g >>> 0}:${p}`;
  Object.assign(h, {
    setInt(g, p, v) {
      h.ints.set(key(g, p), v);
    },
    setBool(g, p, v) {
      h.bools.set(key(g, p), v);
    },
    setDid(g, p, v) {
      h.dids.set(key(g, p), v);
    },
    setVital(id, current, max = 100) {
      h.stats.vitals[id] = { current, max };
    },
    actions(name) {
      return h.calls.filter((c) => c[0] === name);
    },
    clearCalls() {
      h.calls.length = 0;
    },
    /** The server's answer to an item action: clears the item token (kinds 11/13/14/48). */
    answer() {
      h._item = null;
    },
    useDone() {
      h.useDoneSeq++;
      h._item = null;
    },
    GetPlayerId: () => h.me,
    GetBusyState: () => h.busy,
    GetCastBusyState: () => h.castBusy,
    GetCurrentCombatMode: () => h.mode,
    IsPortalSpaceActive: () => h.portal === true,
    GetGroundContainerId: () => h.groundContainer,
    GetUseDoneSeq: () => h.useDoneSeq,
    TryGetPlayerInventory: () => h.inv.map((r) => ({ ...r })),
    TryGetPlayerInventoryCached: () => h.inv.map((r) => ({ ...r })),
    TryGetPackRoomCached() {
      const packs = h.inv
        .filter((r) => !r.equipMask && r.containerId === 0 && r.requiresBackpackSlot && r.itemsCapacity > 0)
        .map((p) => {
          const used = h.inv.filter((r) => r.containerId === p.guid).length;
          return { guid: p.guid, name: p.name, used, cap: p.itemsCapacity, free: Math.max(0, p.itemsCapacity - used) };
        });
      return { main: { used: 0, cap: 102, free: 102 }, containers: { used: packs.length, cap: 7, free: 7 - packs.length }, packs, freeItemSlots: 0 };
    },
    TryGetPlayerStats: () => JSON.parse(JSON.stringify(h.stats)),
    TryGetSelfEnchantments: () => h.ench.map((r) => ({ ...r })),
    TryGetObjectIntProperty: (g, p) => h.ints.get(key(g, p)),
    TryGetObjectBoolProperty: (g, p) => h.bools.get(key(g, p)),
    TryGetObjectDataIdProperty: (g, p) => h.dids.get(key(g, p)),
    TryGetObjectName: (g) => (g >>> 0 === h.me ? h.myName : h.names.get(g >>> 0)),
    TryGetObjectDistance: (g) => (h.dist.has(g >>> 0) ? h.dist.get(g >>> 0) : null),
    TryGetObjectDescFlags: (g) => h.desc.get(g >>> 0),
    TryGetObjectState: (g) => h.physState.get(g >>> 0) ?? 0,
    TryGetObjectInstanceIdProperty: (g, p) => (p === 44 ? h.petOwner.get(g >>> 0) : undefined),
    TryGetObjectAppraisal: (g) => h.appraisals.get(g >>> 0),
    NearbyGuids: () => h.nearby.slice(),
    TryGetItemMana(g) {
      const m = h.mana.get(g >>> 0);
      return m ? { cur: null, max: null, ratePerSec: null, lastIdMs: 0, stale: true, ...m } : null;
    },
    HasAppraisalData: (g) => h.appraised.has(g >>> 0) || h.mana.has(g >>> 0),
    GetLastIdTime: (g) => h.lastId.get(g >>> 0) ?? 0,
    RequestId: (g) => rec("RequestId", g >>> 0),
    TryGetSpellRecord: (id) => h.spells.get(id >>> 0) ?? null,
    TryGetKnownSpells: () => h.known.slice(),
    TryGetFellowshipInfo: () => (h.fellowship ? JSON.parse(JSON.stringify(h.fellowship)) : null),
    FindNearbyByName(name, opts = {}) {
      const want = String(name).toLowerCase();
      return h.nearby
        .filter((g) => (h.names.get(g) || "").toLowerCase() === want)
        .filter((g) => !opts.player || (g >= 0x50000001 && g <= 0x5fffffff))
        .map((g) => ({ guid: g, name: h.names.get(g), dist: h.dist.get(g) ?? 1 }));
    },
    FellowshipRecruit: (g) => rec("FellowshipRecruit", g >>> 0),
    SendTell: (n, t) => rec("SendTell", n, t),
    UseObject: (g) => rec("UseObject", g >>> 0),
    UseItemOnTarget: (i, t) => rec("UseItemOnTarget", i >>> 0, t >>> 0),
    MoveItemToContainer: (i, c, p = 0) => rec("MoveItemToContainer", i >>> 0, c >>> 0, p),
    MergeStacks: (s, d, a) => rec("MergeStacks", s >>> 0, d >>> 0, a),
    ChangeCombatMode: (m) => rec("ChangeCombatMode", m),
    CastSelf: (id) => rec("CastSelf", id >>> 0),
    tryClaimItemAction(owner, opts = {}) {
      const t = clock.now();
      if (h._item && t - h._item.issuedAt > ITEM_TOKEN_TIMEOUT_MS) h._item = null;
      if (h._item && h._item.owner !== owner) return false;
      const min = Number(opts.minIntervalMs) || 0;
      const last = h._claims.get(owner);
      if (min > 0 && last != null && t - last < min) return false;
      h._item = { owner, issuedAt: t };
      h._claims.set(owner, t);
      return true;
    },
    releaseItemAction(owner) {
      if (h._item && h._item.owner === owner) h._item = null;
    },
    tryClaimCast(owner) {
      if (h._cast && h._cast.useDoneAtIssue === h.useDoneSeq && clock.now() - h._cast.issuedAt <= 12000) return h._cast.owner === owner;
      h._cast = { owner, issuedAt: clock.now(), useDoneAtIssue: h.useDoneSeq };
      return true;
    },
    releaseCast(owner) {
      if (h._cast && h._cast.owner === owner) h._cast = null;
    },
  });
  // Accessors (Object.assign would copy their CURRENT value, not the getter).
  Object.defineProperty(h, "itemActionToken", {
    get() {
      if (h._item && clock.now() - h._item.issuedAt > ITEM_TOKEN_TIMEOUT_MS) h._item = null;
      return h._item ? { ...h._item } : null;
    },
  });
  Object.defineProperty(h, "castToken", {
    get() {
      return h._cast ? { ...h._cast } : null; // raw, like the seam (a stale claim lingers)
    },
  });
  return h;
}

/** Combat loop fake: `targets` = [{guid, dist}], `locked` guid. */
export function makeCombat(init = {}) {
  const c = { enabled: true, locked: 0, targets: [], ...init };
  c._scanTargets = () => c.targets.map((t) => ({ score: 100 - t.dist, ...t }));
  return c;
}

/** Buff loop fake with the INT-1 surface (needsBuff, idleRebuffWindowS, tick). */
export function makeBuff(init = {}) {
  const b = {
    enabled: true,
    desired: [],
    idleRebuffWindowS: 0,
    rebuffSecondsRemaining: 300,
    status: { ready: true, desired: 0, active: 0, pending: 0, blocked: null },
    needs: () => false,
    ticks: [],
    ...init,
  };
  b.needsBuff = (o = {}) => b.needs(o);
  b.tick = () => {
    b.ticks.push(b.idleRebuffWindowS);
  };
  return b;
}

export function ctx(over = {}) {
  return {
    now: 0,
    inCombat: false,
    threat: false,
    combatPinned: false,
    lootPinned: false,
    buffPinned: false,
    corpse: false,
    buffNeeded: false,
    underAttack: false,
    action: "Idle",
    ...over,
  };
}

/** check(name, fn) runner in the tests/rynth_hud_bridge.test.mjs style. */
export function makeRunner() {
  const r = { pass: 0, fail: 0 };
  r.check = async (name, fn) => {
    try {
      await fn();
      r.pass++;
      console.log(`  ok   ${name}`);
    } catch (e) {
      r.fail++;
      console.log(`  FAIL ${name}\n       ${e && e.stack ? e.stack.split("\n").slice(0, 6).join("\n       ") : e}`);
    }
  };
  return r;
}
