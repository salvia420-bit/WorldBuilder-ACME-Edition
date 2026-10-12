// RynthCombatLoop — Phase-2 combat brain on the RynthWebHost seam.
//
// A faithful minimal subset of RynthAi's combat contract as extracted in
// docs/rynth-integration/workflow-reports/11.md. Constants are lifted
// verbatim (report 11 §constants table); rule tags reference its numbering.
// Degrade-open (contract 0.1): absent gates fall back to interval pacing,
// never block.
//
// Live-confirmed traps this encodes:
// - ACE silently reverts Melee mode when a bow/wand is wielded — use the
//   equipment-derived suggested-mode toggle, never a blind SetCombatMode.
// - objectHealthFraction is QueryHealth-fed — poll the locked target.
//
// 2026-10-12 engagement protocol (client melee rework 86c4d11e Phase F +
// ACE semantics). The client no longer runs the player up to a melee target
// itself — a melee click only sends the attack, ACE answers with its own
// charge MoveTo (sticky bit, Player_Move.cs MoveTo) and auto-repeats the
// swing (Player_Melee.cs Attack), and `stickToEntity` survives only for this
// bot. So, per engagement:
// - ONE attack request, not one per 9 s: ACE ignores a TargetedMeleeAttack
//   while its MeleeTarget is alive (Player_Melee.cs:99) and every request
//   rides a MaybeStopCompletely whose MoveToState stops a running charge
//   chain (GameActionMoveToState.cs:22-26). Re-issue only on a new lock, on
//   the loop's END (kind=19 attackDone with an error — ACE sends
//   ActionCancelled when the repeat chain ends, None between swings), or
//   after MELEE_SWING_PATIENCE_MS of silence (no event plane / lost events).
// - Range first: a charge that runs 15 m without arriving fails with "You
//   charged too far!" (FailDistance 15, MoveToManager.cs:488), and a missile
//   shot / spell out of range is refused (Player_Missile.cs TargetInRange,
//   Player_Magic.cs VerifySpellRange — neither approaches). Beyond the
//   mode's engage range the bot runs up on the local StickyManager and sends
//   nothing; a range refusal (MissileOutOfRange / YouChargedTooFar) closes
//   the next approach to CLOSE_IN_RANGE_M.
// - The stick is re-asserted, not assumed: every server motion for the
//   local player re-runs the stick preamble and unsticks unless the motion
//   carries a sticky target (src/session/messages/position.rs:1100-1122) —
//   a stance change or a cast gesture silently drops it.
// - Switching or dropping a live engagement sends CancelAttack (ACE keeps
//   swinging at the old MeleeTarget otherwise).

// T9 — alt must beat locked+stickiness. C#'s 25.0 (CombatManager.cs:344) is
// on ScoreCandidate's 2-pts-per-yard distance scale ((maxDist-d)/maxDist*100,
// MonsterRange default 50 — CombatManager.cs:2215); our score is 1 pt/yd
// (100-d), so the scale-equivalent threshold is 12.5. 25 here made the lock
// ~2x stickier than the tuned behavior (netwasm parity finding 1).
const TARGET_SWITCH_STICKINESS = 12.5;
const TARGET_SCAN_GRACE_MS = 1500; // T10 — retain lock through an EMPTY scan gap
// P2/E4 cast resolution. ACE answers EVERY cast request with exactly one
// UseDone (success after the recoil, or the refusal), so with UseDone in the
// capability set the deadline is only a lost-event backstop: ACE plays
// windups at CastSpeed 2, level-5+ bolts take 2.9-4.4 s and level 8 ~7 s —
// the old flat 2.5 s "resolved" casts that were still winding up and fired
// the next one into ACE's busy window. Without UseDone the old 2.5 s pacing
// stays (degrade-open). Refusals (kind=13 codes) resolve early.
const CAST_RESOLUTION_TIMEOUT_MS = 2500;
const CAST_RESOLUTION_USEDONE_TIMEOUT_MS = 12_000;
const CAST_MANA_BACKOFF_MS = 5000; // out of mana: let vitals refill before the next bolt
// Cast refusal codes (mirror of buff_loop.js REFUSAL_CLASSES — copied, not
// imported: this file must stay import-free for the byte-copy harnesses).
const CAST_REFUSALS = new Map([
  [0x0400, "components"], // YouDontHaveAllTheComponents
  [0x0401, "mana"], // YouDontHaveEnoughManaToCast
  [0x0402, "fizzle"], // YourSpellFizzled
  [0x0407, "place"], // YourSpellCannotBeCastOutside
  [0x0408, "place"], // YourSpellCannotBeCastInside
  [0x001d, "transient"], // YoureTooBusy
  [0x04eb, "transient"], // YouCantDoThatWhileInTheAir
  [0x042c, "transient"], // TargetNotAcquired
  [0x0498, "transient"], // YouHaveMovedTooFar (PK windup move cap)
  [0x000f, "transient"], // BadCast
  [0x03fc, "unknown-spell"], // MagicInvalidSpellType — not in the spellbook
  [0x0550, "range"], // MissileOutOfRange (VerifySpellRange)
]);
// T2/T13 — confirmed-kill re-engage suppression. C# RECENTLY_KILLED_SUPPRESS_MS
// = 4000.0 (CombatManager.cs:234); the 30s previously here ignored mobs that
// respawn/survive inside 4-30s which C# re-engages (netwasm parity finding 5).
const RECENTLY_KILLED_TTL_MS = 4000;
const QUERY_HEALTH_INTERVAL_MS = 1000;
// Fallback re-issue window for a melee/missile engagement whose server loop
// shows no sign of life (no swing, damage or attackDone event) — only bites
// when the push-event plane is absent or an event was lost.
const MELEE_SWING_PATIENCE_MS = 9000;
const ATTACK_REISSUE_MIN_MS = 1000; // never re-request an attack faster than this
// A kill or a CancelAttack leaves ONE loop-end (attackDone ActionCancelled)
// still in flight for the OLD loop — it lands a swing-length after the death
// motion, i.e. after the next request. Each such end is expected (counted)
// and swallowed instead of ending the new engagement; an expectation older
// than this is dropped so a lost event can't eat a real refusal for good.
const STALE_LOOP_END_TTL_MS = 3000;
// Engage ranges (metres, centre to centre as the bot measures; ACE measures
// cylinder distance, so these carry the radii as margin).
const MELEE_CHARGE_RANGE_M = 12; // under ACE's 15 m charge FailDistance
const MISSILE_ENGAGE_RANGE_M = 20; // thrown ~23 m, bows 40-78 m (Creature_Missile.cs GetMaxMissileRange)
const MAGIC_ENGAGE_RANGE_M = 15; // BaseRangeConstant + (init+ranks)*BaseRangeMod — a fresh caster's bolt reaches ~15 m
const CLOSE_IN_RANGE_M = 4; // after a range refusal: run in close before the next try
// APPROACH progress watchdog: the run-up has no pathing (the stick steers
// straight at the target), so a mob across water / behind a wall would hold
// the loop forever. No APPROACH_PROGRESS_M of closing within APPROACH_STALL_MS
// parks the target as unreachable for UNREACHABLE_PARK_MS (the C# input's
// `Blacklisted` bit — RynthAi's own unreachable blacklist).
const APPROACH_PROGRESS_M = 1;
const APPROACH_STALL_MS = 8000;
const UNREACHABLE_PARK_MS = 60_000;
// No-contact blacklist (RynthAi CombatManager.JudgePendingCast, reworked after
// the 2026-10-12 review). A lock is parked only when our attacks make NO
// CONTACT with it. Contact = its health fraction dropped, a damage line naming
// it, OR it defended (our attack evaded / our spell resisted — a tough target is
// hittable, just slow). Magic counts RESOLVED casts (UseDone or the deadline;
// a refusal never reached the target and doesn't count), each judged
// BLACKLIST_CAST_SETTLE_MS after it resolved so its damage has landed (level-5+
// windups run 3-4 s). BLACKLIST_ATTEMPTS such misses in a row park the target
// for BLACKLIST_TIMEOUT_MS (RynthAi defaults: 3 / 1500 ms / 30 s). Melee/missile
// (ACE repeats the attack itself): NO_PROGRESS_ATTACK_MS in ATTACK with no
// contact. A lock that attacked us within ATTACKER_GRACE_MS is never parked —
// idling under attack is worse than swinging at it. Live-hit 2026-10-12 on the
// 1070: an admin-@create'd Drudge stayed at 100% through 30+ Flame Bolts (they
// flew through it into festival pumpkins) and held the lock forever.
const BLACKLIST_ATTEMPTS = 3;
const BLACKLIST_CAST_SETTLE_MS = 1500;
const BLACKLIST_TIMEOUT_MS = 30_000;
const NO_PROGRESS_ATTACK_MS = 20_000;
const ATTACKER_GRACE_MS = 10_000;
const REFUSAL_LATE_MS = 1500; // a kind=13 refusal that trails its own UseDone (event plane lags the seq)
// …and arrives right after the NEXT cast went out (the tick that resolved the
// old cast casts again at once): within this long of that issue, with the
// UseDone seq unchanged since, it is the previous cast's refusal — a refusal of
// the new cast either comes as an errored UseDone (the seq has moved) or, for a
// fizzle, only after the windup (>= ~1 s).
const STALE_REFUSAL_MS = 500;
const STICK_REASSERT_MS = 500; // min spacing between StickToObject re-asserts
const STICK_BLIND_REASSERT_MS = 1500; // re-assert cadence when the stick can't be read back
const INCAPABLE_PARK_MS = 60_000; // stand-down window when this character can't fight right now
const DEATH_SEEN_TTL_MS = 10_000; // kind=29 victim memory for the kill confirm
const MODE_TOGGLE_LIMIT = 5; // combat-mode toggles before standing down
const WE_MISSILE_OUT_OF_RANGE = 0x0550; // WeenieError.MissileOutOfRange (missile + spell range refusals)
const WE_YOU_CHARGED_TOO_FAR = 0x003d; // WeenieError.YouChargedTooFar (charge FailDistance)
const CLIENT_EVENT_CHAT = 2; // kind=2 chat line (u32 = WeenieError code on failure lines)
const CLIENT_EVENT_USE_FAILED = 13; // kind=13 UseDone(error) / spell-cast WeenieError (u32 = code)
const WAR_BOLTS = [27, 28, 58, 64, 75, 86, 92]; // level-1 war spells

