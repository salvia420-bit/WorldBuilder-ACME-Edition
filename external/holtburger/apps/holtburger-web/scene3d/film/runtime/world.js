// scene3d/film/runtime/world.js — world control for a film shoot: teleport, readiness, prewarm, avatar, actor
// (SPEC §0 streaming dolly, §3 world.*, §3.4 readiness gate; recon_world, recon_terrain).
//
// WHY: everything streams around the PLAYER (terrain/object rings, the LRU,
// ACE's 3×3 creature visibility), so the hidden player character is the
// film's streaming dolly. Before a site is shot the director teleports it
// there (≈10 s: portal tunnel ≥ 4 s + arrival + streaming) and must know —
// not guess — when the world around the camera is complete, or the take shows
// pop-in, half-baked terrain or empty rooms. This module:
//   * teleport(cmd) — sends an ACE admin command (`sessionHandle.sendChat`;
//     ONLY '@'-prefixed text is a command — a '/' line is spoken aloud), single
//     line, ≤ 200 chars; verbs that log the account out or write the world
//     database are refused (morph, portalstorm, rotate, createinst, `nudge
//     <args>`, shutdown, ban, boot, gag); then parks the film viewer cell
//     (injected `parkViewerCell`), so the previous site's cell never decides
//     viewer-indoor / sealed-dungeon state while the next site streams in;
//   * ready(opts) — the SPEC §3.4 gate, every sub-check reported: the teleport
//     actually happened (portal entered, or a grace without one), portal space
//     inactive, target landblocks' terrain baked + attached (a terrainGroup mesh
//     — the baked mark lands BEFORE the mesh attaches) + not parked, no
//     `terrain:|statics:|buildings:` guard keys in flight, the PVS sweep
//     complete, interiors loaded (`envCellLoadedLbs`, `__interiorBuildPending`),
//     then a scene settle (terrainBakedLbs.size, staticsGroup children,
//     cellContainers3d.size unchanged for 3 × 500 ms) and `settleSec`; never
//     blocks past `timeoutSec`;
//   * prewarm({points, radius}) — collision (populate*ForLandblock, deduped and
//     skipped inside the player's own 3×3, which the stream already populates),
//     the private heightmap corridor, and the per-landblock loaders (terrain via
//     `_runTerrainRingBatch` — NEVER `loadTerrainRing`, which would shift the
//     player-centred fixed grid — statics, buildings, EnvCells), refired until
//     the baked marks land or a timeout (the stream guard silently skips bakes
//     when 6 are in flight or cooling down);
//   * avatar(visible) — the film-owned hide term (`entityManager.setFilmHidden`:
//     rig + held items + shadow, survives the teleport Hidden flips), fallback
//     the camera near-fade opacity;
//   * actor(cue) — the player-as-actor: soul emotes through
//     `window.__routeSlashCommand` (only tokens the DAT catalog resolves — an
//     unknown /x would become an '@x' admin command), client motions
//     (`entityManager.setMotion` / `setSwingMotion`), facing
//     (`turnToHeading(−compass)`), and walking (`moveToPosition` + polling
//     `pursuitStatus` for arrived/failed).
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Page module: dependencies injected
// ({liveScene3d, sessionHandle, window, worldQuery, corridor, wasmExports,
// parkViewerCell, now, sleep, log}); never imports a stateful scene3d module; every wasm export is
// typeof-guarded and every wasm box freed. Waiting uses the injected clock.

import { FilmError } from "../core/errors.js";
import { LB_SIZE, hex32, isIndoorCell, localFromWorld } from "../core/units.js";

/** Longest admin command accepted (the plan schema's limit). */
export const WORLD_MAX_COMMAND_LENGTH = 200;
/** Admin verbs world.teleport / world.command refuse (logout, permanent DB writes, server control). */
export const WORLD_FORBIDDEN_VERBS = Object.freeze(["morph", "portalstorm", "rotate", "createinst", "shutdown", "stopnow", "ban", "unban", "boot", "gag", "ungag"]);
/** Readiness defaults (SPEC §3.4). */
export const WORLD_READY_DEFAULTS = Object.freeze({ settleSec: 3, timeoutSec: 90, pollMs: 500, sceneSettleMs: 1500, teleportGraceSec: 8 });
/** Prewarm defaults. */
export const WORLD_PREWARM_DEFAULTS = Object.freeze({ radius: 96, timeoutSec: 30, pollMs: 500, maxLandblocks: 49, populateConcurrency: 3 });
/** Inflight stream-guard key kinds that block readiness. */
export const WORLD_GUARD_KINDS = Object.freeze(["terrain", "statics", "buildings"]);
/** MotionStance NonCombat (ACE MotionCommand.cs) — the stance used when a rig reports none. */
export const NONCOMBAT_STANCE = 0x8000003d;

/**
 * Curated ACE MotionCommand values (ACE.Entity/Enum/MotionCommand.cs) for
 * `actor({motion})` by name; numbers / hex strings are accepted directly.
 * Class byte 0x40/0x41/0x43/0x44/0x45 = held (setMotion), 0x10/0x12/0x13 =
 * one-shot action (setSwingMotion).
 * @type {Readonly<Record<string, number>>}
 */
