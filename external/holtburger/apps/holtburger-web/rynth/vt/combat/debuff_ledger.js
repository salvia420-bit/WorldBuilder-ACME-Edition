// rynth/vt/combat/debuff_ledger.js — what WE have landed on which monster
// (PLAN W1-7 CMB, §2.11, V-18). ACE never sends another creature's
// enchantments to the client (U4 §7.1), so monster debuff state comes ONLY
// from our own casts: noteIssued() records the pending cast, the server's
// result line (host_signals castLine: "You cast X on Y[, surpassing …|,
// refreshing …|, but it is surpassed by …]", "Y resists your spell", "You
// fail to affect Y with X" — ACE WorldObject_Magic.cs:192/:405-440/:2136)
// confirms it, and the per-id DAT duration expires it (Incantation of
// Defenselessness Other lasts 60 s, its siblings 300 s — U6 hazard 11, so the
// timer is per id, never per level).
//
// Matching: our pending cast by spell name + target name (case-insensitive);
// the resist line names no spell, so it matches the newest pending cast at
// that target name. Two same-named monsters share a name on the wire — the
// pending cast carries the guid we aimed at, so the worst case is one extra
// recast (K5).

const PENDING_ACTIVE_MS = 6000; // an unresolved cast counts as "on" this long (windup + projectile flight)
const PENDING_TTL_MS = 12_000; // pendings older than this are dropped by prune()
const FAILED_HOLD_MS = 30_000; // "You fail to affect" (immune/invalid): don't hammer it
const MAX_PENDING = 32;

const lc = (s) => String(s ?? "").trim().toLowerCase();

export class DebuffLedger {
  constructor({ now = Date.now, durationOf = () => 0, nameOf = () => "", log } = {}) {
    this.now = typeof now === "function" ? now : Date.now;
    this.durationOf = typeof durationOf === "function" ? durationOf : () => 0;
    this.nameOf = typeof nameOf === "function" ? nameOf : () => "";
    this.log = typeof log === "function" ? log : (m) => console.log(`[vt:ledger] ${m}`);
    this._active = new Map(); // guid -> Map(family -> { spellId, until, outcome, at })
    this._pending = []; // [{ guid, targetName, spellId, spellName, family, at }]
    this._unavailable = new Map(); // family -> untilMs
  }

  /** Our cast at `guid` just went out (sent). */
  noteIssued(guid, targetName, spellId, family) {
    try {
      const g = Number(guid) >>> 0;
      if (!g || !family) return;
      const at = this.now();
      // One live pending per (guid, family): a re-issue replaces the old one.
      this._pending = this._pending.filter((p) => !(p.guid === g && p.family === family));
      this._pending.push({
        guid: g,
        targetName: lc(targetName),
        spellId: Number(spellId) || 0,
        spellName: lc(this.nameOf(spellId)),
        family: String(family),
        at,
      });
      if (this._pending.length > MAX_PENDING) this._pending.splice(0, this._pending.length - MAX_PENDING);
    } catch (_) {
      /* never throws */
    }
  }

  /** Drop the pending cast for (guid, family) — a fizzle/refusal with no result line. */
  clearPending(guid, family) {
    const g = Number(guid) >>> 0;
    this._pending = this._pending.filter((p) => !(p.guid === g && (family == null || p.family === family)));
  }

  /**
   * Match a castLine Signal against OUR pending casts. Returns
   * { guid, family, outcome, spellId } when it was ours, else null.
   */
  onCastLine(sig) {
    try {
      if (!sig || sig.type !== "castLine") return null;
      const target = lc(sig.targetName);
      if (!target) return null;
      const spell = lc(sig.spellName);
      const outcome = String(sig.outcome || "");
      let idx = -1;
      for (let i = this._pending.length - 1; i >= 0; i--) {
        const p = this._pending[i];
        if (p.targetName !== target) continue;
        if (outcome === "resisted" ? true : p.spellName && p.spellName === spell) {
          idx = i;
          break;
        }
      }
      if (idx < 0) return null;
      const p = this._pending[idx];
      this._pending.splice(idx, 1);
      const t = this.now();
      if (outcome === "landed" || outcome === "surpassing" || outcome === "refreshing" || outcome === "surpassed") {
        // surpassed: a stronger copy (someone else's) is on — treat as landed
        // for our own timer (U6 §2.4, conservative).
        const secs = Number(this.durationOf(p.spellId)) || 0;
        this._set(p.guid, p.family, { spellId: p.spellId, until: t + Math.max(0, secs) * 1000, outcome, at: t });
      } else if (outcome === "failed") {
        this._set(p.guid, p.family, { spellId: p.spellId, until: t + FAILED_HOLD_MS, outcome, at: t });
      }
      // resisted: not landed — the planner recasts on its next cycle.
      return { guid: p.guid, family: p.family, outcome, spellId: p.spellId };
    } catch (_) {
      return null;
    }
  }

