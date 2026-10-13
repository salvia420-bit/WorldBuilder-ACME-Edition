// rynth/vt/combat/attack_planner.js — the ONLY object rynth/combat_loop.js
// talks to for the VTank Monsters/Items tabs (PLAN W1-7 CMB §3.9; INT-1 hooks
// §3.14). combat_loop attaches it as `combat.vt` only while isActive() (D10),
// so the legacy war/scan path stays byte-identical at the Default profile;
// acquireRangeM() is bound to the ALWAYS-set combat.acquireRangeFn (critic G9).
//
// Hooks (all never throw):
//   scanVerdict(guid, distM)   per scan candidate: null | {ignore:true} | {scoreBias: P×1000}
//   ensureLoadout(target, now) ENGAGE, before the mode toggle: "ok" | "busy"
//   attackAllowed(target)      melee/missile swing gate (A column)
//   nextCast(target, {mode, dist, now})  magic step: null (legacy _pickWarSpell)
//                              | {skip:true} | {done:true} | {spellId, kind, untargeted, family}
//   onCastIssued(target, plan, sent)
//
// Planner semantics (normative, §3.9): per lock in magic mode —
//  1. debuffs of the resolved entry in order I → V(element) → ExVuln → G/B/Y
//     (current weapon: melee → G first, missile → B first, magic → Y first; the
//     other two in G,B,Y order) → F → WC → FC → DC; the first key neither
//     active in the ledger nor unavailable → its best castable rung (gated by
//     the spell's OWN school); no known rung ⇒ markUnavailable(family) and the
//     next key (fixes the C# stuck-wand hazard, U6 §2.3).
//  2. Cp / Cs: a DoT attack when not active (window = its duration) → kind "dot".
//  3. A off and R off ⇒ {done:true}; scanVerdict then excludes the guid while —
//     re-evaluated every scan, never latched — its CURRENT entry is
//     non-attacking and every selected family is active or unavailable. An
//     A-off entry is also excluded while this character cannot cast at all
//     (no Magic stance, no caster, no debuff-wand swap): it could only be
//     dropped again by the melee/missile attackAllowed gate.
//  4. R ⇒ ring (untargeted) only when AllowUntargetedRings; otherwise the
//     entry's bolt/streak with a one-time warning.
//  5. attack: shape = S ? streak : (arc ? arc : bolt), element = resolved
//     Damage Type, highest castable rung. WarSpellMode "legacy" + DEFAULT entry
//     with its S / arc / Damage Type unedited ⇒ null (combat_loop's legacy
//     _pickWarSpell); an edited attack column on DEFAULT is planned like any row.
//  6. three fizzles of one id ⇒ excluded 10 min.

import * as spellTables from "./spell_tables.js";
import { DebuffLedger } from "./debuff_ledger.js";
import { DEFAULT_ENTRY } from "./monster_list.js";
import { readTierThresholds, skillCapFn } from "../../skill_cap.js";

/** The DEFAULT row's attack columns (S, arc, Damage Type) are unedited. */
function defaultAttackShape(entry) {
  const dt = String(entry.damageType ?? DEFAULT_ENTRY.damageType).toLowerCase();
  return !!entry.S === DEFAULT_ENTRY.S && !!entry.arc === DEFAULT_ENTRY.arc && dt === String(DEFAULT_ENTRY.damageType).toLowerCase();
}

const MODE_MAGIC = 8;
const MODE_MISSILE = 4;
const MODE_NONCOMBAT = 1;

// ACE ItemType / EquipMask (ACE.Entity/Enum/ItemType.cs, EquipMask.cs:32-37).
const IT_MELEE = 0x1;
const IT_MISSILE = 0x100;
const IT_CASTER = 0x8000;
const EM_MELEE = 0x00100000;
const EM_SHIELD = 0x00200000;
const EM_MISSILE = 0x00400000;
const EM_HELD = 0x01000000;
const EM_TWO_HANDED = 0x02000000;
const EM_WEAPON_SLOTS = EM_MELEE | EM_MISSILE | EM_HELD | EM_TWO_HANDED;

// Magic school → skill id, the tier defaults and the tier rule live in
// rynth/skill_cap.js (shared with the buff/vitals loops' opt-in skill cap).

// WeenieError codes on kind-13 (combat_loop.js CAST_REFUSALS).
const WE_FIZZLE = 0x0402;
const WE_UNKNOWN_SPELL = 0x03fc;
const WE_NO_COMPONENTS = 0x0400;
const WE_NO_MANA = 0x0401;

const UNAVAILABLE_MS = 60_000; // re-check a family with no known rung after this
const FIZZLE_LIMIT = 3;
const EXCLUDE_MS = 10 * 60_000;
const CAST_ATTRIBUTION_MS = 10_000; // a refusal this soon after our cast is ours
const SWAP_GATE_MS = 3000; // ≥ 3 s between swaps (REF WeaponSwapGate)
const SWAP_FAIL_HOLD_MS = 30_000;
const STANCE_RETRY_MS = 3000;
const STANCE_WAIT_MS = 6000;
const RING_REFUSED_HOLD_MS = 10 * 60_000;
const LOADOUT_OWNER = "vtloadout";

