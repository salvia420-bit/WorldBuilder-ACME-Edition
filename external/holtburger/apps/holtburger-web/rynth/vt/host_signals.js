// rynth/vt/host_signals.js — typed host signals for the VTank layer (W1-8 SEAM).
//
// PLAN §3.2 "host signals" + §3.10. The whole VT layer makes exactly ONE
// `host.onEvent` registration (this one, I-12 / V-9) and fans the numeric
// ClientEvent kinds out as typed Signals in JS. Two signals have no server
// packet and are SYNTHESIZED here: `portalOut` (the falling edge of the
// portal-space presentation, or kind 66 when no presentation runs, or — once
// the arrival is in — a presentation flag stuck up for PORTAL_OUT_STUCK_MS,
// e.g. a hidden tab whose frame loop never ends the tunnel) and
// `vendorClose` (ACE never tells the client a vendor closed — U4 row 19).
// The stuck-flag portalOut only tells metas (ExitPortal); every movement gate
// still reads IsPortalSpaceActive itself.
//
// Event-kind sources (normative, PLAN §3.2):
//   2  chat (+ tell when u32b === 2 TELL, or the self-tell line; + castLine)
//   11 inventory · 12 vendorOpen (u32 guid, text name) · 13 useFailed
//   (u32 WeenieError, text) · 14 useDone · 21/31 containerOpened/Closed ·
//   22 fellowship · 29 death · 32 appraised · 33 portalIn · 66
//   teleportArrived · 47/49 equip (detached/attached) · 48 equip failed.
// vendorOpen comes from kind 12 ONLY — never from a non-null
// TryGetVendorState, whose wasm cache outlives the vendor session
// (src/lib.rs prune_guid is the only removal; critic B2/C9).
//
// Every signal also carries a NON-enumerable `at` (the injected clock when it
// was emitted), so executors can require "a vendorOpen newer than my
// UseObject" without changing the §3.2 shapes; `latestAt(type)` reads it.
//
// Rules: plain ES module, no imports, no timers (sample() is driven by the
// host heartbeat), never throws, a throwing listener is isolated and logged.

export const SIGNAL_TYPES = Object.freeze([
  "chat",
  "tell",
  "castLine",
  "death",
  "portalIn",
  "portalOut",
  "teleportArrived",
  "vendorOpen",
  "vendorClose",
  "appraised",
  "inventory",
  "fellowship",
  "equip",
  "useFailed",
  "useDone",
  "containerOpened",
  "containerClosed",
]);
const SIGNAL_TYPE_SET = new Set(SIGNAL_TYPES);

/** A vendor further than this from the player is treated as closed. */
export const VENDOR_CLOSE_RANGE_M = 8;
/** Safety: a vendor session with no kind-12 refresh for this long is closed. */
export const VENDOR_SAFETY_MS = 300_000;
/** A presentation flag still up this long after the arrival (kind 66) ends
 *  the transit for the metas: the router's cap (portal_gate.js
 *  PORTAL_SPACE_MAX_HOLD_MS, mirrored — this module imports nothing). */
export const PORTAL_OUT_STUCK_MS = 90_000;
/** The window event plugins/vendor-ui.js dispatches from onHidden. */
export const VENDOR_CLOSED_EVENT = "hb-vendor-closed";

const KIND = Object.freeze({
  CHAT: 2,
  INVENTORY: 11,
  VENDOR_OPENED: 12,
  USE_FAILED: 13,
  USE_DONE: 14,
  CONTAINER_OPENED: 21,
  FELLOWSHIP: 22,
  DEATH: 29,
  CONTAINER_CLOSED: 31,
  APPRAISED: 32,
  PORTAL_SPACE_ENTERED: 33,
  ENTITY_DETACHED: 47,
  INVENTORY_ACTION_FAILED: 48,
  ENTITY_ATTACHED: 49,
  TELEPORT_ARRIVED: 66,
});

