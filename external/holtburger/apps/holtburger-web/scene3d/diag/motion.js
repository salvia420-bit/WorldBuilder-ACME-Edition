// scene3d/diag/motion.js — per-entity motion-state diagnostic slice
//
// Wave-3 runtime-correctness probe for the question "did the renderer
// actually apply the motion the wire told it to?". Two classes of bug:
//
//   (a) entity stuck in idle when wire broadcast attack — the swing
//       packet drained, classifyMotionCommand returned "attack", but
//       the link-table fetch silently bailed (missing clip, mid-flight
//       eviction, removed entity), so `currentActionKey` never changed.
//   (b) drudge did not play damage-taken animation — the inverse: the
//       motion clip resolved + crossFadeTo ran, but a subsequent STOP
//       broadcast clobbered it before the rig finished a single cycle.
//
// Both fail silently from outside. The hook lives at the END of
// `setMotion()` immediately after `inst.crossFadeTo(action, cacheKey,
// CROSSFADE_S)` lands. That crossFadeTo synchronously sets
// `inst.currentAction` + `inst.currentActionKey` (entities.js L601-602),
// so the snapshot we take reflects what the runtime *applied*, not
// what we *wanted*. Same "no cheating" stance as wire.js / events.js:
// every read is of state the runtime already committed.
//
// Cost per hook fire: O(1) — one Map lookup, one history push, one
// optional shift() when the per-guid ring exceeds 20 entries (and one
// shift() on the global 200-entry ring). Holtburg setMotion peaks at
// ~50 hits/sec during a busy combat scene; well within budget.
//
// Devtools entry points exposed on `__diag.motion`:
//   byGuid       — Map(guid → { guid, name, current, history })
//   globalHistory — flat ring of every transition, newest at end
//   snapshot(guid?) — one entry, or whole-world map
//   stuckEntities(thresholdMs = 5000) — entries with no transition in N ms,
//                  cross-referenced against `__diag.wire.tail` for the same
//                  guid in the same window (recentWireEventsForGuid > 0 ⇒
//                  potential stuck bug; == 0 ⇒ idle entity, expected)
//   coverageMatrix() — Wave 6 / Phase 6.1 (2026-05-26): cumulative
//                  stance×cmd play counts across ALL guids. Returns
//                  `{ [stance_hex]: { [cmd_hex]: count } }`. Hooked
//                  alongside the per-guid history; counter increments
//                  whenever `onMotionApplied` fires with a CHANGED
//                  actionKey (same gate as globalHistory). Designed for
//                  the input-matrix drill — see exit gate at
//                  `external/holtburger/docs/movement-animation-overhaul-plan-2026-05-26.md`
//                  §"Wave 6 → Phase 6.1".
//   coverageSummary() — quick `{ totalPlays, stancesSeen, motionsSeen }`
//                  rollup of the matrix, for one-line operator queries.
//   coverageReset()  — clears the matrix without touching byGuid/history.
//                  Useful when scoping a capture window to a specific
//                  input drill (e.g. "now press W+D, then dump").
//   reset()      — zero all state (matrix, byGuid, history, link plays)

const MAX_GLOBAL_HISTORY = 200;
const MAX_PER_GUID_HISTORY = 20;
const DEFAULT_STUCK_THRESHOLD_MS = 5000;

/**
 * Parse the canonical action-key shape "setupId:mtableId:cmd:stance".
 * Mixed decimal + 0x-hex per AnimationCache.makeKey — be defensive on
 * each segment independently.
 */
function parseActionKey(key) {
  if (!key) return { setupId: null, mtableId: null, cmd: null, stance: null };
  const parts = String(key).split(":");
  const parseHex = (s) => {
    if (s == null) return null;
    if (s.startsWith("0x") || s.startsWith("0X")) {
      const n = parseInt(s, 16);
      return Number.isFinite(n) ? n : null;
    }
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  };
  return {
    setupId: parseHex(parts[0]),
    mtableId: parseHex(parts[1]),
    cmd: parseHex(parts[2]),
    stance: parseHex(parts[3]),
  };
}