const ELEMENTS = spellTables.ELEMENTS;
const GBY = Object.freeze({ melee: ["G", "B", "Y"], missile: ["B", "G", "Y"], magic: ["Y", "G", "B"] });
const GBY_FAMILY = Object.freeze({ G: "gravity", B: "broadside", Y: "yield" });
const IGNORE = Object.freeze({ ignore: true });
const LOG_REPEAT_MS = 10_000;

// C3: identical messages at most once per 10 s.
function rateLimited(log, now) {
  const seen = new Map();
  return (msg) => {
    try {
      const t = now();
      const last = seen.get(msg);
      if (last != null && t - last < LOG_REPEAT_MS) return;
      if (seen.size >= 128) seen.clear();
      seen.set(msg, t);
      log(msg);
    } catch (_) {
      /* logging never throws */
    }
  };
}

export class AttackPlanner {
  constructor({
    host = null,
    options = null,
    monsters,
    spells = spellTables,
    ledger = null,
    items = null,
    creatures = null,
    subscribe = null,
    getCombat = null,
    getNav = null,
    now = Date.now,
    log,
    state = null,
  } = {}) {
    if (!monsters) throw new Error("AttackPlanner: monsters (MonsterList) required");
    // Page-session memory that must outlive a layer rebind (D6; HUD Restart,
    // the reconnect takeover): the loadout before a debuff-wand swap. INT-2
    // passes session.ext.plannerState; without it the memory is per planner
    // (review runtime-3).
    this._st = state && typeof state === "object" ? state : {};
    if (!("saved" in this._st)) this._st.saved = null;
    this.host = host;
    this.options = options;
    this.monsters = monsters;
    this.spells = spells || spellTables;
    this.now = typeof now === "function" ? now : Date.now;
    this.log = rateLimited(typeof log === "function" ? log : (m) => console.log(`[vt:planner] ${m}`), this.now);
    this.ledger =
      ledger ||
      new DebuffLedger({ now: this.now, durationOf: (id) => this.spells.durationOf(id), nameOf: (id) => this.spells.nameOf(id), log: this.log });
    this.items = items;
    this.creatures = creatures;
    this.getCombat = typeof getCombat === "function" ? getCombat : () => null;
    this.getNav = typeof getNav === "function" ? getNav : () => null;

    this._svMemo = { seq: undefined, rev: -1, map: new Map() };
    this._seqCache = { seq: undefined, known: null, cap: null, wielded: undefined, scan: null };
    this._knownSig = null;
    this._fizzles = new Map(); // spellId -> count
    this._excluded = new Map(); // spellId -> untilMs
    this._last = null; // { target, spellId, family, kind, at, resolved }
    this._lastPlan = null;
    this._ringRefusedUntil = 0;
    this._swap = null; // { op: "wield"|"unwield", item, at, purpose }
    this._failedItems = new Map(); // guid -> untilMs
    this._stance = null; // { want, since, lastAt }
    this._warned = new Set();
    this._unsubs = [];

    if (typeof subscribe === "function") {
      const on = (type, fn) => {
        try {
          const u = subscribe(type, (sig) => {
            try {
              fn(sig);
            } catch (_) {
              /* a handler never breaks the fan-out */
            }
          });
          if (typeof u === "function") this._unsubs.push(u);
        } catch (_) {
          /* subscription unavailable */
        }
      };
      on("castLine", (sig) => this._onCastLine(sig));
      on("useFailed", (sig) => this._onUseFailed(sig));
      on("equip", (sig) => this._onEquip(sig));
    }
    if (this.spells && typeof this.spells.isLoaded === "function" && !this.spells.isLoaded()) this._kickLoad();
  }

  /** { main, offhand, kind } — the loadout before a debuff-wand swap (kept in
   *  the injected page-session state, so a rebind can still put it back). */
  get _saved() {
    return this._st.saved || null;
  }
  set _saved(v) {
    this._st.saved = v || null;
  }

  dispose() {
    for (const u of this._unsubs.splice(0)) {
      try {
        u();
      } catch (_) {
        /* already detached */
      }
    }
  }

  // ── small helpers ────────────────────────────────────────────────────
  _kickLoad() {
    try {
      const p = this.spells.loadCombatSpells && this.spells.loadCombatSpells();
      if (p && typeof p.catch === "function") p.catch(() => {});
    } catch (_) {
      /* stays not-ready */
    }
  }

  _warnOnce(key, msg) {
    if (this._warned.has(key)) return;
    this._warned.add(key);
    try {
      this.log(msg);
    } catch (_) {
      /* never throws */
    }
  }

  _opt(key, dflt) {
    try {
      const v = this.options && typeof this.options.getValue === "function" ? this.options.getValue(key) : undefined;
      return v === undefined || v === null ? dflt : v;
    } catch (_) {
      return dflt;
    }
  }

  _call(name, ...args) {
    const h = this.host;
    const f = h && h[name];
    if (typeof f !== "function") return undefined;
    try {
      return f.apply(h, args);
    } catch (_) {
      return undefined;
    }
  }

  _seq() {
    const s = this.host && this.host.snap;
    return s && s.seq != null ? s.seq : undefined;
  }