const CHAT_CATEGORY_TELL = 2;
// Chat categories that carry another player's words (src/lib.rs
// CHAT_CATEGORY_*): local say, tell, channels, emote, trade/LFG/roleplay/
// general/fellowship/allegiance, broadcast/society/olthoi, and the outgoing /
// social copies. A server cast line never arrives in one of them, so a player
// emoting "resists your spell" can never forge a castLine.
const SPEECH_CATEGORIES = new Set([1, 2, 3, 4, 12, 13, 14, 15, 16, 17, 21, 22, 23, 24, 25, 26]);

// control_channel.js:82-83 (src/chat_format.rs format_tell; names arrive with
// ACE's ^/& markers already trimmed).
export const TELL_RE = /^(.+?) tells you, "(.*)"$/;
export const SELF_TELL_RE = /^You think, "(.*)"$/;

/**
 * Parse a kind-2 line as a tell: `{ name, text, isSelf }` or null. A tell from
 * someone else needs the TELL category; the self form ("You think, …") is
 * accepted on its regex alone (its `name` is null — the caller fills it in).
 */
export function parseTell(text, cat) {
  if (typeof text !== "string" || !text) return null;
  const s = SELF_TELL_RE.exec(text);
  if (s) return { name: null, text: s[1], isSelf: true };
  if ((Number(cat) >>> 0) !== CHAT_CATEGORY_TELL) return null;
  const m = TELL_RE.exec(text);
  return m ? { name: m[1], text: m[2], isSelf: false } : null;
}

// ACE WorldObject_Magic.cs:411-420 suffixes on the "You cast" line (:441).
const CAST_SUFFIXES = [
  [", but it is surpassed by ", "surpassed"],
  [", surpassing ", "surpassing"],
  [", refreshing ", "refreshing"],
];
const RESIST_RE = /^(.+) resists your spell$/; // WorldObject_Magic.cs:192
const FAIL_PREFIX = "You fail to affect "; // WorldObject_Magic.cs:2136, Player_Magic.cs:1110
const CAST_PREFIX = "You cast ";

/**
 * Parse our own cast-result line: `{ spellName, targetName, outcome }` or
 * null. Outcomes: "landed" | "surpassing" | "refreshing" | "surpassed" |
 * "resisted" (spell name not on the line → "") | "failed".
 *
 * Splitting: the suffix is cut at its FIRST marker; the head splits at the
 * LAST " on " (spell names contain " on " — "Laying on of Hands", "Hearts on
 * Sleeves" — creature names do not); the fail line splits at the FIRST
 * " with " ("Incantation of Acid Stream with 300 Spellpower").
 */
export function parseCastLine(text) {
  if (typeof text !== "string" || !text) return null;
  if (text.startsWith(CAST_PREFIX)) {
    let head = text.slice(CAST_PREFIX.length);
    let outcome = "landed";
    let cut = -1;
    for (const [marker, oc] of CAST_SUFFIXES) {
      const i = head.indexOf(marker);
      if (i >= 0 && (cut < 0 || i < cut)) {
        cut = i;
        outcome = oc;
      }
    }
    if (cut >= 0) head = head.slice(0, cut);
    const on = head.lastIndexOf(" on ");
    if (on <= 0) return null;
    const spellName = head.slice(0, on);
    const targetName = head.slice(on + 4);
    if (!spellName || !targetName) return null;
    return { spellName, targetName, outcome };
  }
  if (text.startsWith(FAIL_PREFIX)) {
    const rest = text.slice(FAIL_PREFIX.length);
    const w = rest.indexOf(" with ");
    if (w <= 0) return null;
    const targetName = rest.slice(0, w);
    const spellName = rest.slice(w + 6);
    if (!spellName) return null;
    return { spellName, targetName, outcome: "failed" };
  }
  const r = RESIST_RE.exec(text);
  if (r) return { spellName: "", targetName: r[1], outcome: "resisted" };
  return null;
}

