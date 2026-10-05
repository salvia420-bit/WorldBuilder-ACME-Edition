// app/latency_diag.js — per-action latency hops, input → wire → screen.
//
// Owner report (2026-10-05): "lag with just about everything" (using an item
// from inventory, stance switch) while playing through a Cloudflare tunnel.
// This surface splits each action's latency into the hops WE own and the
// hop the network/server owns, so a pasted summary says which one is slow.
//
// Hops recorded per action (performance.now() ms):
//   tInput  — JS called the SessionHandle method (wrapper entry)
//   tEnq    — the method returned: the SessionCommand is on the wasm channel
//   tWire   — the action's packet left through WebSocket.send (opcode-matched
//             by GameAction type, so movement heartbeats never claim it)
//   tIn1    — first inbound WebSocket frame after tWire (lower bound on RTT)
//   tInRel  — first inbound frame carrying the RELATED reply (UseDone /
//             WeenieError GameEvent for a Use, the local player's
//             UpdateMotion for a stance/attack/cast); falls back to tIn1 for
//             actions without a byte matcher
//   tDrain  — the first frame-pump drain after tInRel (the event sat in the
//             wasm queue until this rAF)
//   tUi     — the related ClientEvent / local-player motion update was
//             dispatched (UI rebuilt / rig setMotion ran)
//   tPaint  — the next requestAnimationFrame after tUi (visible by then)
//
// Client-owned = (tWire - tInput) + (tPaint - tInRel). Network+server =
// tInRel - tWire. With ?netWorker=1 the socket lives in a worker, so tWire /
// tIn* are unobservable here and read "n/a".
//
// Console (paste the output):
//   __diag.latency.summary()        — table + medians per hop, returns text
//   __diag.latency.records          — raw ring (last 32 actions)
//   __diag.latency.reset()
// `?latencyDiag=off` disables every hook (no wrapping, no WS patch).
//
// Cost: the WS hooks do one length check per frame while no action is
// pending; method wrappers cover ONLY the action methods listed below (never
// the per-frame getters).

const MAX_RECORDS = 32;
const PENDING_TIMEOUT_MS = 15000;
const FRAME_SAMPLES = 120;

// GameAction types (Chorizite GameActionType / ACE GameActionType).
const ACT = Object.freeze({
  MELEE: 0x0008,
  MISSILE: 0x000a,
  PUT_IN_CONTAINER: 0x0019,
  GET_AND_WIELD: 0x001a,
  DROP: 0x001b,
  USE_WITH_TARGET: 0x0035,
  USE: 0x0036,
  CAST_UNTARGETED: 0x0048,
  CAST_TARGETED: 0x004a,
  CHANGE_COMBAT_MODE: 0x0053,
});
// Background senders that must never be attributed to a user action.
const BACKGROUND_ACTIONS = new Set([0xf61c, 0xf753, 0xf61b, 0xf7c9, 0x01e9]);

// ClientEventKind numbers (scene3d/client_event_kinds.js).
const EV = Object.freeze({
  CHAT: 2, STATS: 8, INVENTORY: 11, USE_FAILED: 13, USE_DONE: 14,
  COMBAT: 19, SALVAGE: 52, ENCHANTMENTS: 46, INV_ACTION_FAILED: 48,
});
const ENTITY_KIND_MOTION = 5;

// inbound: "useDone" | "selfMotion" | null (first inbound frame)
// events: ClientEvent kinds that count as "UI updated"
// selfMotion: a local-player KIND_MOTION entity update counts as "rig updated"
const INV_EVENTS = [EV.INVENTORY, EV.INV_ACTION_FAILED];
export const METHOD_SPECS = Object.freeze({
  useObject: { act: [ACT.USE], inbound: "useDone", events: [EV.USE_DONE, EV.USE_FAILED, EV.INVENTORY, EV.ENCHANTMENTS, EV.INV_ACTION_FAILED] },
  useWithTarget: { act: [ACT.USE_WITH_TARGET], inbound: "useDone", events: [EV.USE_DONE, EV.USE_FAILED, EV.INVENTORY, EV.SALVAGE, EV.INV_ACTION_FAILED] },
  toggleCombatMode: { act: [ACT.CHANGE_COMBAT_MODE], inbound: "selfMotion", selfMotion: true },
  setCombatMode: { act: [ACT.CHANGE_COMBAT_MODE], inbound: "selfMotion", selfMotion: true },
  attack: { act: [ACT.MELEE], inbound: "selfMotion", selfMotion: true, events: [EV.COMBAT] },
  missileAttack: { act: [ACT.MISSILE], inbound: "selfMotion", selfMotion: true, events: [EV.COMBAT] },
  castTargetedSpell: { act: [ACT.CAST_TARGETED], inbound: "selfMotion", selfMotion: true },
  castUntargetedSpell: { act: [ACT.CAST_UNTARGETED], inbound: "selfMotion", selfMotion: true },
  setWielded: { act: [ACT.GET_AND_WIELD], events: INV_EVENTS },
  wieldFromPack: { act: [ACT.GET_AND_WIELD], events: INV_EVENTS },
  unwieldToPack: { act: [ACT.PUT_IN_CONTAINER], events: INV_EVENTS },
  putItemInContainer: { act: [ACT.PUT_IN_CONTAINER], events: INV_EVENTS },
  dropItem: { act: [ACT.DROP], events: INV_EVENTS },
  giveObject: { events: INV_EVENTS },
  mergeStacks: { events: INV_EVENTS },
  splitStackToContainer: { events: INV_EVENTS },
  splitStackToWield: { events: INV_EVENTS },
  splitStackTo3D: { events: INV_EVENTS },
  buyFromVendor: { events: INV_EVENTS },
  sellToVendor: { events: INV_EVENTS },
  sendChat: { events: [EV.CHAT] },
  sendTell: { events: [EV.CHAT] },
});

