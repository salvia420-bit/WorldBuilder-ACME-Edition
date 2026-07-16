// RynthVitals — B15/B16 vital-emergency policy on the RynthWebHost seam.
//
// A faithful subset of RynthAi's OnHeartbeat vital rules (report 11 §B15/B16):
//   B15 Emergency HP override — HP <= 30% && stam > 20% -> Stamina-to-Health
//       Self, regardless of mode/config (sits below the configurable
//       thresholds so a "do nothing" config still survives).
//   B16 In-combat vs idle threshold sets — inCombat reacts at LOW thresholds
//       (HealAt=60, GetManaAt=40, RestamAt=30); idle tops up to HIGH
//       (TopOff*=95). Strict `<`; 0 disables a vital. Mana-recharge
//       (Stam->Mana) additionally requires stam > 15.
//
// Vital fractions come from playerStats().vitals: flat [type, current, base,
// buffedMax] with VitalType Health=1 / Stamina=3 / Mana=5 (holtburger_common
// ::stats::VitalType). Casts are self-targeted war-school recovery spells,
// gated + paced like the buff loop (Magic mode, cast/busy gates). Returns
// true from step() when it issued/holds a vital action this tick, so the
// caller (buff loop / kernel) yields to it.

const VITAL_HEALTH = 1;
const VITAL_STAMINA = 3;
const VITAL_MANA = 5;

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

// Self recovery spells (level-1 ids; a real config supplies the highest
// castable tier — this is the mechanism, not the spell ladder).
const SPELLS = {
  healSelf: 6, // Heal Self I
  stamToHealth: 1664, // Stamina to Health Self I
  stamToMana: 1676, // Stamina to Mana Self I
  revitalize: 1177, // Revitalize Self I (stamina)
};

const CAST_INTERVAL_MS = 400;

export class RynthVitals {
  constructor(host, opts = {}) {
    this.host = host;
    this.cfg = { ...DEFAULTS, ...(opts.thresholds || {}) };
    this.spells = { ...SPELLS, ...(opts.spells || {}) };
    this.log = opts.log || ((m) => console.log(`[vitals] ${m}`));
    this.lastCastAt = 0;
    this.actions = 0;
    this.lastReason = null;
  }

  _fractions() {
    const s = this.host.s;
    if (!s.playerStats) return null;
    let v;
    try {
      v = Array.from(s.playerStats().vitals || []).map(Number);
    } catch (_) {
      return null;
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

  /** knownSpell(id) — only cast what's in the book. */
  _known(id) {
    if (!this._knownSet) {
      const s = this.host.s;
      this._knownSet = new Set(
        (s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []) : []).map(Number)
      );
    }
    return this._knownSet.has(id);
  }

  /** Decide the next vital action from the fractions, or null. */
  _decide(f, inCombat) {
    const c = this.cfg;
    // B15 — emergency HP override (below all configurable thresholds).
    if (f.hp < c.emergencyHp && f.stam > c.emergencyStamFloor && this._known(this.spells.stamToHealth)) {
      return { spell: this.spells.stamToHealth, reason: "EMERGENCY hp->stam" };
    }
    const healAt = inCombat ? c.healAtCombat : c.topOffHp;
    const manaAt = inCombat ? c.getManaAtCombat : c.topOffMana;
    const stamAt = inCombat ? c.restamAtCombat : c.topOffStam;
    // Health first (survival).
    if (healAt > 0 && f.hp < healAt && this._known(this.spells.healSelf)) {
      return { spell: this.spells.healSelf, reason: `heal hp<${healAt}` };
    }
    // Stamina.
    if (stamAt > 0 && f.stam < stamAt && this._known(this.spells.revitalize)) {
      return { spell: this.spells.revitalize, reason: `restam stam<${stamAt}` };
    }
    // Mana recharge (Stam->Mana) — needs stamina headroom.
    if (
      manaAt > 0 &&
      f.mana < manaAt &&
      f.stam > c.manaRechargeStamFloor &&
      this._known(this.spells.stamToMana)
    ) {
      return { spell: this.spells.stamToMana, reason: `getmana mana<${manaAt}` };
    }
    return null;
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

    // Casting needs Magic mode + the gates (same traps as the buff loop).
    if (h.GetCurrentCombatMode() !== 8) {
      if (Date.now() - (this._modeAt || 0) > 3000) {
        if (h.s.toggleCombatMode) h.s.toggleCombatMode();
        this._modeAt = Date.now();
      }
      return true; // holding for mode — still "owns" the tick
    }
    const now = Date.now();
    if (now - this.lastCastAt < CAST_INTERVAL_MS) return true;
    if (h.GetCastBusyState() !== 0 || h.GetBusyState() !== 0) return true;

    h.CastSpell(0, action.spell); // untargeted = self
    this.lastCastAt = now;
    this.actions += 1;
    this.lastReason = action.reason;
    this.log(`${action.reason} (hp=${Math.round(f.hp)} stam=${Math.round(f.stam)} mana=${Math.round(f.mana)})`);
    return true;
  }

  get status() {
    return { actions: this.actions, lastReason: this.lastReason, ...(this._fractions() || {}) };
  }
}

export default RynthVitals;
