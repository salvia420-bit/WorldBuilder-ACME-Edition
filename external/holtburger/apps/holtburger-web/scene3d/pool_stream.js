// scene3d/pool_stream.js — ST9 stage B: the pool feed/release/dispatch
// relocation into P4 (T22; SPEC §1.6, pass-08 D-08.2/D-08.3/S2 + F-11.19,
// pass-07 D-07.5/S2).
//
// WHAT MOVES
// ----------
// Under stage A the FrameWorkScheduler exists and the legacy 6 ms families
// register as W6 clients with their code unchanged. Stage B is where the POOL
// work becomes first-class scheduler work:
//
//   W1 URGENT  — the player tile's feed, interior feed on entry, teleport seeds
//   W2 UPLOAD  — the UploadStager drain (stage C; one coalesced item)
//   W3 FEED    — STAGED→LIVE TilePlan feeds, RESUMABLE (a feed job steps one
//                chunk per slot; `tickP4` re-arms it, so the item never
//                re-enqueues into the class the slot is draining)
//   W4 RELEASE — park drains, PARKED→EMPTY deletes, pool optimize() compaction
//
// and where **P1 events RECORD work and never execute it** (pass-08 S1): a
// grid admit records a bake-dispatch item; P4 posts the job. A settled frame
// does one anchor compare and exits.
//
// BAKE-JOB DISPATCH (F-11.19 — the finding that this was owned by nobody)
// ----------------------------------------------------------------------
// P1-recorded admits enqueue dispatch items; P4 posts them at CONCURRENCY 1,
// ordered player-tile → interior → Chebyshev distance; a vacate PURGES the
// tile's queued dispatch (and its queued scheduler items and uploads) so a
// tile that left the window is never baked "just because it was asked for".
// That is the same dequeue-never-fetch-then-drop discipline the grid applies
// to packs, extended to the bake worker.
//
// THE ORDERING INVARIANT, END TO END (pass-08 S2.4)
// ------------------------------------------------
//   geometry appends → texture stages → matrices/instances → membership
//   record → LIVE flip last
// The feed job holds its tile's LIVE flip until (a) every member is fed and
// (b) every rsId the tile needs has STAGED in the UploadStager. A tile whose
// textures have not uploaded stays invisible instead of flashing unuploaded
// — which is why stage C lands together with the feed path rather than after
// it (SPEC §3 T22).
//
// SEVERAL FEEDS PER TILE (2026-10-22). The live producers emit one TilePlan per
// (LANDBLOCK, domain) — statics and buildings per LB, envcells per LB — and a
// tile is 2×2 LBs, so up to eight plans for ONE tile can be in flight at once
// during a ring build. The feed map used to hold one job per tile: a second
// plan overwrote the first, whose commit step was then never re-armed (a
// commit always needs a step after the last feed step), so its instances stayed
// born-invisible forever, outside every membership record (never released),
// while the producer had already taken their nodes off the legacy path —
// missing props and a leak [M: node probe, two plans for one tile → 1 of 2
// committed, 2 of 3 instances invisible]. Every tile now holds a LIST of jobs;
// each commits on its own (the registry's commit merges into the tile's
// membership record — "re-feed of a tile already resident"; a plan that
// commits after its tile PARKED commits invisible, pool_registry.js `commit`),
// and a vacate abandons all of them.

import { tileChebyshev } from "./residency_grid.js";

// ---------------------------------------------------------------------------
// bake-job dispatch queue (F-11.19)
// ---------------------------------------------------------------------------

export class BakeDispatchQueue {
  /**
   * @param {object} deps
   * @param {(tileKey:number, item:object)=>Promise<any>|any} deps.post
   *   post ONE bake job; resolution/rejection releases the concurrency slot.
   * @param {(m:string,d?:any)=>void} [deps.warn]
   */
  constructor({ post, warn } = {}) {
    this.post = typeof post === "function" ? post : null;
    this.warn = typeof warn === "function" ? warn : () => {};
    /** @type {Map<number, object>} tileKey -> {tileKey, interior, seq} */
    this.queued = new Map();
    this.inFlight = null;
    this.playerTile = -1;
    this._seq = 0;
    this.stats = { recorded: 0, posted: 0, purged: 0, completed: 0, failed: 0, coalesced: 0 };
  }

  setPlayerTile(tileKey) {
    this.playerTile = tileKey;
  }

