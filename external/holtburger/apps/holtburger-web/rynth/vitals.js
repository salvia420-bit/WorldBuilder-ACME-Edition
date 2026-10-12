// RynthVitals — B15/B16 vital-emergency policy on the RynthWebHost seam.
//
// A faithful subset of RynthAi's OnHeartbeat vital rules (report 11 §B15/B16):
//   B15 Emergency HP override — HP <= 30% && stam > 20% -> Stamina-to-Health
//       Self, regardless of mode/config (sits below the configurable
//       thresholds so a "do nothing" config still survives). The HP bound is
//       INCLUSIVE (<=), matching C# CheckVitals (BuffManager.cs:733
//       `curHealthPct <= 30`) — a character at exactly 30% is in emergency,
//       not top-off (b5.md finding 7).
//   B16 In-combat vs idle threshold sets — inCombat reacts at LOW thresholds
//       (HealAt=60, GetManaAt=40, RestamAt=30); idle tops up to HIGH
//       (TopOff*=95). Strict `<`; 0 disables a vital. Mana-recharge
//       (Stam->Mana) additionally requires stam > 15. Priority order is
//       HP -> Mana -> Stamina: C# CheckVitals checks mana-recharge BEFORE
//       stamina-recharge (BuffManager.cs:759-760); the earlier stam-first
//       ordering here picked the wrong spell when both were low (b5.md
//       finding 6).
//
// Vital fractions come from playerStats().vitals: flat [type, current, base,
// buffedMax] with VitalType Health=1 / Stamina=3 / Mana=5 (holtburger_common
// ::stats::VitalType). Casts are self-targeted life-school recovery spells,
// gated + paced like the buff loop (Magic mode, cast/busy gates). Returns
// true from step() when it issued/holds a vital action this tick, so the
// caller (buff loop / kernel) yields to it.
//
// 2026-10-12 update:
//   * Recovery spells resolve to the HIGHEST KNOWN tier (I..VI, the level-7
//     lore spell, the level-8 Incantation) instead of always casting the
//     level-1 id: nothing passed `opts.spells` on any live path, so a
//     mid-level character healed 10-25 HP per cast until the give-up valve
//     parked it. opts.spells still pins an axis to one id.
//   * Three fizzles in a row of one tier demote that axis a tier (skill vs.
//     difficulty), the vitals twin of the buff loop's tier walk.
//   * Cast refusals (kind=13 codes, buff_loop.js castRefusalClass): missing
//     components hold every vital cast, no mana parks the axis briefly so the
//     mana axis gets its turn, a spell missing from the book is demoted.
//   * Spells are cast TARGETED at the player's own guid (all of them are
//     SelfTargeted) — the retail shape that carries the glow; ACE never turns
//     the caster for a self target.
//   * The Magic-mode entry checks for a wielded caster first (the wasm now
//     refuses set(Magic) locally and prints a chat line per refusal), and no
//     cast starts in portal space (portal_gate.js).
//   * playerStats() returns a wasm box: copied and freed per read; the known
//     book is re-read every 30 s instead of cached once at construction (a bot
//     built before the spellbook hydrated never cast anything).

import { portalSpaceActive } from "./portal_gate.js";
import { castRefusalClass, casterWielded } from "./buff_loop.js";

const VITAL_HEALTH = 1;
const VITAL_STAMINA = 3;
const VITAL_MANA = 5;
// EquipMask::CASTER and the wielded-caster test live once in buff_loop.js
// (casterWielded) — both loops gate their Magic-mode entry on it.

// Thresholds (report 11 B16 defaults; percent).
const DEFAULTS = {
  healAtCombat: 60,
  getManaAtCombat: 40,
  restamAtCombat: 30,
  topOffHp: 95,
  topOffStam: 95,
  topOffMana: 95,
  emergencyHp: 30, // B15
  emergencyStamFloor: 20, // B15 needs stam headroom to convert
  manaRechargeStamFloor: 15, // B16 Stam->Mana requires stam>15
};

