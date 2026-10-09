// scene3d/tex_upgrade_queue.js — `?texUpgradeQueue` (2026-10-09): progressive HD
// textures. ONE admission queue in front of every full-tier texture download.
//
// WHY. Entering the Town Network asked for 151 `tex-xu7` records (200 MB, up to
// ~4 MB each) and 290 texchan sidecars (98 MB) for a dungeon whose own DAT
// records are ~1 MB. `?interiorHold` made them wait for the walls, and then
// they all went at once: ~25 s of contention on the 1070's link, about a
// minute at 50 Mbit/s, never at 666 kbit/s. Nothing said which surfaces the
// player could actually see.
//
// WHAT. Every full-tier albedo fetch (tex-xu7, then its tex-bc7 fallback and
// the CLIP twin), every tex-bc7-pre fetch and every texchan sidecar fetch has
// to pass `admit()` before it goes to the network. Callers RECEIVE the queue by
// injection (`Bc7RecordSource` via `qctx`, `SuiteAssetSource` via
// `opts.queue`); neither imports this module, so no module cycle appears, and
// a source built without a queue (every existing suite, the `=off` arm) runs
// today's code.
//
//   ORDER — a visibility index built from the scene graph (no hooks in
//   cells.js / statics.js): surfaces on meshes in the current render set,
//   nearest first, then the rest of the resident world, then surfaces with no
//   known holder. Bands (lower first):
//     0 nearFull     full/twin record, in view, within `?texUpgradeFullM` (32 m)
//     1 nearTexchan  texchan sidecar, in view, within D_full
//     2 farPre       tex-bc7-pre, in view, BEYOND D_full (one slot at most)
//     3 aged         no holder ever, enqueued after the latest resume, waited 20 s
//     4 fifo         the index is unavailable (no liveScene3d / camera)
//     ---- background (`?texUpgradeBgShare`; 0 = never) ----
//     5 far          full/twin/texchan in view beyond D_full
//     6 resident     full/twin/texchan on a resident holder not in view
//     7 unknown      no holder found yet (never seen)
//     ---- never dispatched ----
//     8 held         pre for a surface inside D_full or not in view (the pre
//                    record IS retail resolution: it adds nothing over the
//                    RGBA8 albedo there and is cancelled when the full record
//                    dispatches)
//     9 parked       held only by hidden groups (sealed dungeon: the outdoor
//                    statics), or seen once and now orphaned
//
//   PACE — an in-flight cap everywhere (HTTP/1.1: 3 in flight, at most 2 "big"
//   (estimate >= 512 KB); h2/h3: 6/4; a link under 1 MB/s: 1) plus at most one
//   pre in flight, and texture-worker back-pressure (no new full dispatch
//   while more than 8 transcodes are queued). A token bucket (0.8 x link while
//   a foreground job waits, bgShare x link otherwise) applies ONLY while the
//   player is indoors / sealed or within 30 s of an interior resume: outdoors
//   there is no interior to protect and the queue is work-conserving.
//
//   PAUSE — nothing is dispatched while `interiorBuildPending()` (the same
//   predicate and 3-minute ceiling `holdForInterior` uses; `?interiorHold=off`
//   disables it). Jobs already in flight continue. After a resume, dispatch
//   waits (<= 500 ms) for an index refresh that sees the new landblock's cells.
//
//   LIVENESS — a job is DROPPED only when no waiter is live AND the index finds
//   no holder for its RenderSurface. Liveness is evaluated in the async pump
//   only (never in `admit`/`addWaiter`), with a 2 s grace for asks made before
//   the material is installed (texchan). A dropped job resolves `null` and the
//   source resolves a DROPPED sentinel: no negative cache, no absent count.
//
// Ticket API (what `admit` resolves): `received(n)` — the bytes are in, the
// in-flight slot is free (call it BEFORE the transcode); `refetch(kind)` — the
// chain needs another network leg (xu7 absent, transcoder not up, transcode
// failed): frees the slot and re-admits at the head of the same band;
// `release()` — the chain is over (idempotent).
//
// DIAG (both arms; the singleton exists whenever the production MaterialCache
// does): `window.__texUpgradeQueue` — `stats()`, `log()`, `trackInView(on)`,
// `report({wallsEpochMs})`. No timers run unless jobs are queued or the
// tracker is armed.

import { flagIsOff, materialRsId, bc7Source, bc7HdLog } from "./bc7_textures.js";
import { interiorBuildPending, INTERIOR_HOLD_MAX_MS } from "./bandwidth_tier.js";
import { texWorkerStats, xu7Stats } from "./xu7_textures.js";
import { suiteHdLog } from "./suite_assets.js";

// --------------------------------------------------------------------------
// flags (not memoised: the ESM suites re-stub `window` per case)
// --------------------------------------------------------------------------

function _pageSearch(search) {
  if (search !== undefined) return search;
  try {
    return typeof window !== "undefined" && window.location ? window.location.search || "" : "";
  } catch (_) {
    return "";
  }
}

/** `?texUpgradeQueue` — DEFAULT ON; `off`/`0`/`false`/`no` restores the direct asks. */
export function texUpgradeQueueEnabled(search) {
  try {
    const v = new URLSearchParams(_pageSearch(search)).get("texUpgradeQueue");
    return !flagIsOff(v);
  } catch (_) {
    return true;
  }
}

export const TEXQ_DEFAULT_FULL_M = 32;
export const TEXQ_DEFAULT_BG_SHARE = 0.3;

/** `?texUpgradeFullM` — metres, default 32, clamped [0, 1000]; `0` (or
 *  `off`/`false`/`no`) = no threshold; garbage = the default. */
export function texUpgradeFullMeters(search) {
  try {
    const v = new URLSearchParams(_pageSearch(search)).get("texUpgradeFullM");
    if (v == null || v === "") return TEXQ_DEFAULT_FULL_M;
    if (flagIsOff(v)) return 0; // off/0/false/no: no distance threshold
    const n = Number(v);
    if (!Number.isFinite(n)) return TEXQ_DEFAULT_FULL_M;
    return Math.min(1000, Math.max(0, n));
  } catch (_) {
    return TEXQ_DEFAULT_FULL_M;
  }
}

/** `?texUpgradeBgShare` — background share of the link, default 0.3, clamped
 *  [0, 1]; `0` (or `off`/`false`/`no`) = NO background dispatch at all. */
export function texUpgradeBgShare(search) {
  try {
    const v = new URLSearchParams(_pageSearch(search)).get("texUpgradeBgShare");
    if (v == null || v === "") return TEXQ_DEFAULT_BG_SHARE;
    if (flagIsOff(v)) return 0; // off/0/false/no: no background dispatch
    const n = Number(v);
    if (!Number.isFinite(n)) return TEXQ_DEFAULT_BG_SHARE;
    return Math.min(1, Math.max(0, n));
  } catch (_) {
    return TEXQ_DEFAULT_BG_SHARE;
  }
}

// --------------------------------------------------------------------------
// constants
// --------------------------------------------------------------------------

const FG_SHARE = 0.8;
const BIG_BYTES = 512 * 1024;
const MIN_BUCKET_BYTES = 2 * 1024 * 1024;
const SLOW_LINK_BPS = 1024 * 1024;
const DEFAULT_LINK_BPS = 2 * 1024 * 1024;
const INDEX_MIN_MS = 250;
const INDEX_OUTDOOR_MS = 1000;
const IDLE_SWEEP_MS = 1000;
const PAUSE_POLL_MS = 250;
const RESUME_WAIT_MAX_MS = 500;
const RESUME_WAIT_POLL_MS = 50;
const RESUME_BUCKET_MS = 30000;
const AGE_MS = 20000;
const LIVE_GRACE_MS = 2000;
const VIEW_RADIUS_M = 96;
const WORKER_BACKPRESSURE_DEPTH = 8;
const OBS_WINDOW_MS = 20000;
const OBS_MIN_BYTES = 512 * 1024;
const OBS_MIN_BUSY_MS = 100;
const LOG_MAX = 4096;
const TRACK_MS = 250;
const TRACK_SNAP_MAX = 1200;
const SCAN_BUDGET = 300;
const RESCAN_MS = 2000;
const PROTO_REPROBE_MS = 5000;