  _ctx(now) {
    return { seq: this._seq(), now: now ?? this.now() };
  }

  _perSeq() {
    const seq = this._seq();
    if (seq === undefined || this._seqCache.seq !== seq) {
      this._seqCache = { seq, known: null, cap: null, wielded: undefined, scan: null };
    }
    return this._seqCache;
  }

  _entry(guid, now) {
    return this.monsters.resolve(Number(guid) >>> 0, this._ctx(now));
  }

  _selfGuid() {
    return Number(this._call("GetPlayerId")) >>> 0;
  }

  /** Known spell ids (memo per snapshot seq). A change of the book clears "unavailable" marks. */
  _known() {
    const c = this._perSeq();
    if (c.known) return c.known;
    let ids = this._call("TryGetKnownSpells");
    if (!Array.isArray(ids) && !(ids && typeof ids[Symbol.iterator] === "function")) {
      const s = this.host && this.host.s;
      try {
        ids = s && typeof s.playerKnownSpells === "function" ? s.playerKnownSpells() : [];
      } catch (_) {
        ids = [];
      }
    }
    const set = new Set();
    for (const id of ids || []) set.add(Number(id));
    let sum = 0;
    for (const id of set) sum = (sum + id) % 2147483647;
    const sig = `${set.size}:${sum}`;
    if (this._knownSig !== null && this._knownSig !== sig) this.ledger.clearUnavailable?.();
    this._knownSig = sig;
    c.known = set;
    return set;
  }

  /** (school) → highest spell level this character can cast in it (Infinity when skills are unreadable). */
  _capFn() {
    const c = this._perSeq();
    if (c.cap) return c.cap;
    const stats = this._call("TryGetPlayerStats");
    const skills = stats && stats.skills ? stats.skills : null;
    // RynthAi GetHighestSpellTier (the combat thresholds) — skill_cap.js.
    c.cap = skillCapFn(skills, readTierThresholds((k, d) => this._opt(k, d), "MinSkillLevelTier"));
    return c.cap;
  }

  _excludedIds(now) {
    for (const [id, until] of this._excluded) if (until <= now) this._excluded.delete(id);
    return this._excluded;
  }

  _best(family, now) {
    if (!family) return null;
    return this.spells.bestCastable(family, { known: this._known(), maxLevelBySchool: this._capFn(), exclude: this._excludedIds(now) });
  }

  /** Wielded rows of the player ({guid, itemType, equipMask}); null when unreadable. Memo per seq. */
  _wielded() {
    const c = this._perSeq();
    if (c.wielded !== undefined) return c.wielded;
    let rows = null;
    const self = this._selfGuid();
    if (self && typeof (this.host && this.host.TryGetWieldedItems) === "function") rows = this._call("TryGetWieldedItems", self);
    if (!Array.isArray(rows)) {
      const inv = this._inventory();
      rows = inv ? inv.filter((i) => (Number(i.equipMask) >>> 0) !== 0) : null;
    }
    c.wielded = Array.isArray(rows) ? rows.map((r) => ({ guid: r.guid >>> 0, itemType: Number(r.itemType) >>> 0, equipMask: Number(r.equipMask) >>> 0 })) : null;
    return c.wielded;
  }

  _inventory() {
    const h = this.host;
    if (!h) return null;
    if (typeof h.TryGetPlayerInventoryCached === "function") return this._call("TryGetPlayerInventoryCached") || null;
    if (typeof h.TryGetPlayerInventory === "function") return this._call("TryGetPlayerInventory") || null;
    return null;
  }

  _mainWeapon(rows) {
    if (!rows) return null;
    return rows.find((r) => r.equipMask & EM_WEAPON_SLOTS) || null;
  }

  _casterWielded(rows = this._wielded()) {
    if (!rows) return null;
    return rows.some((r) => r.itemType & IT_CASTER);
  }

  // Live stance from the host (combat.mode is only refreshed after the
  // ENGAGE hook, so it can be a tick stale while a loadout holds "busy").
  _mode() {
    const m = this._call("GetCurrentCombatMode");
    if (typeof m === "number" && m > 0) return m;
    const c = this.getCombat();
    return c && typeof c.mode === "number" ? c.mode : 0;
  }

  // ── entry → families ─────────────────────────────────────────────────
  _attacks(entry) {
    return entry.A === true || entry.R === true;
  }

  _weaponKindOfRow(row) {
    if (!row) return null;
    if (row.itemType & IT_CASTER) return "magic";
    if (row.itemType & IT_MISSILE || row.equipMask & EM_MISSILE) return "missile";
    if (row.itemType & IT_MELEE || row.equipMask & (EM_MELEE | EM_TWO_HANDED)) return "melee";
    return null;
  }

  /** The character's fighting style for the G/B/Y order: melee | missile | magic. */
  _fightKind(entry) {
    if (this._saved && this._saved.kind) return this._saved.kind;
    if (entry && entry.weapon && this.items && typeof this.items.find === "function") {
      const it = this.items.find(entry.weapon);
      if (it) return it.kind === "caster" ? "magic" : it.kind === "missile" ? "missile" : it.kind === "melee" ? "melee" : null;
    }
    const k = this._weaponKindOfRow(this._mainWeapon(this._wielded()));
    if (k) return k;
    const mode = this._mode();
    return mode === MODE_MAGIC ? "magic" : mode === MODE_MISSILE ? "missile" : "melee";
  }

