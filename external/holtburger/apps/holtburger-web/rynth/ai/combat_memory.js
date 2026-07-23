// ═══════════════════════════════════════════════════════════════════════
// PARKED — NOT WIRED. Do not call attach(host) from production code.
//
// rynth/combat_loop.js's kernel-driven P12 damage-learner remains the ONE
// kill-truth for the live bot. Wiring this module today would create a
// SECOND host.onEvent subscriber for the exact same kind=19 stream (review
// 11 D-latent / 12 §1.1 / 17-SYNTHESIS "Dark-core wiring-order sanity
// check"), and the two would disagree on what a "kill" even is:
//   - combat_loop's kills come from polling TryGetTargetHealthFraction===0
//     against a GUID-locked target — authoritative, guid-keyed.
//   - CombatMemory.kills (below) is a SEVERITY-DERIVED, NAME-KEYED estimate
//     (KILL_SEVERITY=0.999 crossing on a per-defender-name accumulator) —
//     approximate by construction (the module's own comment on
//     KILL_SEVERITY says so), and two same-named mobs killed back-to-back
//     are indistinguishable from one engagement here.
// Before this is ever wired: pick ONE kill-truth (almost certainly
// combat_loop's guid-based polling — it's already live and authoritative),
// and either delete CombatMemory's kill/TTK bookkeeping or clearly demote it
// to "approximate, name-keyed, corroboration-only, never compared to the
// kernel's kill count in any observe-block." Also note (12 §1.1): kind=19
// currently has ZERO live consumers at all — the kernel drives loops via
// `.tick()` and never calls the `startOn()` that subscribes combat_loop's
// own `_onCombatEvent`, so combat_loop's push-event path is ALSO presently
// dormant (it still functions via polling). Reconcile that seam first.
// ═══════════════════════════════════════════════════════════════════════
//
// combat_memory.js — the combat-telemetry core (Phase-2 dark module, A3-1 §D4).
// A pure, headless consumer of the kind=19 CombatEvent family (and kind=29
// Death) that the wasm client already emits on the RynthWebHost push-event
// plane (webhost.js `onEvent`; payload shapes: src/lib.rs ~L42690, api.js
// event taxonomy). It maintains windowed in/out DPS, per-name accuracy /
// defense / crit rate, an approximate time-to-kill, and a name→last-seen-damage
// danger tally — the raw material a future combat observe-block will render.
//
// DARK: this module is a READ of an already-emitted stream. It renders NOTHING
// to the director yet (the observe-block surface is deferred, A3-1 §D4), so its
// current director observation-token cost is ZERO. It never drives an action
// and never throws into the director loop (survival invariant): consume() wraps
// every path in a try/catch and degrades to a no-op on any malformed or absent
// event.
//
// INDEPENDENCE (no double-count vs combat_loop): CombatMemory owns its own
// maps and windows and holds NO reference to RynthCombatLoop's `damageModel`.
// The two are separate subscribers to the same host.onEvent tap — feeding one
// combat event increments each exactly once, in its own structure.
//
// Clock: all timestamps come from `opts.now` (default Date.now) so the windows
// and TTK are deterministic under test.
//
// Frozen public API (a future observe-block programs against this shape):
//   attach(host)               // subscribe host.onEvent; returns this
//   consume(evt)               // feed one normalized {kind,text,u32,u32b} event
//   outDps() / inDps()         // sustained damage-per-second over the window
//   outWindow() / inWindow()   // raw summed damage inside the window
//   accuracy(name) / defense(name) / critRate([name])
//   ttk(name)                  // {avgMs,lastMs,samples} | approximate, severity-derived
//   danger(name)               // last damage that attacker dealt us (0 if unknown)
//   mostDangerous()            // {name,lastSeenDamage} of the current top threat | null
//   targets() / attackers()    // name lists (defenders hit / attackers seen)
//   snapshot()                 // plain-data aggregate (NOT a rendered block)

// Protocol event kinds (numbers, not content literals) — mirror combat_loop.js.
const CLIENT_EVENT_CHAT = 2;
const CLIENT_EVENT_COMBAT = 19; // CLIENT_EVENT_KIND_COMBAT_EVENT
const CLIENT_EVENT_DEATH = 29; // CLIENT_EVENT_KIND_DEATH

