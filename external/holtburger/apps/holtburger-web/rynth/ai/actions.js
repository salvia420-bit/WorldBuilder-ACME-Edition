// actions.js — the typed action surface the LLM may invoke, with validation
// and a never-throws executor over the live bot API. INTERFACE FROZEN — see
// rynth/ai/SPEC.md §actions (exact v1 action list + bounds + the no-admin
// "say" rule).

// Same bound as the in-game control channel (control_channel.js:28) — the
// map spans ~±101.95 /loc degrees.
const MAX_LOC_DEG = 102;
const SAY_MAX_CHARS = 120;
const NOTE_MAX_CHARS = 500;

export const ACTIONS = {
  goto: {
    params: { ns: `number, /loc degrees NS, |deg| <= ${MAX_LOC_DEG}`, ew: `number, /loc degrees EW, |deg| <= ${MAX_LOC_DEG}` },
    desc: "travel to /loc coordinates (pauses grind, resumes on arrival)",
  },
  goto_lb: {
    params: {
      lb: "full u32 objCellId (hex string or number) as printed on the observation's pos line, e.g. 0xA9B40015 — NOT the bare 4-digit landblock word",
      x: "number, landblock-local, 0 <= x < 192",
      y: "number, landblock-local, 0 <= y < 192",
      z: "number",
    },
    desc: "travel to an exact landblock-local position",
  },
  stop_goto: { params: {}, desc: "cancel any travel/goto in progress" },
  set_priorities: {
    params: { rules: "object of monster-name -> int 1..99; REPLACES all rules" },
    desc: "replace the combat hunting priorities",
  },
  set_loot_min_value: {
    params: { value: "int >= 0" },
    desc: "set the loot Value threshold (items below are skipped)",
  },
  pause: { params: {}, desc: "stop the grind kernel (combat/buff/loot go idle)" },
  resume: { params: {}, desc: "start the grind kernel" },
  say: {
    params: { text: `string <= ${SAY_MAX_CHARS} chars; must NOT start with "@"` },
    desc: "say in local chat (no admin/@ commands)",
  },
  set_checkin: { params: { minutes: "int 1..30" }, desc: "change your check-in interval" },
  note: { params: { text: `string <= ${NOTE_MAX_CHARS} chars` }, desc: "leave a note-to-self in the journal" },
  none: { params: {}, desc: "do nothing this check-in" },
};

export function renderActionCatalog() {
  return Object.entries(ACTIONS)
    .map(([type, { params, desc }]) => {
      const p = Object.entries(params)
        .map(([k, d]) => `${k}: ${d}`)
        .join("; ");
      return `${type} {${p}} — ${desc}`;
    })
    .join("\n");
}

const isFiniteNum = (v) => typeof v === "number" && Number.isFinite(v);
// Landblock as number (objCellId, uint32-ish) or hex string, optionally
// 0x-prefixed, up to 8 digits — matches the {lb,x,y,z} shape bot.goto routes
// to the nav sidecar (global_router.js:64).
const isLandblock = (lb) =>
  (typeof lb === "number" && Number.isInteger(lb) && lb >= 0) ||
  (typeof lb === "string" && /^(0x)?[0-9a-f]{1,8}$/i.test(lb.trim()));

/** Shape+bounds validation only. -> { ok, error? } */
export function validateAction(a) {
  if (!a || typeof a !== "object" || Array.isArray(a)) return { ok: false, error: "action must be an object" };
  if (typeof a.type !== "string" || !Object.prototype.hasOwnProperty.call(ACTIONS, a.type))
    return { ok: false, error: `unknown action type: ${JSON.stringify(a.type)}` };
  switch (a.type) {
    case "goto":
      for (const k of ["ns", "ew"])
        if (!isFiniteNum(a[k]) || Math.abs(a[k]) > MAX_LOC_DEG)
          return { ok: false, error: `${k} must be a finite number, |deg| <= ${MAX_LOC_DEG}` };
      return { ok: true };
    case "goto_lb":
      if (!isLandblock(a.lb)) return { ok: false, error: "lb must be a full u32 objCellId as hex string or non-negative integer" };
      for (const k of ["x", "y", "z"])
        if (!isFiniteNum(a[k])) return { ok: false, error: `${k} must be a finite number` };
      // Sidecar rejects landblock-local coords outside [0,192) — catch it
      // here so the LLM gets a bounds message instead of a routing failure.
      for (const k of ["x", "y"])
        if (a[k] < 0 || a[k] >= 192) return { ok: false, error: `${k} must be landblock-local, 0 <= ${k} < 192` };
      return { ok: true };
    case "set_priorities": {
      const r = a.rules;
      if (!r || typeof r !== "object" || Array.isArray(r))
        return { ok: false, error: "rules must be an object of name -> int 1..99" };
      for (const [name, v] of Object.entries(r)) {
        if (!name.trim()) return { ok: false, error: "rule names must be non-empty" };
        if (!Number.isInteger(v) || v < 1 || v > 99)
          return { ok: false, error: `priority for ${JSON.stringify(name)} must be an int 1..99` };
      }
      return { ok: true };
    }
    case "set_loot_min_value":
      if (!Number.isInteger(a.value) || a.value < 0) return { ok: false, error: "value must be an int >= 0" };
      return { ok: true };
    case "say": {
      if (typeof a.text !== "string" || !a.text.trim()) return { ok: false, error: "text must be a non-empty string" };
      // SPEC §actions: no admin commands from the LLM, ever.
      if (a.text.trim().startsWith("@")) return { ok: false, error: 'refused: "@" admin commands are not allowed' };
      return { ok: true };
    }
    case "set_checkin":
      if (!Number.isInteger(a.minutes) || a.minutes < 1 || a.minutes > 30)
        return { ok: false, error: "minutes must be an int 1..30" };
      return { ok: true };
    case "note":
      if (typeof a.text !== "string" || !a.text.trim()) return { ok: false, error: "text must be a non-empty string" };
      return { ok: true };
    default:
      // stop_goto / pause / resume / none take no params.
      return { ok: true };
  }
}