const KILL_CONFIDENCE = 0.8; // P12 — predict kill if remHP <= avgDmg*0.80
const KILL_MIN_SAMPLES = 3; // P12 — need >=3 learned hits first
const FACE_TOLERANCE_RAD = (15 * Math.PI) / 180; // P3 — 15° facing window
const FACE_SETTLE_MS = 140; // P3 — turn-stop -> cast settle (>=1 server tick)
const FACE_MAX_WAIT_MS = 2500; // P3 — magic facing safety cap

const ITEM_TYPE_CREATURE = 16;
const PLAYER_GUID_MIN = 0x50000000;
const PLAYER_GUID_MAX = 0x5fffffff;

const CLIENT_EVENT_COMBAT = 19; // CLIENT_EVENT_KIND_COMBAT_EVENT
const CLIENT_EVENT_DEATH = 29; // CLIENT_EVENT_KIND_DEATH

/** Offset me -> pos in the global frame (landblock index * 192 + local), so
 *  a target across a landblock seam has a true direction and range. */
export function globalDelta(me, pos) {
  const a = me.objCellId >>> 0;
  const b = pos.objCellId >>> 0;
  return {
    dx: (((b >>> 24) & 0xff) - ((a >>> 24) & 0xff)) * 192 + (pos.x - me.x),
    dy: (((b >>> 16) & 0xff) - ((a >>> 16) & 0xff)) * 192 + (pos.y - me.y),
  };
}

/** Distance in the global frame, so a lock that crossed into the next
 *  landblock keeps a true range. */
export function globalDist(me, pos) {
  const { dx, dy } = globalDelta(me, pos);
  return Math.hypot(dx, dy, (pos.z ?? 0) - (me.z ?? 0));
}

export class RynthCombatLoop {
  constructor(host, opts = {}) {
    this.host = host;
    this.log = opts.log || ((m) => console.log(`[combat] ${m}`));
    // T8 — opt-in monster priority: name-substring (lowercase) -> priority.
    // priorityScore = max(0, priority-1)*5 (report 11 T8 formula); a target
    // whose name contains a key gets that bias. Default rules add 0.
    this.priorities = opts.priorities || {}; // { "olthoi": 10, "rat": 0 }
    // Attack request shape (RynthAi MeleeAttackPower/MissileAttackPower/
    // *AttackHeight). Height is the retail enum (1 High, 2 Medium, 3 Low);
    // power/accuracy in [0,1] — ACE: damage x(0.5+power), refill = power s.
    this.attackHeight = opts.attackHeight ?? 2;
    this.meleePower = opts.meleePower ?? 0.6;
    this.missileAccuracy = opts.missileAccuracy ?? 0.6;
    this.meleeChargeRangeM = opts.meleeChargeRangeM ?? MELEE_CHARGE_RANGE_M;
    this.missileRangeM = opts.missileRangeM ?? MISSILE_ENGAGE_RANGE_M;
    this.magicRangeM = opts.magicRangeM ?? MAGIC_ENGAGE_RANGE_M;
    this.state = "IDLE"; // IDLE | ACQUIRE | ENGAGE | APPROACH | ATTACK
    this.locked = 0; // T9 lock
    this.lockedScore = -1;
    this.lastSeenLockedAt = 0; // T10
    this.recentlyKilled = new Map(); // guid -> diedAt (T2)
    this.kills = 0;
    // P12 — damage learning, keyed by target guid:
    //   { hits, totalDamage, maxHp } ; maxHp learned as damage/severity.
    this.damageModel = new Map();
    this.predictedKill = false; // armed when remHP <= avgDmg*confidence
    // Lifetime learning telemetry (survives per-target model deletion).
    this.lifetimeHits = 0;
    this.lifetimeMaxHpLearned = 0;
    this.predictionsMade = 0;
    this.mode = 1;
    this.modeRequestedAt = 0;
    // P5 mark-on-issue
    this.awaitingCast = false;
    this.castIssuedAt = 0;
    this.useDoneAtIssue = 0;
    this.lastQueryAt = 0;
    this.lastSwingAt = 0;
    this.warSpell = null;
    this._running = false;
    // Director-togglable hunting (2026-07-21 scope addition): the combat
    // kernel auto-engages any attackable object whenever it's on; the AI
    // director now owns that as a toggle (hunt_start/hunt_stop,
    // tools/world.js) so it can hunt when it chooses and stand down while
    // surveying/traveling/dying. Defaults to CURRENT behavior (true) — the
    // boot-time on/off switch (?botKernel=off / config.kernel===false, the
    // WHOLE kernel) is unchanged; this is a narrower runtime knob on just
    // the combat loop's own target scan.
    this.enabled = true;
    // One melee/missile engagement = one server repeat loop:
    // { target, issuedAt, issues, loopEnded, loopEndedAt, endError,
    //   lastActivityAt, damageSeen } — null when no request is live.
    this._engage = null;
    this._closeInFor = 0; // guid whose last try was refused for range
    this._stuckTo = 0;
    this._stuckAt = 0;
    this._incapableUntil = 0; // stand-down deadline (no war spell, no combat mode)
    this.incapableReason = null;
    this._deaths = new Map(); // kind=29 victim guid -> seenAt (kill confirm)
    this._scanEpoch = 0; // bumps on recentlyKilled writes (scan memo key)
    this._scanMemo = null;
    this._hfSeen = { guid: 0, hf: -1 }; // last polled fraction of the lock (P12)
    this._pendingDelta = null; // magic damage awaiting its fraction drop (P12)
    this._staleEnds = 0; // old-loop attackDone ends still expected (kill/cancel)
    this._staleEndsAt = 0;
    this._approach = null; // { target, bestDist, bestAt } — run-up progress
    this.unreachable = new Map(); // guid -> parkedUntil (approach stalled / no-damage blacklist)
    this._castHoldUntil = 0; // mana-refusal backoff for war casts
    this._evTap = false;
    this._evTapLive = false; // a host event tap is installed (contact lines can arrive)
    // No-contact blacklist (see BLACKLIST_* above).
    this.blacklistAttempts = opts.blacklistAttempts ?? BLACKLIST_ATTEMPTS;
    this.blacklistSettleMs = opts.blacklistSettleMs ?? BLACKLIST_CAST_SETTLE_MS;
    this.blacklistTimeoutMs = opts.blacklistTimeoutMs ?? BLACKLIST_TIMEOUT_MS;
    this.noProgressAttackMs = opts.noProgressAttackMs ?? NO_PROGRESS_ATTACK_MS;
    this.attackerGraceMs = opts.attackerGraceMs ?? ATTACKER_GRACE_MS;
    // Per-lock contact watch: { target, name, hf, misses: [resolvedAt…],
    // lastContactAt, attackSince } — misses = our resolved casts since the
    // last contact.
    this._watch = null;
    this._castTarget = 0; // the lock the cast in flight was aimed at
    this._lastAttempt = null; // { target, at } — last cast resolved as an attempt
    this._attackers = new Map(); // creature name -> last time it hit / swung at us
    this.blacklisted = 0; // targets parked for no contact (status)
  }

  /** Portal space (tunnel through world fade-in) — mirror of
   *  rynth/portal_gate.js portalSpaceActive (inlined: this file stays
   *  import-free). Retail never acts in portal space; any absence/throw reads
   *  as "not in portal space". */
  _portalSpace() {
    const h = this.host;
    try {
      if (typeof h.IsPortalSpaceActive === "function") return h.IsPortalSpaceActive() === true;
    } catch (_) {
      /* fall through to the page global */
    }
    try {
      const f = typeof globalThis !== "undefined" ? globalThis.__isPortalSpaceActive : undefined;
      return typeof f === "function" && f() === true;
    } catch (_) {
      return false;
    }
  }