  /** Resolved Damage Type (M17): explicit, else lowest known resist with a castable rung, else the weapon's element, else Fire. */
  _element(entry, guid, now) {
    if (entry.damageType && entry.damageType !== "Auto") return this.spells.normalizeElement(entry.damageType) || "Fire";
    const shape = entry.S ? "streak" : entry.arc ? "arc" : "bolt";
    let castable = [];
    if (this.spells.isLoaded()) castable = ELEMENTS.filter((el) => this._best(`${shape}:${el.toLowerCase()}`, now));
    if (this.creatures && typeof this.creatures.weakest === "function") {
      const wcid = Number(this._call("TryGetObjectWcid", guid)) >>> 0;
      if (wcid) {
        let weak = null;
        try {
          weak = this.creatures.weakest(wcid, castable.length ? castable : undefined);
        } catch (_) {
          weak = null;
        }
        if (weak) return weak;
      }
    }
    const wEl = this._weaponElement(entry);
    if (wEl && (!castable.length || castable.includes(wEl))) return wEl;
    return "Fire";
  }

  _weaponElement(entry) {
    if (!this.items || typeof this.items.find !== "function") return null;
    if (entry.weapon) {
      const it = this.items.find(entry.weapon);
      if (it && it.element) return it.element;
    }
    const main = this._mainWeapon(this._wielded());
    if (main) {
      const it = this.items.find(main.guid);
      if (it && it.element) return it.element;
    }
    return null;
  }

  /** Ordered debuff families of an entry (step 1). */
  _debuffFamilies(entry, guid, now) {
    const fams = [];
    const needEl = entry.V || (entry.exVuln && entry.exVuln !== "None");
    const el = needEl ? this._element(entry, guid, now) : null;
    if (entry.I) fams.push("imperil");
    if (entry.V && el) fams.push(`vuln:${el.toLowerCase()}`);
    if (entry.exVuln && entry.exVuln !== "None") {
      const ex = this.spells.normalizeElement(entry.exVuln);
      const fam = ex ? `vuln:${ex.toLowerCase()}` : null;
      if (fam && !fams.includes(fam)) fams.push(fam);
    }
    const order = GBY[this._fightKind(entry)] || GBY.melee;
    for (const k of order) if (entry[k]) fams.push(GBY_FAMILY[k]);
    if (entry.F) fams.push("fester");
    if (entry.WC) fams.push("wc");
    if (entry.FC) fams.push("fc");
    if (entry.DC) fams.push("dc");
    return fams;
  }

  _dotFamilies(entry) {
    const fams = [];
    if (entry.Cp) fams.push("cp");
    if (entry.Cs) fams.push("cs");
    return fams;
  }

  /** Every selected family is on (ledger) or can't be cast — the non-attacking exclusion predicate. */
  _familiesSettled(guid, entry, now) {
    const fams = this._debuffFamilies(entry, guid, now).concat(this._dotFamilies(entry));
    for (const fam of fams) {
      if (this.ledger.isActive(guid, fam) || this.ledger.isUnavailable(fam)) continue;
      if (this.spells.isLoaded() && !this._best(fam, now)) continue; // nothing castable = unavailable
      return false;
    }
    return true;
  }

  /** Can this character cast right now (Magic stance or a caster in hand)? */
  _canCastNow() {
    if (this._mode() === MODE_MAGIC) return true;
    const cw = this._casterWielded();
    return cw === true || cw === null; // unreadable ⇒ do not exclude on a guess
  }

  /** Would ensureLoadout swap to a caster for pending debuffs (SwitchWandsToDebuff + a wand)? */
  _wandSwapAvailable() {
    return this._opt("SwitchWandsToDebuff", false) === true && this._findWand() !== 0;
  }

  /**
   * The scan exclusion for an entry with A off (step 3, M8). Such an entry acts
   * only by casting, so it is excluded while — re-evaluated every scan — it has
   * nothing left to cast (every selected family active, unavailable or with no
   * castable rung; R off) or this character cannot cast at all now (no Magic
   * stance, no caster in hand, no debuff-wand swap). An R entry (ring / standard
   * war, G:83) stays admitted while the character can cast. Admitting an entry
   * the character cannot act on would make INT-1's `_attackStep` gate
   * (attackAllowed false) drop and re-lock it every tick.
   */
  _nonAttackingExcluded(g, entry, t) {
    if (entry.A === true) return false;
    const castNow = this._canCastNow();
    if (entry.R === true && castNow) return false;
    if (this._familiesSettled(g, entry, t)) return true;
    return !(castNow || this._wandSwapAvailable());
  }

  // ── public API ───────────────────────────────────────────────────────
  /** Attach rule (D10): a non-default monster list, WarSpellMode "vtank", or SwitchWandsToDebuff. */
  isActive() {
    try {
      if (!this.monsters.isDefaultOnly()) return true;
      if (this._opt("WarSpellMode", "legacy") === "vtank") return true;
      return this._opt("SwitchWandsToDebuff", false) === true;
    } catch (_) {
      return false;
    }
  }

