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
//   reset()      — zero all state

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

    reset() {
      motion.byGuid.clear();
      motion.globalHistory.length = 0;
      motion.linkPlays.length = 0;
    },
  };

  diag.motion = motion;
}