export const TEXQ_BANDS = Object.freeze([
  "nearFull", "nearTexchan", "farPre", "aged", "fifo",
  "far", "resident", "unknown", "held", "parked",
]);
const B_NEAR_FULL = 0, B_NEAR_TEXCHAN = 1, B_FAR_PRE = 2, B_AGED = 3, B_FIFO = 4;
const B_FAR = 5, B_RESIDENT = 6, B_UNKNOWN = 7, B_HELD = 8, B_PARKED = 9;
const FG_MAX_BAND = B_FIFO;
const BG_MAX_BAND = B_UNKNOWN;

// cls: 0 in view, 1 resident (not in view), 3 hidden-only (parked). 2 = none.
const CLS_VIEW = 0, CLS_RESIDENT = 1, CLS_HIDDEN = 3;

const _perfNow = () =>
  typeof performance !== "undefined" && typeof performance.now === "function" ? performance.now() : Date.now();

/** Pre-fetch size guess from the retail albedo dims (no wasm export exposes the
 *  record size). Only drives "big" and the token charge; `received(n)`
 *  corrects the bucket with the real byte count. Full tier = 4x retail per
 *  axis (bc7_textures.js PAGE-RESAMPLE note), BC7 = 1 B/px, mips +1/3. */
export function texUpgradeEstimateBytes(net, w, h) {
  const px = w > 0 && h > 0 ? w * h : 256 * 256;
  switch (net) {
    case "pre": return Math.ceil(px * 1.34);
    case "xu7": return Math.ceil(px * 16 * 1.34 * 0.6);
    case "hbc7": return Math.ceil(px * 16 * 1.34);
    case "texchan": return px * 5;
    default: return px * 4;
  }
}

function _defaultLinkBps() {
  try {
    const t = typeof window !== "undefined" && typeof window.__bandwidthTier === "function" ? window.__bandwidthTier() : null;
    return t && t.bps > 0 ? { bps: t.bps, source: t.source || null } : { bps: null, source: t ? t.source || null : null };
  } catch (_) {
    return { bps: null, source: null };
  }
}

/** HTTP version of the game origin's shard/suite downloads, from resource
 *  timing: "h1" | "h2" | "h3", or null while no such entry exists. */
function _defaultProtocol() {
  try {
    if (typeof performance === "undefined" || typeof performance.getEntriesByType !== "function") return null;
    const all = performance.getEntriesByType("resource");
    for (let i = all.length - 1, n = 0; i >= 0 && n < 400; i -= 1, n += 1) {
      const e = all[i];
      const name = String(e && e.name);
      if (!(name.includes("/shards/") || name.includes("/suite/"))) continue;
      const p = String(e.nextHopProtocol || "").toLowerCase();
      if (!p) continue;
      return p.startsWith("h3") ? "h3" : p === "h2" ? "h2" : "h1";
    }
  } catch (_) {
    /* diag-grade input */
  }
  return null;
}

/** Transcodes queued behind the network: the texture worker's client queue
 *  plus the main-thread budgeted FIFO. */
function _defaultWorkerDepth() {
  let d = 0;
  try {
    const w = texWorkerStats();
    if (w && w.enabled) d += w.queueDepth | 0;
  } catch (_) { /* fail-soft */ }
  try {
    d += xu7Stats().queueDepth | 0;
  } catch (_) { /* fail-soft */ }
  return d;
}

/** Is the full-tier upgrade for `rs` still outstanding (queue wait + fetch +
 *  transcode + CLIP twin)? Works on both arms. */
function _defaultPendingProbe(rs) {
  try {
    const src = bc7Source();
    if (!src) return false;
    return typeof src.upgradePending === "function" ? src.upgradePending(rs) : src.pending(rs);
  } catch (_) {
    return false;
  }
}

// --------------------------------------------------------------------------
// visibility index — rsId → nearest holder, from the scene graph
// --------------------------------------------------------------------------

function _sig(node) {
  const ch = node && node.children;
  if (!ch) return 0;
  let n = ch.length;
  for (let i = 0; i < ch.length; i += 1) {
    const g = ch[i] && ch[i].children;
    if (g) n += g.length * 1024; // second level weighted so (1,3) != (3,1)
  }
  return n;
}

function _meshRs(o, out) {
  const m = o.material;
  if (Array.isArray(m)) {
    for (let i = 0; i < m.length; i += 1) {
      const r = materialRsId(m[i]);
      if (r && out.indexOf(r) < 0) out.push(r);
    }
  } else {
    const r = materialRsId(m);
    if (r) out.push(r);
  }
}

const _sphTmp = [0, 0, 0, 0];
/** World-space bounding sphere of one mesh into `_sphTmp`. */
function _meshSphere(o) {
  let sph = null;
  if ((o.isInstancedMesh || o.isBatchedMesh) && typeof o.computeBoundingSphere === "function") {
    try {
      if (!o.boundingSphere) o.computeBoundingSphere();
      sph = o.boundingSphere;
    } catch (_) { sph = null; }
  }
  if (!sph) {
    const g = o.geometry;
    if (g) {
      try {
        if (!g.boundingSphere && typeof g.computeBoundingSphere === "function") g.computeBoundingSphere();
      } catch (_) { /* no positions */ }
      sph = g.boundingSphere || null;
    }
  }
  const c = sph && sph.center;
  const x = c ? +c.x || 0 : 0, y = c ? +c.y || 0 : 0, z = c ? +c.z || 0 : 0;
  const r0 = sph && Number.isFinite(sph.radius) && sph.radius > 0 ? sph.radius : 0;
  const e = o.matrixWorld && o.matrixWorld.elements;
  if (!e) {
    _sphTmp[0] = x; _sphTmp[1] = y; _sphTmp[2] = z; _sphTmp[3] = r0;
    return _sphTmp;
  }
  _sphTmp[0] = e[0] * x + e[4] * y + e[8] * z + e[12];
  _sphTmp[1] = e[1] * x + e[5] * y + e[9] * z + e[13];
  _sphTmp[2] = e[2] * x + e[6] * y + e[10] * z + e[14];
  const s = Math.sqrt(Math.max(
    e[0] * e[0] + e[1] * e[1] + e[2] * e[2],
    e[4] * e[4] + e[5] * e[5] + e[6] * e[6],
    e[8] * e[8] + e[9] * e[9] + e[10] * e[10],
  ));
  _sphTmp[3] = r0 * (Number.isFinite(s) ? s : 1);
  return _sphTmp;
}

/** The camera frustum's four side planes [nx,ny,nz,d]x4 from projection x
 *  view (Gribb/Hartmann on three's column-major elements), or null. Near/far
 *  are left out on purpose: the 96 m radius replaces the far plane. */
function _sidePlanes(cam) {
  const P = cam && cam.projectionMatrix && cam.projectionMatrix.elements;
  const V = cam && cam.matrixWorldInverse && cam.matrixWorldInverse.elements;
  if (!P || !V) return null;
  const m = new Array(16);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      m[c * 4 + r] = P[r] * V[c * 4] + P[4 + r] * V[c * 4 + 1] + P[8 + r] * V[c * 4 + 2] + P[12 + r] * V[c * 4 + 3];
    }
  }
  const row = (r) => [m[r], m[4 + r], m[8 + r], m[12 + r]];
  const r0 = row(0), r1 = row(1), r3 = row(3);
  const planes = [];
  for (const [a, sgn] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1]]) {
    const p = [r3[0] + sgn * a[0], r3[1] + sgn * a[1], r3[2] + sgn * a[2], r3[3] + sgn * a[3]];
    const len = Math.hypot(p[0], p[1], p[2]);
    if (!(len > 0)) return null;
    planes.push([p[0] / len, p[1] / len, p[2] / len, p[3] / len]);
  }
  return planes;
}

function _inPlanes(planes, x, y, z, r) {
  if (!planes) return true;
  for (let i = 0; i < planes.length; i += 1) {
    const p = planes[i];
    if (p[0] * x + p[1] * y + p[2] * z + p[3] < -r) return false;
  }
  return true;
}