const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

function flagOff() {
  try {
    const v = new URLSearchParams(globalThis.location?.search || "").get("latencyDiag");
    return v === "off" || v === "0" || v === "false";
  } catch (_) {
    return false;
  }
}

function u8(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}

function rdU32(b, o) {
  return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
}

// Outbound ws frame = [port u16 BE][AC packet]. Our send_message packets carry
// only BLOB_FRAGMENTS (+ENCRYPTED_CHECKSUM): packet header 20 B, fragment
// header 16 B, then the message: opcode u32 (0xF7B1 GameAction), action
// sequence u32, action type u32. Returns the action type, or -1.
export function parseOutboundActionType(data) {
  const b = u8(data);
  if (!b || b.length < 50) return -1;
  const flags = rdU32(b, 2 + 4);
  if ((flags & 0x4) === 0 || (flags & ~0x6) !== 0) return -1;
  if (rdU32(b, 38) !== 0xf7b1) return -1;
  return rdU32(b, 46);
}

// Byte scan of an inbound frame for the related reply. Optional headers vary
// on S2C packets, so scan rather than parse; the 4-byte opcode + guid/event
// match keeps false positives negligible for a diagnostic.
export function inboundMatches(data, kind, localGuid) {
  const b = u8(data);
  if (!b) return false;
  const end = b.length - 16;
  for (let i = 22; i <= end; i++) {
    if (kind === "useDone") {
      if (b[i] === 0xb0 && b[i + 1] === 0xf7 && b[i + 2] === 0 && b[i + 3] === 0) {
        const ev = rdU32(b, i + 12);
        if (ev === 0x01c7 || ev === 0x028a || ev === 0x028b) return true;
      }
    } else if (kind === "selfMotion") {
      if (b[i] === 0x4c && b[i + 1] === 0xf7 && b[i + 2] === 0 && b[i + 3] === 0
          && localGuid && rdU32(b, i + 4) === localGuid) {
        return true;
      }
    }
  }
  return false;
}

function median(xs) {
  const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const m = v.length >> 1;
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

const r1 = (x) => (Number.isFinite(x) ? Math.round(x * 10) / 10 : null);
const d = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : NaN);

export function hopsOf(rec) {
  const inRel = Number.isFinite(rec.tInRel) ? rec.tInRel : rec.tIn1;
  return {
    action: rec.name,
    act: rec.actHex ?? "",
    enqueue: r1(d(rec.tInput, rec.tEnq)),
    toWire: r1(d(rec.tEnq, rec.tWire)),
    netServer: r1(d(rec.tWire, inRel)),
    firstByte: r1(d(rec.tWire, rec.tIn1)),
    queueToDrain: r1(d(inRel, rec.tDrain)),
    drainToUi: r1(d(rec.tDrain, rec.tUi)),
    uiToPaint: r1(d(rec.tUi, rec.tPaint)),
    total: r1(d(rec.tInput, rec.tPaint)),
    clientOwned: r1(d(rec.tInput, rec.tWire) + d(inRel, rec.tPaint)),
    via: rec.uiVia ?? (rec.timedOut ? "timeout" : "pending"),
  };
}