// Self recovery spells, lowest tier first: I..VI, the level-7 lore spell,
// the level-8 Incantation (data/spells-catalog.json names; levels are the
// formula's scarab — rynth_magic_update_test.cjs checks both). Every one is
// SelfTargeted. Categories can't be used here: 89 holds both Stamina-to-Health
// and Stamina-to-Mana, 67 mixes Heal Self with Healing Mastery.
export const VITAL_LADDERS = Object.freeze({
  healSelf: Object.freeze([6, 1157, 1158, 1159, 1160, 1161, 2073, 4311]), // Heal Self I..VI, Adja's Intervention, Incantation of Heal Self
  stamToHealth: Object.freeze([1664, 1665, 1666, 1667, 1668, 1669, 2343, 4658]), // … Rushed Recovery, Incantation of Stamina to Health Self
  stamToMana: Object.freeze([1676, 1677, 1678, 1679, 1680, 1681, 2345, 4981]), // … Meditative Trance, Incantation of Stamina to Mana Self
  revitalize: Object.freeze([1177, 1178, 1179, 1180, 1181, 1182, 2083, 4321]), // … Robustification, Incantation of Revitalize Self
});

// Magic-mode entry give-up valve (02 C1 / synthesis #11): toggleCombatMode()
// is a NonCombat<->suggested BINARY flip that never yields Magic(8) for a
// melee/archer character (get_suggested_combat_mode only returns Magic when
// a caster item is the currently WIELDED weapon) — a hybrid who knows a
// self-heal but fights with a melee weapon oscillated NonCombat<->Melee
// forever with `return true` holding the WHOLE kernel tick every cycle.
// Fix shape: enter Magic EXPLICITLY (ChangeCombatMode(8)) instead of the
// toggle, AND bound the attempts — after MAGIC_MODE_ATTEMPT_LIMIT refusals,
// stop asking and release the tick (`return false`) for MAGIC_MODE_PARK_MS
// so combat/loot/buff get to run. A genuine non-caster (no wand/orb/staff
// wielded) is refused by the wasm's own local gate either way (SetCombatMode
// arm, session/commands/combat.rs `is_wielding_caster`) — no JS-side
// workaround makes that character castable; parking here only stops the
// livelock, it can't grant Magic mode. Since 2026-10-12 a known-empty caster
// slot skips the request outright (see step()).
const MAGIC_MODE_ATTEMPT_LIMIT = 5;
const MAGIC_MODE_PARK_MS = 15_000;

const CAST_INTERVAL_MS = 400;
// Give-up valve (B9-analogue for vitals): if a vital's recovery spell fires
// this many times without the fraction improving by MIN_PROGRESS_PCT, the
// spell is too weak vs this character's pool (the Heal-Self-I-vs-99999-HP
// livelock) — park that vital for the cooldown so the bot stops looping and
// resumes other work. Parked vitals still yield to a true B15 emergency.
const NO_PROGRESS_LIMIT = 6;
const MIN_PROGRESS_PCT = 0.5;
const VITAL_PARK_MS = 60_000;

const KNOWN_REFRESH_MS = 30_000;
// An EMPTY book (a pure melee build, or the spellbook not streamed yet) is
// re-read at most this often — _known() runs several times per kernel tick
// and per status read, and every read copies playerKnownSpells() out of wasm
// (2026-10-12 review #11).
const KNOWN_EMPTY_REFRESH_MS = 2_000;
const FIZZLE_DEMOTE_LIMIT = 3;
// A fizzle (or other refusal) belongs to our last cast when it lands inside
// this window — longer than the slowest recovery cast (~3.1 s for a tier-6
// spell at CastSpeed 2; level 7/8 fast casts are quicker).
const REFUSAL_WINDOW_MS = 10_000;
const COMPONENTS_PARK_MS = 60_000;
const MANA_AXIS_PARK_MS = 10_000;

export class RynthVitals {
  constructor(host, opts = {}) {
    this.host = host;
    this.cfg = { ...DEFAULTS, ...(opts.thresholds || {}) };
    // Explicit per-axis pins (opts.spells) win over the ladder resolution.
    this.spellOverrides = { ...(opts.spells || {}) };
    this.log = opts.log || ((m) => console.log(`[vitals] ${m}`));
    this.lastCastAt = 0;
    this.actions = 0;
    this.lastReason = null;
    // Give-up valve state, per vital axis ("hp"/"stam"/"mana").
    this._noProgress = { hp: 0, stam: 0, mana: 0 };
    this._lastPct = { hp: -1, stam: -1, mana: -1 };
    this._parkedUntil = { hp: 0, stam: 0, mana: 0 };
    // 2026-10-12 state.
    this._knownSet = null;
    this._knownAt = 0;
    this._demoted = new Set(); // spell ids skipped by the ladder resolution
    this._fizzles = new Map(); // spell id -> consecutive fizzles
    this._lastCast = null; // { spell, axis, at, fizzled }
    this._blocked = null; // { reason, until }
    this._lastLoggedBlock = null;
    this.lastRefusal = null;
    if (typeof host?.onEvent === "function") host.onEvent((e) => this._onEvent(e));
  }