export class TexVisibilityIndex {
  constructor() {
    /** @type {WeakMap<object, object>} */
    this._cache = new WeakMap();
    /** rs -> { cls, dist } */
    this.map = new Map();
    this.available = false;
    /** false when this refresh ran out of scan budget (holders may be missing) */
    this.complete = false;
    this.indoor = false;
    this.visibleLbs = new Set();
    this.at = 0;
    this.st = {
      refreshes: 0, lastMs: 0, maxMs: 0, scans: 0, budgetHits: 0,
      cellsVisible: 0, cells: 0, nodes: 0, entities: 0, cls0: 0, cls1: 0, hidden: 0,
    };
  }

  /** Cached holder entry for `node`; rescans on a child-count change, while
   *  meshes still carry rs-less (fallback) materials, or (entities) every 2 s. */
  _entry(node, mode, now, budget) {
    const prev = this._cache.get(node);
    const sig = _sig(node);
    const stale = !prev || prev.sig !== sig
      || (prev.zeros > 0 && prev.rescans < 5 && now - prev.at >= RESCAN_MS)
      || (mode === "entity" && now - prev.at >= RESCAN_MS);
    if (!stale) return prev;
    if (budget.n <= 0) {
      this.st.budgetHits += 1;
      this.complete = false; // a holder may be missing from this refresh
      return prev || null;
    }
    budget.n -= 1;
    this.st.scans += 1;
    if (mode === "node") {
      try { if (typeof node.updateWorldMatrix === "function") node.updateWorldMatrix(true, true); } catch (_) { /* fail-soft */ }
    }
    const rs = [];
    const sph = [];
    let zeros = 0;
    const tmp = [];
    const stack = [node];
    while (stack.length) {
      const o = stack.pop();
      if (!o) continue;
      if (o.isMesh) {
        tmp.length = 0;
        _meshRs(o, tmp);
        if (tmp.length === 0) zeros += 1;
        else {
          const s = _meshSphere(o);
          for (const r of tmp) { rs.push(r); sph.push(s[0], s[1], s[2], s[3]); }
        }
      }
      const ch = o.children;
      if (ch && ch.length) for (let i = 0; i < ch.length; i += 1) stack.push(ch[i]);
    }
    const e = { sig, at: now, zeros, rescans: prev && prev.sig === sig ? prev.rescans + 1 : 0, rs: null, sph: null, agg: null };
    if (mode === "cell") {
      e.rs = Uint32Array.from(rs);
      e.sph = Float64Array.from(sph);
    } else {
      e.rs = Uint32Array.from(new Set(rs));
      e.agg = _aggSphere(sph);
      if (mode === "entity") {
        const m = node.matrixWorld && node.matrixWorld.elements;
        const ox = m ? m[12] : 0, oy = m ? m[13] : 0, oz = m ? m[14] : 0;
        let rr = 0;
        for (let i = 0; i < sph.length; i += 4) {
          rr = Math.max(rr, Math.hypot(sph[i] - ox, sph[i + 1] - oy, sph[i + 2] - oz) + sph[i + 3]);
        }
        e.relR = rr;
      }
    }
    this._cache.set(node, e);
    return e;
  }

  /**
   * Rebuild `map` from `s` (a `liveScene3d`-shaped object).
   * @param {object|null} s
   * @param {number} now epoch ms (rescan ages)
   * @param {{scanBudget?:number}} [o]
   */
  refresh(s, now, o = {}) {
    const t0 = _perfNow();
    const map = new Map();
    const lbs = new Set();
    this.st.refreshes += 1;
    this.complete = true;
    const cam = s ? (s.cameraSwitcher && s.cameraSwitcher.activeCamera) || s.camera : null;
    const ce = cam && cam.matrixWorld && cam.matrixWorld.elements;
    if (!s || !ce) {
      this.available = false;
      this.map = map;
      this.visibleLbs = lbs;
      this.at = now;
      this._finish(t0);
      return this;
    }
    this.available = true;
    const cx = ce[12], cy = ce[13], cz = ce[14];
    const planes = _sidePlanes(cam);
    const budget = { n: o.scanBudget != null ? o.scanBudget : SCAN_BUDGET };
    const put = (rs, cls, dist) => {
      const e = map.get(rs);
      if (!e) map.set(rs, { cls, dist });
      else if (cls < e.cls || (cls === e.cls && dist < e.dist)) { e.cls = cls; e.dist = dist; }
    };
    let indoor = false;
    try {
      indoor = !!s._sealedEvictLbKey || !!(s.sessionHandle && typeof s.sessionHandle.isCurrentCellIndoor === "function" && s.sessionHandle.isCurrentCellIndoor());
    } catch (_) { indoor = !!s._sealedEvictLbKey; }
    this.indoor = indoor;

    // 1) EnvCell containers. Visible (the render set the cell tick applied) =
    //    in view; built but hidden = resident. Visible ones scan unbudgeted.
    const reg = s.cellContainers3d;
    let cellsVisible = 0, cells = 0;
    if (reg && typeof reg.forEach === "function") {
      const cellsShown = !s.cellsGroup || s.cellsGroup.visible !== false;
      const unbudgeted = { n: Infinity };
      for (const pass of [0, 1]) {
        for (const [cid, c] of reg) {
          if (!c) continue;
          const vis = cellsShown && c.visible !== false;
          if ((pass === 0) !== vis) continue;
          cells += 1;
          const e = this._entry(c, "cell", now, vis ? unbudgeted : budget);
          if (vis) {
            cellsVisible += 1;
            lbs.add(((cid >>> 0) & 0xffff0000) >>> 0);
          }
          if (!e) continue;
          const cls = vis ? CLS_VIEW : CLS_RESIDENT;
          const rsA = e.rs, sp = e.sph;
          for (let i = 0; i < rsA.length; i += 1) {
            const k = i * 4;
            const d = Math.max(0, Math.hypot(sp[k] - cx, sp[k + 1] - cy, sp[k + 2] - cz) - sp[k + 3]);
            put(rsA[i], cls, d);
          }
        }
      }
    }

    // 2) Outdoor statics + buildings: top-level nodes. In view = within 96 m
    //    and in the frustum; a node in a HIDDEN group (sealed dungeon) is a
    //    hidden holder (parked), walked anyway so it is never "unknown".
    let nodes = 0;
    for (const g of [s.staticsGroup, s.buildingsGroup]) {
      if (!g || !g.children) continue;
      const shown = g.visible !== false;
      const ch = g.children;
      for (let i = 0; i < ch.length; i += 1) {
        const node = ch[i];
        if (!node) continue;
        const e = this._entry(node, "node", now, budget);
        if (!e || e.rs.length === 0) continue;
        nodes += 1;
        const a = e.agg;
        const d = Math.max(0, Math.hypot(a[0] - cx, a[1] - cy, a[2] - cz) - a[3]);
        let cls;
        if (!shown) cls = CLS_HIDDEN;
        else if (node.visible === false) cls = CLS_RESIDENT;
        else cls = d <= VIEW_RADIUS_M && _inPlanes(planes, a[0], a[1], a[2], a[3]) ? CLS_VIEW : CLS_RESIDENT;
        for (let j = 0; j < e.rs.length; j += 1) put(e.rs[j], cls, d);
      }
    }

    // 3) Entities: root within 96 m and drawn = in view.
    let ents = 0;
    const em = s.entityManager && s.entityManager.entityMap;
    if (em && typeof em.values === "function") {
      for (const inst of em.values()) {
        const root = inst && inst.root;
        if (!root) continue;
        const e = this._entry(root, "entity", now, budget);
        if (!e || e.rs.length === 0) continue;
        ents += 1;
        const m = root.matrixWorld && root.matrixWorld.elements;
        const px = m ? m[12] : 0, py = m ? m[13] : 0, pz = m ? m[14] : 0;
        const d = Math.max(0, Math.hypot(px - cx, py - cy, pz - cz) - (e.relR || 0));
        const drawn = root.visible !== false && root.parent !== null;
        const cls = drawn && d <= VIEW_RADIUS_M ? CLS_VIEW : CLS_RESIDENT;
        for (let j = 0; j < e.rs.length; j += 1) put(e.rs[j], cls, d);
      }
    }

    this.map = map;
    this.visibleLbs = lbs;
    this.at = now;
    let c0 = 0, c1 = 0, ch3 = 0;
    for (const v of map.values()) {
      if (v.cls === CLS_VIEW) c0 += 1;
      else if (v.cls === CLS_RESIDENT) c1 += 1;
      else ch3 += 1;
    }
    Object.assign(this.st, { cellsVisible, cells, nodes, entities: ents, cls0: c0, cls1: c1, hidden: ch3 });
    this._finish(t0);
    return this;
  }