  /** P1 records — never posts. */
  record(tileKey, { interior = false } = {}) {
    if (this.queued.has(tileKey)) { this.stats.coalesced += 1; return false; }
    if (this.inFlight === tileKey) { this.stats.coalesced += 1; return false; }
    this.queued.set(tileKey, { tileKey, interior: !!interior, seq: this._seq++ });
    this.stats.recorded += 1;
    return true;
  }

  /** Slot vacation purges the queued dispatch (an in-flight job is left to
   *  finish — its result is dropped by the caller's window check, which is
   *  cheaper and safer than cancelling mid-decode). */
  purge(tileKey) {
    if (this.queued.delete(tileKey)) { this.stats.purged += 1; return true; }
    return false;
  }

  purgeAll(tileKeys) {
    let n = 0;
    for (const t of tileKeys) if (this.purge(t)) n += 1;
    return n;
  }

  /** Distance-ordered pick: player tile → interior → Chebyshev → FIFO. */
  peek() {
    let best = null;
    for (const it of this.queued.values()) {
      const d = this.playerTile >= 0 ? tileChebyshev(it.tileKey, this.playerTile) : 0;
      const rank = it.tileKey === this.playerTile ? -2 : (it.interior ? -1 : d);
      if (best === null || rank < best.rank || (rank === best.rank && it.seq < best.it.seq)) {
        best = { rank, it };
      }
    }
    return best ? best.it : null;
  }

  get depth() {
    return this.queued.size;
  }

  /** P4 posts ONE job (concurrency 1). Returns the tile posted, or -1. */
  dispatch() {
    if (this.inFlight !== null || !this.post) return -1;
    const it = this.peek();
    if (!it) return -1;
    this.queued.delete(it.tileKey);
    this.inFlight = it.tileKey;
    this.stats.posted += 1;
    let r;
    try {
      r = this.post(it.tileKey, it);
    } catch (e) {
      this.inFlight = null;
      this.stats.failed += 1;
      this.warn("[poolStream] bake dispatch threw", e);
      return it.tileKey;
    }
    if (r && typeof r.then === "function") {
      r.then(
        () => { this.inFlight = null; this.stats.completed += 1; },
        (e) => { this.inFlight = null; this.stats.failed += 1; this.warn("[poolStream] bake job failed", e); },
      );
    } else {
      this.inFlight = null;
      this.stats.completed += 1;
    }
    return it.tileKey;
  }
}

// ---------------------------------------------------------------------------
// the stream controller
// ---------------------------------------------------------------------------

export class PoolStreamController {
  /**
   * @param {object} deps
   * @param {import("./pool_registry.js").PoolRegistry} deps.registry
   * @param {object} deps.scheduler            FrameWorkScheduler
   * @param {import("./upload_stage.js").UploadStager} [deps.uploads]
   * @param {(tileKey:number, item:object)=>Promise<any>} [deps.postBake]
   * @param {number} [deps.feedChunk]          members per W3 step [A]
   * @param {(m:string,d?:any)=>void} [deps.warn]
   */
  constructor({ registry, scheduler, uploads = null, postBake = null, feedChunk = 64, warn } = {}) {
    if (!registry) throw new Error("pool_stream: registry required");
    if (!scheduler) throw new Error("pool_stream: scheduler required");
    this.registry = registry;
    this.scheduler = scheduler;
    this.uploads = uploads;
    this.feedChunk = feedChunk;
    this.warn = typeof warn === "function" ? warn : (m, d) => { try { console.warn(m, d); } catch (_) { /* fail-soft */ } };
    this.dispatch = new BakeDispatchQueue({ post: postBake, warn: this.warn });
    /** tileKey -> in-progress feed jobs (one per TilePlan; see the header's
     *  "several feeds per tile") */
    this._feeds = new Map();
    /** tiles the window has dropped since their job was posted */
    this._vacated = new Set();
    this._uploadItemPending = false;
    this.stats = {
      admits: 0, vacates: 0, feedsStarted: 0, feedsCommitted: 0, feedsAbandoned: 0,
      parks: 0, adopts: 0, releases: 0, flipDeferrals: 0, purgedItems: 0,
      teleportDrains: 0,
    };
  }

  // ── P1: events RECORD, never execute ────────────────────────────────────

  setPlayerTile(tileKey) {
    this.dispatch.setPlayerTile(tileKey);
  }