export const MOTION_COMMANDS = Object.freeze({
  Ready: 0x41000003, Crouch: 0x41000012, Sitting: 0x41000013, Sleeping: 0x41000014,
  Cheer: 0x1300004c, Beckon: 0x1300007a, BowDeep: 0x1300007d, ClapHands: 0x1300007e, Cry: 0x1300007f,
  Laugh: 0x13000080, Nod: 0x13000083, Point: 0x13000084, Shrug: 0x13000086, Wave: 0x13000087,
  Salute: 0x1300008a, ScratchHead: 0x1300008b, WaveHigh: 0x1300008e, WaveLow: 0x1300008f, Cringe: 0x13000091,
  Kneel: 0x13000092, Plead: 0x13000093, Shiver: 0x13000094, Shoo: 0x13000095, YMCA: 0x1200009b, Mock: 0x130000cb,
  WarmHands: 0x13000119,
  PrayState: 0x430000eb, BowDeepState: 0x430000ec, CrossArmsState: 0x430000ee, PointState: 0x430000f0,
  WaveState: 0x430000f1, AkimboState: 0x430000f2, SaluteState: 0x430000f3, LeanState: 0x430000f6,
  KneelState: 0x430000f7, SnowAngelState: 0x43000118, MeditateState: 0x4300011c, SitState: 0x4300013d,
  DrudgeDanceState: 0x43000144, AtEaseState: 0x43000149,
});

/** Case-insensitive name → value index of MOTION_COMMANDS. */
const MOTION_BY_LOWER = new Map(Object.entries(MOTION_COMMANDS).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * Validate an ACE admin command for sendChat. Returns the trimmed command or
 * throws FilmError `FILM_BAD_COMMAND` with a readable reason.
 * @param {*} cmd
 * @returns {string}
 */
export function validateAdminCommand(cmd) {
  if (typeof cmd !== "string") throw new FilmError(`admin command must be a string (got ${typeof cmd})`, "FILM_BAD_COMMAND");
  const c = cmd.trim();
  if (!c.startsWith("@")) {
    throw new FilmError(`admin command must start with '@' (a '/' or plain line is SPOKEN aloud by ACE): ${JSON.stringify(cmd)}`, "FILM_BAD_COMMAND");
  }
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(c)) throw new FilmError("admin command must be a single line without control characters", "FILM_BAD_COMMAND");
  if (c.length > WORLD_MAX_COMMAND_LENGTH) throw new FilmError(`admin command is ${c.length} characters (max ${WORLD_MAX_COMMAND_LENGTH})`, "FILM_BAD_COMMAND");
  const parts = c.slice(1).split(/\s+/).filter(Boolean);
  const verb = (parts[0] || "").toLowerCase();
  if (!verb) throw new FilmError("admin command has no verb", "FILM_BAD_COMMAND");
  if (WORLD_FORBIDDEN_VERBS.includes(verb)) throw new FilmError(`admin verb @${verb} is refused by film mode (logout / permanent world edit / server control)`, "FILM_BAD_COMMAND");
  if (verb === "nudge" && parts.length > 1) {
    throw new FilmError("@nudge with arguments edits a landblock instance in the world database; film mode only allows the bare @nudge cell fix", "FILM_BAD_COMMAND");
  }
  return c;
}

/**
 * Landblock keys whose square comes within `radius` of any point (AC world
 * metres), sorted ascending. Points may be `[x,y,z]` or `{x,y,z}`; non-finite
 * points are skipped.
 * @param {Array} points
 * @param {number} radius metres (≥ 0)
 * @returns {number[]}
 */
export function landblocksAround(points, radius) {
  const r = Number.isFinite(radius) && radius > 0 ? radius : 0;
  const out = new Set();
  for (const p of Array.isArray(points) ? points : []) {
    const v = p && typeof p === "object" ? [p[0] ?? p.x, p[1] ?? p.y] : null;
    if (!v || !Number.isFinite(v[0]) || !Number.isFinite(v[1])) continue;
    const x0 = Math.max(0, Math.floor((v[0] - r) / LB_SIZE)), x1 = Math.min(255, Math.floor((v[0] + r) / LB_SIZE));
    const y0 = Math.max(0, Math.floor((v[1] - r) / LB_SIZE)), y1 = Math.min(255, Math.floor((v[1] + r) / LB_SIZE));
    for (let x = x0; x <= x1; x += 1) {
      for (let y = y0; y <= y1; y += 1) {
        // Nearest point of the landblock square to the centre.
        const nx = Math.min(Math.max(v[0], x * LB_SIZE), (x + 1) * LB_SIZE);
        const ny = Math.min(Math.max(v[1], y * LB_SIZE), (y + 1) * LB_SIZE);
        if (Math.hypot(v[0] - nx, v[1] - ny) <= r) out.add(((x << 24) | (y << 16)) >>> 0);
      }
    }
  }
  return [...out].sort((a, b) => a - b);
}

/** Uint32 landblock key of an id / hex string; null when invalid. */
function lbKey(id) {
  let n = null;
  if (typeof id === "number" && Number.isInteger(id) && id >= -2147483648 && id < 4294967296) n = id >>> 0;
  else if (typeof id === "string" && /^\s*(?:0x)?[0-9a-fA-F]{1,8}\s*$/.test(id)) n = parseInt(id.trim().replace(/^0x/i, ""), 16) >>> 0;
  return n === null ? null : (n & 0xffff0000) >>> 0;
}

/** free() a wasm box, swallowing double-free errors. */
function freeBox(b) {
  if (b && typeof b === "object" && typeof b.free === "function") {
    try {
      b.free();
    } catch (_) {
      /* already released */
    }
  }
}

/** Wrap an angle into (−π, π]. */
function wrapPi(a) {
  let x = a % (2 * Math.PI);
  if (x <= -Math.PI) x += 2 * Math.PI;
  else if (x > Math.PI) x -= 2 * Math.PI;
  return x === 0 ? 0 : x;
}