/** Apply one action to the live bot. NEVER throws. -> { type, ok, result?|error? } */
export async function executeAction(bot, a, { log } = {}) {
  const type = a && typeof a === "object" ? a.type : undefined;
  const fail = (error) => {
    try {
      log && log(`[ai] action ${type}: ${error}`);
    } catch {}
    return { type, ok: false, error: String(error) };
  };
  try {
    const v = validateAction(a);
    if (!v.ok) return fail(v.error);
    switch (a.type) {
      case "goto":
      case "goto_lb": {
        if (typeof bot?.goto !== "function") return fail("unavailable");
        // The nav sidecar needs the FULL u32 objCellId — the high word places
        // the point. A bare landblock word (e.g. 0xA9B4) would route to the
        // map-corner landblock 0x0000; refuse it with an actionable error.
        const lbNum = a.type === "goto_lb" ? (typeof a.lb === "string" ? parseInt(a.lb.trim(), 16) : a.lb) : 0;
        if (a.type === "goto_lb" && lbNum <= 0xffff)
          return fail(
            `lb 0x${lbNum.toString(16).toUpperCase()} looks like a bare landblock word — send the full u32 objCellId from the pos line (e.g. 0xA9B40015)`,
          );
        // The nav sidecar only knows outdoor terrain — indoor (EnvCell) routes
        // 400 (v6.2 spam). Refuse with the indoor alternative instead of
        // letting the sidecar error bubble up as an opaque routing failure.
        if (a.type === "goto_lb" && ((lbNum >>> 0) & 0xffff) >= 0x100)
          return fail(
            `0x${lbNum.toString(16).toUpperCase()} is an indoor dungeon cell — outdoor goto cannot route into dungeons; use goto_object/use_object on something in your nearby list instead (note: an OBJECT guid from 'nearby', e.g. 0x7860205D, is NOT a cell/landblock id — never derive goto_lb targets from object guids)`,
          );
        try {
          const p = bot?.host?.TryGetPlayerPose?.();
          if (p && ((p.objCellId >>> 0) & 0xffff) >= 0x100)
            return fail(
              "you are indoors (dungeon cell) — outdoor goto cannot route from here; use exit_building to walk outside first, then goto",
            );
        } catch {}
        const to = a.type === "goto" ? { ns: a.ns, ew: a.ew } : { lb: lbNum, x: a.x, y: a.y, z: a.z };
        // bot.goto resolves {ok, state, legsWalked, replans} or {ok:false,
        // error} (bot.js:141-148); refusals like "goto already active"
        // surface as the error here.
        const r = await bot.goto(to);
        return r && r.ok ? { type, ok: true, result: r } : fail((r && r.error) || "goto failed");
      }
      case "stop_goto":
        // router.cancel() aborts a raw travel AND an in-flight goto — the
        // global router treats an external cancel as route-cancelled
        // (global_router.js:30).
        if (typeof bot?.router?.cancel !== "function") return fail("unavailable");
        bot.router.cancel();
        return { type, ok: true, result: "cancelled" };
      case "set_priorities":
        if (!bot?.combat) return fail("unavailable");
        bot.combat.priorities = { ...a.rules }; // replace, don't merge (SPEC §actions)
        return { type, ok: true, result: { rules: { ...a.rules } } };
      case "set_loot_min_value":
        if (!bot?.loot) return fail("unavailable");
        bot.loot.minValue = a.value;
        return { type, ok: true, result: { value: a.value } };
      case "pause":
        if (typeof bot?.kernel?.stop !== "function") return fail("unavailable");
        bot.kernel.stop();
        return { type, ok: true, result: "paused" };
      case "resume":
        if (typeof bot?.kernel?.start !== "function") return fail("unavailable");
        bot.kernel.start();
        return { type, ok: true, result: "resumed" };
      case "say": {
        if (typeof bot?.host?.WriteToChat !== "function") return fail("unavailable");
        const text = a.text.trim().slice(0, SAY_MAX_CHARS);
        bot.host.WriteToChat(text);
        return { type, ok: true, result: { text } };
      }
      case "set_checkin":
        // No bot surface — the director applies the new interval from this
        // result (SPEC §actions).
        return { type, ok: true, result: { minutes: a.minutes } };
      case "note":
        // No bot surface — the director journals the plan results, which
        // carry this text (SPEC §actions).
        return { type, ok: true, result: { text: a.text.trim().slice(0, NOTE_MAX_CHARS) } };
      case "none":
        return { type, ok: true, result: "noop" };
      default:
        return fail("unknown action type"); // unreachable post-validate; keeps never-throws airtight
    }
  } catch (e) {
    return fail((e && e.message) || e);
  }
}

/** Sequential, capped, never-throws plan execution. -> results[] */
export async function executePlan(bot, actions, { maxActions = 5, log } = {}) {
  const results = [];
  try {
    const list = Array.isArray(actions) ? actions : [];
    for (const a of list.slice(0, maxActions)) results.push(await executeAction(bot, a, { log }));
    if (list.length > maxActions) {
      try {
        log && log(`[ai] plan truncated: ${list.length - maxActions} action(s) past maxActions=${maxActions} skipped`);
      } catch {}
    }
  } catch {} // executeAction never throws, but the plan guarantee stands regardless
  return results;
}