  /** O7: acquire radius = max(MonsterRange, ApproachRange) only while nav is enabled with a route; pure. */
  acquireRangeM(monsterRangeM) {
    const m = Number(monsterRangeM);
    try {
      const nav = this.getNav();
      if (nav && nav.enabled === true) {
        const has = typeof nav.hasRoute === "function" ? nav.hasRoute() : nav.hasRoute === true;
        if (has) {
          const a = Number(this._opt("ApproachRange", 4));
          if (Number.isFinite(a) && a > m) return a;
        }
      }
    } catch (_) {
      /* fall back to the monster range */
    }
    return m;
  }

  /** Per scan candidate (memo per host.snap.seq + list revision). */
  scanVerdict(guid, distM) {
    try {
      const g = Number(guid) >>> 0;
      const seq = this._seq();
      const rev = this.monsters.rev;
      if (seq !== undefined) {
        const m = this._svMemo;
        if (m.seq !== seq || m.rev !== rev) this._svMemo = { seq, rev, map: new Map() };
        const hit = this._svMemo.map.get(g);
        if (hit !== undefined) return hit;
      }
      const t = this.now();
      const { entry } = this._entry(g, t);
      let v;
      if (this.spells.isLoaded()) this._known(); // book change ⇒ unavailable marks cleared before they are read
      if (entry.priority === -1) v = IGNORE;
      else if (this._nonAttackingExcluded(g, entry, t)) v = IGNORE;
      else v = { scoreBias: entry.priority * 1000 };
      if (seq !== undefined) this._svMemo.map.set(g, v);
      return v;
    } catch (_) {
      return null;
    }
  }

  /** Melee/missile swing gate: the A column. */
  attackAllowed(target) {
    try {
      return this._entry(target).entry.A === true;
    } catch (_) {
      return true;
    }
  }

  nextCast(target, { mode, now } = {}) {
    try {
      if (mode !== undefined && mode !== MODE_MAGIC) return null;
      const g = Number(target) >>> 0;
      if (!g) return null;
      const t = typeof now === "number" ? now : this.now();
      const { entry, index } = this._entry(g, t);
      if (!this.spells.isLoaded()) {
        this._kickLoad();
        return this._remember(this._attacks(entry) ? null : { skip: true });
      }
      this._known(); // refresh the book first: a newly learned spell clears its "unavailable" mark
      // 1. debuffs
      for (const fam of this._debuffFamilies(entry, g, t)) {
        const p = this._planFamily(g, fam, "debuff", t);
        if (p) return this._remember(p);
      }
      // 2. DoTs (attacks with a window)
      for (const fam of this._dotFamilies(entry)) {
        const p = this._planFamily(g, fam, "dot", t);
        if (p) return this._remember(p);
      }
      // 3. debuff-only: combat drops the lock; the next scan must see the exclusion
      if (!this._attacks(entry)) {
        this._svMemo = { seq: undefined, rev: -1, map: new Map() };
        return this._remember({ done: true });
      }
      // 4. ring
      if (entry.R) {
        const ring = this._ringPlan(g, entry, t);
        if (ring) return this._remember(ring);
      }
      // 5. attack — an UNEDITED attack shape on the DEFAULT row keeps the
      // legacy war pick (WarSpellMode legacy); an explicit S / arc / Damage
      // Type on DEFAULT is honoured like on any named row (G:84/G:93, guide-4).
      if (index === 0 && this._opt("WarSpellMode", "legacy") !== "vtank" && defaultAttackShape(entry)) return this._remember(null);
      const shape = entry.S ? "streak" : entry.arc ? "arc" : "bolt";
      const el = this._element(entry, g, t);
      const fam = `${shape}:${el.toLowerCase()}`;
      const sp = this._best(fam, t);
      if (!sp) {
        this._warnOnce(`noattack:${fam}`, `no castable ${fam.replace(":", " ")} spell known — falling back to the legacy war pick`);
        return this._remember(null);
      }
      return this._remember({ spellId: sp.id, kind: "attack", untargeted: false, family: fam });
    } catch (e) {
      this._warnOnce(`nextCast:${e && e.message}`, `nextCast failed: ${e && e.message}`);
      return null;
    }
  }

  _remember(plan) {
    this._lastPlan = plan;
    return plan;
  }

  _planFamily(g, fam, kind, t) {
    if (this.ledger.isActive(g, fam) || this.ledger.isUnavailable(fam)) return null;
    const sp = this._best(fam, t);
    if (!sp) {
      this.ledger.markUnavailable(fam, t + UNAVAILABLE_MS);
      return null;
    }
    return { spellId: sp.id, kind, untargeted: false, family: fam };
  }

  _scanList() {
    const c = this._perSeq();
    if (c.scan) return c.scan;
    let list = null;
    const combat = this.getCombat();
    if (combat && typeof combat._scanTargets === "function") {
      try {
        list = combat._scanTargets();
      } catch (_) {
        list = null;
      }
    }
    if (!Array.isArray(list)) list = this._hostScan();
    c.scan = list;
    return list;
  }