  /** Resolved spell per role — the pinned id, else the highest known tier.
   *  Back-compat view of the old `spells` field (observe/netbrain read it). */
  get spells() {
    return {
      healSelf: this._spell("healSelf"),
      stamToHealth: this._spell("stamToHealth"),
      stamToMana: this._spell("stamToMana"),
      revitalize: this._spell("revitalize"),
    };
  }

  _spell(role) {
    const pinned = this.spellOverrides[role];
    if (pinned != null) return pinned;
    const ladder = VITAL_LADDERS[role];
    for (let i = ladder.length - 1; i >= 0; i--) {
      const id = ladder[i];
      if (!this._demoted.has(id) && this._known(id)) return id;
    }
    return ladder[0]; // nothing known — _decide's _known() check skips it
  }

  _vitalAxis(reason) {
    if (reason.startsWith("EMERGENCY") || reason.startsWith("heal")) return "hp";
    if (reason.startsWith("restam")) return "stam";
    if (reason.startsWith("getmana")) return "mana";
    return null;
  }

  _parked(axis, now) {
    return axis && this._parkedUntil[axis] > now;
  }

  _fractions() {
    const s = this.host.s;
    if (!s.playerStats) return null;
    let v;
    let ps = null;
    try {
      ps = s.playerStats();
      v = Array.from(ps?.vitals || []).map(Number);
    } catch (_) {
      return null;
    } finally {
      try {
        ps?.free?.(); // wasm box — copy-then-free (webhost.js review F6 rule)
      } catch (_) {
        /* already freed */
      }
    }
    const out = {};
    for (let i = 0; i + 3 < v.length; i += 4) {
      const type = v[i];
      const cur = v[i + 1];
      const max = v[i + 3];
      if (!(max > 0)) continue;
      const pct = (cur / max) * 100;
      if (type === VITAL_HEALTH) out.hp = pct;
      else if (type === VITAL_STAMINA) out.stam = pct;
      else if (type === VITAL_MANA) out.mana = pct;
    }
    return out;
  }