// ValueSnapShotGroup(60): a 60-second sliding window. Port keeps timestamped
// samples, prunes anything older than the window, and reports the trailing
// sum and a per-second rate. Rate divides by the window span in seconds — but
// never by more than the actual elapsed run time (so a fresh window isn't
// diluted) and never by less than one second (so the very first sample can't
// produce an unbounded spike). Once the group has run longer than its window,
// the denominator is the full window: a true sustained-DPS reading.
export const DPS_WINDOW_MS = 60_000;
export { MAX_TRACKED_NAMES };
const MIN_RATE_DENOM_MS = 1_000;

export class ValueSnapShotGroup {
  constructor(windowMs = DPS_WINDOW_MS) {
    this.windowMs = windowMs;
    this.samples = []; // { t, v } oldest-first
    this.firstAt = null; // first sample ever (for the rate denominator ramp)
    this.total = 0; // lifetime sum (survives window eviction)
  }

  add(value, now) {
    const v = Number(value) || 0;
    if (this.firstAt == null) this.firstAt = now;
    this.samples.push({ t: now, v });
    this.total += v;
    this._prune(now);
  }

  _prune(now) {
    const cut = now - this.windowMs;
    let i = 0;
    while (i < this.samples.length && this.samples[i].t < cut) i++;
    if (i > 0) this.samples.splice(0, i);
  }

  sum(now) {
    if (now != null) this._prune(now);
    let s = 0;
    for (const x of this.samples) s += x.v;
    return s;
  }

  count(now) {
    if (now != null) this._prune(now);
    return this.samples.length;
  }

  // Damage-per-second over the effective window span (see class note).
  rate(now) {
    this._prune(now);
    if (!this.samples.length || this.firstAt == null) return 0;
    const elapsedMs = Math.max(now - this.firstAt, 0);
    const denomMs = Math.min(this.windowMs, Math.max(elapsedMs, MIN_RATE_DENOM_MS));
    return this.sum(now) / (denomMs / 1000);
  }
}

// A defender is considered dead once the severity (=damage/MaxHealth) we've
// dealt this engagement crosses a full bar. Approximate on purpose — it is the
// only kill signal derivable from the name-keyed damage stream alone (the
// kind=29 Death event is guid-keyed, so it can't be bridged to a name here).
const KILL_SEVERITY = 0.999;

// LRU cap for byTarget/byAttacker (name-keyed, unbounded pre-fix — synthesis
// streamline #12 / review 11 §3 S3: "add an LRU before wiring"). Same
// convention as indoor_router.js's _floorPlaneByCell: a plain Map used as an
// insertion-ordered LRU — touch (get-or-create) deletes-then-re-sets the key
// so it moves to the "most recent" end, and the least-recently-touched
// entry (the Map's first key) is evicted once the cap is exceeded. 512
// distinct names comfortably covers a long 24/7 soak's creature variety
// (retail's per-landblock spawn tables are far smaller) while bounding worst
// case (e.g. a name-spam griefer, or many uniquely-named NPCs) from growing
// forever.
const MAX_TRACKED_NAMES = 512;

// get-or-create `key` in `map`, refreshing its LRU recency on every touch
// (not just creation) — an active engagement must never be evicted out from
// under itself while cold, rarely-touched names age out first.
function lruTouch(map, key, makeDefault, maxSize) {
  let r = map.get(key);
  if (r !== undefined) {
    map.delete(key);
    map.set(key, r);
    return r;
  }
  r = makeDefault();
  map.set(key, r);
  if (map.size > maxSize) {
    map.delete(map.keys().next().value); // evict least-recently-touched
  }
  return r;
}