  _finish(t0) {
    const ms = _perfNow() - t0;
    this.st.lastMs = +ms.toFixed(3);
    if (ms > this.st.maxMs) this.st.maxMs = +ms.toFixed(3);
  }
}

function _aggSphere(sph) {
  if (sph.length === 0) return [0, 0, 0, 0];
  let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
  for (let i = 0; i < sph.length; i += 4) {
    const r = sph[i + 3];
    x0 = Math.min(x0, sph[i] - r); x1 = Math.max(x1, sph[i] + r);
    y0 = Math.min(y0, sph[i + 1] - r); y1 = Math.max(y1, sph[i + 1] + r);
    z0 = Math.min(z0, sph[i + 2] - r); z1 = Math.max(z1, sph[i + 2] + r);
  }
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2, cz = (z0 + z1) / 2;
  let R = 0;
  for (let i = 0; i < sph.length; i += 4) {
    R = Math.max(R, Math.hypot(sph[i] - cx, sph[i + 1] - cy, sph[i + 2] - cz) + sph[i + 3]);
  }
  return [cx, cy, cz, R];
}

// --------------------------------------------------------------------------
// the queue
// --------------------------------------------------------------------------

class TexUpgradeTicket {
  constructor(q, job) {
    this._q = q;
    this._job = job;
    this._slot = true; // holds an in-flight slot
    this._post = false; // received, chain still running (transcode)
    this._done = false;
    this._recv = false;
  }
  get kind() { return this._job.kind; }
  get net() { return this._job.net; }
  get id() { return this._job.id; }
  /** The bytes are in: frees the in-flight slot (call BEFORE the transcode). */
  received(n) { this._q._onReceived(this, n); }
  /** Another network leg is needed: frees the slot, re-admits at the head of
   *  the same band. Resolves a new ticket, or null when the job is dropped. */
  refetch(net = "hbc7") { return this._q._refetch(this, net); }
  /** The chain is over (idempotent). */
  release() { this._q._onRelease(this); }
}

export class TexUpgradeQueue {
  /**
   * @param {object} [opts] every input is injectable for the node suites:
   *   now, schedule(fn,ms)->h, cancel(h), microtask(fn), sceneProvider(),
   *   linkBps() -> {bps, source} | number | null, protocol() -> "h1"|"h2"|"h3"|null,
   *   paused() -> bool, workerDepth() -> number, pendingProbe(rs) -> bool,
   *   indoor() -> bool (default: from the scene), fullM, bgShare, pauseMaxMs,
   *   search.
   */
  constructor(opts = {}) {
    this._opts = opts;
    this._now = opts.now || (() => Date.now());
    this._schedule = opts.schedule || ((fn, ms) => setTimeout(fn, ms));
    this._cancel = opts.cancel || ((h) => clearTimeout(h));
    this._microtask = opts.microtask || ((fn) => (typeof queueMicrotask === "function" ? queueMicrotask(fn) : Promise.resolve().then(fn)));
    this._sceneProvider = opts.sceneProvider || (() => {
      try { return typeof window !== "undefined" ? window.liveScene3d || null : null; } catch (_) { return null; }
    });
    this._linkBpsFn = opts.linkBps || _defaultLinkBps;
    this._protocolFn = opts.protocol || _defaultProtocol;
    this._pausedFn = opts.paused || (() => interiorBuildPending());
    this._workerDepthFn = opts.workerDepth || _defaultWorkerDepth;
    this._pendingProbe = opts.pendingProbe || _defaultPendingProbe;
    this._indoorFn = opts.indoor || null;
    this._fullM = opts.fullM != null ? opts.fullM : texUpgradeFullMeters(opts.search);
    this._bgShare = opts.bgShare != null ? opts.bgShare : texUpgradeBgShare(opts.search);
    this._pauseMaxMs = opts.pauseMaxMs != null ? opts.pauseMaxMs : INTERIOR_HOLD_MAX_MS;
    /** Set by the production MaterialCache when it routes through this queue
     *  (false on the `?texUpgradeQueue=off` arm, where only the diag runs). */
    this.armed = false;
    this._init();
  }

  _init() {
    this._seq = 0;
    /** key -> queued job (first job per key; addWaiter / pre-cancel lookups) */
    this._jobs = new Map();
    /** queued jobs, sorted lazily */
    this._order = [];
    this._orderDirty = false;
    this._fgQueued = 0;
    this._inflightAll = 0;
    this._inflightBig = 0;
    this._inflightPre = 0;
    this._postRecv = 0;
    /** rs -> count of full/twin/hbc7 legs dispatched and not yet released
     *  (on the wire OR transcoding) — pre cancellation */
    this._fullInflightRs = new Map();
    this._timer = null;
    this._timerDue = Infinity;
    this._microPending = false;
    this._pumping = false;
    this._idx = new TexVisibilityIndex();
    this._idxAt = -Infinity;
    this._idxEver = false;
    this._idxGen = 0;
    this._sweptGen = 0;
    // pause
    this._pauseSince = null;
    this._pauseExpired = false;
    this._pauseLbs = null;
    this._pauseMs = 0;
    this._resumes = [];
    this._lastResumeAt = null;
    this._resumeWait = null;
    // bucket
    this._tokens = MIN_BUCKET_BYTES;
    this._capacity = MIN_BUCKET_BYTES;
    this._rateNow = 0;
    this._bucketOn = false;
    this._lastRefill = null;
    this._rateLog = [];
    // link
    this._obs = [];
    this._link = { L: DEFAULT_LINK_BPS, tierBps: null, source: null, obsBps: null, at: -Infinity };
    this._proto = null;
    this._protoAt = -Infinity;
    this._maxRecord = 0;
    // diag
    this._log = [];
    this._st = {
      admitted: 0, joins: 0, dispatched: 0, received: 0, refetches: 0, dropped: 0,
      cancelledPre: 0, aged: 0, backpressureBlocks: 0, tokenBlocks: 0, resumeWaitHits: 0,
      resumeWaitTimeouts: 0, pauseEpisodes: 0, pauseCeilings: 0,
      dispatchedByKind: { full: 0, pre: 0, twin: 0, texchan: 0 },
      bytes: { pre: 0, xu7: 0, hbc7: 0, texchan: 0 },
    };
    // tracker
    this._tracking = false;
    this._trackTimer = null;
    this._track = new Map();
    this._trackSnaps = [];
    this._trackLastAt = null;
  }

  // ---- public API ---------------------------------------------------------

  /**
   * Ask for one network leg. Resolves a ticket, or null when the job is
   * dropped (no live waiter AND no holder) or cancelled (a pre whose full
   * record dispatched).
   * @param {"full"|"pre"|"twin"|"texchan"} kind
   * @param {number|string} id rsId (full/pre/twin) or texchan stem
   * @param {{did?:number, rs?:number, w?:number, h?:number, live?:()=>boolean}|null} [hint]
   * @param {{net?:string}} [o] network leg for the size estimate (default:
   *   xu7 for full, hbc7 for twin, pre, texchan)
   */
  admit(kind, id, hint, o) {
    const net = (o && o.net) || (kind === "full" ? "xu7" : kind === "twin" ? "hbc7" : kind);
    return new Promise((resolve) => {
      const job = this._makeJob(kind, net, id, hint, resolve, kind === "twin");
      this._st.admitted += 1;
      // A pre asked while its full record is on the wire or transcoding (a
      // second Surface DID on the same RenderSurface) adds nothing, and no
      // later full dispatch would cancel it: held, it would sit in `_order`
      // for the session (1 Hz wake + index walk forever). Cancel it now.
      if (kind === "pre" && (this._fullInflightRs.get(job.rs) | 0) > 0) {
        this._st.cancelledPre += 1;
        this._logJob(job, this._now(), "cancelled");
        job.state = "cancelled";
        resolve(null);
        return;
      }
      if (!this._jobs.has(job.key)) this._jobs.set(job.key, job);
      this._enqueue(job);
    });
  }

