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

const TARGET_SWITCH_STICKINESS = 25.0; // T9 — alt must beat locked+25
const TARGET_SCAN_GRACE_MS = 1500; // T10 — keep lock through scan gaps
const CAST_RESOLUTION_TIMEOUT_MS = 2500; // P2/E4 — UseDone fallback
const RECENTLY_KILLED_TTL_MS = 30_000; // T2 — corpse re-engage guard
const QUERY_HEALTH_INTERVAL_MS = 1000;
const MELEE_SWING_PATIENCE_MS = 9000; // melee has no UseDone; re-issue window
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

export class RynthCombatLoop {
  constructor(host, opts = {}) {
    this.host = host;
    this.log = opts.log || ((m) => console.log(`[combat] ${m}`));
    // T8 — opt-in monster priority: name-substring (lowercase) -> priority.
    // priorityScore = max(0, priority-1)*5 (report 11 T8 formula); a target
    // whose name contains a key gets that bias. Default rules add 0.
    this.priorities = opts.priorities || {}; // { "olthoi": 10, "rat": 0 }
    this.state = "IDLE"; // IDLE | ACQUIRE | ENGAGE | ATTACK
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
    // P12 — subscribe to the push-event plane for confirmed per-hit damage.
    if (host.onEvent) host.onEvent((e) => this._onCombatEvent(e));
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
    let learnedMax = 0;
    if (severity > 0) {
      learnedMax = dmg / severity; // direct (melee/missile)
    } else {
      // Fraction-delta learn against the last poll.
      const hf = this.host.TryGetTargetHealthFraction(this.locked);
      if (hf >= 0 && this._lastHf >= 0 && this._lastHf > hf) {
        learnedMax = dmg / (this._lastHf - hf);
      }
    }
    if (learnedMax > 0) {
      m.maxHp = m.maxHp ? Math.max(m.maxHp, learnedMax) : learnedMax;
      this.lifetimeMaxHpLearned = Math.max(this.lifetimeMaxHpLearned, learnedMax);
    }
    this.lifetimeHits += 1;
    this.damageModel.set(this.locked, m);
  }