  // Fallback count without a combat loop: attackable, live creatures with a known distance, minus ignored ones.
  _hostScan() {
    const out = [];
    const guids = this._call("NearbyGuids");
    if (!guids) return out;
    for (const g0 of guids) {
      const g = g0 >>> 0;
      if (this._call("ObjectIsPlayer", g) === true) continue;
      if (this._call("TryGetObjectIntProperty", g, 1) !== 16) continue;
      if (this._call("ObjectIsAttackable", g) === false) continue;
      if (this._call("TryGetTargetHealthFraction", g) === 0) continue;
      const d = this._call("TryGetObjectDistance", g);
      if (typeof d !== "number") continue;
      const v = this.scanVerdict(g, d);
      if (v && v.ignore) continue;
      out.push({ guid: g, dist: d });
    }
    return out;
  }

  _ringPlan(g, entry, t) {
    const ringM = Number(this._opt("RingRange", 5)) || 5;
    const scan = this._scanList();
    const inRing = scan.filter((s) => typeof s.dist === "number" && s.dist <= ringM);
    let want;
    if (entry.A) want = inRing.length >= (Number(this._opt("MinRingTargets", 4)) || 4);
    else want = inRing.some((s) => (s.guid >>> 0 === g ? entry.R : this._entry(s.guid, t).entry.R === true));
    if (!want) return null; // R-only with nothing in ring range: standard war on the target (G:83)
    if (this._opt("AllowUntargetedRings", false) !== true) {
      this._warnOnce("ring-gate", "ring wanted but AllowUntargetedRings is off (untested on ACE, L-R1) — casting the entry's bolt/streak instead");
      return null;
    }
    if (t < this._ringRefusedUntil) return null;
    const el = this._element(entry, g, t);
    const fam = `ring:${el.toLowerCase()}`;
    const sp = this._best(fam, t);
    if (!sp) return null;
    return { spellId: sp.id, kind: "ring", untargeted: true, family: fam };
  }

  onCastIssued(target, plan, sent) {
    try {
      if (!plan || plan.skip || plan.done || !plan.spellId) {
        if (sent) this._last = null; // the legacy war pick went out: its refusals are not ours
        return;
      }
      const t = this.now();
      const g = Number(target) >>> 0;
      if (!sent) {
        if (plan.kind === "ring") {
          this._ringRefusedUntil = t + RING_REFUSED_HOLD_MS;
          this._warnOnce(`ring-refused:${plan.spellId}`, `ring ${plan.spellId} refused by the host cast policy — rings off for 10 min`);
        }
        return;
      }
      this._last = { target: g, spellId: plan.spellId, family: plan.family, kind: plan.kind, at: t, resolved: false };
      if (plan.kind === "debuff" || plan.kind === "dot") {
        const name = this._call("TryGetObjectName", g);
        this.ledger.noteIssued(g, typeof name === "string" ? name : "", plan.spellId, plan.family);
      }
    } catch (_) {
      /* never throws */
    }
  }

  _onCastLine(sig) {
    const r = this.ledger.onCastLine(sig);
    if (!r) return;
    const last = this._last;
    if (last && last.target === r.guid && last.family === r.family) last.resolved = true;
    if (r.outcome !== "resisted" && r.outcome !== "failed") this._fizzles.delete(r.spellId);
    this._svMemo = { seq: undefined, rev: -1, map: new Map() }; // the exclusion predicate may have changed
  }

  _onUseFailed(sig) {
    const last = this._last;
    if (!last || last.resolved) return;
    const t = this.now();
    if (t - last.at > CAST_ATTRIBUTION_MS) return;
    const tok = this.host && this.host.castToken;
    if (tok && tok.owner && tok.owner !== "combat") return; // another module's cast
    const code = (Number(sig && sig.code) >>> 0) & 0xffff;
    if (code !== WE_FIZZLE && code !== WE_UNKNOWN_SPELL && code !== WE_NO_COMPONENTS && code !== WE_NO_MANA) return;
    last.resolved = true;
    if (last.kind === "debuff" || last.kind === "dot") this.ledger.clearPending?.(last.target, last.family);
    if (code === WE_UNKNOWN_SPELL) {
      this._excluded.set(last.spellId, t + EXCLUDE_MS);
      this._warnOnce(`unknown:${last.spellId}`, `spell ${last.spellId} refused as not in the spellbook — excluded for 10 min`);
      return;
    }
    if (code !== WE_FIZZLE) return;
    const n = (this._fizzles.get(last.spellId) || 0) + 1;
    if (n >= FIZZLE_LIMIT) {
      this._fizzles.delete(last.spellId);
      this._excluded.set(last.spellId, t + EXCLUDE_MS);
      this.log(`spell ${last.spellId} (${this.spells.nameOf(last.spellId)}) fizzled ${FIZZLE_LIMIT}x — excluded for 10 min`);
    } else this._fizzles.set(last.spellId, n);
  }