  /** A second ask joined an existing fetch: merge its waiter into the queued
   *  job (no-op once the job dispatched). Never evaluates liveness. */
  addWaiter(kind, id, hint) {
    const key = `${kind}:${kind === "texchan" ? id : id >>> 0}`;
    const j = this._jobs.get(key);
    if (!j || j.state !== "queued") return false;
    j.waiters.push(this._waiterOf(hint));
    this._st.joins += 1;
    return true;
  }

  /** Synchronous pump (tests). */
  pumpNow() { this._pump(); }

  // ---- jobs ----------------------------------------------------------------

  _waiterOf(hint) {
    return { did: hint && hint.did, live: hint && typeof hint.live === "function" ? hint.live : null, t0: this._now() };
  }

  _makeJob(kind, net, id, hint, resolve, head) {
    const rs = kind === "texchan" ? ((hint && hint.rs) >>> 0) : (id >>> 0);
    const w = hint && hint.w > 0 ? hint.w : 0;
    const h = hint && hint.h > 0 ? hint.h : 0;
    const est = texUpgradeEstimateBytes(net, w, h);
    const now = this._now();
    return {
      seq: ++this._seq,
      key: `${kind}:${kind === "texchan" ? id : id >>> 0}`,
      kind, net, id, rs, w, h, est, big: est >= BIG_BYTES, head: !!head,
      waiters: [this._waiterOf(hint)],
      enqAt: now, state: "queued", band: B_UNKNOWN, cls: 2, dist: Infinity,
      everHeld: false, agedAt: null, resolve, dispAt: null, recvAt: null, bytes: null, logRef: null,
    };
  }

  _enqueue(job) {
    this._classify(job, this._now());
    this._order.push(job);
    this._orderDirty = true;
    if (job.band <= FG_MAX_BAND) this._fgQueued += 1;
    this._kick();
  }

  _remove(job) {
    const i = this._order.indexOf(job);
    if (i >= 0) this._order.splice(i, 1);
    if (this._jobs.get(job.key) === job) this._jobs.delete(job.key);
    if (job.band <= FG_MAX_BAND && job.state === "queued") this._fgQueued = Math.max(0, this._fgQueued - 1);
  }

  _settleNull(job, why) {
    this._remove(job);
    job.state = why;
    try { job.resolve(null); } catch (_) { /* fail-soft */ }
  }

  _anyLive(job, now) {
    if (job.waiters.length === 0) return true;
    for (const w of job.waiters) {
      if (now - w.t0 < LIVE_GRACE_MS) return true;
      if (typeof w.live !== "function") return true;
      try { if (w.live()) return true; } catch (_) { return true; }
    }
    return false;
  }

  _classify(job, now) {
    const idx = this._idx;
    let band;
    let cls = 2;
    let dist = Infinity;
    if (!this._idxEver || !idx.available) {
      band = job.kind === "pre" ? B_HELD : B_FIFO;
    } else {
      const e = job.rs ? idx.map.get(job.rs) : undefined;
      if (e && e.cls <= CLS_RESIDENT) {
        job.everHeld = true;
        cls = e.cls;
        dist = e.dist;
        if (cls === CLS_VIEW) {
          const near = !(this._fullM > 0) || dist <= this._fullM;
          if (job.kind === "pre") band = near ? B_HELD : B_FAR_PRE;
          else if (job.kind === "texchan") band = near ? B_NEAR_TEXCHAN : B_FAR;
          else band = near ? B_NEAR_FULL : B_FAR;
        } else {
          band = job.kind === "pre" ? B_HELD : B_RESIDENT;
        }
      } else if (e) {
        job.everHeld = true;
        cls = CLS_HIDDEN;
        band = B_PARKED;
      } else if (job.everHeld) {
        cls = CLS_HIDDEN;
        band = B_PARKED;
      } else if (job.kind === "pre") {
        band = B_HELD;
      } else {
        const after = job.enqAt >= (this._lastResumeAt != null ? this._lastResumeAt : 0);
        if (job.agedAt == null && after && now - job.enqAt >= AGE_MS) {
          job.agedAt = now;
          this._st.aged += 1;
        }
        band = job.agedAt != null ? B_AGED : B_UNKNOWN;
      }
    }
    job.band = band;
    job.cls = cls;
    job.dist = dist;
  }

  _sortOrder() {
    this._order.sort((a, b) => {
      if (a.band !== b.band) return a.band - b.band;
      if (a.head !== b.head) return a.head ? -1 : 1;
      const fifo = a.band === B_UNKNOWN || a.band === B_AGED || a.band === B_FIFO;
      if (!fifo && a.dist !== b.dist) return a.dist - b.dist;
      if (a.enqAt !== b.enqAt) return a.enqAt - b.enqAt;
      return a.seq - b.seq;
    });
    this._orderDirty = false;
    let fg = 0;
    for (const j of this._order) if (j.band <= FG_MAX_BAND) fg += 1;
    this._fgQueued = fg;
  }

  // ---- scheduling ----------------------------------------------------------

  _kick() {
    if (this._microPending) return;
    this._microPending = true;
    this._microtask(() => {
      this._microPending = false;
      this._pump();
    });
  }

  _wake(ms) {
    const due = this._now() + ms;
    if (this._timer != null && this._timerDue <= due) return;
    if (this._timer != null) this._cancel(this._timer);
    this._timerDue = due;
    this._timer = this._schedule(() => {
      this._timer = null;
      this._timerDue = Infinity;
      this._pump();
    }, ms);
  }

  _clearWake() {
    if (this._timer != null) {
      try { this._cancel(this._timer); } catch (_) { /* fail-soft */ }
    }
    this._timer = null;
    this._timerDue = Infinity;
  }

  // ---- pause / resume ------------------------------------------------------

  _loadedLbs() {
    try {
      const s = this._sceneProvider();
      const L = s && s.envCellLoadedLbs;
      return L && typeof L.forEach === "function" ? new Set(L) : null;
    } catch (_) {
      return null;
    }
  }

  _updatePause(now) {
    let p = false;
    try { p = !!this._pausedFn(); } catch (_) { p = false; }
    if (p) {
      if (this._pauseSince == null) {
        this._pauseSince = now;
        this._pauseLbs = this._loadedLbs();
        this._st.pauseEpisodes += 1;
      }
      if (now - this._pauseSince >= this._pauseMaxMs) {
        if (!this._pauseExpired) this._st.pauseCeilings += 1;
        this._pauseExpired = true;
        return false; // the ceiling: a wedged build must not strand the queue
      }
      return true;
    }
    if (this._pauseSince != null) {
      const dur = now - this._pauseSince;
      this._pauseMs += dur;
      this._resumes.push({ at: now, pageMs: Math.round(_perfNow()), pausedMs: dur, ceiling: this._pauseExpired });
      if (this._resumes.length > 64) this._resumes.splice(0, this._resumes.length - 64);
      this._lastResumeAt = now;
      const now2 = this._loadedLbs();
      if (now2 && this._pauseLbs) {
        const fresh = new Set();
        for (const lb of now2) if (!this._pauseLbs.has(lb)) fresh.add(lb >>> 0);
        if (fresh.size > 0) this._resumeWait = { until: now + RESUME_WAIT_MAX_MS, lbs: fresh };
      }
      this._pauseSince = null;
      this._pauseExpired = false;
      this._pauseLbs = null;
    }
    return false;
  }

  // ---- index ---------------------------------------------------------------

  _refreshIndex(now) {
    let s = null;
    try { s = this._sceneProvider(); } catch (_) { s = null; }
    this._idx.refresh(s, now);
    this._idxAt = now;
    this._idxEver = true;
    this._idxGen += 1;
  }

  /** Reclassify + liveness-sweep once per index generation — whoever refreshed
   *  it (the pump, or the in-view tracker running at its own 4 Hz). */
  _sweepIfNew(now) {
    if (this._sweptGen === this._idxGen) return;
    this._sweptGen = this._idxGen;
    this._sweep(now);
  }

  _indoorNow() {
    if (this._indoorFn) {
      try { return !!this._indoorFn(); } catch (_) { return false; }
    }
    return !!this._idx.indoor;
  }