  startOn(host) {
    this._running = true;
    host.onTick(() => {
      if (this._running) {
        try {
          this.tick();
        } catch (e) {
          this.log(`tick threw: ${e.message}`);
        }
      }
    });
    this._ensureEventTap();
  }

  // Push-event subscription (P12 damage learning, the attack-loop end
  // signal, range refusals, kind=29 deaths). Installed lazily on the first
  // tick so the kernel path — which drives tick() directly and never called
  // startOn() — gets it too (the dormant-seam finding, rynth-review 12 §1.1).
  // Idempotent; a host without onEvent (unit mocks) degrades to polling.
  _ensureEventTap() {
    if (this._evTap) return;
    this._evTap = true;
    const h = this.host;
    if (h && typeof h.onEvent === "function") {
      h.onEvent((e) => this._onCombatEvent(e));
      this._evTapLive = true; // damage/evade/resist lines can reach the contact watch
    }
  }

  // Report 11 P12, web-native: learn per-hit damage from BOTH sources —
  // melee/missile carry severity (=damage/MaxHP) directly in the kind=19
  // `damageDealt` payload; magic damage arrives as a combat-category chat
  // line ("You singe X for N points with SPELL") with no severity. For the
  // latter (and as a cross-check for the former) MaxHP is learned from the
  // polled health-fraction DELTA: dealing `dmg` that drops the fraction by
  // Δf implies MaxHP ≈ dmg/Δf. This uses the QueryHealth stream the web
  // client gives us for the selected target — the constraint report 11 was
  // written around (no unselected-mob HP) is relaxed here.
  _learnDamage(dmg, severity) {
    if (!this.locked || !(dmg > 0)) return;
    const m = this.damageModel.get(this.locked) || { hits: 0, totalDamage: 0, maxHp: 0 };
    m.hits += 1;
    m.totalDamage += dmg;
    if (severity > 0) {
      this._learnMaxHp(m, dmg / severity); // direct (melee/missile)
    } else {
      // Fraction-delta learn: the QueryHealth reply that shows this hit
      // trails the chat line, so pair the damage with the NEXT observed drop
      // (_observeHealth) against the fraction polled before it. Hits that
      // land before that drop accumulate into the same delta. (The old code
      // compared against `_lastHf`, which nothing ever assigned — the magic
      // half of P12 never learned a MaxHP.)
      const base =
        this._pendingDelta && this._pendingDelta.guid === this.locked
          ? this._pendingDelta.base
          : this._hfSeen.guid === this.locked
            ? this._hfSeen.hf
            : -1;
      if (base > 0) {
        const prev = this._pendingDelta && this._pendingDelta.guid === this.locked ? this._pendingDelta.dmg : 0;
        this._pendingDelta = { guid: this.locked, base, dmg: prev + dmg };
      }
    }
    this.lifetimeHits += 1;
    this.damageModel.set(this.locked, m);
  }

  _learnMaxHp(m, learnedMax) {
    if (!(learnedMax > 0) || !Number.isFinite(learnedMax)) return;
    m.maxHp = m.maxHp ? Math.max(m.maxHp, learnedMax) : learnedMax;
    this.lifetimeMaxHpLearned = Math.max(this.lifetimeMaxHpLearned, learnedMax);
  }

  // Feed one polled health fraction of the lock (tick-side): resolves a
  // pending magic-damage delta, then records the fraction as the next base.
  _observeHealth(guid, hf) {
    if (!guid || !(hf >= 0)) return;
    const p = this._pendingDelta;
    if (p && p.guid === guid && hf < p.base - 1e-6) {
      const m = this.damageModel.get(guid);
      if (m) this._learnMaxHp(m, p.dmg / (p.base - hf));
      this._pendingDelta = null;
    }
    this._hfSeen = { guid, hf };
  }

  _onCombatEvent(e) {
    if (!e) return;
    const now = Date.now();
    if (e.kind === CLIENT_EVENT_DEATH) {
      // PlayerKilled broadcast (victim u32, killer u32b): authoritative, and
      // it survives the corpse swap that can pull the dead creature out of
      // the entity store before a tick reads its hp=0.
      const victim = e.u32 >>> 0;
      if (victim) {
        this._deaths.set(victim, now);
        if (this._deaths.size > 64) this._pruneDeaths(now);
      }
      this.damageModel.delete(victim);
      return;
    }
    // Range refusals: WeenieError lines carry the code in u32 (kind=2 chat
    // or kind=13 for the spell-cast subset / UseDone errors). Close in on
    // the current lock before the next try.
    if (e.kind === CLIENT_EVENT_CHAT || e.kind === CLIENT_EVENT_USE_FAILED) {
      const code = e.u32 >>> 0;
      if ((code === WE_MISSILE_OUT_OF_RANGE || code === WE_YOU_CHARGED_TOO_FAR) && this.locked) {
        if (this._closeInFor !== this.locked) {
          this.log(`range refusal (0x${code.toString(16)}) on ${this.locked.toString(16)} — closing in`);
        }
        this._closeInFor = this.locked;
      }
      // One of OUR casts refused (kind=13 carries the spell-cast codes; a
      // fizzle never sends UseDone): resolve it instead of waiting out the
      // deadline. Other owners' casts are serialized out by the token.
      if (e.kind === CLIENT_EVENT_USE_FAILED) {
        if (this.awaitingCast && !this._staleRefusal(now)) this._onCastRefusal(code, now, false);
        else if (this._lateRefusalWindow(now)) this._onCastRefusal(code, now, true);
      }
      if (code === WE_MISSILE_OUT_OF_RANGE || code === WE_YOU_CHARGED_TOO_FAR) return;
    }
    // Magic damage: combat-category chat line ("You <verb> <name> for N
    // points with <spell>").
    if (e.kind === CLIENT_EVENT_CHAT && e.text) {
      // ACE SpellProjectile.cs: "[Critical hit! ][Overpower! ][Sneak Attack! ]You
      // <verb> <target> for N points with <spell>." — the prefixes end in "! ".
      const m = /(?:^|! )You \w+ (.+?) for (\d+) points? with /.exec(e.text);
      if (m) {
        this._learnDamage(Number(m[2]), 0);
        // Contact only for the LOCK by name (a bolt that flew past it into
        // something else is a miss on the lock).
        this._noteContact(m[1], now);
        return;
      }
      // "<Name> resists your spell" (WorldObject_Magic.cs TryResistSpell): the
      // bolt reached it — a defence, not a miss.
      const r = /^(.+?) resists your spell/.exec(e.text);
      if (r) {
        this._noteContact(r[1], now);
        return;
      }
      // "[prefix! ]<Name> <verb>s you for N points with <spell>." — a caster
      // hitting US (the defender line); melee/missile hits arrive as kind=19.
      const a = /(?:^|! )(.+?) \w+ you for \d+ points? with /.exec(e.text);
      if (a) this._noteAttacker(a[1], now);
      return;
    }
    if (e.kind !== CLIENT_EVENT_COMBAT || !e.text) return;
    let d;
    try {
      d = JSON.parse(e.text);
    } catch (_) {
      return;
    }
    const g = this._engage;
    switch (d && d.type) {
      case "damageDealt":
        this._learnDamage(d.damage || 0, d.severity || 0);
        this._noteContact(d.defenderName, now, !!g);
        if (g) {
          g.lastActivityAt = now;
          g.damageSeen = true;
        }
        return;
      case "evadedTarget":
        // Our swing/shot was evaded: the target is reachable, just tough.
        this._noteContact(d.defenderName, now, !!g);
        if (g) g.lastActivityAt = now;
        return;
      case "damageTaken":
      case "evadedAttacker":
        // Someone is attacking US (hit, or we evaded) — never park them.
        this._noteAttacker(d.attackerName, now);
        return;
      case "combatCommenceAttack":
        if (g) g.lastActivityAt = now;
        return;
      case "attackDone":
        if (!d.error || d.error === "None") {
          if (g) g.lastActivityAt = now; // between auto-repeat swings
          return;
        }
        // A repeat chain ended (ACE OnAttackDone: ActionCancelled after a
        // kill / range loss / cancel, or a refusal code). The old loop's end
        // after a kill/cancel is expected — swallow it (see the TTL note).
        if (this._staleEnds > 0 && now - this._staleEndsAt <= STALE_LOOP_END_TTL_MS) {
          this._staleEnds--;
          return;
        }
        this._staleEnds = 0;
        if (!g) return;
        g.loopEnded = true;
        g.loopEndedAt = now;
        g.endError = String(d.error);
        return;
      default:
        return;
    }
  }

  _pruneDeaths(now) {
    for (const [g, at] of this._deaths) if (now - at > DEATH_SEEN_TTL_MS) this._deaths.delete(g);
  }

  _deathSeen(guid, now) {
    const at = this._deaths.get(guid >>> 0);
    return at !== undefined && now - at <= DEATH_SEEN_TTL_MS;
  }