  // ── loadout (M19/M20, SwitchWandsToDebuff) ──────────────────────────
  _onEquip(sig) {
    const s = this._swap;
    if (!s || !sig) return;
    if ((Number(sig.item) >>> 0) !== s.item) return;
    if (sig.failed) {
      this._failedItems.set(s.item, this.now() + SWAP_FAIL_HOLD_MS);
      this._warnOnce(`swapfail:${s.item}`, `${s.op} of ${s.item.toString(16)} failed (code ${sig.code ?? "?"}) — not retried for 30 s`);
    }
    s.done = true;
  }

  _itemOk(guid, now) {
    const g = guid >>> 0;
    if (!g) return false;
    const until = this._failedItems.get(g);
    if (until != null) {
      if (until > now) return false;
      this._failedItems.delete(g);
    }
    return true;
  }

  /** A caster for debuff swaps: an Items-tab caster this character owns, else any caster in the pack. */
  _findWand() {
    const t = this.now();
    if (this.items && typeof this.items.ofKind === "function") {
      for (const e of this.items.ofKind("caster")) {
        const g = typeof this.items.resolveGuid === "function" ? this.items.resolveGuid(e) : e.guid;
        if (g && this._itemOk(g, t)) return g >>> 0;
      }
    }
    const inv = this._inventory();
    if (inv) {
      const row = inv.find((i) => (Number(i.itemType) >>> 0) & IT_CASTER && this._itemOk(i.guid >>> 0, t));
      if (row) return row.guid >>> 0;
    }
    return 0;
  }

  _hasPendingDebuffs(g, entry, now) {
    if (!this.spells.isLoaded()) return false;
    const fams = this._debuffFamilies(entry, g, now).concat(this._dotFamilies(entry));
    for (const fam of fams) {
      // A cast of it still in flight (sent, no result line yet) keeps the wand:
      // swapping back now would race our own spell, and a cast lost that way is
      // recast after the pending window — wand → cast → swap → recast, forever.
      if (typeof this.ledger.isPending === "function" && this.ledger.isPending(g, fam)) return true;
      if (this.ledger.isActive(g, fam) || this.ledger.isUnavailable(fam)) continue;
      if (this._best(fam, now)) return true;
    }
    return false;
  }

  _resolveItem(guid) {
    const g = guid >>> 0;
    if (!g) return 0;
    if (this.items && typeof this.items.find === "function") {
      const e = this.items.find(g);
      if (e && typeof this.items.resolveGuid === "function") return this.items.resolveGuid(e) || 0;
    }
    return g;
  }

  /** The loadout this target wants: { main, offhand, purpose } (main 0 = keep what is wielded). */
  _desiredLoadout(g, entry, rows, now) {
    const main = this._mainWeapon(rows);
    const casterNow = !!(main && main.itemType & IT_CASTER);
    if (this._opt("SwitchWandsToDebuff", false) === true && this._hasPendingDebuffs(g, entry, now)) {
      if (casterNow) return { main: 0, offhand: 0, purpose: "debuff" }; // keep the wand until the debuffs are on
      const wand = this._findWand();
      if (wand) {
        if (!this._saved) {
          const shield = rows.find((r) => r.equipMask & EM_SHIELD);
          this._saved = { main: main ? main.guid : 0, offhand: shield ? shield.guid : 0, kind: this._weaponKindOfRow(main) || "melee" };
        }
        return { main: wand, offhand: 0, purpose: "debuff" };
      }
    }
    const isWielded = (guid) => rows.some((r) => r.guid === guid);
    if (entry.weapon) {
      const w = this._resolveItem(entry.weapon);
      if (w && this._itemOk(w, now)) {
        const it = this.items && typeof this.items.find === "function" ? this.items.find(entry.weapon) : null;
        const melee = it ? it.kind === "melee" : true;
        const off = melee && entry.offhand ? this._resolveItem(entry.offhand) : 0;
        if (this._saved && isWielded(w)) this._saved = null; // the entry's weapon replaced the debuff wand
        return { main: w, offhand: off && this._itemOk(off, now) ? off : 0, purpose: "entry" };
      }
    }
    if (this._saved) {
      // Debuffs done: put the pre-swap loadout back (main, then the melee offhand).
      const sv = this._saved;
      if (!sv.main) {
        this._saved = null; // nothing to go back to (was unarmed): keep the wand
      } else {
        const needMain = !isWielded(sv.main) && this._itemOk(sv.main, now);
        const needOff = sv.kind === "melee" && sv.offhand && !isWielded(sv.offhand) && this._itemOk(sv.offhand, now);
        if (needMain || needOff) return { main: needMain ? sv.main : 0, offhand: needOff ? sv.offhand : 0, purpose: "restore" };
        this._saved = null; // weapon is back
      }
    }
    // AUTO weapon, but a melee entry may still name an offhand.
    if (entry.offhand && this._weaponKindOfRow(main) === "melee") {
      const off = this._resolveItem(entry.offhand);
      return { main: 0, offhand: off && this._itemOk(off, now) ? off : 0, purpose: "entry" };
    }
    return { main: 0, offhand: 0, purpose: "auto" };
  }