// Rate-limited logger (C3): identical messages at most once per 10 s.
function makeLog(log, now) {
  const base = typeof log === "function" ? log : (m) => console.log(`[vt:signals] ${m}`);
  const seen = new Map();
  return (msg) => {
    try {
      const t = now();
      const last = seen.get(msg);
      if (last != null && t - last < 10_000) return;
      if (seen.size >= 128) seen.clear();
      seen.set(msg, t);
      base(msg);
    } catch (_) {
      /* logging never throws */
    }
  };
}

// Distance to an object: the seam member when present, else the same rule
// inline (same landblock, or both outdoors in the global frame).
function distanceTo(host, guid) {
  if (typeof host.TryGetObjectDistance === "function") {
    const d = host.TryGetObjectDistance(guid);
    return typeof d === "number" && Number.isFinite(d) ? d : null;
  }
  if (typeof host.TryGetPlayerPose !== "function" || typeof host.TryGetObjectPosition !== "function") return null;
  const me = host.TryGetPlayerPose();
  const pos = host.TryGetObjectPosition(guid);
  if (!me || !pos) return null;
  const a = me.objCellId >>> 0;
  const b = pos.objCellId >>> 0;
  if (!a || !b) return null; // cell 0 = no cell known: never a (false) range close
  const sameLb = a >>> 16 === b >>> 16;
  const bothOutdoor = (a & 0xffff) < 0x100 && (b & 0xffff) < 0x100;
  if (!sameLb && !bothOutdoor) return null;
  const dx = sameLb ? pos.x - me.x : (((b >>> 24) & 0xff) - ((a >>> 24) & 0xff)) * 192 + (pos.x - me.x);
  const dy = sameLb ? pos.y - me.y : (((b >>> 16) & 0xff) - ((a >>> 16) & 0xff)) * 192 + (pos.y - me.y);
  const d = Math.hypot(dx, dy, (Number(pos.z) || 0) - (Number(me.z) || 0));
  return Number.isFinite(d) ? d : null;
}

/**
 * @param {object} host RynthWebHost (or a fake with `onEvent`)
 * @param {{ win?: object|null, now?: () => number, log?: (msg: string) => void }} [opts]
 * @returns {{ on(type: string, fn: Function): () => void, sample(): void,
 *             latest(type: string): object|null, latestAt(type: string): number|null,
 *             dispose(): void }}
 */