  // P12 — arm a kill prediction when learned remaining HP is within one
  // average hit (× confidence). Uses the live health fraction (web streams
  // it for the queried target) against the learned MaxHP.
  _predictKill() {
    const m = this.damageModel.get(this.locked);
    if (!m || m.hits < KILL_MIN_SAMPLES || !m.maxHp) return false;
    const hf = this.host.TryGetTargetHealthFraction(this.locked);
    if (hf < 0) return false;
    const remainingHp = hf * m.maxHp;
    const avgDmg = m.totalDamage / m.hits;
    return remainingHp <= avgDmg * KILL_CONFIDENCE;
  }
  stop() {
    this._running = false;
  }

  /** False while this character can't fight right now (no war spell in Magic
   *  mode, combat mode won't establish) — the kernel stops picking Combat for
   *  the stand-down window instead of starving loot/buff on a dead end. */
  canEngage(now = Date.now()) {
    return !(this._incapableUntil > now);
  }

  _setIncapable(now, reason) {
    if (!(this._incapableUntil > now) || this.incapableReason !== reason) {
      this.log(`${reason} — standing down ${INCAPABLE_PARK_MS / 1000}s`);
    }
    this._incapableUntil = now + INCAPABLE_PARK_MS;
    this.incapableReason = reason;
    this._modeAttempts = 0;
    this._dropLock(reason);
  }

  _markKilledAt(guid, at) {
    this.recentlyKilled.set(guid, at);
    this._scanEpoch++;
    if (this.recentlyKilled.size > 256) {
      for (const [g, t] of this.recentlyKilled) if (at - t > RECENTLY_KILLED_TTL_MS) this.recentlyKilled.delete(g);
    }
  }

  // ── engagement plumbing ──────────────────────────────────────────────
  /** The local player's current sticky target from the wasm (0 = none), or
   *  null when the build can't say. */
  _localStickyTarget() {
    const h = this.host;
    try {
      if (typeof h.TryGetLocalStickyTarget === "function") {
        const v = h.TryGetLocalStickyTarget();
        return typeof v === "number" ? v >>> 0 : null;
      }
      const f = h.s && h.s.localStickyTarget;
      if (typeof f === "function") {
        const v = f.call(h.s);
        return typeof v === "number" ? v >>> 0 : null;
      }
    } catch (_) {
      /* unknown */
    }
    return null;
  }

  /** One APPROACH tick: run up on the stick, park the target as unreachable
   *  when the run-up stops closing distance. Returns false when parked. */
  _approachStep(target, dist, now) {
    const a = this._approach;
    if (!a || a.target !== target) {
      this._approach = { target, bestDist: dist, bestAt: now };
    } else if (dist < a.bestDist - APPROACH_PROGRESS_M) {
      a.bestDist = dist;
      a.bestAt = now;
    } else if (now - a.bestAt > APPROACH_STALL_MS) {
      this.log(`approach to ${target.toString(16)} stalled at ${dist.toFixed(1)} m — parked as unreachable ${UNREACHABLE_PARK_MS / 1000}s`);
      this.unreachable.set(target, now + UNREACHABLE_PARK_MS);
      this._scanEpoch++;
      this._approach = null;
      this._dropLock("unreachable");
      return false;
    }
    this._ensureStick(target, now);
    this.state = "APPROACH";
    return true;
  }

  _isUnreachable(guid, now) {
    const until = this.unreachable.get(guid);
    if (until === undefined) return false;
    if (now < until) return true;
    this.unreachable.delete(guid);
    return false;
  }

  // ── no-contact blacklist (RynthAi JudgePendingCast, reworked) ─────────
  _hfOf(guid) {
    const v = this.host.TryGetTargetHealthFraction(guid);
    return typeof v === "number" && v >= 0 ? v : null;
  }

  /** (Re)arm the contact watch for the current lock. */
  _watchLock(target, now) {
    if (!target) {
      this._watch = null;
      return;
    }
    if (this._watch && this._watch.target === target) return;
    let name = null;
    try {
      name = this.host.TryGetObjectName?.(target) ?? null;
    } catch (_) {
      name = null;
    }
    this._watch = { target, name, hf: this._hfOf(target), misses: [], lastContactAt: now, attackSince: 0 };
  }

  _contact(now) {
    const w = this._watch;
    if (!w) return;
    w.misses.length = 0;
    w.lastContactAt = now;
  }

  /** A damage / evade / resist line or event naming `name`. An UNNAMED
   *  melee/missile result during a live engagement (`engaged`) can only be
   *  the engaged lock's — counted as contact too. */
  _noteContact(name, now, engaged = false) {
    const w = this._watch;
    if (!w) return;
    if (name ? w.name && w.name === name : engaged) this._contact(now);
  }

  _noteAttacker(name, now) {
    if (!name) return;
    this._attackers.set(name, now);
    if (this._attackers.size > 32) {
      for (const [n, at] of this._attackers) if (now - at > this.attackerGraceMs) this._attackers.delete(n);
    }
  }

  _isAttackingUs(name, now) {
    if (!name) return false;
    const at = this._attackers.get(name);
    return at !== undefined && now - at <= this.attackerGraceMs;
  }

  /** Health contact: the lock's fraction dropped since the watch last saw it. */
  _watchHealth(target, now) {
    const w = this._watch;
    if (!w || w.target !== target) return;
    const hf = this._hfOf(target);
    if (hf == null) return;
    if (w.hf != null && hf < w.hf - 1e-6) this._contact(now);
    w.hf = hf;
  }

  /** Park a target our attacks never reach and drop the lock (the scan skips
   *  it via the unreachable map until the timeout lapses). */
  _blacklistTarget(target, now, why) {
    this.unreachable.set(target, now + this.blacklistTimeoutMs);
    this.blacklisted += 1;
    this._watch = null;
    this.log(`${why} on ${target.toString(16)} — blacklisted ${Math.round(this.blacklistTimeoutMs / 1000)}s`);
    if (this.locked === target) this._dropLock("no contact");
  }

  /** Magic verdict (called every tick before re-selection): park the lock
   *  once BLACKLIST_ATTEMPTS resolved casts have each settled for
   *  BLACKLIST_CAST_SETTLE_MS with no contact since. No evidence path at all
   *  (no health reading and no event tap) is never a verdict. -> parked? */
  _judgeWatch(now) {
    const w = this._watch;
    if (!w || w.target !== this.locked || this.mode !== 8) return false;
    this._watchHealth(w.target, now);
    if (w.hf == null && !this._evTapLive) return false;
    let settled = 0;
    for (const t of w.misses) if (now - t >= this.blacklistSettleMs) settled++;
    if (settled < this.blacklistAttempts) return false;
    if (this._isAttackingUs(w.name, now)) return false; // it's hitting us: keep fighting
    this._blacklistTarget(w.target, now, `${settled} resolved casts with no contact`);
    return true;
  }

  /** Melee/missile verdict: ACE repeats the attack itself, so a window stands
   *  in for per-request judging — in ATTACK range with no contact (no damage,
   *  no evade, no health drop) for NO_PROGRESS_ATTACK_MS. */
  _checkAttackProgress(target, now) {
    const w = this._watch;
    if (!w || w.target !== target) return;
    if (this.state !== "ATTACK") {
      w.attackSince = 0;
      return;
    }
    if (!w.attackSince) w.attackSince = now;
    this._watchHealth(target, now);
    const from = Math.max(w.lastContactAt, w.attackSince);
    if (now - from < this.noProgressAttackMs) return;
    if (this._isAttackingUs(w.name, now)) return;
    this._blacklistTarget(target, now, `${Math.round((now - from) / 1000)}s of attacks with no contact`);
  }

  /** A kind=13 refusal can trail the UseDone that already resolved its cast
   *  (the seq is read live, events arrive on the next page pump). */
  _lateRefusalWindow(now) {
    const a = this._lastAttempt;
    return !!a && now - a.at <= REFUSAL_LATE_MS;
  }

  /** The refusal belongs to the PREVIOUS cast even though a new one is in
   *  flight (see STALE_REFUSAL_MS). */
  _staleRefusal(now) {
    if (!this._lateRefusalWindow(now) || now - this.castIssuedAt >= STALE_REFUSAL_MS) return false;
    const h = this.host;
    return !h.has("GetUseDoneSeq") || h.GetUseDoneSeq() === this.useDoneAtIssue;
  }

  /** Un-count the last resolved attempt — it was refused (never reached). */
  _uncountLastAttempt() {
    const a = this._lastAttempt;
    this._lastAttempt = null;
    const w = this._watch;
    if (!a || !w || w.target !== a.target) return;
    const i = w.misses.lastIndexOf(a.at);
    if (i >= 0) w.misses.splice(i, 1);
  }