/**
 * Create the world controller.
 *
 * - `teleport(cmd)` → `{ok, cmd, viewerParked?}` | `{ok:false, error}` — sends an '@' command
 *   (validateAdminCommand) and arms the teleport check of the next ready(); with the
 *   `parkViewerCell` dep (camera_owner.parkCell) it then parks the film viewer cell, so
 *   cells.js follows the player-head walk while the next site loads (`viewerParked`:
 *   a cell was dropped).
 * - `command(cmd)` → same validation and send, without arming the teleport check.
 * - `ready({lbKeys, interiorLb, settleSec=3, timeoutSec=90, pollMs=500,
 *   sceneSettleMs=1500, teleportGraceSec=8, requireTerrainIndoors=false})` →
 *   `Promise<{ok, checks, waitedMs, timedOut}>`.
 * - `prewarm({points, radius=96, lbKeys, interiorLb, timeoutSec=30, pollMs=500,
 *   envCells=true, collision=true, corridor=true, maxLandblocks=49})` →
 *   `Promise<{ok, lbKeys, baked, missing, populated, corridor, waitedMs, timedOut}>`.
 * - `avatar(visible)` → `{ok, guid, visible, method}`.
 * - `actor(cue)` → `Promise<{ok, parts}>`; cue `{emote?:'/wave', motion?:name|number,
 *   face?:compass radians, moveTo?:[x,y,z] world metres, run?=true, timeoutSec?=30}`.
 * - `checkReady(opts)` → the instantaneous checks (no waiting) — diagnostics.
 * - `stats()`.
 *
 * @param {{liveScene3d?:object|null, sessionHandle?:object|null, window?:object|null,
 *   worldQuery?:object|null, corridor?:object|null, wasmExports?:object|null,
 *   parkViewerCell?:()=>boolean,
 *   now?:()=>number, sleep?:(ms:number)=>Promise<void>, log?:(entry:object)=>void}} deps
 * @returns {object}
 */