  /** Reclassify every queued job and run the liveness sweep (pump only). */
  _sweep(now) {
    const idx = this._idx;
    const drop = [];
    for (const j of this._order) {
      // A pre whose full record is already on the wire adds nothing.
      if (j.kind === "pre" && (this._fullInflightRs.get(j.rs) | 0) > 0) { drop.push([j, "cancelled"]); continue; }
      this._classify(j, now);
      // Only a COMPLETE index can say "no holder" (budget-limited scans can
      // leave a holder out of one refresh).
      if (idx.available && idx.complete && j.rs && !idx.map.has(j.rs) && !this._anyLive(j, now)) drop.push([j, "dropped"]);
    }
    for (const [j, why] of drop) {
      if (why === "cancelled") this._st.cancelledPre += 1;
      else this._st.dropped += 1;
      this._logJob(j, now, why);
      this._settleNull(j, why);
    }
    this._orderDirty = true;
  }

  // ---- link / cap / bucket -------------------------------------------------

  _linkEstimate(now) {
    if (now - this._link.at < 500) return this._link;
    let tierBps = null, source = null;
    try {
      const t = this._linkBpsFn();
      if (typeof t === "number") tierBps = t > 0 ? t : null;
      else if (t) { tierBps = t.bps > 0 ? t.bps : null; source = t.source || null; }
    } catch (_) { /* fail-soft */ }
    const obsBps = this._obsBps(now);
    const L = Math.max(tierBps || 0, obsBps || 0) || DEFAULT_LINK_BPS;
    this._link = { L, tierBps, source, obsBps, at: now };
    return this._link;
  }

  /** Bytes over the UNION of [dispatch, received] intervals of this queue's own
   *  jobs in the last 20 s — the transfer speed, not the throttle. */
  _obsBps(now) {
    const lo = now - OBS_WINDOW_MS;
    while (this._obs.length && this._obs[0][1] < lo) this._obs.shift();
    if (this._obs.length === 0) return null;
    const spans = this._obs.map((o) => o).sort((a, b) => a[0] - b[0]);
    let bytes = 0, busy = 0;
    let cs = spans[0][0], ce = spans[0][1];
    for (const [s, e, n] of spans) {
      bytes += n;
      if (s <= ce) { if (e > ce) ce = e; } else { busy += ce - cs; cs = s; ce = e; }
    }
    busy += ce - cs;
    if (bytes < OBS_MIN_BYTES || busy < OBS_MIN_BUSY_MS) return null;
    return (bytes * 1000) / busy;
  }

  _protoNow(now) {
    if (this._proto) return this._proto;
    if (now - this._protoAt >= PROTO_REPROBE_MS) {
      this._protoAt = now;
      try { this._proto = this._protocolFn() || null; } catch (_) { this._proto = null; }
    }
    return this._proto || "h1";
  }

  _capNow(now) {
    const link = this._linkEstimate(now);
    if (link.L < SLOW_LINK_BPS) return { all: 1, big: 1, pre: 1 };
    const p = this._protoNow(now);
    return p === "h2" || p === "h3" ? { all: 6, big: 4, pre: 1 } : { all: 3, big: 2, pre: 1 };
  }

  _bucketActive(now) {
    if (this._indoorNow()) return true;
    return this._lastResumeAt != null && now - this._lastResumeAt < RESUME_BUCKET_MS;
  }

  _refill(now, active) {
    const L = this._linkEstimate(now).L;
    const R = (this._fgQueued > 0 ? FG_SHARE : this._bgShare) * L;
    this._capacity = Math.max(FG_SHARE * L, MIN_BUCKET_BYTES);
    if (!active) {
      this._tokens = this._capacity;
    } else {
      const dt = this._lastRefill == null || !this._bucketOn ? 0 : Math.max(0, now - this._lastRefill);
      this._tokens = Math.min(this._capacity, this._tokens + (this._rateNow * dt) / 1000);
    }
    if (active !== this._bucketOn || R !== this._rateNow) {
      this._rateLog.push([now, active ? R : -1]);
      if (this._rateLog.length > 4096) this._rateLog.splice(0, 1024);
    }
    this._bucketOn = active;
    this._rateNow = R;
    this._lastRefill = now;
  }

  _backpressured() {
    let d = 0;
    try { d = this._workerDepthFn() | 0; } catch (_) { d = 0; }
    return Math.max(d, this._postRecv) > WORKER_BACKPRESSURE_DEPTH;
  }

  // ---- the pump ------------------------------------------------------------

  _pump() {
    if (this._pumping) return;
    this._pumping = true;
    try {
      this._pumpCore();
    } finally {
      this._pumping = false;
    }
  }

  _pumpCore() {
    if (this._order.length === 0) {
      // Nothing waits: no timers. (Receipts re-pump through the microtask.)
      this._clearWake();
      return;
    }
    const now = this._now();
    if (this._updatePause(now)) {
      this._wake(PAUSE_POLL_MS);
      return;
    }
    if (this._resumeWait) {
      const rw = this._resumeWait;
      if (now >= rw.until) {
        this._st.resumeWaitTimeouts += 1;
        this._resumeWait = null;
      } else {
        if (now - this._idxAt >= RESUME_WAIT_POLL_MS || this._idxAt < (this._lastResumeAt || 0)) {
          this._refreshIndex(now);
        }
        this._sweepIfNew(now);
        let hit = false;
        for (const lb of this._idx.visibleLbs) if (rw.lbs.has(lb)) { hit = true; break; }
        if (!hit) {
          this._wake(Math.min(RESUME_WAIT_POLL_MS, Math.max(1, rw.until - now)));
          return;
        }
        this._st.resumeWaitHits += 1;
        this._resumeWait = null;
      }
    }
    // 4 Hz while the bucket is on (indoors / after a resume), 1 Hz outdoors
    // where the order is the only effect and the statics walk is the cost.
    if (now - this._idxAt >= (this._bucketOn ? INDEX_MIN_MS : INDEX_OUTDOOR_MS)) {
      this._refreshIndex(now);
    }
    this._sweepIfNew(now);
    if (this._orderDirty) this._sortOrder();

    const cap = this._capNow(now);
    const bucket = this._bucketActive(now);
    this._refill(now, bucket);
    let blockedTokens = false;
    let blockedBp = false;
    let bpChecked = null;
    for (let i = 0; i < this._order.length;) {
      if (this._inflightAll >= cap.all) break;
      const j = this._order[i];
      if (j.band > BG_MAX_BAND) break; // held / parked: sorted last
      const fg = j.band <= FG_MAX_BAND;
      if (j.kind === "pre" && (this._fullInflightRs.get(j.rs) | 0) > 0) {
        // Its full record is already on the wire: the pre adds nothing.
        this._st.cancelledPre += 1;
        this._logJob(j, now, "cancelled");
        this._settleNull(j, "cancelled"); // removes it from `_order`
        continue;
      }
      if (!fg && (this._bgShare <= 0 || (bucket && this._fgQueued > 0))) { i += 1; continue; }
      if (j.kind === "pre" && this._inflightPre >= cap.pre) { i += 1; continue; }
      if (j.big && this._inflightBig >= cap.big) { i += 1; continue; }
      if (j.net === "xu7") {
        if (bpChecked === null) bpChecked = this._backpressured();
        if (bpChecked) { blockedBp = true; this._st.backpressureBlocks += 1; i += 1; continue; }
      }
      if (bucket && this._tokens <= 0) { blockedTokens = true; this._st.tokenBlocks += 1; break; }
      this._order.splice(i, 1);
      this._dispatch(j, now, bucket);
      // `_dispatch` may cancel a queued pre anywhere in `_order`; rescan from
      // the top (at most cap.all dispatches per pump, so this stays cheap).
      i = 0;
    }

    // Next wake: refill wait, back-pressure poll, else a 1 Hz sweep while
    // anything is queued (reclassification, liveness, aging).
    if (this._order.length === 0) { this._clearWake(); return; }
    let ms = IDLE_SWEEP_MS;
    if (blockedTokens) {
      const need = 1 - this._tokens;
      ms = this._rateNow > 0 ? Math.min(IDLE_SWEEP_MS, Math.max(20, Math.ceil((need * 1000) / this._rateNow))) : IDLE_SWEEP_MS;
    }
    if (blockedBp) ms = Math.min(ms, 100);
    this._wake(ms);
  }