/** Build the `current` snapshot from a live EntityInstance. */
function buildCurrent(inst, now) {
  const key = inst.currentActionKey ?? null;
  const parsed = parseActionKey(key);
  const act = inst.currentAction;
  return {
    actionKey: key,
    cmd: parsed.cmd,
    stance: parsed.stance,
    setupId: parsed.setupId,
    mtableId: parsed.mtableId,
    time: act ? (+act.time || 0) : 0,
    weight: act ? (+act.weight || 0) : 0,
    enabled: act ? !!act.enabled : false,
    appliedAt: now,
  };
}

/** Per-guid ring push: history is oldest-first, append at end. */
function pushPerGuid(entry, transition) {
  entry.history.push(transition);
  if (entry.history.length > MAX_PER_GUID_HISTORY) entry.history.shift();
}

/** Global ring push: oldest-first, append at end, single shift() on overflow. */
function pushGlobal(motion, rec) {
  motion.globalHistory.push(rec);
  if (motion.globalHistory.length > motion.maxGlobalHistory) {
    motion.globalHistory.shift();
  }
}

const MAX_LINK_PLAYS = 200;

export function attachMotion(diag) {
  const motion = {
    byGuid: new Map(),
    globalHistory: [],
    // Separate ring buffer for the link-clip path (combat swings + casts
    // + gesture loops). entities.js::_tryPlayLink raw-plays without
    // touching `inst.currentActionKey`, so these events DON'T appear in
    // byGuid/globalHistory and need their own surface. Diff vs the
    // wire-event combat stream via __diag.wire.tail to detect "wire
    // said attacker swung but no link clip played" type bugs.
    linkPlays: [],
    // Wave 6 / Phase 6.1 (2026-05-26) — per-(stance, cmd) cumulative play
    // counter across all guids. Two-level Map for O(1) increment without
    // string concat on the hot path; materialized to a plain object on
    // `coverageMatrix()`. Counts every CHANGED-actionKey hit, mirroring
    // the gate that pushes to globalHistory — no double-counting of
    // re-entrant `setMotion(sameKey)` no-ops.
    //
    // Shape: Map<stance_u32, Map<cmd_u32, count_int>>. Stance 0 lands
    // here when an EntityInstance hadn't resolved stance yet at the
    // crossFadeTo, which is rare but legitimate during initial spawn
    // bursts. The matrix surface labels it "0x00000000" — operators
    // should expect a small count there for fresh worlds.
    coverage: new Map(),
    maxGlobalHistory: MAX_GLOBAL_HISTORY,
    maxPerGuidHistory: MAX_PER_GUID_HISTORY,
    maxLinkPlays: MAX_LINK_PLAYS,

    /**
     * Hook fired from entities.js::setMotion immediately after
     * `inst.crossFadeTo(...)` lands. At this point the EntityInstance's
     * `currentAction` + `currentActionKey` are the freshly applied
     * values (crossFadeTo sets them synchronously). Records both the
     * new "current" snapshot and a transition entry capturing the
     * old → new actionKey diff for replay.
     */
    onMotionApplied(guid, inst) {
      if (!inst) return;
      const g = guid >>> 0;
      const now = performance.now();
      let entry = motion.byGuid.get(g);
      if (!entry) {
        entry = {
          guid: g,
          name: (inst.meta?.name ?? "") || "",
          current: null,
          history: [],
        };
        motion.byGuid.set(g, entry);
      } else if (!entry.name && inst.meta?.name) {
        // Name may have been empty at the first spawn-time snapshot
        // (e.g. metadata fetch finished after spawn-attempt). Refresh.
        entry.name = inst.meta.name;
      }

      const prior = entry.current;
      const next = buildCurrent(inst, now);

      // Only push a transition when something visible actually changed.
      // crossFadeTo short-circuits when nextAction === currentAction, but
      // setMotion can be re-entered with the same cacheKey for other
      // reasons (caller no-op safety); a non-changing snapshot here would
      // pollute the ring with noise.
      const changed = !prior || prior.actionKey !== next.actionKey;
      if (changed) {
        const transition = {
          t: now,
          oldActionKey: prior?.actionKey ?? null,
          newActionKey: next.actionKey,
          oldCmd: prior?.cmd ?? null,
          newCmd: next.cmd,
          oldStance: prior?.stance ?? null,
          newStance: next.stance,
        };
        pushPerGuid(entry, transition);
        pushGlobal(motion, {
          t: now,
          guid: g,
          name: entry.name,
          newActionKey: next.actionKey,
          oldActionKey: prior?.actionKey ?? null,
          cmd: next.cmd ?? 0,
          stance: next.stance ?? 0,
        });
        // Wave 6 / Phase 6.1 (2026-05-26) — increment the coverage cell
        // on the SAME gate as the history push. We use the parsed
        // numeric values from `next`; both are nullable when the cache
        // key was unparseable, which is rare but real (recovery from a
        // half-bake mid-load) — bucket those under `0` for both axes so
        // the counter still ticks without dropping signal. Use bitwise
        // `>>> 0` to normalize negative-mode parses (parseInt accepts
        // 32-bit signed ints via 0x80000000+).
        const stanceKey = (next.stance ?? 0) >>> 0;
        const cmdKey = (next.cmd ?? 0) >>> 0;
        let row = motion.coverage.get(stanceKey);
        if (!row) {
          row = new Map();
          motion.coverage.set(stanceKey, row);
        }
        row.set(cmdKey, (row.get(cmdKey) ?? 0) + 1);
      }

      entry.current = next;
    },

    /**
     * Hook fired from entities.js::_tryPlayLink after `action.play()`
     * lands. The link path is used for combat swings, spell casts, and
     * gesture loops; it does NOT mutate `inst.currentActionKey` (that
     * stays on the underlying locomotion clip), so locomotion-aware
     * consumers like `onMotionApplied` never see swing events. This
     * separate surface captures them with `(fromCmd, toCmd, stance,
     * hookCount, linkKey)` so the operator can correlate against
     * `__diag.wire.tail` combat packets without confusing the two
     * streams.
     */
    onMotionLinkPlayed(meta) {
      if (!meta || typeof meta.guid !== "number") return;
      const rec = {
        t: performance.now(),
        guid: meta.guid >>> 0,
        name: meta.name ?? "",
        fromCmd: meta.fromCmd >>> 0,
        toCmd: meta.toCmd >>> 0,
        stance: meta.stance >>> 0,
        hookCount: typeof meta.hookCount === "number" ? meta.hookCount : 0,
        linkKey: meta.linkKey ?? null,
      };
      motion.linkPlays.push(rec);
      if (motion.linkPlays.length > motion.maxLinkPlays) {
        motion.linkPlays.shift();
      }
    },

    /**
     * Return either a single guid's entry or the entire byGuid map
     * materialized as a plain object (devtools-friendly).
     */
    snapshot(guid) {
      if (guid !== undefined && guid !== null) {
        return motion.byGuid.get(guid >>> 0) ?? null;
      }
      const out = {};
      for (const [g, entry] of motion.byGuid) {
        out["0x" + g.toString(16).padStart(8, "0")] = entry;
      }
      return out;
    },

    /**
     * Find entities that have not transitioned in `thresholdMs`. For each,
     * cross-reference `__diag.wire.tail` for packets aimed at the same
     * guid in the same window. recentWireEventsForGuid > 0 ⇒ wire was
     * talking to this entity but the renderer never applied a new motion
     * (potential stuck-bug). == 0 ⇒ just an idle entity.
     */
    stuckEntities(thresholdMs = DEFAULT_STUCK_THRESHOLD_MS) {
      const now = performance.now();
      const stuck = [];
      for (const [g, entry] of motion.byGuid) {
        if (!entry.current) continue;
        const sinceLast = now - entry.current.appliedAt;
        if (sinceLast <= thresholdMs) continue;
        let recentWireEventsForGuid = 0;
        const wireTail = typeof window !== "undefined" ? window.__diag?.wire?.tail : null;
        if (Array.isArray(wireTail)) {
          const since = now - sinceLast;
          for (const rec of wireTail) {
            if (rec.t >= since && (rec.g >>> 0) === (g >>> 0)) {
              recentWireEventsForGuid += 1;
            }
          }
        }
        stuck.push({
          guid: g,
          name: entry.name,
          actionKey: entry.current.actionKey,
          sinceLastTransitionMs: sinceLast,
          recentWireEventsForGuid,
        });
      }
      return stuck;
    },

    /**
     * Wave 6 / Phase 6.1 (2026-05-26) — materialize the (stance, cmd)
     * play-count matrix as a plain devtools-friendly object. Keys are
     * 0x-padded 32-bit hex; values are integer counts. Cumulative since
     * either page load or the last `coverageReset()` call.
     *
     * Designed for the input-matrix drill from the plan: drive W, S, A,
     * D, Q, E, Shift+each, Space, combos; then call this and assert
     * every cell with a clip in MT 0x09000001 has count > 0. Useful for
     * surfacing missing classifier wirings (cell stays 0 when an input
     * combo is broadcast but the renderer never landed the cycle).
     */
    coverageMatrix() {
      const out = {};
      for (const [stance, row] of motion.coverage) {
        const stanceKey = "0x" + (stance >>> 0).toString(16).padStart(8, "0");
        const cells = {};
        for (const [cmd, count] of row) {
          const cmdKey = "0x" + (cmd >>> 0).toString(16).padStart(8, "0");
          cells[cmdKey] = count;
        }
        out[stanceKey] = cells;
      }
      return out;
    },

    /**
     * Wave 6 / Phase 6.1 (2026-05-26) — one-line rollup of the coverage
     * matrix. Cheaper than `coverageMatrix()` when the operator just
     * wants "did we cover the matrix at all?" without scanning every
     * cell.
     *
     *   totalPlays   — sum of all cell counts (changed-actionKey hits)
     *   stancesSeen  — distinct stance values that have ≥1 play
     *   motionsSeen  — distinct (stance, cmd) pairs with ≥1 play
     */
    coverageSummary() {
      let totalPlays = 0;
      let motionsSeen = 0;
      for (const [, row] of motion.coverage) {
        motionsSeen += row.size;
        for (const [, count] of row) totalPlays += count;
      }
      return {
        totalPlays,
        stancesSeen: motion.coverage.size,
        motionsSeen,
      };
    },

    /**
     * Wave 6 / Phase 6.1 (2026-05-26) — zero the matrix WITHOUT clearing
     * byGuid / globalHistory / linkPlays. Lets the operator scope a
     * capture window to one drill: call coverageReset(), press a
     * specific combo, then dump coverageMatrix() to see what FRESH
     * plays the input generated. The history rings remain intact for
     * stuck-entity cross-referencing.
     */
    coverageReset() {
      motion.coverage.clear();
    },

    /**
     * Wave 8 / Phase 8.5 (2026-05-26) — bucket the coverage matrix by
     * MotionCommand classifier category. Returns `{ locomotion, jump,
     * swing, cast, emote, reaction, stationary, interaction, idleAmbient,
     * extendedAttack, cycleHeld, unknown }` where each value is the sum
     * of all cell counts whose `cmd_low` falls into that category. Useful
     * for input-matrix drills that ask "how many EMOTES were played
     * during this capture window?" without manually pivoting the full
     * matrix.
     *
     * Categories mirror `scene3d/entities.js` Wave 8 Sets exactly. Any
     * cmd_low not in any Set lands in `unknown` — operators should never
     * see non-zero unknown counts in a healthy world; non-zero indicates
     * either a classifier gap or a stale wasm broadcast.
     *
     * Citations:
     * - `scene3d/entities.js::EMOTE_COMMANDS` / `REACTION_COMMANDS` /
     *   `STATIONARY_COMMANDS` / `INTERACTION_COMMANDS` /
     *   `IDLE_AMBIENT_COMMANDS` / `EXTENDED_ATTACK_COMMANDS` /
     *   `CYCLE_HELD_COMMANDS` — the Sets being bucketed.
     * - `docs/wave-8-motion-command-inventory-2026-05-26.md` — category
     *   definitions.
     */
    coverageByCategory() {
      // Inline category Sets (mirror entities.js Wave 8). Keep in sync if
      // entities.js Sets are extended in future waves. Same low-16 values.
      const LOCOMOTION = new Set([
        // Walk/Run/Sidestep/Turn/Stop/Ready (per Wave 1)
        0x0003, 0x0004, 0x0005, 0x0006, 0x0007,
        0x000D, 0x000E, 0x000F, 0x0010,
      ]);
      const JUMP_FALL = new Set([0x0008, 0x0015, 0x001D, 0x003B, 0x0050]);
      const SWING = new Set([
        // Thrust/Slash/Backhand/Shoot + AttackHigh/Med/Low 1-3 + Punch
        0x0058, 0x0059, 0x005A, 0x005B, 0x005C, 0x005D,
        0x005E, 0x005F, 0x0060, 0x0061,
        0x0062, 0x0063, 0x0064, 0x0065, 0x0066, 0x0067,
        0x0068, 0x0069, 0x006A,
        0x00D0, 0x00D1, 0x00D2,
        0x018F, 0x0190, 0x0191, 0x0192, 0x0193, 0x0194,
      ]);
      const CAST = new Set([
        0x002B, 0x002C, 0x002D, 0x002E, 0x002F, 0x0030, 0x0031, 0x0032,
        0x006F, 0x0070, 0x0071, 0x0072, 0x0073, 0x0074, 0x0075, 0x0076, 0x0077, 0x0078,
        0x00D3,
        0x0034, 0x0035, 0x0036, 0x0037, 0x0038, 0x0039,
        0x00E0, 0x00E1,
        0x012B, 0x012C, 0x012D, 0x012E, 0x012F,
        0x0130, 0x0131, 0x0132, 0x0133, 0x0134,
      ]);
      const EMOTE = new Set([
        0x004C, 0x004D, 0x004E, 0x004F, 0x0057,
        0x006B, 0x006C, 0x006D, 0x006E,
        0x0079, 0x007A, 0x007B, 0x007C, 0x007D, 0x007E, 0x007F,
        0x0080, 0x0081, 0x0082, 0x0083, 0x0084, 0x0085, 0x0086,
        0x0087, 0x0088, 0x0089, 0x008A, 0x008B, 0x008C, 0x008D,
        0x008E, 0x008F, 0x0090, 0x0091, 0x0092, 0x0093, 0x0094,
        0x0095, 0x0096, 0x0097, 0x0098, 0x0099, 0x009A,
        0x009B, 0x00CA, 0x00CB, 0x00CC,
        0x00D4, 0x00DF, 0x0119, 0x00F9, 0x0135,
        0x014A, 0x014B, 0x014C, 0x014D, 0x014E, 0x014F,
        0x0150, 0x0151, 0x0152,
      ]);
      const REACTION = new Set([
        0x0051, 0x0052, 0x0053, 0x0054, 0x0055, 0x0056,
        0x00E4, 0x00E5, 0x00E6,
      ]);
      const STATIONARY = new Set([
        0x0011, 0x0012, 0x0013, 0x0014,
        0x00EA, 0x00EB, 0x00EC, 0x00ED, 0x00EE, 0x00EF,
        0x00F0, 0x00F1, 0x00F2, 0x00F3, 0x00F4, 0x00F5,
        0x00F6, 0x00F7, 0x00F8,
        0x00FA, 0x00FB, 0x00FC, 0x00FD,
        0x0118, 0x011A, 0x011B, 0x011C,
        0x013D, 0x013E, 0x013F, 0x0140, 0x0141, 0x0142,
        0x0143, 0x0144, 0x0145, 0x0146, 0x0147, 0x0148, 0x0149,
      ]);
      const INTERACTION = new Set([
        0x0016, 0x0017, 0x0018, 0x0019, 0x001A, 0x001B, 0x001C,
        0x00A0, 0x00A1,
        0x00E8, 0x00E9,
        0x0136, 0x0137, 0x0138, 0x0139,
      ]);
      const IDLE_AMBIENT = new Set([
        0x009C, 0x009D, 0x009E, 0x009F,
        0x00E2, 0x00E3, 0x011E,
      ]);
      const EXTENDED_ATTACK = new Set([
        0x004A, 0x004B,
        0x00CD, 0x00CE, 0x00CF,
        0x010E, 0x010F,
        0x011F, 0x0120, 0x0121, 0x0122, 0x0123, 0x0124,
        0x0125, 0x0126, 0x0127, 0x0128, 0x0129, 0x012A,
        0x013A, 0x0153,
        0x0165, 0x0166, 0x0167, 0x0171, 0x0172,
        0x0173, 0x0174, 0x0175, 0x0176, 0x0177, 0x0178,
        0x0179, 0x017A, 0x017B, 0x017C, 0x017D, 0x017E,
        0x017F, 0x0180, 0x0181, 0x0182, 0x0183, 0x0184,
        0x0185,
        0x0186, 0x0187, 0x0188, 0x0189, 0x018A, 0x018B,
        0x018C, 0x018D, 0x018E,
        0x0195, 0x0196, 0x0197, 0x0198, 0x0199, 0x019A,
        0x019B,
      ]);
      const CYCLE_HELD = new Set([
        0x0001, 0x0002, 0x0009, 0x000A, 0x000B, 0x000C,
        0x001E,
        0x001F, 0x0020, 0x0021, 0x0022, 0x0023, 0x0024,
        0x0025, 0x0026, 0x0027, 0x0028, 0x0029, 0x002A,
        0x003A,
      ]);

      const buckets = {
        locomotion: 0,
        jump: 0,
        swing: 0,
        cast: 0,
        emote: 0,
        reaction: 0,
        stationary: 0,
        interaction: 0,
        idleAmbient: 0,
        extendedAttack: 0,
        cycleHeld: 0,
        unknown: 0,
      };

      for (const [, row] of motion.coverage) {
        for (const [cmd, count] of row) {
          const low = (cmd >>> 0) & 0xFFFF;
          if (LOCOMOTION.has(low)) buckets.locomotion += count;
          else if (JUMP_FALL.has(low)) buckets.jump += count;
          else if (SWING.has(low)) buckets.swing += count;
          else if (CAST.has(low)) buckets.cast += count;
          else if (EMOTE.has(low)) buckets.emote += count;
          else if (REACTION.has(low)) buckets.reaction += count;
          else if (STATIONARY.has(low)) buckets.stationary += count;
          else if (INTERACTION.has(low)) buckets.interaction += count;
          else if (IDLE_AMBIENT.has(low)) buckets.idleAmbient += count;
          else if (EXTENDED_ATTACK.has(low)) buckets.extendedAttack += count;
          else if (CYCLE_HELD.has(low)) buckets.cycleHeld += count;
          else buckets.unknown += count;
        }
      }
      return buckets;
    },

    reset() {
      motion.byGuid.clear();
      motion.globalHistory.length = 0;
      motion.linkPlays.length = 0;
      motion.coverage.clear();
    },
  };

  diag.motion = motion;
}