export function createWorld(deps = {}) {
  const d = deps && typeof deps === "object" ? deps : {};
  const win = d.window !== undefined ? d.window : (typeof window !== "undefined" ? window : null);
  const liveOf = () => {
    if (d.liveScene3d && typeof d.liveScene3d === "object") return d.liveScene3d;
    const l = win && win.liveScene3d;
    return l && typeof l === "object" ? l : null;
  };
  const sh = () => {
    const live = liveOf();
    const h = d.sessionHandle ?? (live ? live.sessionHandle : null) ?? (win ? win.__sessionHandle : null) ?? null;
    return h && (typeof h === "object" || typeof h === "function") ? h : null;
  };
  const wasm = () => {
    const live = liveOf();
    const w = d.wasmExports ?? (live ? live.wasmExports : null) ?? null;
    return w && (typeof w === "object" || typeof w === "function") ? w : null;
  };
  const corridorOf = () => {
    const c = d.corridor ?? (d.worldQuery && d.worldQuery.corridor) ?? null;
    return c && typeof c.ensure === "function" ? c : null;
  };
  const nowMs = typeof d.now === "function"
    ? d.now
    : () => {
      const perf = (win && win.performance) || (typeof performance !== "undefined" ? performance : null);
      return perf && typeof perf.now === "function" ? perf.now() : 0;
    };
  const sleep = typeof d.sleep === "function"
    ? d.sleep
    : (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const emitLog = (entry) => {
    if (typeof d.log !== "function") return;
    try {
      d.log({ event: "film-world", ...entry });
    } catch (_) {
      /* never break world control on a logger */
    }
  };
  const parkViewer = typeof d.parkViewerCell === "function" ? d.parkViewerCell : null;

  /** Pending teleport {cmd, atMs, entered, unsub, fromCell}. */
  let pending = null;
  /** Landblocks this controller populated collision for. */
  const populated = new Set();
  const counters = { teleports: 0, commands: 0, readyCalls: 0, prewarms: 0, loaderCalls: 0, populateCalls: 0, actorCues: 0 };

  // ---- player ---------------------------------------------------------------

  /** Local player {cell, pos, lbKey} (wasm pose copied + freed), or null. */
  function playerPose() {
    const h = sh();
    if (!h || typeof h.getLocalPlayerPose !== "function") return null;
    let p = null;
    try {
      p = h.getLocalPlayerPose();
      if (!p) return null;
      const cell = p.landblockId >>> 0;
      const x = ((cell >>> 24) & 0xff) * LB_SIZE + p.x;
      const y = ((cell >>> 16) & 0xff) * LB_SIZE + p.y;
      if (![x, y, p.z].every(Number.isFinite)) return null;
      return { cell, lbKey: (cell & 0xffff0000) >>> 0, pos: [x, y, +p.z], local: [+p.x, +p.y, +p.z] };
    } catch (_) {
      return null;
    } finally {
      freeBox(p);
    }
  }

  /** The local player's guid, or 0. */
  function localGuid() {
    try {
      if (win && typeof win.getLocalPlayerGuid === "function") {
        const g = win.getLocalPlayerGuid();
        if (Number.isFinite(g) && g !== 0) return g >>> 0;
      }
    } catch (_) {
      /* fall through */
    }
    const h = sh();
    try {
      if (h && typeof h.playerGuid === "function") {
        const g = h.playerGuid();
        if (Number.isFinite(g) && g !== 0) return g >>> 0;
      }
    } catch (_) {
      /* unknown */
    }
    return 0;
  }

  // ---- commands -----------------------------------------------------------

  function send(cmd) {
    const c = validateAdminCommand(cmd);
    const h = sh();
    if (!h || typeof h.sendChat !== "function") throw new FilmError("sessionHandle.sendChat unavailable", "FILM_NO_SESSION");
    if (typeof h.isPlayerReady === "function") {
      let ready = true;
      try {
        ready = h.isPlayerReady() !== false;
      } catch (_) {
        ready = true;
      }
      if (!ready) throw new FilmError("the player is not in the world yet (ACE drops chat sent before EnteredWorld)", "FILM_NOT_IN_WORLD");
    }
    h.sendChat(c);
    return c;
  }

  function teleport(cmd) {
    try {
      const fromCell = playerPose()?.cell ?? 0;
      const c = send(cmd);
      counters.teleports += 1;
      if (pending && pending.unsub) pending.unsub();
      pending = { cmd: c, atMs: nowMs(), entered: false, unsub: null, fromCell };
      const ev = win && win.__pluginClient && win.__pluginClient.events;
      if (ev && typeof ev.on === "function" && typeof ev.off === "function") {
        const p = pending;
        const handler = () => {
          p.entered = true;
        };
        try {
          ev.on("portalSpaceEntered", handler);
          p.unsub = () => {
            try {
              ev.off("portalSpaceEntered", handler);
            } catch (_) {
              /* bus gone */
            }
          };
        } catch (_) {
          p.unsub = null;
        }
      }
      emitLog({ message: "teleport", cmd: c });
      const out = { ok: true, cmd: c };
      if (parkViewer) out.viewerParked = parkViewerCell();
      return out;
    } catch (e) {
      return { ok: false, error: errJson(e) };
    }
  }

  /**
   * After a sent teleport: park the film viewer cell (the injected
   * `parkViewerCell`), so the player-head walk — not the previous site's
   * cell — drives the viewer cell while the next site loads. Never fails the teleport.
   */
  function parkViewerCell() {
    try {
      return parkViewer() === true;
    } catch (e) {
      emitLog({ level: "warn", message: `parkViewerCell threw: ${e && e.message ? e.message : e}` });
      return false;
    }
  }

  function command(cmd) {
    try {
      const c = send(cmd);
      counters.commands += 1;
      emitLog({ message: "command", cmd: c });
      return { ok: true, cmd: c };
    } catch (e) {
      return { ok: false, error: errJson(e) };
    }
  }

  // ---- readiness ------------------------------------------------------------

  function portalActive() {
    try {
      const f = win && typeof win.__isPortalSpaceActive === "function" ? win.__isPortalSpaceActive : (typeof globalThis.__isPortalSpaceActive === "function" ? globalThis.__isPortalSpaceActive : null);
      if (f) return { known: true, active: f() === true };
    } catch (_) {
      /* unknown */
    }
    return { known: false, active: false };
  }

  /** Normalised target landblocks + interior lb for a ready/prewarm call. */
  function targets(o) {
    const lbs = [];
    const add = (k) => {
      const v = lbKey(k);
      if (v !== null && !lbs.includes(v)) lbs.push(v);
    };
    if (o.lbKeys && typeof o.lbKeys === "object" && typeof o.lbKeys[Symbol.iterator] === "function") for (const k of o.lbKeys) add(k);
    const interior = o.interiorLb === undefined || o.interiorLb === null ? null : lbKey(o.interiorLb);
    if (lbs.length === 0 && interior === null && o.lbKeys === undefined) {
      const p = playerPose();
      if (p) {
        if (isIndoorCell(p.cell)) return { lbs: [], interior: p.lbKey, fromPlayer: true };
        lbs.push(p.lbKey);
      }
    }
    return { lbs, interior, fromPlayer: false };
  }

  /** True when a terrain mesh for lb is attached to terrainGroup. */
  function terrainAttached(live, lb) {
    const g = live.terrainGroup;
    if (!g || !Array.isArray(g.children)) return null;
    const x = (lb >>> 24) & 0xff, y = (lb >>> 16) & 0xff;
    for (const c of g.children) {
      const ud = c && c.userData;
      if (ud && typeof ud.subdivLevel === "number" && ud.lbX === x && ud.lbY === y) return true;
    }
    return false;
  }

  function isParked(live, lb) {
    const lru = live.landblockLru;
    if (!lru || typeof lru.isParked !== "function") return false;
    try {
      return lru.isParked(lb) === true;
    } catch (_) {
      return false;
    }
  }

  /** The instantaneous §3.4 checks (no settle). */
  function checkReady(opts = {}) {
    const o = opts && typeof opts === "object" ? opts : {};
    const live = liveOf();
    const { lbs, interior, fromPlayer } = targets(o);
    const checks = {};
    // Teleport happened?
    if (pending) {
      const ps = win && win.__portalSpace;
      const start = ps && ps.t && Number.isFinite(ps.t.start) ? ps.t.start : 0;
      const pa = portalActive();
      if (pa.active || (start > 0 && start >= pending.atMs)) pending.entered = true;
      const graceMs = (Number.isFinite(o.teleportGraceSec) ? o.teleportGraceSec : WORLD_READY_DEFAULTS.teleportGraceSec) * 1000;
      const age = nowMs() - pending.atMs;
      const ok = pending.entered || age >= graceMs;
      checks.teleport = { ok, cmd: pending.cmd, entered: pending.entered, ageMs: Math.round(age) };
      if (!pending.entered && ok) checks.teleport.note = `no portal entry seen within ${graceMs / 1000} s (portalSpace=off, a same-place teleport, or the command failed)`;
    } else {
      checks.teleport = { ok: true, pending: false };
    }
    // Portal space.
    const pa = portalActive();
    checks.portalSpace = { ok: !pa.active, active: pa.active, known: pa.known };
    if (!live) {
      checks.scene = { ok: false, error: "liveScene3d unavailable" };
      return { ok: false, checks, lbs, interior };
    }
    // Terrain for the target landblocks (interior landblocks skip it unless asked).
    const terrainLbs = lbs.filter((lb) => o.requireTerrainIndoors === true || lb !== interior);
    const baked = live.terrainBakedLbs instanceof Set ? live.terrainBakedLbs : null;
    const missing = [], unattached = [], parked = [];
    for (const lb of terrainLbs) {
      if (!baked || !baked.has(lb)) missing.push(hex32(lb));
      else if (terrainAttached(live, lb) === false) unattached.push(hex32(lb));
      if (isParked(live, lb)) parked.push(hex32(lb));
    }
    checks.terrain = { ok: missing.length === 0 && unattached.length === 0 && parked.length === 0, lbKeys: terrainLbs.map(hex32), missing, unattached, parked };
    if (fromPlayer) checks.terrain.note = "no lbKeys given: the player's landblock";
    if (terrainLbs.length < lbs.length) checks.terrain.skipped = lbs.filter((lb) => !terrainLbs.includes(lb)).map(hex32);
    // Stream guard in flight.
    const inflight = live._streamGuardState && live._streamGuardState.inFlight;
    const keys = [];
    if (inflight && typeof inflight[Symbol.iterator] === "function") {
      for (const k of inflight) {
        const s = String(k);
        if (WORLD_GUARD_KINDS.some((kind) => s.startsWith(`${kind}:`))) keys.push(s);
      }
    }
    checks.streamInFlight = { ok: keys.length === 0, keys };
    // PVS sweep.
    const inc = live._pvsSweepIncomplete;
    checks.pvsSweep = { ok: inc !== true, incomplete: inc === true, known: typeof inc === "boolean" };
    // Interior.
    if (interior !== null) {
      const loaded = live.envCellLoadedLbs instanceof Set ? live.envCellLoadedLbs.has(interior) : false;
      const pendingBuild = win ? win.__interiorBuildPending === true : false;
      checks.interior = { ok: loaded && !pendingBuild, lb: hex32(interior), envCellsLoaded: loaded, interiorBuildPending: pendingBuild };
    } else {
      checks.interior = { ok: true, skipped: "no interior landblock" };
    }
    // Player position resolved.
    const h = sh();
    if (h && typeof h.getLocalPlayerPoseCellResolved === "function") {
      let r = true;
      try {
        r = h.getLocalPlayerPoseCellResolved() !== false;
      } catch (_) {
        r = true;
      }
      checks.player = { ok: r, resolved: r };
    } else {
      checks.player = { ok: true, skipped: "getLocalPlayerPoseCellResolved unavailable" };
    }
    const ok = Object.values(checks).every((c) => c.ok === true);
    return { ok, checks, lbs, interior };
  }

  /** Scene settle signature. */
  function signature(live) {
    if (!live) return "none";
    const t = live.terrainBakedLbs instanceof Set ? live.terrainBakedLbs.size : -1;
    const s = live.staticsGroup && Array.isArray(live.staticsGroup.children) ? live.staticsGroup.children.length : -1;
    const c = live.cellContainers3d && typeof live.cellContainers3d.size === "number" ? live.cellContainers3d.size : -1;
    return `${t}|${s}|${c}`;
  }

  async function ready(opts = {}) {
    counters.readyCalls += 1;
    const o = opts && typeof opts === "object" ? opts : {};
    const settleSec = Number.isFinite(o.settleSec) && o.settleSec >= 0 ? o.settleSec : WORLD_READY_DEFAULTS.settleSec;
    const timeoutSec = Number.isFinite(o.timeoutSec) && o.timeoutSec > 0 ? o.timeoutSec : WORLD_READY_DEFAULTS.timeoutSec;
    const pollMs = Number.isFinite(o.pollMs) && o.pollMs > 0 ? o.pollMs : WORLD_READY_DEFAULTS.pollMs;
    const settleMs = Number.isFinite(o.sceneSettleMs) && o.sceneSettleMs >= 0 ? o.sceneSettleMs : WORLD_READY_DEFAULTS.sceneSettleMs;
    const t0 = nowMs();
    const deadline = t0 + timeoutSec * 1000;
    let sig = null;
    let stableSince = null;
    let last = null;
    for (;;) {
      const r = checkReady(o);
      const now = nowMs();
      const s = signature(liveOf());
      if (s !== sig) {
        sig = s;
        stableSince = now;
      }
      const stableMs = now - stableSince;
      r.checks.settle = { ok: stableMs >= settleMs, stableMs: Math.round(stableMs), needMs: settleMs, signature: s };
      last = r;
      if (r.ok && r.checks.settle.ok) {
        // Final settleSec, capped by the deadline, then re-check everything.
        const wait = Math.min(settleSec * 1000, Math.max(0, deadline - nowMs()));
        if (wait > 0) await sleep(wait);
        const fin = checkReady(o);
        const s2 = signature(liveOf());
        fin.checks.settle = { ok: s2 === sig, stableMs: Math.round(nowMs() - stableSince), needMs: settleMs, signature: s2 };
        fin.checks.settleSec = { ok: true, waitedSec: wait / 1000, requestedSec: settleSec };
        if (fin.ok && fin.checks.settle.ok) {
          if (pending && pending.unsub) pending.unsub();
          pending = null;
          const waitedMs = Math.round(nowMs() - t0);
          emitLog({ message: "ready", waitedMs });
          return { ok: true, checks: fin.checks, waitedMs, timedOut: false };
        }
        last = fin;
        if (s2 !== sig) {
          sig = s2;
          stableSince = nowMs();
        }
      }
      if (nowMs() >= deadline) break;
      await sleep(Math.min(pollMs, Math.max(1, deadline - nowMs())));
    }
    const waitedMs = Math.round(nowMs() - t0);
    emitLog({ level: "warn", message: "ready timed out", waitedMs });
    return { ok: false, checks: last ? last.checks : {}, waitedMs, timedOut: true };
  }

  // ---- prewarm --------------------------------------------------------------

  /** Populate collision for landblocks (bounded concurrency); returns {count, failed}. */
  async function populate(lbs, concurrency) {
    const w = wasm();
    const fns = ["populateBuildingAabbsForLandblock", "populateStaticsAabbsForLandblock", "populateSceneryCollidersForLandblock"]
      .filter((n) => w && typeof w[n] === "function");
    const out = { landblocks: [], failed: [], skipped: [] };
    if (fns.length === 0) {
      out.note = "no populate*ForLandblock exports";
      return out;
    }
    const player = playerPose();
    const ring = new Set();
    if (player && !isIndoorCell(player.cell)) {
      const px = (player.lbKey >>> 24) & 0xff, py = (player.lbKey >>> 16) & 0xff;
      for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
        const x = px + dx, y = py + dy;
        if (x >= 0 && x <= 255 && y >= 0 && y <= 255) ring.add(((x << 24) | (y << 16)) >>> 0);
      }
    }
    const todo = [];
    for (const lb of lbs) {
      if (populated.has(lb)) continue;
      if (ring.has(lb)) {
        out.skipped.push(hex32(lb));
        continue;
      }
      todo.push(lb);
    }
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const lb = todo[next++];
        populated.add(lb);
        let failed = false;
        for (const n of fns) {
          try {
            counters.populateCalls += 1;
            await w[n](lb >>> 0);
          } catch (_) {
            failed = true;
          }
        }
        if (failed) out.failed.push(hex32(lb));
        out.landblocks.push(hex32(lb));
      }
    };
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, todo.length)) }, worker));
    return out;
  }

  /** Fire a loader (sync or async), swallowing failures. */
  function fire(live, name, ...args) {
    const f = live[name];
    if (typeof f !== "function") return false;
    counters.loaderCalls += 1;
    try {
      const r = f.apply(live, args);
      if (r && typeof r.then === "function") r.then(null, () => {});
    } catch (_) {
      /* a loader that throws is refired next poll */
    }
    return true;
  }

  async function prewarm(opts = {}) {
    counters.prewarms += 1;
    const o = opts && typeof opts === "object" ? opts : {};
    const live = liveOf();
    const t0 = nowMs();
    const radius = Number.isFinite(o.radius) && o.radius >= 0 ? o.radius : WORLD_PREWARM_DEFAULTS.radius;
    const timeoutSec = Number.isFinite(o.timeoutSec) && o.timeoutSec >= 0 ? o.timeoutSec : WORLD_PREWARM_DEFAULTS.timeoutSec;
    const pollMs = Number.isFinite(o.pollMs) && o.pollMs > 0 ? o.pollMs : WORLD_PREWARM_DEFAULTS.pollMs;
    const maxLbs = Number.isInteger(o.maxLandblocks) && o.maxLandblocks > 0 ? o.maxLandblocks : WORLD_PREWARM_DEFAULTS.maxLandblocks;
    let lbs = landblocksAround(o.points, radius);
    if (Array.isArray(o.lbKeys)) for (const k of o.lbKeys) {
      const v = lbKey(k);
      if (v !== null && !lbs.includes(v)) lbs.push(v);
    }
    const interior = o.interiorLb === undefined || o.interiorLb === null ? null : lbKey(o.interiorLb);
    if (interior !== null && !lbs.includes(interior)) lbs.push(interior);
    let truncated = false;
    if (lbs.length > maxLbs) {
      lbs = lbs.slice(0, maxLbs);
      truncated = true;
    }
    const report = {
      ok: false, lbKeys: lbs.map(hex32), truncated,
      baked: { terrain: [], statics: [], buildings: [], envCells: [] },
      missing: { terrain: [], statics: [], buildings: [], envCells: [] },
      populated: null, corridor: null, skipped: [], waitedMs: 0, timedOut: false,
    };
    if (!live) {
      report.error = { code: "FILM_NO_SCENE", message: "liveScene3d unavailable" };
      return report;
    }
    if (lbs.length === 0) {
      report.ok = true;
      report.note = "no landblocks to prewarm";
      return report;
    }
    // Collision + corridor (async, in parallel with the loaders below).
    const popP = o.collision === false ? Promise.resolve(null) : populate(lbs, WORLD_PREWARM_DEFAULTS.populateConcurrency).catch(() => null);
    const cor = o.corridor === false ? null : corridorOf();
    const corP = cor ? Promise.resolve(cor.ensure(lbs)).catch((e) => ({ error: String(e && e.message ? e.message : e) })) : Promise.resolve(null);

    const sealed = !!live._sealedEvictLbKey;
    const outdoorKinds = sealed ? [] : ["terrain", "statics", "buildings"];
    if (sealed) report.skipped.push("terrain/statics/buildings: the player is in a sealed dungeon (outdoor streaming is held)");
    const wantEnv = o.envCells !== false;
    const sets = {
      terrain: live.terrainBakedLbs instanceof Set ? live.terrainBakedLbs : null,
      statics: live.staticsBakedLbs instanceof Set ? live.staticsBakedLbs : null,
      buildings: live.buildingsBakedLbs instanceof Set ? live.buildingsBakedLbs : null,
      envCells: live.envCellLoadedLbs instanceof Set ? live.envCellLoadedLbs : null,
    };
    const required = (kind) => {
      if (kind === "envCells") return interior !== null ? [interior] : [];
      if (!outdoorKinds.includes(kind) || !sets[kind]) return [];
      return lbs.filter((lb) => lb !== interior || o.requireTerrainIndoors === true);
    };
    const missingOf = (kind) => required(kind).filter((lb) => !sets[kind] || !sets[kind].has(lb));

    const fireAll = (first) => {
      // Terrain: greedy 3×3 ring cover of the missing landblocks.
      if (outdoorKinds.includes("terrain")) {
        const miss = first ? lbs.filter((lb) => lb !== interior) : missingOf("terrain");
        const covered = new Set();
        const ringBatch = typeof live._runTerrainRingBatch === "function";
        for (const lb of miss) {
          if (covered.has(lb)) continue;
          const cx = (lb >>> 24) & 0xff, cy = (lb >>> 16) & 0xff;
          if (!ringBatch) {
            // Per-landblock fallback (a build without the batched ring facade).
            if (!fire(live, "loadTerrainForLandblock", cx, cy)) break;
            covered.add(lb);
            continue;
          }
          fire(live, "_runTerrainRingBatch", cx, cy);
          for (let dx = -1; dx <= 1; dx += 1) for (let dy = -1; dy <= 1; dy += 1) {
            const x = cx + dx, y = cy + dy;
            if (x >= 0 && x <= 255 && y >= 0 && y <= 255) covered.add(((x << 24) | (y << 16)) >>> 0);
          }
        }
      }
      for (const [kind, loader] of [["statics", "loadStaticsForLandblock"], ["buildings", "loadBuildingsForLandblock"]]) {
        if (!outdoorKinds.includes(kind)) continue;
        const miss = first ? lbs.filter((lb) => lb !== interior) : missingOf(kind);
        for (const lb of miss) fire(live, loader, (lb >>> 24) & 0xff, (lb >>> 16) & 0xff);
      }
      if (wantEnv) {
        const miss = first ? lbs : missingOf("envCells");
        for (const lb of miss) fire(live, "loadEnvCellsForLandblock", lb >>> 0);
      }
    };

    fireAll(true);
    const deadline = t0 + timeoutSec * 1000;
    const kinds = ["terrain", "statics", "buildings", "envCells"];
    for (;;) {
      const allBaked = kinds.every((k) => missingOf(k).length === 0);
      if (allBaked || nowMs() >= deadline) {
        report.timedOut = !allBaked;
        break;
      }
      await sleep(Math.min(pollMs, Math.max(1, deadline - nowMs())));
      if (kinds.every((k) => missingOf(k).length === 0)) continue;
      fireAll(false);
    }
    for (const k of kinds) {
      const req = required(k);
      report.baked[k] = req.filter((lb) => sets[k] && sets[k].has(lb)).map(hex32);
      report.missing[k] = req.filter((lb) => !sets[k] || !sets[k].has(lb)).map(hex32);
    }
    report.populated = await popP;
    report.corridor = await corP;
    report.waitedMs = Math.round(nowMs() - t0);
    report.ok = !report.timedOut;
    emitLog({ message: "prewarm", lbKeys: report.lbKeys, ok: report.ok, waitedMs: report.waitedMs });
    return report;
  }

  // ---- avatar ---------------------------------------------------------------

  function avatar(visible) {
    const show = visible !== false;
    const guid = localGuid();
    const live = liveOf();
    const em = live && live.entityManager;
    if (em && typeof em.setFilmHidden === "function" && guid !== 0) {
      let present = false;
      try {
        present = em.setFilmHidden(guid, !show) === true;
      } catch (e) {
        return { ok: false, error: errJson(e) };
      }
      return { ok: true, guid, visible: show, method: "filmHidden", rigPresent: present };
    }
    const cs = live && live.cameraSwitcher;
    if (cs && typeof cs._applyCameraPlayerFade === "function") {
      try {
        cs._applyCameraPlayerFade(show ? 1 : 0);
      } catch (e) {
        return { ok: false, error: errJson(e) };
      }
      return { ok: true, guid, visible: show, method: "opacity", note: "opacity fade only: the rig still casts a shadow" };
    }
    return { ok: false, error: { code: "FILM_NO_AVATAR_CONTROL", message: guid === 0 ? "local player guid unknown" : "no entityManager.setFilmHidden / camera fade" } };
  }

  // ---- actor ----------------------------------------------------------------

  /** Parse a motion name / number / hex string into a MotionCommand; null when unknown. */
  function motionValue(m) {
    if (typeof m === "number" && Number.isInteger(m) && m > 0) return m >>> 0;
    if (typeof m !== "string") return null;
    const s = m.trim();
    if (/^0x[0-9a-fA-F]{1,8}$/.test(s)) return parseInt(s.slice(2), 16) >>> 0;
    const v = MOTION_BY_LOWER.get(s.toLowerCase());
    return v === undefined ? null : v;
  }

  async function actor(cue) {
    counters.actorCues += 1;
    const c = cue && typeof cue === "object" ? cue : null;
    if (!c) return { ok: false, error: { code: "FILM_BAD_ARGUMENT", message: "actor cue must be an object" }, parts: {} };
    const parts = {};
    const h = sh();
    const live = liveOf();
    const guid = localGuid();

    if (c.face !== undefined && c.face !== null) {
      if (!Number.isFinite(c.face)) parts.face = { ok: false, error: "face must be compass radians" };
      else if (!h || typeof h.turnToHeading !== "function") parts.face = { ok: false, error: "sessionHandle.turnToHeading unavailable" };
      else {
        const yaw = wrapPi(-c.face);
        try {
          h.turnToHeading(yaw);
          parts.face = { ok: true, compass: c.face, yaw };
        } catch (e) {
          parts.face = { ok: false, error: String(e && e.message ? e.message : e) };
        }
      }
    }

    if (c.emote !== undefined && c.emote !== null) {
      const token = typeof c.emote === "string" ? c.emote.trim().replace(/^\//, "") : "";
      if (!/^[A-Za-z][A-Za-z0-9]*$/.test(token)) parts.emote = { ok: false, error: `emote must be a soul-emote token like "/wave" (got ${JSON.stringify(c.emote)})` };
      else if (!h || typeof h.resolveSoulEmote !== "function") parts.emote = { ok: false, error: "sessionHandle.resolveSoulEmote unavailable (refusing: an unresolved /x would be sent as an @x admin command)" };
      else if (!win || typeof win.__routeSlashCommand !== "function") parts.emote = { ok: false, error: "window.__routeSlashCommand unavailable" };
      else {
        let resolved = null;
        try {
          resolved = h.resolveSoulEmote(token);
        } catch (_) {
          resolved = null;
        }
        const known = !!resolved;
        freeBox(resolved);
        if (!known) parts.emote = { ok: false, error: `"/${token}" is not a soul emote in the DAT catalog` };
        else {
          try {
            const r = win.__routeSlashCommand(h, `/${token}`);
            const err = r && r.error ? String(r.error) : null;
            parts.emote = { ok: !!(r && r.dispatched !== false) && !err, token };
            if (err) parts.emote.error = err;
          } catch (e) {
            parts.emote = { ok: false, error: String(e && e.message ? e.message : e) };
          }
        }
      }
    }

    if (c.motion !== undefined && c.motion !== null) {
      const cmd = motionValue(c.motion);
      const em = live && live.entityManager;
      if (cmd === null) parts.motion = { ok: false, error: `unknown motion ${JSON.stringify(c.motion)} (a MotionCommand name like "SitState" or a number)` };
      else if (!em || guid === 0) parts.motion = { ok: false, error: "entityManager or local player guid unavailable" };
      else {
        const cls = (cmd >>> 24) & 0xff;
        const oneShot = cls === 0x10 || cls === 0x12 || cls === 0x13;
        try {
          let stance = 0;
          if (typeof em.getStance === "function") stance = em.getStance(guid) >>> 0;
          if (!stance) stance = NONCOMBAT_STANCE;
          if (oneShot && typeof em.setSwingMotion === "function") {
            await em.setSwingMotion(guid, cmd, {});
            parts.motion = { ok: true, command: hex32(cmd), kind: "one-shot" };
          } else if (typeof em.setMotion === "function") {
            await em.setMotion(guid, cmd, stance, Number.isFinite(c.speed) && c.speed > 0 ? c.speed : 1.0);
            parts.motion = { ok: true, command: hex32(cmd), kind: oneShot ? "one-shot" : "held", stance: hex32(stance) };
          } else {
            parts.motion = { ok: false, error: "entityManager.setMotion unavailable" };
          }
        } catch (e) {
          parts.motion = { ok: false, error: String(e && e.message ? e.message : e) };
        }
      }
    }

    if (c.moveTo !== undefined && c.moveTo !== null) {
      parts.moveTo = await moveTo(h, c);
    }

    if (c.at !== undefined) parts.at = { ok: true, note: "cue.at is scheduled by the take player; world.actor runs the cue now" };
    const ok = Object.values(parts).every((p) => p.ok === true);
    emitLog({ message: "actor", ok, parts: Object.keys(parts) });
    return { ok, parts };
  }

  async function moveTo(h, c) {
    const p = Array.isArray(c.moveTo) || (c.moveTo && typeof c.moveTo === "object")
      ? [c.moveTo[0] ?? c.moveTo.x, c.moveTo[1] ?? c.moveTo.y, c.moveTo[2] ?? c.moveTo.z]
      : null;
    if (!p || !p.every(Number.isFinite)) return { ok: false, error: "moveTo must be [x, y, z] world metres" };
    if (!h || typeof h.moveToPosition !== "function") return { ok: false, error: "sessionHandle.moveToPosition unavailable" };
    // Landblock + local coords: indoors from the player's own cell (dungeon cells sit
    // outside their landblock square), outdoors from the point.
    const player = playerPose();
    let cell, lx, ly;
    if (player && isIndoorCell(player.cell)) {
      cell = player.cell;
      lx = p[0] - ((cell >>> 24) & 0xff) * LB_SIZE;
      ly = p[1] - ((cell >>> 16) & 0xff) * LB_SIZE;
    } else {
      const l = localFromWorld(p[0], p[1], p[2]);
      cell = l.cellId;
      lx = l.lx;
      ly = l.ly;
    }
    const run = c.run !== false;
    try {
      if (typeof h.pursuitStatus === "function") h.pursuitStatus(); // clear a stale completion latch
      h.moveToPosition(cell >>> 0, lx, ly, p[2], run);
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
    if (typeof h.pursuitStatus !== "function") return { ok: true, cell: hex32(cell), note: "pursuitStatus unavailable: arrival not confirmed" };
    const timeoutMs = (Number.isFinite(c.timeoutSec) && c.timeoutSec > 0 ? c.timeoutSec : 30) * 1000;
    const t0 = nowMs();
    for (;;) {
      let s = 0;
      try {
        s = h.pursuitStatus() >>> 0;
      } catch (_) {
        s = 0;
      }
      const state = s & 0xffff;
      if (state === 2) return { ok: true, cell: hex32(cell), status: "arrived", waitedMs: Math.round(nowMs() - t0) };
      if (state === 3) return { ok: false, cell: hex32(cell), status: "failed", weenieError: (s >>> 16) & 0xffff, waitedMs: Math.round(nowMs() - t0) };
      if (nowMs() - t0 >= timeoutMs) return { ok: false, cell: hex32(cell), status: state === 1 ? "active" : "idle", error: "moveTo timed out", waitedMs: Math.round(nowMs() - t0) };
      await sleep(100);
    }
  }

  return {
    teleport,
    command,
    ready,
    checkReady: (opts) => {
      const r = checkReady(opts);
      return { ok: r.ok, checks: r.checks };
    },
    prewarm,
    avatar,
    actor,
    stats: () => ({ ...counters, pendingTeleport: pending ? pending.cmd : null, populatedLandblocks: populated.size }),
  };
}

/** JSON-safe error. */
function errJson(e) {
  if (e instanceof FilmError) return e.toJSON();
  return { name: (e && e.name) || "Error", code: "INTERNAL_ERROR", message: String(e && e.message ? e.message : e) };
}