export function createLatencyDiag() {
  const L = {
    records: [],
    _pending: [],
    _frames: [],
    _lastPumpMs: null,
    _handle: null,
    installed: false,
    wsHooked: false,

    _begin(name, args) {
      const spec = METHOD_SPECS[name];
      if (!spec) return null;
      const rec = {
        name,
        arg0: typeof args?.[0] === "number" ? `0x${(args[0] >>> 0).toString(16)}` : undefined,
        spec,
        tInput: now(),
        tEnq: NaN, tWire: NaN, tIn1: NaN, tInRel: NaN, tDrain: NaN, tUi: NaN, tPaint: NaN,
        actHex: undefined, uiVia: undefined, timedOut: false, error: undefined,
      };
      L.records.push(rec);
      if (L.records.length > MAX_RECORDS) L.records.shift();
      L._pending.push(rec);
      return rec;
    },

    _expire(t) {
      if (L._pending.length === 0) return;
      L._pending = L._pending.filter((r) => {
        if (Number.isFinite(r.tPaint)) return false;
        if (t - r.tInput > PENDING_TIMEOUT_MS) { r.timedOut = true; return false; }
        return true;
      });
    },

    /** WebSocket.send tap (outbound frame). */
    onWsSend(data) {
      if (L._pending.length === 0) return;
      let type = -2; // lazily parsed
      const t = now();
      for (const r of L._pending) {
        if (Number.isFinite(r.tWire)) continue;
        if (type === -2) type = parseOutboundActionType(data);
        if (type < 0) return;
        const want = r.spec.act;
        const ok = want ? want.includes(type) : !BACKGROUND_ACTIONS.has(type);
        if (!ok) continue;
        r.tWire = t;
        r.actHex = `0x${type.toString(16).padStart(4, "0")}`;
        return; // one packet carries one action
      }
    },

    /** WebSocket onmessage tap (inbound frame). */
    onWsMessage(data) {
      if (L._pending.length === 0) return;
      const t = now();
      let guid;
      for (const r of L._pending) {
        if (!Number.isFinite(r.tWire)) continue;
        if (!Number.isFinite(r.tIn1)) r.tIn1 = t;
        if (Number.isFinite(r.tInRel) || !r.spec.inbound) continue;
        if (guid === undefined) {
          try { guid = (globalThis.getLocalPlayerGuid?.() ?? 0) >>> 0; } catch (_) { guid = 0; }
        }
        if (inboundMatches(data, r.spec.inbound, guid)) r.tInRel = t;
      }
    },

    /** Frame-pump start (index.html pumpNetFrame, before poll_events). */
    onPumpStart() {
      const t = now();
      if (L._lastPumpMs !== null) {
        L._frames.push(t - L._lastPumpMs);
        if (L._frames.length > FRAME_SAMPLES) L._frames.shift();
      }
      L._lastPumpMs = t;
      if (L._pending.length === 0) return;
      L._expire(t);
      for (const r of L._pending) {
        if (Number.isFinite(r.tDrain)) continue;
        // The reply this drain carries: the related frame when a matcher
        // exists, else (no matcher / socket in a worker) any inbound.
        const inbound = r.spec.inbound ? r.tInRel : r.tIn1;
        if (Number.isFinite(inbound)) r.tDrain = t;
      }
    },

    _ui(r, via) {
      const t = now();
      r.tUi = t;
      r.uiVia = via;
      if (!Number.isFinite(r.tDrain)) r.tDrain = t;
      const paint = () => { r.tPaint = now(); L._expire(r.tPaint); };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(paint);
      else paint();
    },

    /** After one ClientEvent was dispatched (UI handlers already ran). */
    onEvent(kind) {
      if (L._pending.length === 0) return;
      for (const r of L._pending) {
        if (Number.isFinite(r.tUi) || !r.spec.events) continue;
        if (!Number.isFinite(r.tEnq)) continue;
        // With the socket observable, require the action to have left first.
        if (L.wsHooked && !L._workerSocket && !Number.isFinite(r.tWire)) continue;
        if (r.spec.events.includes(kind)) { L._ui(r, `event:${kind}`); }
      }
    },

    /** One drained EntityUpdate (the 3D hook already applied it). */
    onEntityUpdate(kind, guid) {
      if (L._pending.length === 0 || kind !== ENTITY_KIND_MOTION) return;
      let local = 0;
      try { local = (globalThis.getLocalPlayerGuid?.() ?? 0) >>> 0; } catch (_) {}
      if (!local || (guid >>> 0) !== local) return;
      for (const r of L._pending) {
        if (Number.isFinite(r.tUi) || !r.spec.selfMotion) continue;
        // Only the motion that follows the related inbound reply counts
        // (an earlier self-motion is our own movement echo).
        const gate = (L.wsHooked && !L._workerSocket) ? r.tInRel : r.tEnq;
        if (!Number.isFinite(gate)) continue;
        L._ui(r, "selfMotion");
      }
    },

    attachHandle(handle) {
      if (!handle || L._disabled) return false;
      L._handle = handle;
      const proto = Object.getPrototypeOf(handle);
      if (!proto || proto.__latencyWrapped) return true;
      for (const name of Object.keys(METHOD_SPECS)) {
        const orig = proto[name];
        if (typeof orig !== "function") continue;
        proto[name] = function latencyWrapped(...args) {
          const rec = L._begin(name, args);
          try {
            return orig.apply(this, args);
          } catch (e) {
            if (rec) rec.error = String(e?.message ?? e);
            throw e;
          } finally {
            if (rec) rec.tEnq = now();
          }
        };
      }
      try { Object.defineProperty(proto, "__latencyWrapped", { value: true }); } catch (_) {}
      return true;
    },

    /** Mark that the socket lives in a worker (no WS hops observable). */
    noteWorkerSocket(on) { L._workerSocket = !!on; },

    hookWebSocket(WS = globalThis.WebSocket) {
      if (L.wsHooked || L._disabled || typeof WS !== "function" || !WS.prototype) return false;
      const proto = WS.prototype;
      const origSend = proto.send;
      if (typeof origSend !== "function") return false;
      proto.send = function latencySend(data) {
        if (L._pending.length !== 0) { try { L.onWsSend(data); } catch (_) {} }
        return origSend.call(this, data);
      };
      const desc = Object.getOwnPropertyDescriptor(proto, "onmessage");
      if (desc && typeof desc.set === "function" && typeof desc.get === "function") {
        Object.defineProperty(proto, "onmessage", {
          configurable: true,
          enumerable: desc.enumerable,
          get() {
            const w = desc.get.call(this);
            return (w && w.__latencyOrig) || w;
          },
          set(fn) {
            if (typeof fn !== "function") { desc.set.call(this, fn); return; }
            const wrapped = function latencyOnMessage(ev) {
              if (L._pending.length !== 0) { try { L.onWsMessage(ev?.data); } catch (_) {} }
              return fn.call(this, ev);
            };
            wrapped.__latencyOrig = fn;
            desc.set.call(this, wrapped);
          },
        });
      }
      L.wsHooked = true;
      return true;
    },

    reset() {
      L.records.length = 0;
      L._pending.length = 0;
      L._frames.length = 0;
    },

    rows() { return L.records.map(hopsOf); },

    summary() {
      const rows = L.rows();
      const keys = ["enqueue", "toWire", "netServer", "firstByte", "queueToDrain", "drainToUi", "uiToPaint", "total", "clientOwned"];
      const med = {};
      for (const k of keys) med[k] = r1(median(rows.map((r) => r[k] ?? NaN)));
      const frameMs = r1(median(L._frames));
      let pingRtt = null;
      try {
        const v = L._handle?.sessionLastPingRttMs?.();
        if (Number.isFinite(v) && v !== 0xffffffff) pingRtt = v;
      } catch (_) {}
      const head = `[latency] ${rows.length} actions · frame ${frameMs ?? "?"} ms`
        + ` · ping RTT ${pingRtt ?? "n/a"} ms · ws ${L._workerSocket ? "in worker (wire hops n/a)" : (L.wsHooked ? "hooked" : "not hooked")}`;
      const lines = [head, "action | act | enqueue | toWire | net+server | 1stByte | queue→drain | drain→ui | ui→paint | total | client-owned | via"];
      for (const r of rows) {
        lines.push([r.action, r.act, r.enqueue, r.toWire, r.netServer, r.firstByte, r.queueToDrain, r.drainToUi, r.uiToPaint, r.total, r.clientOwned, r.via].map((x) => x ?? "-").join(" | "));
      }
      lines.push(`median | | ${keys.map((k) => med[k] ?? "-").join(" | ")}`);
      const text = lines.join("\n");
      try {
        if (typeof console !== "undefined") {
          console.table?.(rows);
          console.log(text);
        }
      } catch (_) {}
      return { text, rows, median: med, frameMs, pingRttMs: pingRtt };
    },
  };
  return L;
}

/** Install the singleton on window (+ __diag.latency). Idempotent. */
export function installLatencyDiag(win = globalThis) {
  if (win.__latencyDiag) return win.__latencyDiag;
  const L = createLatencyDiag();
  if (flagOff()) {
    L._disabled = true;
  } else {
    try { L.hookWebSocket(win.WebSocket); } catch (_) {}
  }
  win.__latencyDiag = L;
  try {
    win.__diag = win.__diag || {};
    win.__diag.latency = L;
  } catch (_) {}
  return L;
}

if (typeof window !== "undefined") installLatencyDiag(window);