export class CombatMemory {
  constructor(opts = {}) {
    this._now = typeof opts.now === "function" ? opts.now : () => Date.now();
    this.windowMs = opts.windowMs || DPS_WINDOW_MS;
    // Windowed DPS: "out" = damage we deal, "in" = damage we take.
    this.out = new ValueSnapShotGroup(this.windowMs);
    this.in = new ValueSnapShotGroup(this.windowMs);
    // Per-defender offense: name -> { hits, misses, damage, crits, severitySum,
    //   engagedAt, firstAt, lastAt, kills, ttkSum, ttkCount, lastTtkMs }.
    this.byTarget = new Map();
    // Per-attacker defense/danger: name -> { taken, evaded, damage, crits,
    //   lastSeenDamage, firstAt, lastAt }.
    this.byAttacker = new Map();
    this.totals = {
      dealt: 0, taken: 0, hits: 0, misses: 0,
      evadesFor: 0, evadesAgainst: 0, critsDealt: 0, critsTaken: 0,
      swings: 0, swingErrors: 0, kills: 0,
    };
    this.observedDeaths = 0; // kind=29 count (corroboration; not name-bridged)
    this.lastDeathAt = 0;
  }

  // Subscribe to the host push-event plane. host.onEvent delivers the
  // normalized { kind, text, u32, u32b } shape (webhost.js _dispatchEvent).
  attach(host) {
    if (host && typeof host.onEvent === "function") {
      host.onEvent((e) => this.consume(e));
    }
    return this;
  }

  // Feed one normalized event. Survival invariant: never throws.
  consume(e) {
    try {
      if (!e || typeof e !== "object") return;
      if (e.kind === CLIENT_EVENT_DEATH) {
        this.observedDeaths += 1;
        this.lastDeathAt = this._now();
        return;
      }
      if (e.kind === CLIENT_EVENT_CHAT) return; // magic-damage lines are combat_loop's job; not double-counted here
      if (e.kind !== CLIENT_EVENT_COMBAT || !e.text) return;
      let d;
      try {
        d = JSON.parse(e.text);
      } catch (_) {
        return; // malformed payload — no-op
      }
      if (!d || typeof d.type !== "string") return;
      const now = this._now();
      switch (d.type) {
        case "damageDealt": return this._onDealt(d, now);
        case "damageTaken": return this._onTaken(d, now);
        case "evadedTarget": return this._onEvadedTarget(d, now);
        case "evadedAttacker": return this._onEvadedAttacker(d, now);
        case "attackDone": return this._onAttackDone(d, now);
        default: return; // combatCommenceAttack etc. — ignore
      }
    } catch (_) {
      // Degrade to no-op; the director loop must never see a throw.
    }
  }

  // ── per-event handlers ────────────────────────────────────────────────
  _target(name, now) {
    const r = lruTouch(this.byTarget, name, () => ({
      hits: 0, misses: 0, damage: 0, crits: 0, severitySum: 0,
      engagedAt: null, firstAt: now, lastAt: now,
      kills: 0, ttkSum: 0, ttkCount: 0, lastTtkMs: 0,
    }), MAX_TRACKED_NAMES);
    if (r.engagedAt == null) r.engagedAt = now;
    r.lastAt = now;
    return r;
  }

  _attacker(name, now) {
    const r = lruTouch(this.byAttacker, name, () => (
      { taken: 0, evaded: 0, damage: 0, crits: 0, lastSeenDamage: 0, firstAt: now, lastAt: now }
    ), MAX_TRACKED_NAMES);
    r.lastAt = now;
    return r;
  }

  _onDealt(d, now) {
    const name = d.defenderName || "?";
    const dmg = Number(d.damage) || 0;
    const sev = Number(d.severity) || 0;
    const crit = !!d.criticalHit;
    const r = this._target(name, now);
    r.hits += 1;
    r.damage += dmg;
    if (crit) r.crits += 1;
    r.severitySum += sev;
    this.out.add(dmg, now);
    this.totals.dealt += dmg;
    this.totals.hits += 1;
    if (crit) this.totals.critsDealt += 1;
    // Severity-derived kill + TTK (approximate; see KILL_SEVERITY note).
    if (r.engagedAt != null && r.severitySum >= KILL_SEVERITY) {
      const ttk = Math.max(now - r.engagedAt, 0);
      r.kills += 1;
      r.ttkSum += ttk;
      r.ttkCount += 1;
      r.lastTtkMs = ttk;
      r.engagedAt = null; // reset for a possible respawn under the same name
      r.severitySum = 0;
      this.totals.kills += 1;
    }
  }