export function createHostSignals(host, opts = {}) {
  const o = opts && typeof opts === "object" ? opts : {};
  const win = o.win || null;
  const now = typeof o.now === "function" ? o.now : Date.now;
  const log = makeLog(o.log, now);

  const listeners = new Map(); // type | "*" -> Set<fn>
  const last = new Map(); // type -> last Signal
  let disposed = false;
  // portal state: pending = a portalIn not yet answered by a portalOut;
  // arrived = kind 66 seen for that pending transit; lastActive = the
  // previous sample of the presentation.
  let portalPending = false;
  let arrived = false;
  let arrivedAt = null;
  let lastActive = false;
  const stuckMs = Number.isFinite(o.portalStuckMs) && o.portalStuckMs > 0 ? o.portalStuckMs : PORTAL_OUT_STUCK_MS;
  // the one open vendor session (kind 12 only): { guid, name, at }
  let vendor = null;

  const call = (name, ...args) => {
    try {
      return typeof host?.[name] === "function" ? host[name](...args) : undefined;
    } catch (_) {
      return undefined;
    }
  };
  const selfGuid = () => Number(call("GetPlayerId")) >>> 0;
  const presentationAvailable = () => {
    if (typeof host?.has === "function") return !!call("has", "IsPortalSpaceActive");
    return typeof host?.IsPortalSpaceActive === "function";
  };
  const presentationActive = () => presentationAvailable() && call("IsPortalSpaceActive") === true;

  function emit(sig) {
    try {
      Object.defineProperty(sig, "at", { value: now(), enumerable: false });
    } catch (_) {
      /* a broken clock leaves `at` off */
    }
    Object.freeze(sig);
    last.set(sig.type, sig);
    const fns = [...(listeners.get(sig.type) || []), ...(listeners.get("*") || [])];
    for (const fn of fns) {
      try {
        fn(sig);
      } catch (err) {
        log(`listener for ${sig.type} threw: ${err && err.message ? err.message : err}`);
      }
    }
  }

  function closeVendor(reason) {
    const v = vendor;
    if (!v) return;
    vendor = null;
    emit({ type: "vendorClose", guid: v.guid, reason });
  }

  function emitPortalOut() {
    portalPending = false;
    arrived = false;
    arrivedAt = null;
    emit({ type: "portalOut" });
  }

  function onChat(e) {
    const text = e.text;
    if (typeof text !== "string" || !text) return;
    const cat = Number(e.u32b) >>> 0;
    emit({ type: "chat", text, chatType: Number(e.u32) >>> 0, cat });
    const t = parseTell(text, cat);
    if (t) {
      let name = t.name;
      if (t.isSelf) {
        const me = selfGuid();
        const n = me ? call("TryGetObjectName", me) : null;
        name = typeof n === "string" && n ? n : "You";
      }
      emit({ type: "tell", name, text: t.text, isSelf: t.isSelf });
      return;
    }
    if (SPEECH_CATEGORIES.has(cat)) return;
    const c = parseCastLine(text);
    if (c) emit({ type: "castLine", spellName: c.spellName, targetName: c.targetName, outcome: c.outcome, raw: text });
  }

  function handle(e) {
    const kind = Number(e.kind);
    const u32 = Number(e.u32) >>> 0;
    const u32b = Number(e.u32b) >>> 0;
    switch (kind) {
      case KIND.CHAT:
        onChat(e);
        break;
      case KIND.INVENTORY:
        emit({ type: "inventory" });
        break;
      case KIND.VENDOR_OPENED: {
        if (vendor && vendor.guid !== u32) closeVendor("otherVendor");
        const name = typeof e.text === "string" ? e.text : "";
        vendor = { guid: u32, name, at: now() };
        emit({ type: "vendorOpen", guid: u32, name });
        break;
      }
      case KIND.USE_FAILED:
        emit({ type: "useFailed", code: u32, text: typeof e.text === "string" ? e.text : "" });
        break;
      case KIND.USE_DONE:
        emit({ type: "useDone" });
        break;
      case KIND.CONTAINER_OPENED:
        emit({ type: "containerOpened", guid: u32 });
        if (vendor && u32 !== vendor.guid) closeVendor("container");
        break;
      case KIND.CONTAINER_CLOSED:
        emit({ type: "containerClosed", guid: u32 });
        break;
      case KIND.FELLOWSHIP:
        emit({ type: "fellowship" });
        break;
      case KIND.DEATH: {
        const me = selfGuid();
        emit({ type: "death", victim: u32, killer: u32b, self: u32 !== 0 && u32 === me, text: typeof e.text === "string" ? e.text : "" });
        break;
      }
      case KIND.APPRAISED:
        emit({ type: "appraised", guid: u32 });
        break;
      case KIND.PORTAL_SPACE_ENTERED:
        portalPending = true;
        arrived = false;
        emit({ type: "portalIn", seq: u32 });
        closeVendor("portal");
        break;
      case KIND.TELEPORT_ARRIVED:
        emit({ type: "teleportArrived", cell: u32 });
        // No presentation hold running (absent, ?portalSpace=off, already
        // over): the arrival IS the exit. Otherwise sample() waits for the
        // presentation to drop.
        if (portalPending) {
          arrived = true;
          arrivedAt = now();
          if (!presentationActive()) emitPortalOut();
        }
        break;
      case KIND.ENTITY_DETACHED:
      case KIND.ENTITY_ATTACHED:
        emit({ type: "equip", item: u32, wielder: u32b, failed: false });
        break;
      case KIND.INVENTORY_ACTION_FAILED:
        emit({ type: "equip", item: u32, wielder: 0, failed: true, code: u32b });
        break;
      default:
        break;
    }
  }

  // THE one host.onEvent registration. host.onEvent has no removal API, so a
  // disposed instance keeps the closure but ignores everything.
  const onEvent = (e) => {
    if (disposed || !e) return;
    try {
      handle(e);
    } catch (err) {
      log(`event kind ${e && e.kind} failed: ${err && err.message ? err.message : err}`);
    }
  };
  if (typeof host?.onEvent === "function") {
    try {
      host.onEvent(onEvent);
    } catch (err) {
      log(`host.onEvent registration failed: ${err && err.message ? err.message : err}`);
    }
  } else {
    log("host has no onEvent — signals are inert");
  }

  // plugins/vendor-ui.js onHidden -> "hb-vendor-closed" {detail:{guid}}.
  const onVendorClosed = (ev) => {
    if (disposed || !vendor) return;
    try {
      const g = Number(ev && ev.detail && ev.detail.guid) >>> 0;
      if (!g || g === vendor.guid) closeVendor("window");
    } catch (err) {
      log(`vendor-closed event failed: ${err && err.message ? err.message : err}`);
    }
  };
  let winAttached = false;
  if (win && typeof win.addEventListener === "function") {
    try {
      win.addEventListener(VENDOR_CLOSED_EVENT, onVendorClosed);
      winAttached = true;
    } catch (_) {
      winAttached = false;
    }
  }

  return {
    /** Subscribe to one Signal type (or "*" for all). Returns the unsubscribe. */
    on(type, fn) {
      if (disposed || typeof fn !== "function") return () => {};
      if (type !== "*" && !SIGNAL_TYPE_SET.has(type)) {
        log(`on(): unknown signal type ${String(type)}`);
        return () => {};
      }
      let set = listeners.get(type);
      if (!set) listeners.set(type, (set = new Set()));
      set.add(fn);
      return () => {
        listeners.get(type)?.delete(fn);
      };
    },
    /**
     * Once per heartbeat (INT-2 preTick): the portal presentation's edges
     * (rising = in portal, also closes a vendor; falling = portalOut) and
     * the open vendor's range (> 8 m) / 300 s safety.
     */
    sample() {
      if (disposed) return;
      try {
        if (presentationAvailable()) {
          const active = call("IsPortalSpaceActive") === true;
          if (active && !lastActive) {
            // rising edge: in portal space even if kind 33 was missed
            portalPending = true;
            closeVendor("portal");
          }
          // falling edge, or the arrival came while the hold was up and the
          // hold is over now (a sample that missed the edge itself)
          if (!active && portalPending && (lastActive || arrived)) emitPortalOut();
          else if (active && portalPending && arrived && arrivedAt !== null && now() - arrivedAt > stuckMs) {
            // The arrival is in but the presentation flag never dropped (its
            // sequencer only advances on rendered frames: a hidden tab). One
            // portalOut for the metas; the movement gates keep their own read.
            log(`portal presentation still up ${Math.round((now() - arrivedAt) / 1000)} s after the arrival — portalOut synthesized`);
            emitPortalOut();
          }
          lastActive = active;
        } else {
          lastActive = false;
        }
        if (vendor) {
          if (now() - vendor.at > VENDOR_SAFETY_MS) {
            closeVendor("timeout");
          } else {
            const d = distanceTo(host, vendor.guid);
            if (d != null && d > VENDOR_CLOSE_RANGE_M) closeVendor("range");
          }
        }
      } catch (err) {
        log(`sample failed: ${err && err.message ? err.message : err}`);
      }
    },
    /** The last Signal of `type`, or null. */
    latest(type) {
      return last.get(type) ?? null;
    },
    /** When the last Signal of `type` was emitted (injected clock), or null. */
    latestAt(type) {
      const s = last.get(type);
      return s && typeof s.at === "number" ? s.at : null;
    },
    /** Detach every JS listener and the window listener; idempotent. */
    dispose() {
      if (disposed) return;
      disposed = true;
      listeners.clear();
      last.clear();
      vendor = null;
      if (winAttached) {
        try {
          win.removeEventListener(VENDOR_CLOSED_EVENT, onVendorClosed);
        } catch (_) {
          /* window gone */
        }
        winAttached = false;
      }
    },
  };
}

export default createHostSignals;
