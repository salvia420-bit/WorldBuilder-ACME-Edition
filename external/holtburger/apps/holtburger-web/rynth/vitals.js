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
//
// 2026-10-13 give-up valve fix (rynth-macro-nav-3): the valve measured the
// NET change of the vital between two casts, so under sustained incoming
// damage a heal that landed in full still read as "no progress" and HP was
// parked for 60 s mid-fight. ACE tells the caster what each self vital spell
// restored (kind=2 Magic chat, WorldObject_Magic.cs: boost "You cast X and
// restore N points of your health." / transfer "You cast X on yourself and
// lose N points of stamina and also gain M points of mana"); when that line
// arrived for the axis's previous cast, the spell is judged by its own gain.
// Without a line (no event plane, globally squelched Magic chat, a fizzle)
// the old fraction compare stays. A vital back at/above its threshold also
// resets that axis's count, so the next fight starts fresh.
//
// 2026-10-13 skill cap + demotion expiry (rynth-macro-nav-4):
//   * A fizzle demotion (three in a row) expires after FIZZLE_DEMOTE_RETRY_MS,
//     the combat planner's EXCLUDE_MS and the buff loop's fizzle-walk retry.
//     It used to last for the bot's life, so a tier lost to bad luck before
//     the Focus / Willpower / Life mastery buffs landed never came back.
//     "Not in the spellbook" demotions stay permanent.
//   * Opt-in (opts.skillCap / setSkillCap, off by default): every axis — the
//     B15 Stamina-to-Health rung included — resolves to the highest known tier
//     the buffed Life Magic skill reaches (skill_cap.js; RynthAi
//     AttemptVitalCast → GetDynamicSelfBuffId over GetHighestBuffSpellTier).
//     ACE fails a cast outright below Power − 50 and rolls a 0.07 sigmoid
//     above it, so the highest KNOWN tier is often one the character can't
//     cast yet. When no known tier is within the cap, today's pick stands. A
//     rise of the Life tier also lifts the fizzle demotions it now covers.

import { portalSpaceActive } from "./portal_gate.js";
import { castRefusalClass, casterWielded } from "./buff_loop.js";
import { SCHOOL } from "./skill_cap.js";

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
// Spell level of every ladder id (slot + 1 — V7 checks the scarab levels).
const VITAL_TIER = new Map();
for (const ids of Object.values(VITAL_LADDERS)) ids.forEach((id, i) => VITAL_TIER.set(id, i + 1));

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
// Since 2026-10-13 "improving" is the spell's own reported gain (pts / max)
// when ACE's gain line came, the fraction change otherwise (header).
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
// A fizzle demotion is lifted after this long (rynth-macro-nav-4): three in a
// row are bad luck at skill ≈ power (ACE SkillCheck sigmoid), not a ceiling —
// the combat planner's EXCLUDE_MS, the buff loop's FIZZLE_WALK_RETRY_MS.
const FIZZLE_DEMOTE_RETRY_MS = 10 * 60_000;
// A fizzle (or other refusal) belongs to our last cast when it lands inside
// this window — longer than the slowest recovery cast (~3.1 s for a tier-6
// spell at CastSpeed 2; level 7/8 fast casts are quicker).
const REFUSAL_WINDOW_MS = 10_000;
const COMPONENTS_PARK_MS = 60_000;
const MANA_AXIS_PARK_MS = 10_000;

// ACE's caster lines for a self vital spell (ChatMessageType.Magic, sent as a
// kind=2 chat event with the text as-is). The amount is the clamped delta the
// spell really applied (Creature.UpdateVitalDelta), so it measures the spell,
// not the net change under incoming damage.
//   boost    (WorldObject_Magic.cs HandleCastSpell vital arm):
//            "You cast Heal Self VI and restore 200 points of your health."
//   transfer (WorldObject_Magic.cs transfer arm, source == destination):
//            "You cast Stamina to Mana Self I on yourself and lose 50 points
//             of stamina and also gain 45 points of mana"
const BOOST_GAIN_LINE = /^You cast (.+) and restore (\d+) points? of your (health|stamina|mana)\b/;
const TRANSFER_GAIN_LINE = /^You cast (.+) on yourself and lose \d+ points? of \w+ and also gain (\d+) points? of (health|stamina|mana)\b/;
const GAIN_AXIS = Object.freeze({ health: "hp", stamina: "stam", mana: "mana" });