  _dispatch(j, now, bucket) {
    j.state = "inflight";
    j.dispAt = now;
    if (this._jobs.get(j.key) === j) this._jobs.delete(j.key);
    if (j.band <= FG_MAX_BAND) this._fgQueued = Math.max(0, this._fgQueued - 1);
    this._inflightAll += 1;
    if (j.big) this._inflightBig += 1;
    if (j.kind === "pre") this._inflightPre += 1;
    if (j.kind !== "pre" && j.kind !== "texchan") {
      this._fullInflightRs.set(j.rs, (this._fullInflightRs.get(j.rs) | 0) + 1);
      // Cancel the queued pre for the same surface: the full record is coming.
      const pj = this._jobs.get(`pre:${j.rs}`);
      if (pj && pj.state === "queued") {
        this._st.cancelledPre += 1;
        this._logJob(pj, now, "cancelled");
        this._settleNull(pj, "cancelled");
      }
    }
    j.charged = bucket ? j.est : 0;
    if (bucket) this._tokens -= j.est;
    this._st.dispatched += 1;
    if (this._st.dispatchedByKind[j.kind] != null) this._st.dispatchedByKind[j.kind] += 1;
    j.logRef = this._logJob(j, now, "dispatched");
    const t = new TexUpgradeTicket(this, j);
    // Counted in `_fullInflightRs` until RELEASE (not receipt): a pre asked
    // while this record transcodes must still see it (see `admit`).
    t._fullHeld = j.kind !== "pre" && j.kind !== "texchan";
    try { j.resolve(t); } catch (_) { /* fail-soft */ }
  }

  _freeSlot(t) {
    if (!t._slot) return;
    t._slot = false;
    const j = t._job;
    this._inflightAll = Math.max(0, this._inflightAll - 1);
    if (j.big) this._inflightBig = Math.max(0, this._inflightBig - 1);
    if (j.kind === "pre") this._inflightPre = Math.max(0, this._inflightPre - 1);
  }

  _onReceived(t, n) {
    if (t._recv || t._done) return;
    t._recv = true;
    const j = t._job;
    const now = this._now();
    const bytes = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
    j.recvAt = now;
    j.bytes = bytes;
    this._st.received += 1;
    if (this._st.bytes[j.net] != null) this._st.bytes[j.net] += bytes;
    if (bytes > this._maxRecord) this._maxRecord = bytes;
    if (j.charged) {
      this._tokens = Math.min(this._capacity, this._tokens + (j.charged - bytes));
      j.charged = 0;
    }
    if (bytes > 0 && j.dispAt != null) {
      this._obs.push([j.dispAt, Math.max(now, j.dispAt + 1), bytes]);
      if (this._obs.length > 2048) this._obs.splice(0, 512);
    }
    if (j.logRef) { j.logRef.bytes = bytes; j.logRef.recvAt = now; }
    this._freeSlot(t);
    if (j.net === "xu7") { t._post = true; this._postRecv += 1; }
    this._kick();
  }

  _onRelease(t) {
    if (t._done) return;
    t._done = true;
    this._freeSlot(t);
    if (t._post) { t._post = false; this._postRecv = Math.max(0, this._postRecv - 1); }
    const j = t._job;
    if (t._fullHeld) {
      t._fullHeld = false;
      const c = (this._fullInflightRs.get(j.rs) | 0) - 1;
      if (c > 0) this._fullInflightRs.set(j.rs, c);
      else this._fullInflightRs.delete(j.rs);
    }
    if (j.logRef && j.logRef.doneAt == null) j.logRef.doneAt = this._now();
    this._kick();
  }

  _refetch(t, net) {
    const old = t._job;
    if (!t._recv) {
      if (old.logRef) old.logRef.bytes = 0;
      // Nothing came over the wire on this leg (transcoder not up): give the
      // bucket back what dispatch charged, or the leak throttles the room.
      if (old.charged) {
        this._tokens = Math.min(this._capacity, this._tokens + old.charged);
        old.charged = 0;
      }
    }
    this._onRelease(t);
    this._st.refetches += 1;
    return new Promise((resolve) => {
      const j = this._makeJob(old.kind, net || "hbc7", old.id, null, resolve, true);
      // Same key as the job it continues, registered while queued, so a second
      // ask for this surface JOINS the leg (`addWaiter`): an unregistered leg
      // could be dropped under a live joiner, who then never asks again.
      j.key = old.key;
      if (!this._jobs.has(j.key)) this._jobs.set(j.key, j);
      j.rs = old.rs;
      j.w = old.w; j.h = old.h;
      j.est = texUpgradeEstimateBytes(j.net, old.w, old.h);
      j.big = j.est >= BIG_BYTES;
      j.waiters = old.waiters;
      j.everHeld = old.everHeld;
      j.enqAt = old.enqAt;
      j.agedAt = old.agedAt;
      this._enqueue(j);
    });
  }

  // ---- diag ----------------------------------------------------------------

  _logJob(j, now, ev) {
    const e = {
      kind: j.kind, net: j.net, id: typeof j.id === "number" ? (j.id >>> 0).toString(16) : String(j.id),
      rs: j.rs ? (j.rs >>> 0).toString(16) : null, ev, band: TEXQ_BANDS[j.band], cls: j.cls,
      dist: Number.isFinite(j.dist) ? Math.round(j.dist * 10) / 10 : null,
      enqAt: j.enqAt, dispAt: j.dispAt, recvAt: null, doneAt: ev === "dispatched" ? null : now, bytes: null,
    };
    this._log.push(e);
    if (this._log.length > LOG_MAX) this._log.splice(0, this._log.length - LOG_MAX);
    return e;
  }

  log() {
    return this._log.slice();
  }

  stats() {
    const now = this._now();
    const byKind = {};
    const byBand = {};
    for (const j of this._order) {
      byKind[j.kind] = (byKind[j.kind] || 0) + 1;
      const b = TEXQ_BANDS[j.band];
      byBand[b] = (byBand[b] || 0) + 1;
    }
    const link = this._linkEstimate(now);
    const cap = this._capNow(now);
    return {
      enabled: this.armed,
      paused: this._pauseSince != null && !this._pauseExpired,
      pauseMs: this._pauseMs + (this._pauseSince != null ? now - this._pauseSince : 0),
      resumes: this._resumes.slice(),
      resumeWait: this._resumeWait ? { untilMs: this._resumeWait.until - now, lbs: [...this._resumeWait.lbs].map((x) => x.toString(16)) } : null,
      fullM: this._fullM,
      bgShare: this._bgShare,
      link: { tierBps: link.tierBps, source: link.source, obsBps: link.obsBps == null ? null : Math.round(link.obsBps), L: Math.round(link.L), proto: this._proto || "h1(default)" },
      bucket: { active: this._bucketOn, indoor: this._indoorNow(), tokens: Math.round(this._tokens), capacity: Math.round(this._capacity), rate: Math.round(this._rateNow), fg: Math.round(FG_SHARE * link.L), bg: Math.round(this._bgShare * link.L) },
      cap,
      inflight: { all: this._inflightAll, big: this._inflightBig, pre: this._inflightPre, transcoding: this._postRecv },
      queued: { total: this._order.length, fg: this._fgQueued, byKind, byBand },
      ...this._st,
      dispatchedByKind: { ...this._st.dispatchedByKind },
      bytes: { ...this._st.bytes },
      maxRecord: this._maxRecord,
      index: { ...this._idx.st, available: this._idx.available, complete: this._idx.complete, ageMs: Number.isFinite(this._idxAt) ? now - this._idxAt : null, visibleLbs: [...this._idx.visibleLbs].map((x) => x.toString(16)) },
      tracking: this._tracking,
    };
  }

  /**
   * In-view wait tracker (4 Hz, BOTH arms; armed only on request). For every
   * RenderSurface the index puts in view whose full-tier upgrade is still
   * outstanding, accumulate the time it spent in view while waiting; within
   * D_full ("near") and unscoped.
   */
  trackInView(on = true) {
    if (!on) {
      this._tracking = false;
      if (this._trackTimer != null) { try { this._cancel(this._trackTimer); } catch (_) { /* */ } }
      this._trackTimer = null;
      return false;
    }
    if (this._tracking) return true;
    this._tracking = true;
    this._track = new Map();
    this._trackSnaps = [];
    this._trackLastAt = null;
    const tick = () => {
      this._trackTimer = null;
      if (!this._tracking) return;
      try { this._trackTick(); } catch (_) { /* diag only */ }
      if (this._tracking) this._trackTimer = this._schedule(tick, TRACK_MS);
    };
    this._trackTimer = this._schedule(tick, 0);
    return true;
  }