  _set(guid, family, rec) {
    let m = this._active.get(guid);
    if (!m) {
      m = new Map();
      this._active.set(guid, m);
    }
    m.set(family, rec);
  }

  /**
   * true while our `family` is on `guid` with more than `leadMs` left, or a
   * cast of it is still pending (issued < PENDING_ACTIVE_MS ago, no verdict
   * yet) — so the planner moves on to the next key instead of double-casting.
   */
  isActive(guid, family, { leadMs = 2000 } = {}) {
    const g = Number(guid) >>> 0;
    const t = this.now();
    const m = this._active.get(g);
    const rec = m && m.get(family);
    if (rec && rec.until - t > leadMs) return true;
    for (const p of this._pending) {
      if (p.guid === g && p.family === family && t - p.at < PENDING_ACTIVE_MS) return true;
    }
    return false;
  }

  /** Is a cast of `family` at `guid` issued and still awaiting its result line? */
  isPending(guid, family) {
    const g = Number(guid) >>> 0;
    const t = this.now();
    return this._pending.some((p) => p.guid === g && p.family === family && t - p.at < PENDING_ACTIVE_MS);
  }

  /** Earliest expiry (ms clock) among our live debuffs on `guid`, or null. */
  earliestExpiry(guid) {
    const m = this._active.get(Number(guid) >>> 0);
    if (!m) return null;
    const t = this.now();
    let best = null;
    for (const rec of m.values()) {
      if (rec.until <= t) continue;
      if (best === null || rec.until < best) best = rec.until;
    }
    return best;
  }

  /** The character cannot cast `family` at all until `untilMs` (no known rung). */
  markUnavailable(family, untilMs) {
    if (!family) return;
    this._unavailable.set(String(family), Number(untilMs) || 0);
  }

  isUnavailable(family) {
    const until = this._unavailable.get(String(family));
    if (until == null) return false;
    if (until > this.now()) return true;
    this._unavailable.delete(String(family));
    return false;
  }

  /** Clear every "unavailable" mark (e.g. the known-spell book changed). */
  clearUnavailable() {
    this._unavailable.clear();
  }

  forget(guid) {
    const g = Number(guid) >>> 0;
    this._active.delete(g);
    this._pending = this._pending.filter((p) => p.guid !== g);
  }

  /** Drop expired debuffs, stale pendings and lapsed unavailable marks (INT-2 calls this at 1 Hz). */
  prune() {
    try {
      const t = this.now();
      for (const [g, m] of this._active) {
        for (const [fam, rec] of m) if (rec.until <= t) m.delete(fam);
        if (!m.size) this._active.delete(g);
      }
      this._pending = this._pending.filter((p) => t - p.at < PENDING_TTL_MS);
      for (const [fam, until] of this._unavailable) if (until <= t) this._unavailable.delete(fam);
    } catch (_) {
      /* never throws */
    }
  }

  /** Read-only view for status()/the panel. */
  snapshot() {
    const t = this.now();
    const active = [];
    for (const [g, m] of this._active) {
      for (const [fam, rec] of m) {
        if (rec.until > t) active.push({ guid: g, family: fam, spellId: rec.spellId, remainingS: Math.round((rec.until - t) / 1000), outcome: rec.outcome });
      }
    }
    const unavailable = [];
    for (const [fam, until] of this._unavailable) if (until > t) unavailable.push(fam);
    return { active, pending: this._pending.length, unavailable };
  }
}