  /** Approach on the local StickyManager, re-asserting the stick whenever a
   *  server motion dropped it (the unpack preamble unsticks on every self
   *  UpdateMotion without a sticky target). */
  _ensureStick(target, now) {
    const cur = this._localStickyTarget();
    if (cur === target) return;
    if (this._stuckTo === target) {
      const wait = cur === null ? STICK_BLIND_REASSERT_MS : STICK_REASSERT_MS;
      if (now - this._stuckAt < wait) return;
    }
    this.host.StickToObject(target);
    this._stuckTo = target;
    this._stuckAt = now;
  }

  _releaseStick() {
    if (!this._stuckTo) return;
    this.host.StopStick();
    this._stuckTo = 0;
  }

  _cancelAttack() {
    const h = this.host;
    if (typeof h.CancelAttack === "function") return h.CancelAttack();
    const f = h.s && h.s.cancelAttack;
    if (typeof f === "function") {
      try {
        f.call(h.s);
        return true;
      } catch (_) {
        return false;
      }
    }
    return false;
  }

  /** End the live melee/missile engagement. CancelAttack only when ACE's
   *  repeat loop may still be running on a LIVING target — a kill or a seen
   *  loop end needs none, and a stray cancel also stops a server MoveTo. */
  _endEngagement(reason) {
    const g = this._engage;
    if (!g) return;
    this._engage = null;
    if (g.loopEnded) return;
    const now = Date.now();
    const hf = this.host.TryGetTargetHealthFraction(g.target);
    if (hf === 0 || this._deathSeen(g.target, now)) {
      this._expectStaleEnd(now); // the killed loop still owes its ActionCancelled
      return;
    }
    if (this._cancelAttack() !== false) this._expectStaleEnd(now);
    this.log(`cancel attack on ${g.target.toString(16)} (${reason})`);
  }

  _expectStaleEnd(now) {
    const live = this._staleEnds > 0 && now - this._staleEndsAt <= STALE_LOOP_END_TTL_MS;
    this._staleEnds = (live ? this._staleEnds : 0) + 1;
    this._staleEndsAt = now;
  }

  _dropLock(reason) {
    this._endEngagement(reason);
    this._releaseStick();
    this.locked = 0;
    this.lockedScore = -1;
    this.predictedKill = false;
    this._closeInFor = 0;
    this.state = "ACQUIRE";
  }

  /** Kernel/bot exit hook: stop driving the body for this lock (stick +
   *  live attack loop). The lock itself is kept so a restarted kernel
   *  re-evaluates the same target; `cancelAttack:false` leaves ACE's swing
   *  loop running (a heal preempt keeps the fight going meanwhile). */
  disengage({ cancelAttack = true } = {}) {
    if (cancelAttack) this._endEngagement("disengage");
    // Unconditional (the pre-2026-10-12 kernel StopStick): the swing motions
    // stick the player server-side even when this loop armed nothing, and a
    // stick left behind pulls the idle body back toward the old target
    // between a goto's legs.
    this.host.StopStick();
    this._stuckTo = 0;
    if (this.state === "ATTACK" || this.state === "APPROACH") this.state = "ENGAGE";
  }

  /** Read-only view for kernel.status / the HUD. */
  get status() {
    const now = Date.now();
    return {
      state: this.state,
      enabled: this.enabled,
      locked: this.locked >>> 0,
      kills: this.kills,
      mode: this.mode,
      engagedAt: this._engage ? this._engage.issuedAt : 0,
      incapable: this._incapableUntil > now ? this.incapableReason : null,
      warSpell: this.warSpell,
      blacklisted: this.blacklisted, // targets parked for no contact
      castMisses: this._watch && this._watch.target === this.locked ? this._watch.misses.length : 0, // resolved casts since contact
    };
  }