  /** Grid `onShift`/`onSeed` admit. Records a bake dispatch; posts nothing. */
  onAdmit(tileKey, opts = {}) {
    this._vacated.delete(tileKey);
    this.stats.admits += 1;
    if (this.registry.isTileResident(tileKey)) {
      // PARKED → LIVE is a pointer re-adopt: no bake, no fetch, no decode.
      this.enqueueAdopt(tileKey, opts.urgent === true);
      return false;
    }
    return this.dispatch.record(tileKey, opts);
  }

  /** Grid vacate. Purges the queued dispatch AND every queued scheduler item
   *  and upload for the tile (S2.6). Live caller: pool_producer.js
   *  `_releaseTile` — the tile went EMPTY or a teleport vacated it (2026-10-23
   *  review: it had no live caller, so a plan still feeding when its tile went
   *  EMPTY committed after the release and drew a tile no grid slot owned). */
  onVacate(tileKey) {
    this.stats.vacates += 1;
    this._vacated.add(tileKey);
    this.dispatch.purge(tileKey);
    let purged = this.scheduler.purgeByTile(tileKey);
    if (this.uploads) purged += this.uploads.purgeByTile(tileKey);
    this.stats.purgedItems += purged;
    const jobs = this._feeds.get(tileKey);
    if (jobs) {
      // STAGED but vacated before the flip: nothing entered any pool that
      // must persist (pass-07 S2's "drop the TilePlan" row) — for EVERY plan
      // of the tile still in flight.
      for (const job of jobs) {
        job.abandon();
        this.stats.feedsAbandoned += 1;
      }
      this._feeds.delete(tileKey);
    }
    return purged;
  }

  /** The grid is populating a vacated tile again (a transition into
   *  FETCHING / STAGED / LIVE, or a shift/seed admit — pool_producer.js):
   *  its plans are fed again. Records nothing; the admit hooks own the work.
   *  Without it a vacate would refuse the tile's plans for the session — a
   *  re-admit does not always pass through `onAdmit` (teleport admits and
   *  `readmitEmptyTiles` fire no onShift/onSeed). */
  onReadmit(tileKey) {
    this._vacated.delete(tileKey);
  }

  /** Drop one finished/abandoned job from its tile's list. */
  _forgetJob(tileKey, job) {
    const jobs = this._feeds.get(tileKey);
    if (!jobs) return;
    const i = jobs.indexOf(job);
    if (i >= 0) jobs.splice(i, 1);
    if (jobs.length === 0) this._feeds.delete(tileKey);
  }

  onTeleport(vacatedTiles = []) {
    this.stats.teleportDrains += 1;
    for (const t of vacatedTiles) this.onVacate(t);
  }

  // ── worker results ENQUEUE; they never touch the scene (pass-08 D-08.4) ──

  /**
   * A TilePlan arrived. Enqueue a RESUMABLE W3 feed (or W1 when urgent).
   * NOTHING is fed here — the arrival callback's only legal act is enqueueing.
   * @returns {boolean} false when the tile is vacated and the plan is refused
   *   — the caller must render its nodes another way (pool_producer.js hands
   *   them back as passthrough).
   */
  onPlanReady(tilePlan, geometrySource, { urgent = false } = {}) {
    const tileKey = tilePlan.tile;
    if (this._vacated.has(tileKey)) {
      // Vacated while the job was in flight: never fed, never drawn.
      this.stats.feedsAbandoned += 1;
      return false;
    }
    // `onLayer` fires from inside `job.step()`, i.e. after `job` is assigned;
    // it notes the rsId on THIS plan's job (a tile can have several).
    const job = this.registry.beginFeed(tilePlan, geometrySource, {
      onLayer: (rsId) => { if (this.uploads) this._noteLayer(rsId, job); },
    });
    job._cls = urgent ? "W1" : "W3";
    job._needsMore = false;
    let jobs = this._feeds.get(tileKey);
    if (!jobs) { jobs = []; this._feeds.set(tileKey, jobs); }
    jobs.push(job);
    this.stats.feedsStarted += 1;
    this._enqueueFeedStep(tileKey, job, job._cls);
    return true;
  }

  _noteLayer(rsId, job) {
    // The producer registers the actual texture; this is the accounting hook
    // that lets a feed know which rsIds its flip waits on.
    if (!job) return;
    if (!job._rsIds) job._rsIds = new Set();
    job._rsIds.add(rsId >>> 0);
  }