  _onCombatEvent(e) {
    if (e.kind === CLIENT_EVENT_DEATH) {
      this.damageModel.delete(e.u32); // KillerNotification for our victim
      return;
    }
    // Magic damage: combat-category chat line ("You <verb> <name> for N
    // points with <spell>").
    if (e.kind === 2 && e.text) {
      const m = /^You \w+ .+? for (\d+) points? with /.exec(e.text);
      if (m) this._learnDamage(Number(m[1]), 0);
      return;
    }
    if (e.kind !== CLIENT_EVENT_COMBAT || !e.text) return;
    let d;
    try {
      d = JSON.parse(e.text);
    } catch (_) {
      return;
    }
    if (d.type !== "damageDealt") return;
    this._learnDamage(d.damage || 0, d.severity || 0);
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

  // ── target selection (T2 filter subset + natural scoring + T8 hook) ──
  _scanTargets() {
    const h = this.host;
    const me = h.TryGetPlayerPose();
    if (!me) return [];
    const now = Date.now();
    const out = [];
    for (const g of h.NearbyGuids()) {
      // T2 exclusion classes, in order:
      if (h.ObjectIsPlayer(g) || (g >= PLAYER_GUID_MIN && g <= PLAYER_GUID_MAX)) continue;
      const killedAt = this.recentlyKilled.get(g);
      if (killedAt && now - killedAt < RECENTLY_KILLED_TTL_MS) continue;
      const itemType = h.TryGetObjectIntProperty(g, 1);
      if (itemType !== ITEM_TYPE_CREATURE) continue; // not Monster class
      if (!h.ObjectIsAttackable(g)) continue; // T2: vendors/NPCs are creatures too
      const hf = h.TryGetTargetHealthFraction(g);
      if (hf === 0) continue; // dead-not-corpse
      const pos = h.TryGetObjectPosition(g);
      if (!pos || pos.objCellId >>> 16 !== me.objCellId >>> 16) continue; // same LB only (v1 distance gate)
      const d = Math.hypot(pos.x - me.x, pos.y - me.y, pos.z - me.z);
      if (d > 40) continue;
      // Natural "fastest-to-attack" scoring: nearer = higher, plus T8's
      // opt-in monster-priority term: (priority-1)*5 when the name
      // substring-matches a configured rule.
      out.push({ guid: g, score: 100 - d + this._priorityTerm(g), dist: d });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  _priorityTerm(guid) {
    const keys = Object.keys(this.priorities);
    if (!keys.length) return 0;
    const name = (this.host.TryGetObjectName(guid) || "").toLowerCase();
    let best = 0;
    for (const k of keys) {
      if (name.includes(k)) best = Math.max(best, Math.max(0, this.priorities[k] - 1) * 5);
    }
    return best;
  }

  _selectTarget() {
    const now = Date.now();
    const targets = this._scanTargets();
    const lockedEntry = targets.find((t) => t.guid === this.locked);
    if (lockedEntry) {
      this.lastSeenLockedAt = now;
      this.lockedScore = lockedEntry.score;
    }
    if (this.locked && !lockedEntry) {
      // T10 scan grace: keep the lock briefly through a scan gap.
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
    // E4: UseDoneSeq advance OR the hard deadline — never wedge.
    if (h.has("GetUseDoneSeq") && h.GetUseDoneSeq() !== this.useDoneAtIssue) {
      this.awaitingCast = false;
      return true;
    }
    if (Date.now() - this.castIssuedAt > CAST_RESOLUTION_TIMEOUT_MS) {
      this.awaitingCast = false;
      return true;
    }
    return false;
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
    const dx = pos.x - me.x;
    const dy = pos.y - me.y;
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
    const s = this.host.s;
    const known = s.playerKnownSpells ? Array.from(s.playerKnownSpells() || []).map(Number) : [];
    this.warSpell = WAR_BOLTS.find((id) => known.includes(id)) || null;
    return this.warSpell;
  }

  tick() {
    const h = this.host;
    if (!h.IsPlayerReady()) return;
    const now = Date.now();
    const target = this._selectTarget();

    if (!target) {
      this.state = "ACQUIRE";
      return;
    }

    // Kill / disappearance detection.
    const pos = h.TryGetObjectPosition(target);
    const hf = h.TryGetTargetHealthFraction(target);
    if (!pos || hf === 0) {
      this.log(`kill confirmed ${target.toString(16)} (${this.kills + 1})`);
      this.kills++;
      this.recentlyKilled.set(target, now);
      this.damageModel.delete(target);
      this.locked = 0;
      this.lockedScore = -1;
      this.predictedKill = false;
      h.StopStick();
      this.state = "ACQUIRE";
      return;
    }

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

    // ENGAGE: equipment-derived combat mode (the live-confirmed trap) +
    // stick for melee-range hold. Missile ammo is handled by the toggle
    // itself — the equipment-derived suggested mode (get_suggested_combat_
    // mode + is_missing_missile_ammo, ACE Player_Combat) never returns
    // Missile without ammo, and ACE reverts a doomed mode to NonCombat, so
    // the loop self-corrects rather than getting stuck in a no-ammo missile
    // stance. The guard below bounds a mode that WON'T establish at all.
    this.mode = h.GetCurrentCombatMode();
    if (this.mode <= 1) {
      if (now - this.modeRequestedAt > 3000) {
        // If repeated toggles never leave NonCombat, the character can't
        // enter combat (no usable weapon/caster, or a persistent refusal) —
        // park the target so acquisition moves on instead of looping.
        this._modeAttempts = (this._modeAttempts || 0) + 1;
        if (this._modeAttempts > 5) {
          this.log(`cannot enter combat vs ${target.toString(16)} — parking`);
          this.recentlyKilled.set(target, now); // reuse the skip-TTL map
          this.locked = 0;
          this.lockedScore = -1;
          this._modeAttempts = 0;
          this.state = "ACQUIRE";
          return;
        }
        const s = h.s;
        if (s.toggleCombatMode) s.toggleCombatMode();
        this.modeRequestedAt = now;
        this.state = "ENGAGE";
      }
      return; // wait for the mode to complete before attacking
    }
    this._modeAttempts = 0; // established — reset the guard
    if (this.state !== "ATTACK") {
      h.StickToObject(target);
      this.state = "ATTACK";
    }

    // Health polling (QueryHealth-fed health fraction).
    if (now - this.lastQueryAt > QUERY_HEALTH_INTERVAL_MS) {
      h.QueryHealth(target);
      this.lastQueryAt = now;
    }

    // ATTACK, paced per mode.
    if (this.mode === 8) {
      if (!this._castResolved()) return; // P2: one cast in flight
      if (h.GetCastBusyState() !== 0) return; // local cast gesture gate
      // P3 — settle facing before the cast (don't fire while turning).
      if (this._faceGate(target) !== "cast") return;
      const spell = this._pickWarSpell();
      if (!spell) {
        this.log("no war spell known — cannot fight in magic mode");
        this.stop();
        return;
      }
      h.CastSpell(target, spell);
      this._markCastIssued();
    } else {
      // Melee/missile: no UseDone per swing — patience-window pacing.
      if (now - this.lastSwingAt < MELEE_SWING_PATIENCE_MS) return;
      if (this.mode === 4 && h.s.missileAttack) h.s.missileAttack(target, 2, 0.6);
      else h.MeleeAttack(target, 2, 0.6);
      this.lastSwingAt = now;
    }
  }
}

export default RynthCombatLoop;