  _onTaken(d, now) {
    const name = d.attackerName || "?";
    const dmg = Number(d.damage) || 0;
    const crit = !!d.criticalHit;
    const r = this._attacker(name, now);
    r.taken += 1;
    r.damage += dmg;
    r.lastSeenDamage = dmg; // name -> lastSeenDamage danger
    if (crit) r.crits += 1;
    this.in.add(dmg, now);
    this.totals.taken += dmg;
    if (crit) this.totals.critsTaken += 1;
  }

  _onEvadedTarget(d, now) {
    // We swung at defenderName and missed (accuracy denominator).
    const name = d.defenderName || "?";
    const r = this._target(name, now);
    r.misses += 1;
    this.totals.evadesFor += 1;
  }

  _onEvadedAttacker(d, now) {
    // attackerName swung at us and we dodged (defense numerator).
    const name = d.attackerName || "?";
    const r = this._attacker(name, now);
    r.evaded += 1;
    this.totals.evadesAgainst += 1;
  }

  _onAttackDone(d, now) {
    this.totals.swings += 1;
    if (d.error && d.error !== "None") this.totals.swingErrors += 1;
  }

  // ── derivations (pure reads) ──────────────────────────────────────────
  outDps(now = this._now()) {
    return this.out.rate(now);
  }
  inDps(now = this._now()) {
    return this.in.rate(now);
  }
  outWindow(now = this._now()) {
    return this.out.sum(now);
  }
  inWindow(now = this._now()) {
    return this.in.sum(now);
  }

  // accuracy(name) = hits / (hits + misses) against that defender.
  accuracy(name) {
    const r = this.byTarget.get(name);
    if (!r) return 0;
    const swings = r.hits + r.misses;
    return swings ? r.hits / swings : 0;
  }

  // defense(name) = evaded / (taken + evaded) against that attacker.
  defense(name) {
    const r = this.byAttacker.get(name);
    if (!r) return 0;
    const attempts = r.taken + r.evaded;
    return attempts ? r.evaded / attempts : 0;
  }

  // critRate(): overall crit fraction of our landed hits, or per-defender if
  // a name is given.
  critRate(name) {
    if (name != null) {
      const r = this.byTarget.get(name);
      return r && r.hits ? r.crits / r.hits : 0;
    }
    return this.totals.hits ? this.totals.critsDealt / this.totals.hits : 0;
  }

  // ttk(name): approximate time-to-kill for a defender name.
  ttk(name) {
    const r = this.byTarget.get(name);
    if (!r || !r.ttkCount) return { avgMs: 0, lastMs: 0, samples: 0 };
    return { avgMs: r.ttkSum / r.ttkCount, lastMs: r.lastTtkMs, samples: r.ttkCount };
  }

  // danger(name): the last damage that attacker dealt us (0 if never seen).
  danger(name) {
    const r = this.byAttacker.get(name);
    return r ? r.lastSeenDamage : 0;
  }

  // mostDangerous(): the attacker whose last hit landed hardest.
  mostDangerous() {
    let best = null;
    for (const [name, r] of this.byAttacker) {
      if (!best || r.lastSeenDamage > best.lastSeenDamage) best = { name, lastSeenDamage: r.lastSeenDamage };
    }
    return best;
  }

  targets() {
    return [...this.byTarget.keys()];
  }
  attackers() {
    return [...this.byAttacker.keys()];
  }

  // snapshot(): plain-data aggregate for downstream consumers. NOT a rendered
  // observe-block (that director surface is deferred, A3-1 §D4).
  snapshot(now = this._now()) {
    return {
      outDps: this.outDps(now),
      inDps: this.inDps(now),
      outWindow: this.outWindow(now),
      inWindow: this.inWindow(now),
      critRate: this.critRate(),
      totals: { ...this.totals },
      observedDeaths: this.observedDeaths,
      mostDangerous: this.mostDangerous(),
      targetCount: this.byTarget.size,
      attackerCount: this.byAttacker.size,
    };
  }
}

export default CombatMemory;