  _enqueueFeedStep(tileKey, job, cls) {
    this.scheduler.enqueue(cls, {
      kind: "poolFeed",
      tileKey,
      bytes: 0,
      fn: () => this._runFeedStep(tileKey, job),
    });
  }

  /**
   * ONE chunk of one tile's feed. Continuation is requested by SETTING A FLAG,
   * never by re-enqueueing into the class the slot is currently draining — a
   * self-re-enqueueing item spins the slot until its budget expires (and, on
   * a frozen clock, forever). `tickP4` re-arms exactly one step per pending
   * tile per frame, which also bounds the feed's per-frame cost by
   * construction rather than by the budget check alone.
   */
  _runFeedStep(tileKey, job) {
    job._needsMore = false;
    if (job.committed) return; // already abandoned (a vacate) or committed
    if (this._vacated.has(tileKey)) { job.abandon(); this._forgetJob(tileKey, job); return; }
    if (!job.done) {
      job.step(this.feedChunk);
      job._needsMore = true;
      return;
    }
    // Fed. The LIVE FLIP waits on the tile's textures having STAGED — the
    // S2.4 ordering invariant, enforced rather than assumed.
    if (this.uploads && job._rsIds && job._rsIds.size > 0) {
      for (const rsId of job._rsIds) {
        if (!this.uploads.isStaged(rsId)) {
          this.stats.flipDeferrals += 1;
          job._needsMore = true;
          return;
        }
      }
    }
    job.commit();
    this._forgetJob(tileKey, job);
    this.stats.feedsCommitted += 1;
  }

  // ── W4: park / adopt / release ──────────────────────────────────────────

  enqueuePark(tileKey) {
    this.scheduler.enqueue("W4", {
      kind: "poolPark",
      tileKey,
      fn: () => { this.registry.parkTile(tileKey); this.stats.parks += 1; },
    });
  }

  enqueueAdopt(tileKey, urgent = false) {
    // Re-adopt is immediate-class work (zero fetch/decode/upload) but still
    // goes through the slot so pool mutation has exactly one caller.
    this.scheduler.enqueue(urgent ? "W1" : "W4", {
      kind: "poolAdopt",
      tileKey,
      fn: () => { this.registry.adoptTile(tileKey); this.stats.adopts += 1; },
    });
  }

  enqueueRelease(tileKey) {
    this.scheduler.enqueue("W4", {
      kind: "poolRelease",
      tileKey,
      fn: () => { this.registry.releaseTile(tileKey); this.stats.releases += 1; },
    });
  }

  enqueueOptimize(maxPools = 1) {
    this.scheduler.enqueue("W4", {
      kind: "poolOptimize",
      fn: () => { this.registry.tickOptimize(maxPools); },
    });
  }

  // ── W2: the upload drain, coalesced to one pending item ─────────────────

  requestUploadDrain() {
    if (!this.uploads || this._uploadItemPending) return false;
    if (!this.uploads.hasPending()) return false;
    this._uploadItemPending = true;
    this.scheduler.enqueue("W2", {
      kind: "uploadDrain",
      fn: () => {
        this._uploadItemPending = false;
        this.uploads.drain();
        if (this.uploads.hasPending()) this.requestUploadDrain();
      },
    });
    return true;
  }

  // ── P4 tick (called from the slot; posts at most ONE bake job) ───────────

  /**
   * The P4-side half: frame bookkeeping + the F-11.19 dispatch post. The
   * FrameWorkScheduler runs the W1..W4 items themselves.
   */
  tickP4() {
    this.registry.beginFrame();
    if (this.uploads) {
      this.uploads.beginFrame();
      this.requestUploadDrain();
    }
    // Re-arm one step per pending feed (see `_runFeedStep`'s note) — every
    // plan of every tile, not one per tile.
    for (const [tileKey, jobs] of this._feeds) {
      for (const job of jobs) {
        if (job._needsMore) this._enqueueFeedStep(tileKey, job, job._cls || "W3");
      }
    }
    return this.dispatch.dispatch();
  }

  stats_() {
    let feedsInFlight = 0;
    for (const jobs of this._feeds.values()) feedsInFlight += jobs.length;
    return {
      ...this.stats,
      dispatch: { ...this.dispatch.stats, depth: this.dispatch.depth, inFlight: this.dispatch.inFlight },
      // feeds (TilePlans) still stepping or waiting on their flip; `feedTiles`
      // is how many distinct tiles they belong to.
      feedsInFlight,
      feedTiles: this._feeds.size,
    };
  }
}