/** Parse ACE's self-cast vital gain line → { spellName, axis, pts }, or null. */
export function parseVitalGainLine(text) {
  if (typeof text !== "string") return null;
  const m = BOOST_GAIN_LINE.exec(text) || TRANSFER_GAIN_LINE.exec(text);
  if (!m) return null;
  return { spellName: m[1], axis: GAIN_AXIS[m[3]], pts: Number(m[2]) };
}

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
    // 2026-10-13: the last cast per axis (the _lastCast record; its `gain` is
    // filled from ACE's gain line) and the buffed max per axis from the last
    // _fractions() read — the valve's own-gain measure.
    this._axisCast = { hp: null, stam: null, mana: null };
    this._max = { hp: 0, stam: 0, mana: 0 };
    // 2026-10-12 state.
    this._knownSet = null;
    this._knownAt = 0;
    this._demoted = new Set(); // spell ids skipped by the ladder resolution
    // spell id -> ts: the fizzle members of _demoted, lifted at ts
    // (FIZZLE_DEMOTE_RETRY_MS). Ids absent here (not in the book) stay.
    this._demotedUntil = new Map();
    this._fizzles = new Map(); // spell id -> consecutive fizzles
    this._lastCast = null; // { spell, axis, at, refused, gain, emergency }
    this._blocked = null; // { reason, until }
    this._lastLoggedBlock = null;
    this.lastRefusal = null;
    // Opt-in skill cap (rynth-macro-nav-4): fn(school) -> highest castable
    // level (skill_cap.js createHostSkillCap), or null = the highest known tier.
    this.skillCap = null;
    this._lifeCapSeen = null; // the Life cap at the last step (rise detection)
    this.setSkillCap(opts.skillCap);
    if (typeof host?.onEvent === "function") host.onEvent((e) => this._onEvent(e));
  }

  /** Opt-in skill cap: `fn(school) → highest castable level`
   *  (skill_cap.js createHostSkillCap), or null/absent for today's highest
   *  known tier. Takes effect at the next resolution. */
  setSkillCap(fn) {
    this.skillCap = typeof fn === "function" ? fn : null;
    this._lifeCapSeen = null;
  }

  // The Life Magic cap (every vital spell is Life school); Infinity = no cap.
  _lifeCap() {
    const cap = this.skillCap;
    if (!cap) return Infinity;
    try {
      const v = Number(cap(SCHOOL.Life));
      return Number.isNaN(v) ? Infinity : v;
    } catch (_) {
      return Infinity;
    }
  }

  // A demoted id, unless its fizzle demotion ran out (lifted here, lazily).
  _isDemoted(id) {
    if (!this._demoted.has(id)) return false;
    const until = this._demotedUntil.get(id);
    if (until == null || Date.now() < until) return true;
    this._demotedUntil.delete(id);
    this._demoted.delete(id);
    this.log(`${id} back on the ladder (fizzle demotion expired)`);
    return false;
  }

  // Skill cap on: a RISE of the Life tier (Focus / Willpower / Life mastery
  // landing) lifts the fizzle demotions of the tiers it now covers — the odds
  // they were demoted under are gone. A tier above the new cap stays demoted:
  // lifting it could only make it today's fallback pick again.
  _checkSkillRise() {
    if (!this.skillCap) return;
    const life = this._lifeCap();
    const prev = this._lifeCapSeen;
    this._lifeCapSeen = life;
    // Only a finite -> higher finite move: skills turning readable is no rise.
    if (!(Number.isFinite(prev) && Number.isFinite(life) && life > prev) || !this._demotedUntil.size) return;
    for (const id of [...this._demotedUntil.keys()]) {
      if (!(VITAL_TIER.get(id) <= life)) continue;
      this._demotedUntil.delete(id);
      this._demoted.delete(id);
      this.log(`${id} back on the ladder (Life Magic tier ${prev} -> ${life})`);
    }
  }

  /** Resolved spell per role — the pinned id, else the highest known tier
   *  (within the Life skill cap when one is set).
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
    const cap = this._lifeCap(); // Infinity unless the opt-in skill cap is set
    // Nothing known within the cap: today's pick, but only from below the
    // lowest demoted tier — a demotion never resolves UP to a tier above it.
    let fallback = null;
    for (let i = ladder.length - 1; i >= 0; i--) {
      const id = ladder[i];
      if (this._isDemoted(id)) {
        fallback = null;
        continue;
      }
      if (!this._known(id)) continue;
      if (i + 1 <= cap) return id;
      if (fallback == null) fallback = id;
    }
    return fallback ?? ladder[0]; // nothing known — _decide's _known() check skips it
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
      const axis = type === VITAL_HEALTH ? "hp" : type === VITAL_STAMINA ? "stam" : type === VITAL_MANA ? "mana" : null;
      if (!axis) continue;
      out[axis] = pct;
      this._max[axis] = max; // the valve's own-gain measure (pts / max)
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

  // kind=13 refusal codes for our most recent cast (see REFUSAL_WINDOW_MS);
  // kind=2 gain lines for the axis's last cast (_onGainLine).
  _onEvent(e) {
    if (e && e.kind === 2) {
      this._onGainLine(e);
      return;
    }
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
      if (n >= FIZZLE_DEMOTE_LIMIT) this._demote(lc.spell, `fizzled ${n}x in a row`, FIZZLE_DEMOTE_RETRY_MS);
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

  // ACE's "You cast X and restore N points of your <vital>" (or the transfer
  // form) for the last cast on that vital's axis, inside the same attribution
  // window as refusals. First line wins; a refused cast has no gain.
  _onGainLine(e) {
    const g = parseVitalGainLine(e.text);
    if (!g) return;
    const rec = this._axisCast[g.axis];
    if (!rec || rec.refused || rec.gain != null || Date.now() - rec.at > REFUSAL_WINDOW_MS) return;
    // Another module's cast in flight? The shared token names its owner.
    const tok = this.host.castToken;
    if (tok && tok.owner && tok.owner !== "vitals") return;
    rec.gain = g.pts;
  }

  // A vital back at/above its threshold ends that axis's recovery episode:
  // the give-up count starts over, so the first cast of the next fight at a
  // lower fraction than the last cast of this one is not "no progress".
  _resetRecoveredAxes(f, inCombat) {
    const c = this.cfg;
    const at = {
      hp: inCombat ? c.healAtCombat : c.topOffHp,
      mana: inCombat ? c.getManaAtCombat : c.topOffMana,
      stam: inCombat ? c.restamAtCombat : c.topOffStam,
    };
    for (const axis of ["hp", "mana", "stam"]) {
      if (at[axis] > 0 && f[axis] < at[axis]) continue; // still recovering
      this._lastPct[axis] = -1;
      this._noProgress[axis] = 0;
      this._axisCast[axis] = null;
    }
  }

  // `retryMs` > 0 (a fizzle run) lifts the demotion after that long; without
  // it (not in the book) the demotion is for good, and stays so.
  _demote(spell, why, retryMs = 0) {
    this._fizzles.delete(spell);
    const permanent = this._demoted.has(spell) && !this._demotedUntil.has(spell);
    if (retryMs > 0 && !permanent) this._demotedUntil.set(spell, Date.now() + retryMs);
    else this._demotedUntil.delete(spell);
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
    this._resetRecoveredAxes(f, inCombat);
    this._checkSkillRise(); // no-op unless the opt-in skill cap is set
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
    const emergency = action.reason.startsWith("EMERGENCY");
    const prev = axis ? this._axisCast[axis] : null;
    this._lastCast = { spell: action.spell, axis, at: now, refused: null, gain: null, emergency };
    if (axis) this._axisCast[axis] = this._lastCast;
    this._lastLoggedBlock = null;

    // Give-up valve: track whether this axis's recovery is actually
    // working. The EMERGENCY axis is exempt (never give up on survival).
    // When ACE reported what the axis's previous cast restored, judge the
    // spell by that (incoming damage can hold the fraction flat while every
    // heal lands); otherwise compare the fraction with the previous cast's.
    if (axis && !emergency) {
      const pct = f[axis];
      const max = this._max[axis];
      const stalled =
        prev && !prev.emergency && prev.gain != null && max > 0
          ? (prev.gain / max) * 100 < MIN_PROGRESS_PCT
          : this._lastPct[axis] >= 0 && pct <= this._lastPct[axis] + MIN_PROGRESS_PCT;
      if (stalled) {
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