  // ── target selection (T2 filter subset + natural scoring + T8 hook) ──
  _scanTargets() {
    if (!this.enabled) return []; // hunting OFF (director toggle) — never acquire a target
    const h = this.host;
    // Per-snapshot memo: the kernel asks for threats twice per tick (vitals'
    // inCombat + the action pick) and tick() selects once more — one scan per
    // frozen snapshot is the same answer three times. Keyed on the snapshot
    // seq + the recentlyKilled epoch; hosts without a snapshot don't memo.
    const seq = h.snap && h.snap.seq;
    const memo = this._scanMemo;
    if (seq != null && memo && memo.seq === seq && memo.epoch === this._scanEpoch) return memo.out;
    const me = h.TryGetPlayerPose();
    if (!me) return [];
    const now = Date.now();
    const out = [];
    for (const g of h.NearbyGuids()) {
      // T2 exclusion classes, in order:
      if (h.ObjectIsPlayer(g) || (g >= PLAYER_GUID_MIN && g <= PLAYER_GUID_MAX)) continue;
      const killedAt = this.recentlyKilled.get(g);
      if (killedAt && now - killedAt < RECENTLY_KILLED_TTL_MS) continue;
      if (this.unreachable.size && this._isUnreachable(g, now)) continue; // run-up stalled on it
      const itemType = h.TryGetObjectIntProperty(g, 1);
      if (itemType !== ITEM_TYPE_CREATURE) continue; // not Monster class
      // T2: vendors/NPCs are creatures too. ObjectIsAttackable now FAILS OPEN
      // when the desc flags haven't streamed yet (webhost.js), matching C#'s
      // `HasObjectIsAttackable` anti-stall guard (CombatManager.cs:610), so a
      // not-yet-described spawn is engaged instead of stared at (combat T4).
      if (!h.ObjectIsAttackable(g)) continue;
      const hf = h.TryGetTargetHealthFraction(g);
      if (hf === 0) continue; // dead-not-corpse
      const pos = h.TryGetObjectPosition(g);
      if (!pos) continue;
      // Outdoors the landblocks tile the world, so a mob across a seam is
      // measured in the global frame (the old same-LB gate hid a drudge 5 m
      // away across Holtburg's A9B3/A9B4 seam — live 2026-10-12). Indoor
      // (EnvCell, cell index >= 0x100) landblocks are not world-contiguous:
      // those still need the same landblock.
      const sameLb = pos.objCellId >>> 16 === me.objCellId >>> 16;
      const bothOutdoor = (pos.objCellId & 0xffff) < 0x100 && (me.objCellId & 0xffff) < 0x100;
      if (!sameLb && !bothOutdoor) continue;
      const d = sameLb ? Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z) : globalDist(me, pos);
      if (d > 40) continue;
      // Natural "fastest-to-attack" scoring: nearer = higher, plus T8's
      // opt-in monster-priority term: (priority-1)*5 when the name
      // substring-matches a configured rule.
      out.push({ guid: g, score: 100 - d + this._priorityTerm(g), dist: d });
    }
    out.sort((a, b) => b.score - a.score);
    Object.freeze(out); // shared by every caller of this snapshot's memo
    if (seq != null) this._scanMemo = { seq, epoch: this._scanEpoch, out };
    return out;
  }

  _priorityTerm(guid) {
    const keys = Object.keys(this.priorities);
    if (!keys.length) return 0;
    const name = (this.host.TryGetObjectName(guid) || "").toLowerCase();
    let best = 0;
    for (const k of keys) {
      // Case-insensitive like RynthAi's rule match (CombatManager
      // GetRuleForTarget: IndexOf(..., OrdinalIgnoreCase)); the map itself
      // keeps the caller's casing (set_priorities / the HUD round-trip it).
      if (name.includes(String(k).toLowerCase())) best = Math.max(best, Math.max(0, this.priorities[k] - 1) * 5);
    }
    return best;
  }

  // ── netBrain (D1 path A′) — .NET-wasm TargetScoring behind the same seam ──
  // Attached by bot.js when ?netBrain=shadow|on. shadow: the C# slice is
  // called beside the JS selection and divergences are counted on
  // __diag.netbrain; on: the C# selection DRIVES the lock (the JS pass still
  // runs so the comparison metrics keep their baseline). Every failure path
  // degrades to the JS decision — the brain can never wedge the loop.
  attachNetBrain(brain, mode, nbModule, opts = {}) {
    this._nb = { brain, mode, m: nbModule };
    this._nbGraceMs = -1; // C#-side TargetLostScanAtMs, threaded call-to-call
    this._nbPrevLock = 0;
    this._nbCtx = null;
    this._nbLastAt = 0;
    this._nbMinIntervalMs = opts.minIntervalMs ?? 250;
  }

  // ScoringInput from LIVE host state — the exact inverse of the parity
  // harness's makeHost (netwasm-spike/CombatScoring/parity_check.cjs:25-61).
  // DTO Id fields are C# int32: guids ride two's-complement (g|0) and come
  // back via >>>0 (live ACE dynamic guids sit above 2^31).
  _nbBuildInput(preLock, now) {
    const h = this.host;
    const me = h.TryGetPlayerPose();
    if (!me) return null;
    const hasFlagsFn = typeof h.HasObjectDescFlags === "function";
    // Cost bound (review finding): the 60 m NearbyGuids snapshot in a town
    // includes items/NPCs/doors far beyond anything the C# filter can select
    // (range 40, disengage 43). Skip entities beyond 50 m — EXCEPT the lock,
    // which C# must see to run its own out-of-range/disengage handling — and
    // hard-cap the row count, keeping the nearest. Distances are computed in
    // the GLOBAL frame (lb-index*192 + local), exactly like
    // TargetScoring.Distance — local deltas would drop every cross-LB mob
    // (review finding). A positionless entity gets NO row: absence is C#'s
    // transient-miss encoding (target==null keeps the lock through the scan
    // grace); a HasPosition:false row would read as an immediate
    // "out of range" drop instead.
    const NB_RANGE_M = 50;
    const NB_MAX_ENTITIES = 64;
    const gX = (cell, x) => ((cell >>> 24) & 0xff) * 192 + x;
    const gY = (cell, y) => ((cell >>> 16) & 0xff) * 192 + y;
    const meGx = gX(me.objCellId >>> 0, me.x);
    const meGy = gY(me.objCellId >>> 0, me.y);
    const entities = [];
    for (const g of h.NearbyGuids()) {
      // Fold the JS guid-range player check (:172) into IsPlayer, and force
      // ObjectClass!=5 for those (the C# path filters on ObjectClass only).
      const isPlayer = h.ObjectIsPlayer(g) || (g >= PLAYER_GUID_MIN && g <= PLAYER_GUID_MAX);
      const itemType = h.TryGetObjectIntProperty(g, 1);
      const pos = h.TryGetObjectPosition(g);
      if (!pos) continue; // absence = C# transient-miss encoding (keeps the lock via grace)
      const cell = pos.objCellId >>> 0;
      const dist = Math.hypot(gX(cell, pos.x) - meGx, gY(cell, pos.y) - meGy, pos.z - me.z);
      if (g !== preLock && dist > NB_RANGE_M) continue;
      const killedAt = this.recentlyKilled.get(g);
      // One desc-flags read feeds Attackable + AttackableUnknown (both sides
      // now fail OPEN on unknown flags — webhost.js ObjectIsAttackable / C# T4).
      const flags = hasFlagsFn ? h._live("GetObjectDescFlags", g) : null;
      entities.push({
        _d: g === preLock ? 0 : dist, // transient sort key for the cap (lock always survives), stripped below
        Id: g | 0,
        Name: h.TryGetObjectName(g) || "",
        // C#'s T2 monster filter runs on ObjectClass (5 = Monster); derive it
        // from the same protocol facts the JS filter uses.
        ObjectClass: isPlayer ? 7 : itemType === ITEM_TYPE_CREATURE ? 5 : 0,
        IsPlayer: isPlayer,
        ItemType: itemType ?? 0,
        HasPosition: true,
        ObjCellId: cell,
        X: pos.x,
        Y: pos.y,
        Z: pos.z,
        HealthRatio: h.TryGetTargetHealthFraction(g),
        Attackable: flags == null ? true : (flags & 0x10) !== 0,
        AttackableUnknown: flags == null,
        HostHasIsAttackable: hasFlagsFn,
        LosBlocked: false, // no live LOS input (documented gap)
        Blacklisted: this.unreachable.size > 0 && this._isUnreachable(g, now), // approach-stall park
        UserNeverAttack: false,
        KilledMsAgo: killedAt ? now - killedAt : -1,
      });
    }
    // Cap: keep the nearest rows (lock included via _d=0 for the preLock row).
    let rows = entities;
    if (rows.length > NB_MAX_ENTITIES) {
      rows = rows.sort((a, b) => a._d - b._d).slice(0, NB_MAX_ENTITIES);
      this._nb.m.diag().truncated++;
    }
    for (const r of rows) delete r._d;
    // Heading -> z-rot quaternion, inverse of parity_check.cjs headingRad():
    // physYawDeg = 2*atan2(QZ,QW) = -headingDeg  =>  QW=cos(h/2), QZ=-sin(h/2).
    const hasPose = me.heading != null;
    return {
      NowMs: now,
      PlayerId: (h.GetPlayerId() || 0) | 0,
      Player: {
        HasPose: hasPose,
        ObjCellId: me.objCellId >>> 0,
        X: me.x, Y: me.y, Z: me.z,
        QW: hasPose ? Math.cos(me.heading / 2) : 1.0,
        QZ: hasPose ? -Math.sin(me.heading / 2) : 0.0,
      },
      // MonsterRange 40 matches the JS hardcoded perimeter (:187) — feeding
      // C#'s default 50 would make every 40-50m mob a guaranteed filter
      // divergence and drown the real signal (the T2 range delta is already
      // documented in the spike README).
      Config: {
        MonsterRange: 40.0,
        MonsterDisengageRange: 0.0,
        MonsterRules: Object.entries(this.priorities).map(([k, v]) => ({ Name: k, Priority: v })),
      },
      Lock: {
        LockedTargetId: preLock | 0,
        ActiveTargetId: preLock | 0,
        TargetLostScanAtMs: this._nbGraceMs,
      },
      Entities: rows,
    };
  }

  _selectTarget() {
    // Pre-lock preference: the value tick() captured BEFORE its kill-confirm
    // block (C#'s SelectTargetTick performs its own hp==0 drop and must see
    // the pre-kill lock); fall back to the current lock for direct callers.
    const preLock = this._nbCtx?.preLock ?? this.locked;
    this._nbCtx = null;
    // Hunting OFF (hunt_stop / explorer boot): the JS pass alone decides, so
    // the lock winds down through its empty scan + T10 grace. The C# input
    // carries no "hunting" bit — in mode "on" it kept re-locking the target
    // and hunt_stop never stood a live fight down (2026-10-12 review).
    const nb = this.enabled ? this._nb : null;
    const onMode = !!nb?.brain && nb.mode === "on";
    // mode "on": C# owns the lock. The JS pass still runs — but only as the
    // comparison baseline — so its lock mutations are snapshot/restored;
    // without this, throttled ticks returned the raw JS selection and the
    // two scoring models fought a StickToObject tug-of-war whenever they
    // persistently disagreed (review finding, 2026-07-16).
    const snap = onMode
      ? { locked: this.locked, score: this.lockedScore, seen: this.lastSeenLockedAt }
      : null;
    const jsSel = this._selectTargetJs();
    if (snap) {
      this.locked = snap.locked;
      this.lockedScore = snap.score;
      this.lastSeenLockedAt = snap.seen;
    }
    if (!nb?.brain) return jsSel;
    const now = Date.now();
    if (now - this._nbLastAt < this._nbMinIntervalMs) return onMode ? this.locked : jsSel;
    this._nbLastAt = now;
    // Grace state is only meaningful for the lock it was armed on.
    if (preLock !== this._nbPrevLock) this._nbGraceMs = -1;
    this._nbPrevLock = preLock;
    const out = nb.m.shadowTick(
      nb.brain,
      "combat",
      () => this._nbBuildInput(preLock, now),
      (csOut) => ({
        agree: (csOut.SelectedTargetId | 0) === (jsSel | 0),
        jsVal: jsSel ? (jsSel >>> 0).toString(16) : "-",
        csVal: csOut.SelectedTargetId ? (csOut.SelectedTargetId >>> 0).toString(16) : "-",
      })
    );
    if (!out) return onMode ? this.locked : jsSel; // brain error: keep C#'s last word in "on"
    this._nbGraceMs = out.TargetLostScanAtMs;
    if (!onMode) return jsSel;
    // mode "on": the C# selection drives the lock.
    const csSel = out.SelectedTargetId ? out.SelectedTargetId >>> 0 : 0;
    if (csSel !== this.locked) {
      if (csSel) this.log(`netbrain lock ${csSel.toString(16)}${this.locked ? ` (was ${this.locked.toString(16)})` : ""}`);
      else if (this.locked) this.log(`netbrain drop ${this.locked.toString(16)}${out.DropReason ? ` (${out.DropReason})` : ""}`);
      this.locked = csSel;
      this.lockedScore = csSel
        ? out.Scanned.find((s) => (s.Id >>> 0) === csSel)?.Score ?? this.lockedScore
        : -1;
      if (csSel) this.lastSeenLockedAt = now;
    }
    return this.locked;
  }

  _selectTargetJs() {
    const now = Date.now();
    const targets = this._scanTargets();
    const lockedEntry = targets.find((t) => t.guid === this.locked);
    if (lockedEntry) {
      this.lastSeenLockedAt = now;
      this.lockedScore = lockedEntry.score;
    }
    if (this.locked && !lockedEntry) {
      // T10 scan grace, C# semantics: the grace only RETAINS the lock while
      // the scan is EMPTY. An absent lock is not a candidate in
      // HandleCombatTrigger — it gets no +stickiness — so with an alternative
      // visible the best candidate re-locks IMMEDIATELY
      // (CombatManager.cs:2170-2189; grace drop: :1774-1783). Holding the
      // lock through the full 1500ms here blocked legitimate re-locks
      // (netwasm parity finding 2).
      if (targets.length) {
        const best = targets[0];
        this.log(`relock ${this.locked.toString(16)} -> ${best.guid.toString(16)} (lock left scan)`);
        this.locked = best.guid;
        this.lockedScore = best.score;
        this.lastSeenLockedAt = now;
        return this.locked;
      }
      if (now - this.lastSeenLockedAt < TARGET_SCAN_GRACE_MS) return this.locked;
      this.log(`drop target ${this.locked.toString(16)} (scan grace expired)`);
      this.locked = 0;
      this.lockedScore = -1;
    }
    const best = targets[0];
    if (!best) return this.locked;
    if (!this.locked) {
      this.locked = best.guid;
      this.lockedScore = best.score;
      this.lastSeenLockedAt = now;
      this.log(`lock ${best.guid.toString(16)} (${this.host.TryGetObjectName(best.guid)}) d=${best.dist.toFixed(1)}`);
    } else if (
      best.guid !== this.locked &&
      best.score > this.lockedScore + TARGET_SWITCH_STICKINESS // T9
    ) {
      this.log(`switch ${this.locked.toString(16)} -> ${best.guid.toString(16)}`);
      this.locked = best.guid;
      this.lockedScore = best.score;
      this.lastSeenLockedAt = now;
    }
    return this.locked;
  }

  // ── cast serializer (P2/P5/E4) ───────────────────────────────────────
  _castResolved() {
    if (!this.awaitingCast) return true;
    const h = this.host;
    // E4: UseDoneSeq advance, a refusal event (_onCastRefusal), OR the hard
    // deadline — never wedge. The deadline is the long backstop when UseDone
    // is tracked (see CAST_RESOLUTION_USEDONE_TIMEOUT_MS).
    const hasUseDone = h.has("GetUseDoneSeq");
    if (hasUseDone && h.GetUseDoneSeq() !== this.useDoneAtIssue) {
      this._resolveCast(true);
      return true;
    }
    const deadline = hasUseDone ? CAST_RESOLUTION_USEDONE_TIMEOUT_MS : CAST_RESOLUTION_TIMEOUT_MS;
    if (Date.now() - this.castIssuedAt > deadline) {
      this._resolveCast(true);
      return true;
    }
    return false;
  }
  /** attempt: the cast went off (UseDone / deadline) — it counts toward the
   *  no-contact watch of the lock it was aimed at; a refusal never does. */
  _resolveCast(attempt = false) {
    this.awaitingCast = false;
    if (attempt) {
      const at = Date.now();
      this._lastAttempt = { target: this._castTarget, at };
      const w = this._watch;
      if (w && w.target === this._castTarget) w.misses.push(at);
    }
    const h = this.host;
    if (typeof h.releaseCast === "function") h.releaseCast("combat");
  }

  // A cast refusal (kind=13 UseFailed / spell-cast WeenieError, code in u32)
  // while one of OUR casts is in flight: resolve it now and react by class.
  // stale: the refusal trails the previous cast's UseDone — un-count that
  // attempt (refused, not a miss) and leave any cast now in flight alone.
  _onCastRefusal(code, now, stale = false) {
    const cls = CAST_REFUSALS.get(code & 0xffff);
    if (!cls) return false;
    if (stale) this._uncountLastAttempt();
    else if (this.awaitingCast) this._resolveCast(false);
    switch (cls) {
      case "components":
        this._setIncapable(now, "out of spell components for war magic");
        break;
      case "place":
        this._setIncapable(now, "war spell refused here (indoor/outdoor restriction)");
        break;
      case "unknown-spell":
        this.log(`war spell ${this.warSpell} not in the spellbook — re-picking`);
        this.warSpell = null; // _pickWarSpell re-reads the book (none -> stand down)
        break;
      case "mana":
        this._castHoldUntil = now + CAST_MANA_BACKOFF_MS;
        break;
      default:
        break; // fizzle / transient / range (close-in handled by the caller): retry on the next gates
    }
    return true;
  }
  _markCastIssued() {
    // P5: arm resolution tracking at issue time.
    this.awaitingCast = true;
    this.castIssuedAt = Date.now();
    this.useDoneAtIssue = this.host.has("GetUseDoneSeq") ? this.host.GetUseDoneSeq() : 0;
  }

  // P3 — magic face-settle. Returns "cast" when facing is within tolerance
  // AND held FACE_SETTLE_MS (turn-stop reached the server before the cast);
  // "turn" while still turning; "cast" also on the FACE_MAX_WAIT_MS cap so a
  // jittery target can't block casting forever. Heading convention: pose yaw
  // 0 -> +Y (north), pi/2 -> +X (east); forward = (sin yaw, cos yaw), so the
  // bearing to (dx,dy) is atan2(dx, dy).
  _faceGate(target) {
    const h = this.host;
    const me = h.TryGetPlayerPose();
    const pos = h.TryGetObjectPosition(target);
    if (!me || !pos || me.heading == null) return "cast"; // no facing data -> don't block
    // Global frame: a lock across a landblock seam (local y 190 vs 3) is a
    // few metres away, not 187 m the other way.
    const { dx, dy } = globalDelta(me, pos);
    const desired = Math.atan2(dx, dy);
    let err = desired - me.heading;
    while (err > Math.PI) err -= 2 * Math.PI;
    while (err < -Math.PI) err += 2 * Math.PI;
    const now = Date.now();
    if (Math.abs(err) > FACE_TOLERANCE_RAD) {
      // Keep turning; do NOT cast while turning (the P3 bug this prevents).
      if (h.has("TurnToHeading")) h.TurnToHeading(desired);
      this._faceInWindowSince = 0;
      this._faceStartedAt = this._faceStartedAt || now;
      // Safety cap: after FACE_MAX_WAIT_MS, cast anyway.
      if (now - this._faceStartedAt > FACE_MAX_WAIT_MS) {
        this._faceStartedAt = 0;
        return "cast";
      }
      return "turn";
    }
    // Within angle — release turns, settle, then cast.
    this._faceStartedAt = 0;
    if (!this._faceInWindowSince) this._faceInWindowSince = now;
    return now - this._faceInWindowSince >= FACE_SETTLE_MS ? "cast" : "turn";
  }

  _pickWarSpell() {
    if (this.warSpell) return this.warSpell;
    const h = this.host;
    let known = [];
    if (typeof h.TryGetKnownSpells === "function") known = h.TryGetKnownSpells() || [];
    else if (h.s && typeof h.s.playerKnownSpells === "function") known = Array.from(h.s.playerKnownSpells() || []);
    known = known.map(Number);
    this.warSpell = WAR_BOLTS.find((id) => known.includes(id)) || null;
    return this.warSpell;
  }

  tick() {
    const h = this.host;
    if (!h.IsPlayerReady()) return;
    this._ensureEventTap();
    const now = Date.now();
    // No requests and no stick in portal space (a teleport's tunnel and its
    // build hold): the body would walk cells whose collision hasn't landed,
    // and the old lock is in the previous location anyway — selection
    // resumes (and grace-drops it) once the world is back.
    if (this._portalSpace()) {
      this.state = "PORTAL";
      return;
    }

    // netBrain shadow context: the C# slice must see the PRE-kill-confirm
    // lock (its SelectTargetTick does its own hp==0 drop, so both sides'
    // drop+re-lock land inside the same compared tick).
    if (this._nb?.brain) this._nbCtx = { preLock: this.locked, now };

    // Kill detection — validate the lock BEFORE re-selection (C# Think order,
    // CombatManager.cs:1717-1744) so the same tick can re-lock an alternative.
    // hp=0 is the kill confirm (DropTarget("hp=0"), CombatManager.cs:1733) —
    // a death motion zeroes the fraction — plus the authoritative kind=29
    // PlayerKilled for the lock, which survives the corpse swap pulling the
    // dead creature out of the entity store before a tick reads its hp=0.
    // A vanished/positionless lock WITHOUT either is a transient world-filter
    // miss, NOT a kill — C# keeps the lock and lets the T10 scan grace drop a
    // truly vanished mob kill-free (CombatManager.cs:1739-1741, :1786;
    // netwasm parity finding 3).
    if (this.locked && (h.TryGetTargetHealthFraction(this.locked) === 0 || this._deathSeen(this.locked, now))) {
      this.log(`kill confirmed ${this.locked.toString(16)} (${this.kills + 1})`);
      this.kills++;
      this._markKilledAt(this.locked, now);
      this.damageModel.delete(this.locked);
      if (this._engage && this._engage.target === this.locked) {
        // ACE ends its own loop on the kill; its ActionCancelled is still owed.
        if (!this._engage.loopEnded) this._expectStaleEnd(now);
        this._engage = null;
      }
      this._pendingDelta = null;
      this.locked = 0;
      this.lockedScore = -1;
      this.predictedKill = false;
      this._closeInFor = 0;
      // Unconditional: the swing motions stuck us to the mob server-side
      // even when this loop never armed a stick of its own.
      h.StopStick();
      this._stuckTo = 0;
      this.state = "ACQUIRE"; // re-stick if selection re-locks below
    }

    // Standing down (no war spell in Magic mode / no combat mode): no lock,
    // no requests until the window lapses (canEngage() tells the kernel).
    if (this._incapableUntil > now) {
      if (this.locked) this._dropLock(this.incapableReason || "standing down");
      this.state = "IDLE";
      return;
    }

    // No-contact blacklist: judge before re-selection, so a parked lock is
    // replaced in this same tick.
    if (this._watch) this._judgeWatch(now);

    const target = this._selectTarget();
    this._watchLock(target, now);

    // A live engagement whose target is no longer the lock (T9 switch, T10
    // re-lock, grace drop, netBrain re-target): ACE keeps swinging at its
    // MeleeTarget until told otherwise, and ignores a new request meanwhile.
    if (this._engage && this._engage.target !== target) {
      this._endEngagement(target ? "re-target" : "lock dropped");
    }
    if (this._closeInFor && this._closeInFor !== target) this._closeInFor = 0;

    if (!target) {
      this._releaseStick();
      this.state = "ACQUIRE";
      return;
    }

    // T12 — transient world-filter miss: skip the tick, keep the lock
    // (CombatManager.cs:1786 "transient miss — skip tick, keep lock").
    const pos = h.TryGetObjectPosition(target);
    if (!pos) return;

    // P12 — kill anticipation. When the learned model says this target is
    // one hit from death, note it (observable) and let target selection
    // pre-warm: the next _selectTarget already ranks alternatives, so on
    // the confirmed kill next tick there's a ready lock. We don't abandon
    // the current swing (that would waste the finishing blow) — just flag.
    if (!this.predictedKill && this._predictKill()) {
      this.predictedKill = true;
      this.predictionsMade += 1;
      this.log(`predicted kill on ${target.toString(16)} — pre-scanning next`);
    }

    // ENGAGE: equipment-derived combat mode (the live-confirmed trap).
    // Missile ammo is handled by the toggle itself — the equipment-derived
    // suggested mode (get_suggested_combat_mode + is_missing_missile_ammo,
    // ACE Player_Combat) never returns Missile without ammo, and ACE reverts
    // a doomed mode to NonCombat, so the loop self-corrects rather than
    // getting stuck in a no-ammo missile stance. The guard below bounds a
    // mode that WON'T establish at all. (The wasm toggle predicts its own
    // un-echoed request for 2 s — combat_toggle.rs — so a re-toggle at the
    // 3 s cadence reads the confirmed mode and can't flip itself back.)
    this.mode = h.GetCurrentCombatMode();
    // A mode change ended ACE's repeat loop on its own (Player_Melee.cs
    // Attack: CombatMode != Melee -> OnAttackDone) — e.g. vitals/buff
    // switched to Magic to cast.
    if (this._engage && this._engage.mode !== this.mode) {
      if (!this._engage.loopEnded) this._expectStaleEnd(now); // that loop's ActionCancelled is still owed
      this._engage = null;
    }
    if (this.mode <= 1) {
      if (now - this.modeRequestedAt > 3000) {
        // Repeated toggles that never leave NonCombat mean the character
        // can't enter combat right now (a persistent refusal) — that is not
        // this target's fault, so stand the whole loop down (canEngage)
        // instead of the old 4 s target park that re-locked straight back
        // onto the same dead end.
        this._modeAttempts = (this._modeAttempts || 0) + 1;
        if (this._modeAttempts > MODE_TOGGLE_LIMIT) {
          this._setIncapable(now, "combat mode will not establish");
          return;
        }
        if (typeof h.ToggleCombatMode === "function") h.ToggleCombatMode();
        else if (h.s && typeof h.s.toggleCombatMode === "function") h.s.toggleCombatMode();
        this.modeRequestedAt = now;
        this.state = "ENGAGE";
      }
      return; // wait for the mode to complete before attacking
    }
    this._modeAttempts = 0; // established — reset the guard

    // Health polling (QueryHealth-fed health fraction).
    if (now - this.lastQueryAt > QUERY_HEALTH_INTERVAL_MS) {
      h.QueryHealth(target);
      this.lastQueryAt = now;
    }
    this._observeHealth(target, h.TryGetTargetHealthFraction(target));
    this._watchHealth(target, now);

    const me = h.TryGetPlayerPose();
    const dist = me ? globalDist(me, pos) : 0;
    if (this.mode === 8) this._magicStep(target, dist, now);
    else {
      this._attackStep(target, dist, now);
      this._checkAttackProgress(target, now);
    }
  }

  // Melee / missile: ONE request per engagement (header, 2026-10-12).
  _attackStep(target, dist, now) {
    const h = this.host;
    const missile = this.mode === 4;
    const g = this._engage && this._engage.target === target ? this._engage : null;
    if (g && !g.loopEnded) {
      // ACE's repeat loop owns the fight (charge, swings, sticky); the bot
      // only watches. Silence for the whole patience window means the event
      // plane is missing or an end was lost — fall through and re-request
      // (degrade-open; ACE ignores a request while its loop is alive).
      const lastSign = Math.max(g.issuedAt, g.lastActivityAt || 0);
      if (now - lastSign < MELEE_SWING_PATIENCE_MS) {
        this.state = "ATTACK";
        return;
      }
    }
    const range =
      this._closeInFor === target
        ? CLOSE_IN_RANGE_M
        : missile
          ? this.missileRangeM
          : this.meleeChargeRangeM;
    if (dist > range) {
      // APPROACH: run up on the local stick and request nothing yet — a
      // charge from out here fails at 15 m, a shot out of range is refused.
      this._approachStep(target, dist, now);
      return;
    }
    this._approach = null;
    // Release OUR stick before the request in every mode: from here the body
    // belongs to ACE — the charge MoveTo (melee; it re-sticks on arrival and
    // every swing motion carries StickToObject) or the server Rotate before a
    // shot (missile, Player_Missile.cs). A stick left armed would run the
    // player on the StickyManager alongside the charge for a round trip —
    // exactly the parallel run-up 86c4d11e Phase F removed from the client.
    // While the request is live the hands-off branch above never re-sticks.
    this._releaseStick();
    this.state = "ATTACK";
    if (g && now - g.issuedAt < ATTACK_REISSUE_MIN_MS) return;
    if (g && g.loopEnded && g.endError && g.endError !== "ActionCancelled") {
      this.log(`attack loop on ${target.toString(16)} ended (${g.endError}) — re-requesting`);
    }
    if (missile) this._missileAttack(target);
    else h.MeleeAttack(target, this.attackHeight, this.meleePower);
    this._engage = {
      target,
      mode: this.mode,
      issuedAt: now,
      issues: (g ? g.issues : 0) + 1,
      loopEnded: false,
      loopEndedAt: 0,
      endError: null,
      lastActivityAt: 0,
      damageSeen: false,
    };
    this.lastSwingAt = now;
  }

  _missileAttack(target) {
    const h = this.host;
    if (typeof h.MissileAttack === "function") return h.MissileAttack(target, this.attackHeight, this.missileAccuracy);
    const f = h.s && h.s.missileAttack;
    if (typeof f !== "function") return false;
    try {
      f.call(h.s, target, this.attackHeight, this.missileAccuracy);
      return true;
    } catch (_) {
      return false;
    }
  }

  // Magic: the cast serializer (P2/P5/E4) unchanged; range-first like the
  // other modes (ACE turns the caster but never walks it into range —
  // Player_Magic.cs TurnTo_Magic / VerifySpellRange).
  _magicStep(target, dist, now) {
    const h = this.host;
    if (!this._castResolved()) return; // P2: one cast in flight
    if (h.GetCastBusyState() !== 0) return; // local cast gesture gate (a HUMAN cast; bot casts never open it)
    // Shared caster contract: the shadow busy count (casts/uses sent minus
    // UseDone) is the gate that sees vitals'/buff's/loot's in-flight actions.
    if (typeof h.GetBusyState === "function" && h.GetBusyState() !== 0) return;
    if (this._castHoldUntil > now) return; // mana-refusal backoff
    const spell = this._pickWarSpell();
    if (!spell) {
      // Was `this.stop()` — inert on the kernel path (the kernel ticks the
      // loop directly), so it logged this every tick and held Combat
      // forever. A caster with no bolt can't fight: stand down instead.
      this._setIncapable(now, "no war spell known — cannot fight in Magic mode");
      return;
    }
    const range = this._closeInFor === target ? CLOSE_IN_RANGE_M : this.magicRangeM;
    if (dist > range) {
      this._approachStep(target, dist, now);
      return;
    }
    this._approach = null;
    this._releaseStick(); // cast from here
    this.state = "ATTACK";
    // P3 — settle facing before the cast (don't fire while turning).
    if (this._faceGate(target) !== "cast") return;
    // C3 shared serializer: another module (vitals/buff) may hold an
    // still-open cast claim (gesture done, UseDone not yet resolved) —
    // wait rather than overlap it. Degrade-open if the host predates
    // the token (contract 0.1).
    if (typeof h.tryClaimCast === "function" && !h.tryClaimCast("combat")) return;
    this._castTarget = target; // the no-contact watch counts this cast when it resolves
    h.CastSpell(target, spell);
    this._markCastIssued();
  }
}

export default RynthCombatLoop;