  /** knownSpell(id) — only cast what's in the book. Re-read every 30 s (and
   *  while empty): the book can still be hydrating when the bot is built. */
  _known(id) {
    const now = Date.now();
    const maxAge = this._knownSet && this._knownSet.size > 0 ? KNOWN_REFRESH_MS : KNOWN_EMPTY_REFRESH_MS;
    if (!this._knownSet || now - this._knownAt > maxAge) {
      const s = this.host.s;
      try {
        this._knownSet = new Set((s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []) : []).map(Number));
      } catch (_) {
        this._knownSet = this._knownSet || new Set();
      }
      this._knownAt = now;
    }
    return this._knownSet.has(id);
  }

  /** Decide the next vital action from the fractions, or null. */
  _decide(f, inCombat) {
    const c = this.cfg;
    const now = Date.now();
    // B15 — emergency HP override (below all configurable thresholds).
    // The emergency ALWAYS fires regardless of the give-up valve — a
    // dying character never gives up, even if the conversion is slow.
    // INCLUSIVE bound (<=) per C# BuffManager.cs:733 `curHealthPct <= 30`
    // (was `<`, which handed hp==30 to the top-off arm — b5.md finding 7).
    const stamToHealth = this._spell("stamToHealth");
    if (f.hp <= c.emergencyHp && f.stam > c.emergencyStamFloor && this._known(stamToHealth)) {
      return { spell: stamToHealth, reason: "EMERGENCY hp->stam" };
    }
    const healAt = inCombat ? c.healAtCombat : c.topOffHp;
    const manaAt = inCombat ? c.getManaAtCombat : c.topOffMana;
    const stamAt = inCombat ? c.restamAtCombat : c.topOffStam;
    // Health first (survival). Parked axes are skipped (give-up valve).
    const healSelf = this._spell("healSelf");
    if (healAt > 0 && f.hp < healAt && !this._parked("hp", now) && this._known(healSelf)) {
      return { spell: healSelf, reason: `heal hp<${healAt}` };
    }
    // Mana recharge (Stam->Mana) — needs stamina headroom. C# checks mana
    // BEFORE stamina (BuffManager.cs:759-760); the two were flipped here, so
    // a character both low on mana and stamina restam'd instead of recharging
    // mana (b5.md finding 6).
    const stamToMana = this._spell("stamToMana");
    if (
      manaAt > 0 &&
      f.mana < manaAt &&
      !this._parked("mana", now) &&
      f.stam > c.manaRechargeStamFloor &&
      this._known(stamToMana)
    ) {
      return { spell: stamToMana, reason: `getmana mana<${manaAt}` };
    }
    // Stamina (Revitalize) — after mana per the C# order above.
    const revitalize = this._spell("revitalize");
    if (stamAt > 0 && f.stam < stamAt && !this._parked("stam", now) && this._known(revitalize)) {
      return { spell: revitalize, reason: `restam stam<${stamAt}` };
    }
    return null;
  }

  // kind=13 refusal codes for our most recent cast (see REFUSAL_WINDOW_MS).
  _onEvent(e) {
    if (!e || e.kind !== 13) return;
    const cls = castRefusalClass(e.u32);
    const lc = this._lastCast;
    if (!cls || !lc || lc.refused || Date.now() - lc.at > REFUSAL_WINDOW_MS) return;
    // Another module's cast in flight? The shared token names its owner.
    const tok = this.host.castToken;
    if (tok && tok.owner && tok.owner !== "vitals") return;
    lc.refused = cls;
    const now = Date.now();
    this.lastRefusal = { code: e.u32 >>> 0, cls, spellId: lc.spell, at: now };
    if (cls === "fizzle") {
      const n = (this._fizzles.get(lc.spell) || 0) + 1;
      this._fizzles.set(lc.spell, n);
      if (n >= FIZZLE_DEMOTE_LIMIT) this._demote(lc.spell, `fizzled ${n}x in a row`);
    } else if (cls === "unknown-spell") {
      this._demote(lc.spell, "not in the spellbook");
    } else if (cls === "components") {
      this._blocked = { reason: "components", until: now + COMPONENTS_PARK_MS };
      this._logBlock("components", `cast refused: missing spell components — vital casts held ${COMPONENTS_PARK_MS / 1000}s`);
    } else if (cls === "mana" && lc.axis && lc.axis !== "mana") {
      // Give the mana axis (Stam->Mana) its turn instead of re-asking.
      this._parkedUntil[lc.axis] = Math.max(this._parkedUntil[lc.axis], now + MANA_AXIS_PARK_MS);
    }
  }

  _demote(spell, why) {
    this._fizzles.delete(spell);
    if (this._demoted.has(spell)) return;
    this._demoted.add(spell);
    this.log(`demote ${spell} (${why}) — next lower known tier`);
  }

  _logBlock(reason, msg) {
    if (this._lastLoggedBlock === reason) return;
    this._lastLoggedBlock = reason;
    this.log(msg);
  }

  // true/false from the inventory snapshot, null when it can't be told.
  _casterWielded() {
    return casterWielded(this.host);
  }

  /**
   * @param inCombat boolean (kernel/combat supplies it)
   * @returns true if a vital action was issued/held this tick (caller yields)
   */
  step(inCombat) {
    const h = this.host;
    if (!h.IsPlayerReady()) return false;
    const f = this._fractions();
    if (!f || f.hp === undefined) return false;
    const action = this._decide(f, inCombat);
    if (!action) return false;

    const now0 = Date.now();
    if (this._blocked && this._blocked.until > now0) return false; // e.g. no components — release the tick
    if (portalSpaceActive(h)) return false; // ACE refuses casts mid-teleport

    // Casting needs Magic mode + the gates (same traps as the buff loop).
    // Enter Magic EXPLICITLY (ChangeCombatMode(8)) rather than
    // toggleCombatMode() — the equipment-derived toggle never reaches
    // Magic for a non-caster (02 C1); see the give-up-valve comment above.
    // This does NOT touch combat_loop's own equipment-derived toggle for
    // its Melee/Missile ENGAGE stance (the bow/wand mode-revert trap,
    // README "Live-verified traps") — only vitals'/buff's MAGIC entry
    // becomes an explicit set.
    if (h.GetCurrentCombatMode() !== 8) {
      if (this._magicParkedUntil && now0 < this._magicParkedUntil) return false; // gave up — don't hold the tick
      if (this._casterWielded() === false) {
        this._magicParkedUntil = now0 + MAGIC_MODE_PARK_MS;
        this._magicAttempts = 0;
        this._blocked = { reason: "no-caster", until: now0 + MAGIC_MODE_PARK_MS };
        this._logBlock("no-caster", "no caster (wand/orb/staff) wielded — vital spells need Magic mode; holding");
        return false;
      }
      if (now0 - (this._modeAt || 0) > 3000) {
        h.ChangeCombatMode(8);
        this._modeAt = now0;
        this._magicAttempts = (this._magicAttempts || 0) + 1;
        if (this._magicAttempts > MAGIC_MODE_ATTEMPT_LIMIT) {
          this._magicParkedUntil = now0 + MAGIC_MODE_PARK_MS;
          this._magicAttempts = 0;
          this.log(
            `give up entering Magic mode after ${MAGIC_MODE_ATTEMPT_LIMIT} attempts (no caster wielded?) — parked ${MAGIC_MODE_PARK_MS / 1000}s`
          );
          return false; // release the tick instead of livelocking (02 C1)
        }
      }
      return true; // still trying — holding for mode this tick
    }
    this._magicAttempts = 0; // mode established — reset the guard
    const now = Date.now();
    if (now - this.lastCastAt < CAST_INTERVAL_MS) return true;
    if (h.GetCastBusyState() !== 0 || h.GetBusyState() !== 0) return true;
    // C3 shared serializer: another module (combat/buff/recall) may hold a
    // still-open cast claim (gesture done, resolution not yet seen) — wait
    // rather than overlap it. Degrade-open if the host predates the token.
    if (typeof h.tryClaimCast === "function" && !h.tryClaimCast("vitals")) return true;

    // A clean previous cast of the same spell ends its fizzle run.
    const lc = this._lastCast;
    if (lc && lc.spell === action.spell && !lc.refused) this._fizzles.delete(action.spell);
    // Targeted at our own guid (the retail way, and the glow). NEVER
    // untargeted: ACE's untargeted path keeps a NULL target and a non-self
    // enchantment then crashes the server (buff_loop._castSelfBuff has the
    // full chain). No guid yet -> no cast; free the token and wait.
    const self = typeof h.GetPlayerId === "function" ? h.GetPlayerId() >>> 0 : 0;
    if (!self) {
      if (typeof h.releaseCast === "function") h.releaseCast("vitals");
      return true;
    }
    h.CastSpell(self, action.spell);
    this.lastCastAt = now;
    this.actions += 1;
    this.lastReason = action.reason;
    const axis = this._vitalAxis(action.reason);
    this._lastCast = { spell: action.spell, axis, at: now, refused: null };
    this._lastLoggedBlock = null;

    // Give-up valve: track whether this axis's fraction is actually
    // improving. The EMERGENCY axis is exempt (never give up on survival).
    if (axis && !action.reason.startsWith("EMERGENCY")) {
      const pct = f[axis];
      if (this._lastPct[axis] >= 0 && pct <= this._lastPct[axis] + MIN_PROGRESS_PCT) {
        this._noProgress[axis] += 1;
        if (this._noProgress[axis] >= NO_PROGRESS_LIMIT) {
          this._parkedUntil[axis] = now + VITAL_PARK_MS;
          this._noProgress[axis] = 0;
          this.log(`give up ${axis} — no progress after ${NO_PROGRESS_LIMIT} casts (spell too weak vs pool); parked ${VITAL_PARK_MS / 1000}s`);
        }
      } else {
        this._noProgress[axis] = 0; // real progress resets the counter
      }
      this._lastPct[axis] = pct;
    }

    this.log(`${action.reason} spell ${action.spell} (hp=${Math.round(f.hp)} stam=${Math.round(f.stam)} mana=${Math.round(f.mana)})`);
    return true;
  }

  get status() {
    const now = Date.now();
    const parked = Object.keys(this._parkedUntil).filter((a) => this._parkedUntil[a] > now);
    return {
      actions: this.actions,
      lastReason: this.lastReason,
      parked,
      spells: this.spells,
      blocked: this._blocked && this._blocked.until > now ? this._blocked.reason : null,
      lastRefusal: this.lastRefusal,
      ...(this._fractions() || {}),
    };
  }
}

export default RynthVitals;