  /** One tracker sample (exported for the suites). */
  _trackTick() {
    const now = this._now();
    this._refreshIndex(now);
    if (this._order.length) this._kick(); // the pump sweeps the new generation
    const dt = this._trackLastAt == null ? 0 : Math.max(0, now - this._trackLastAt);
    this._trackLastAt = now;
    const near = [];
    const seen = new Set();
    for (const [rs, e] of this._idx.map) {
      if (e.cls !== CLS_VIEW) continue;
      const isNear = !(this._fullM > 0) || e.dist <= this._fullM;
      if (isNear) near.push(rs);
      let pend = false;
      try { pend = !!this._pendingProbe(rs); } catch (_) { pend = false; }
      let t = this._track.get(rs);
      if (!pend) continue;
      seen.add(rs);
      if (!t || t.closedAt != null) {
        t = { rs, first: now, last: now, inViewMs: 0, inViewNearMs: 0, minDist: e.dist, closedAt: null, everNear: isNear, prevTick: true };
        this._track.set(rs, t);
      } else {
        if (t.prevTick) {
          t.inViewMs += dt;
          if (isNear) t.inViewNearMs += dt;
        }
        t.last = now;
        t.prevTick = true;
        if (e.dist < t.minDist) t.minDist = e.dist;
        if (isNear) t.everNear = true;
      }
    }
    for (const t of this._track.values()) {
      if (t.closedAt != null) continue;
      if (!seen.has(t.rs)) {
        t.prevTick = false;
        let pend = false;
        try { pend = !!this._pendingProbe(t.rs); } catch (_) { pend = false; }
        if (!pend) t.closedAt = now;
      }
    }
    this._trackSnaps.push({ at: now, near: Uint32Array.from(near) });
    if (this._trackSnaps.length > TRACK_SNAP_MAX) this._trackSnaps.splice(0, this._trackSnaps.length - TRACK_SNAP_MAX);
  }

  /**
   * Post-run report.
   * @param {{wallsEpochMs?:number, windowMs?:number}} [o]
   */
  report(o = {}) {
    const now = this._now();
    const walls = Number.isFinite(o.wallsEpochMs) ? o.wallsEpochMs : (this._resumes.length ? this._resumes[this._resumes.length - 1].at : null);
    const win = Number.isFinite(o.windowMs) ? o.windowMs : 10000;
    const hd = { pre: 0, xu7: 0, hbc7: 0, twin: 0, texchan: 0, total: 0 };
    const hdAll = { pre: 0, xu7: 0, hbc7: 0, twin: 0, texchan: 0, total: 0 };
    let hdLog = null;
    try { hdLog = bc7HdLog(); } catch (_) { hdLog = null; }
    let suiteLog = null;
    try { suiteLog = suiteHdLog(); } catch (_) { suiteLog = null; }
    const add = (k, at, n) => {
      if (walls == null || !(n > 0)) return;
      if (at >= walls) { hdAll[k] = (hdAll[k] || 0) + n; hdAll.total += n; }
      if (at >= walls && at <= walls + win) { hd[k] = (hd[k] || 0) + n; hd.total += n; }
    };
    if (hdLog) for (const e of hdLog.bytes) add(e.kind, e.at, e.bytes);
    if (suiteLog) for (const e of suiteLog) add("texchan", e.at, e.bytes);

    // Budget for the window (queue arm, bucket active the whole window):
    // capacity + integral of the rate + bigCap x the largest record seen.
    let budget10s = null;
    if (this.armed && walls != null) {
      let total = this._capacity;
      let unbounded = false;
      const segs = this._rateLog;
      for (let i = 0; i < segs.length; i += 1) {
        const [t, R] = segs[i];
        const tEnd = i + 1 < segs.length ? segs[i + 1][0] : now;
        const a = Math.max(t, walls), b = Math.min(tEnd, walls + win);
        if (b <= a) continue;
        if (R < 0) { unbounded = true; break; }
        total += (R * (b - a)) / 1000;
      }
      const cap = this._capNow(now);
      budget10s = unbounded ? null : Math.round(total + cap.big * Math.max(this._maxRecord, 4.1e6));
    }

    // In-view waits.
    let maxNear = 0, maxAll = 0, over10s = 0, maxSpan = 0, tracked = 0, closed = 0;
    const open = [];
    for (const t of this._track.values()) {
      tracked += 1;
      if (t.closedAt != null) closed += 1;
      if (t.inViewNearMs > maxNear) maxNear = t.inViewNearMs;
      if (t.inViewMs > maxAll) maxAll = t.inViewMs;
      if (t.inViewNearMs > 10000) over10s += 1;
      if (t.everNear) maxSpan = Math.max(maxSpan, (t.closedAt != null ? t.closedAt : now) - t.first);
      if (t.closedAt == null) {
        open.push({ rs: t.rs.toString(16), ageMs: now - t.first, inViewMs: t.inViewMs, inViewNearMs: t.inViewNearMs, dist: Math.round(t.minDist * 10) / 10 });
      }
    }
    open.sort((a, b) => b.inViewMs - a.inViewMs);

    // Order: of the first K full landings after the walls (K = in-view rsIds
    // within D_full at walls + 2 s), how many were in that set?
    let order = null;
    if (walls != null && this._trackSnaps.length && hdLog) {
      let snap = null;
      for (const sn of this._trackSnaps) {
        if (!snap || Math.abs(sn.at - (walls + 2000)) < Math.abs(snap.at - (walls + 2000))) snap = sn;
      }
      const S = new Set(snap ? snap.near : []);
      const K = S.size;
      const landed = hdLog.verdicts
        .filter((v) => v.outcome === "swapped" && v.at >= walls)
        .sort((a, b) => a.at - b.at);
      const firstK = [];
      const got = new Set();
      for (const v of landed) {
        if (got.has(v.rs)) continue;
        got.add(v.rs);
        firstK.push(v.rs);
        if (firstK.length >= K) break;
      }
      const inView = firstK.filter((rs) => S.has(rs)).length;
      order = { K, snapAt: snap ? snap.at : null, firstK: firstK.length, inView, firstKInViewFraction: firstK.length ? +(inView / firstK.length).toFixed(3) : null };
    }

    return {
      wallsEpochMs: walls,
      windowMs: win,
      hdBytesWindow: hd,
      hdBytesSinceWalls: hdAll,
      budget10s,
      inView: { maxWaitMs: Math.round(maxNear), over10s, maxWaitMsAll: Math.round(maxAll), maxSpanMs: Math.round(maxSpan), tracked, closed, open: open.slice(0, 40) },
      order,
      stats: this.stats(),
    };
  }

  /** Test hook: clear every timer, settle every queued job null, zero state. */
  _resetForTest() {
    this._clearWake();
    if (this._trackTimer != null) { try { this._cancel(this._trackTimer); } catch (_) { /* */ } }
    this._trackTimer = null;
    this._tracking = false;
    for (const j of this._order.slice()) {
      try { j.resolve(null); } catch (_) { /* fail-soft */ }
    }
    this._init();
  }

  /** Test hook: is any timer live? */
  _hasTimersForTest() {
    return this._timer != null || this._trackTimer != null;
  }
}

// --------------------------------------------------------------------------
// singleton (page only)
// --------------------------------------------------------------------------

let _singleton = null;

/**
 * The page's queue, created on first call and installed as
 * `window.__texUpgradeQueue`. Null outside a window context (workers, the
 * node suites without a `window` stub). Creating it starts no timer.
 */
export function getTexUpgradeQueue() {
  if (_singleton) return _singleton;
  if (typeof window === "undefined") return null;
  _singleton = new TexUpgradeQueue();
  try {
    window.__texUpgradeQueue = _singleton;
  } catch (_) {
    /* diag only */
  }
  return _singleton;
}

/** Test hook: drop the singleton (timers cleared). */
export function _resetTexUpgradeQueueForTest() {
  if (_singleton) _singleton._resetForTest();
  _singleton = null;
  try {
    if (typeof window !== "undefined") delete window.__texUpgradeQueue;
  } catch (_) {
    /* */
  }
}