  /** ENGAGE hook: wield what this target's entry wants; "busy" holds the combat tick. */
  ensureLoadout(target, nowMs) {
    try {
      const t = typeof nowMs === "number" ? nowMs : this.now();
      const g = Number(target) >>> 0;
      if (!g) return "ok";
      // A swap in flight: wait for its equip event (kind 47/49) or the 3 s gate.
      const s = this._swap;
      if (s) {
        if (!s.done && t - s.at < SWAP_GATE_MS) return "busy";
        this._swap = null;
        this._call("releaseItemAction", LOADOUT_OWNER);
        this._perSeq().wielded = undefined; // re-read after the change
        if (s.purpose === "debuff") this._stance = { want: MODE_MAGIC, since: t, lastAt: 0 };
        else if (s.purpose === "restore") this._stance = { want: MODE_NONCOMBAT, since: t, lastAt: 0 };
      }
      const stance = this._stanceStep(t);
      if (stance) return stance;
      const rows = this._wielded();
      if (!rows) return "ok"; // cannot see what is wielded: never swap blind
      const { entry } = this._entry(g, t);
      const want = this._desiredLoadout(g, entry, rows, t);
      const wielded = (guid) => rows.some((r) => r.guid === guid);
      if (want.main && !wielded(want.main)) {
        const blocker = rows.find((r) => r.equipMask & EM_MISSILE && r.guid !== want.main);
        // ACE will not auto-dequip a main-hand bow for a Held wand/sword (C# CombatManager.cs:81-93): stow it first.
        if (blocker) return this._issue({ op: "unwield", item: blocker.guid, purpose: want.purpose }, t);
        return this._issue({ op: "wield", item: want.main, mask: 0, purpose: want.purpose }, t);
      }
      if (want.offhand && !wielded(want.offhand)) return this._issue({ op: "wield", item: want.offhand, mask: EM_SHIELD, purpose: want.purpose }, t);
      return "ok";
    } catch (e) {
      this._warnOnce(`loadout:${e && e.message}`, `ensureLoadout failed: ${e && e.message}`);
      return "ok";
    }
  }

  // After a debuff-wand swap the stance must become Magic (and back after the
  // restore) — otherwise an A-off entry would drop the lock in the melee
  // attack step every tick. Bounded: STANCE_WAIT_MS, one request per 3 s.
  _stanceStep(t) {
    const st = this._stance;
    if (!st) return null;
    const mode = this._mode();
    const reached = st.want === MODE_MAGIC ? mode === MODE_MAGIC : mode !== MODE_MAGIC;
    if (reached || t - st.since > STANCE_WAIT_MS) {
      this._stance = null;
      return null;
    }
    if (st.want === MODE_MAGIC && this._casterWielded() === false) {
      this._stance = null;
      return null;
    }
    if (t - st.lastAt >= STANCE_RETRY_MS) {
      st.lastAt = t;
      this._call("ChangeCombatMode", st.want);
    }
    return "busy";
  }

  _issue(action, t) {
    if (!this._itemOk(action.item, t)) return "ok";
    const h = this.host;
    if (h && typeof h.tryClaimItemAction === "function") {
      let claimed = false;
      try {
        claimed = h.tryClaimItemAction(LOADOUT_OWNER, { minIntervalMs: SWAP_GATE_MS });
      } catch (_) {
        claimed = false;
      }
      if (!claimed) return "busy"; // another item action in flight, or the 3 s swap gate
    }
    // End the live melee/missile engagement before any wield (ACE's repeat loop).
    try {
      const c = this.getCombat();
      if (c && typeof c.disengage === "function") c.disengage({ cancelAttack: true });
    } catch (_) {
      /* best effort */
    }
    const ok = action.op === "unwield" ? this._call("UnwieldItem", action.item) : this._call("WieldItem", action.item, action.mask || 0);
    if (ok === false || ok === undefined) {
      this._call("releaseItemAction", LOADOUT_OWNER);
      this._failedItems.set(action.item, t + SWAP_FAIL_HOLD_MS);
      this._warnOnce(`swap:${action.op}:${action.item}`, `${action.op} of ${action.item.toString(16)} not sent — skipping it for 30 s`);
      return "ok";
    }
    this._swap = { op: action.op, item: action.item, at: t, purpose: action.purpose, done: false };
    return "busy";
  }

  /** Meta MobsInDist_Priority (works while inactive: DEFAULT P). */
  priorityOf(guid) {
    try {
      return this.monsters.priorityOf(Number(guid) >>> 0, this._ctx());
    } catch (_) {
      return 1;
    }
  }

  status() {
    const t = this.now();
    const excluded = [];
    for (const [id, until] of this._excluded) if (until > t) excluded.push(id);
    let active = false;
    try {
      active = this.isActive();
    } catch (_) {
      active = false;
    }
    return {
      active,
      loaded: !!(this.spells && this.spells.isLoaded && this.spells.isLoaded()),
      entries: this.monsters.entries().length,
      defaultOnly: this.monsters.isDefaultOnly(),
      warSpellMode: this._opt("WarSpellMode", "legacy"),
      lastPlan: this._lastPlan ? { ...this._lastPlan } : null,
      swap: this._swap ? { op: this._swap.op, item: this._swap.item, ageMs: t - this._swap.at } : null,
      saved: this._saved ? { ...this._saved } : null,
      excluded,
      ledger: typeof this.ledger.snapshot === "function" ? this.ledger.snapshot() : null,
    };
  }
}
