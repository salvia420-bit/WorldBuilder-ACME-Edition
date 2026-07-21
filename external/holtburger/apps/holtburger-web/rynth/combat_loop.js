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

// T9 — alt must beat locked+stickiness. C#'s 25.0 (CombatManager.cs:344) is
// on ScoreCandidate's 2-pts-per-yard distance scale ((maxDist-d)/maxDist*100,
// MonsterRange default 50 — CombatManager.cs:2215); our score is 1 pt/yd
// (100-d), so the scale-equivalent threshold is 12.5. 25 here made the lock
// ~2x stickier than the tuned behavior (netwasm parity finding 1).
const TARGET_SWITCH_STICKINESS = 12.5;
const TARGET_SCAN_GRACE_MS = 1500; // T10 — retain lock through an EMPTY scan gap
const CAST_RESOLUTION_TIMEOUT_MS = 2500; // P2/E4 — UseDone fallback
// T2/T13 — confirmed-kill re-engage suppression. C# RECENTLY_KILLED_SUPPRESS_MS
// = 4000.0 (CombatManager.cs:234); the 30s previously here ignored mobs that
// respawn/survive inside 4-30s which C# re-engages (netwasm parity finding 5).
const RECENTLY_KILLED_TTL_MS = 4000;
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
    // Director-togglable hunting (2026-07-21 scope addition): the combat
    // kernel auto-engages any attackable object whenever it's on; the AI
    // director now owns that as a toggle (hunt_start/hunt_stop,
    // tools/world.js) so it can hunt when it chooses and stand down while
    // surveying/traveling/dying. Defaults to CURRENT behavior (true) — the
    // boot-time on/off switch (?botKernel=off / config.kernel===false, the
    // WHOLE kernel) is unchanged; this is a narrower runtime knob on just
    // the combat loop's own target scan.
    this.enabled = true;
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
    if (!this.enabled) return []; // hunting OFF (director toggle) — never acquire a target
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
      // T2: vendors/NPCs are creatures too. ObjectIsAttackable now FAILS OPEN
      // when the desc flags haven't streamed yet (webhost.js), matching C#'s
      // `HasObjectIsAttackable` anti-stall guard (CombatManager.cs:610), so a
      // not-yet-described spawn is engaged instead of stared at (combat T4).
      if (!h.ObjectIsAttackable(g)) continue;
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
        Blacklisted: false,
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
    const nb = this._nb;
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

    // netBrain shadow context: the C# slice must see the PRE-kill-confirm
    // lock (its SelectTargetTick does its own hp==0 drop, so both sides'
    // drop+re-lock land inside the same compared tick).
    if (this._nb?.brain) this._nbCtx = { preLock: this.locked, now };

    // Kill detection — validate the lock BEFORE re-selection (C# Think order,
    // CombatManager.cs:1717-1744) so the same tick can re-lock an alternative.
    // hp=0 is the ONLY kill confirm (DropTarget("hp=0"), CombatManager.cs:1733);
    // a vanished/positionless lock is a transient world-filter miss, NOT a
    // kill — C# keeps the lock and lets the T10 scan grace drop a truly
    // vanished mob kill-free (CombatManager.cs:1739-1741, :1786). Previously
    // `!pos` here counted a phantom kill and TTL-suppressed a live mob on a
    // one-tick entity-stream miss (netwasm parity finding 3).
    if (this.locked && h.TryGetTargetHealthFraction(this.locked) === 0) {
      this.log(`kill confirmed ${this.locked.toString(16)} (${this.kills + 1})`);
      this.kills++;
      this.recentlyKilled.set(this.locked, now);
      this.damageModel.delete(this.locked);
      this.locked = 0;
      this.lockedScore = -1;
      this.predictedKill = false;
      h.StopStick();
      this.state = "ACQUIRE"; // re-stick if selection re-locks below
    }

    const target = this._selectTarget();

    if (!target) {
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
    // Re-stick whenever the lock CHANGED, not only on state transition —
    // a T9 switch / T10 re-lock lands while state is already "ATTACK" and
    // would otherwise leave the stick chasing the previous target (C#
    // re-targets through its per-tick attack path).
    if (this.state !== "ATTACK" || this._stuckTo !== target) {
      h.StickToObject(target);
      this._stuckTo = target;
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
