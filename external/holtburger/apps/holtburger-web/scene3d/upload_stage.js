// scene3d/upload_stage.js — P4 W2: staged GPU uploads (ST9 stage C / T22;
// SPEC §1.6, pass-08 D-08.5 + S4 + S2.4).
//
// THE RULE THIS FILE EXISTS TO ENFORCE
// ------------------------------------
//   **No upload from a completion callback.**
// Today material-build swaps and atlas grows mark textures wherever the
// promise lands, and `renderer.render` pays for them at an uncontrolled
// moment. Under stage C, fetch/transcode/bake completions ENQUEUE only, and
// the stream slot is the sole site that calls `initTexture`, sets
// `needsUpdate`, or marks layers.
//
// The staging API is `renderer.initTexture(texture)` — public in r184 and
// explicitly routing `isCompressedArrayTexture` through `setTexture2DArray`,
// so both singleton CompressedTextures and the bucket/terrain arrays upload
// at a moment WE choose, outside `renderer.render`.
//
// MEASURED (P-INITTEX / P-88MIB, 1070 batch A, 2026-08-10 — the premise this
// stager was designed on is confirmed, not assumed):
//   * `initTexture` stages an 8 MiB CompressedArrayTexture in ~2 ms wall
//     OUTSIDE render(); the next frame's upload cost is ≈ 0.
//   * 88 MiB stages whole in 87–96 ms; split 44/44 it costs ~44 ms/frame.
//     Both are under F6's 250 ms streaming-hitch ceiling, so the terrain
//     t1024 pair — the largest indivisible item in the design — is a
//     schedulable exclusive item rather than a hazard.
//
// ORDERING INVARIANT (pass-08 S2.4, shared with the pool feed path — this is
// why stage C lands WITH the feed and not after it):
//
//   geometry appends → texture stages → matrices/instances → membership
//   record → **LIVE flip last**
//
// and specifically: *a texture stage item for rsId R always precedes any
// material re-point item for R*. `enqueueRepoint` refuses to run before its
// rsId has staged; it defers instead, so a re-point can never expose an
// unuploaded texture. A tile's LIVE flip rides the same mechanism through
// the pool stream controller.
//
// nullRender RULE (F-11.10): under `?nullRender=1` W2 **marks only** —
// `needsUpdate` / layer marks are set, `initTexture` is NEVER called.
// Nothing binds and nothing uploads on a bot arm, so protocol bots and
// zero-GPU harness runs do not pay (or hide) the upload term.

// ---------------------------------------------------------------------------
// budgets (pass-08 D-08.5 rule 4 — all [A], all escapable)
// ---------------------------------------------------------------------------

export const UPLOAD_BUDGETS = Object.freeze({
  /** compressed uploads: previews, full-tier swaps, array layer writes */
  "U-TEX": { bytes: 4 * 1024 * 1024, items: 2 },
  /** pool feed appended vertex+index bytes (bounded UPSTREAM — buffers have
   *  no staging API; this is the accounting side of that bound) */
  "U-BUF": { bytes: 2 * 1024 * 1024, items: Infinity },
  /** RGBA8 nra planes (half-res ⇒ ¼ albedo texels × 4 B) */
  "U-NRA": { bytes: 2 * 1024 * 1024, items: Infinity },
});

/** Array/atlas grow re-marks are CHUNKED: ≤ this many layers per frame until
 *  the prefix is re-homed (instead of one whole-live-prefix re-mark — the
 *  p99 doc #4's 20–250 ms model). */
export const GROW_LAYER_REMARKS_PER_FRAME = 2;

export const UPLOAD_CLASSES = Object.freeze(["U-TEX", "U-BUF", "U-NRA"]);

// ---------------------------------------------------------------------------

export class UploadStager {
  /**
   * @param {object} deps
   * @param {{initTexture?:Function}} deps.renderer  the WebGLRenderer (or a
   *   stub in tests). Absent ⇒ marks-only, counted as `noRenderer`.
   * @param {boolean} [deps.nullRender]  F-11.10 — marks only, never uploads
   * @param {()=>number} [deps.now]
   * @param {object} [deps.budgets]      override UPLOAD_BUDGETS (`?upBudget*`)
   * @param {(m:string,d?:any)=>void} [deps.warn]
   */
  constructor({ renderer = null, nullRender = false, now, budgets, warn } = {}) {
    this.renderer = renderer;
    this.nullRender = !!nullRender;
    this.now = typeof now === "function" ? now : () => (typeof performance !== "undefined" ? performance.now() : Date.now());
    this.budgets = { ...UPLOAD_BUDGETS, ...(budgets || {}) };
    this.warn = typeof warn === "function" ? warn : (m, d) => { try { console.warn(m, d); } catch (_) { /* fail-soft */ } };

    /** @type {Array<object>} FIFO of stage items */
    this._queue = [];
    /** @type {Array<object>} FIFO of exclusive items (one per frame, alone) */
    this._exclusive = [];
    /** @type {Array<object>} re-points waiting on their rsId's stage */
    this._repoints = [];
    /** rsIds whose texture has been staged this session */
    this._staged = new Set();

    this.stats = {
      initTextureCalls: 0,
      marksOnly: 0,
      stagedBytesByClass: { "U-TEX": 0, "U-BUF": 0, "U-NRA": 0 },
      itemsByClass: { "U-TEX": 0, "U-BUF": 0, "U-NRA": 0 },
      exclusiveRuns: 0,
      exclusive: [],           // ring of the last 16 {name, ms, frame}
      repointsDeferred: 0,
      repointsRun: 0,
      growRemarks: 0,
      noRenderer: 0,
      deferredByBudget: 0,
      queueDepth: 0,
      maxItemMs: 0,
      lastError: null,
    };
    this._frame = 0;
    this._spentBytes = { "U-TEX": 0, "U-BUF": 0, "U-NRA": 0 };
    this._spentItems = { "U-TEX": 0, "U-BUF": 0, "U-NRA": 0 };
    this._growThisFrame = 0;
    this._ranThisFrame = false;
  }

  // ── enqueue (from completion callbacks — the ONLY thing they may do) ─────

  /**
   * Stage a texture. `texture` is marked and, unless nullRender is armed,
   * uploaded via `renderer.initTexture` when the slot runs the item.
   * @param {object} opts
   * @param {object} opts.texture
   * @param {number} [opts.rsId]     unlocks re-points waiting on this rsId
   * @param {"U-TEX"|"U-NRA"} [opts.cls]
   * @param {number} [opts.bytes]
   * @param {number} [opts.tileKey]  for slot-vacation purge
   * @param {()=>void} [opts.mark]   extra marking (layer marks) run in BOTH
   *                                 arms — the nullRender rule marks, never uploads
   * @param {()=>void} [opts.onStaged]
   */
  enqueueTexture({ texture, rsId = 0, cls = "U-TEX", bytes = 0, tileKey, mark, onStaged }) {
    this._queue.push({
      kind: "texture", texture, rsId: rsId >>> 0, cls, bytes: bytes | 0,
      tileKey, mark, onStaged, frameEnqueued: this._frame,
    });
    return this;
  }

  /**
   * A material/pool re-point that must not run before its texture staged
   * (pass-08 D-08.5 rule 2). Deferred, never reordered ahead.
   */
  enqueueRepoint(rsId, fn, tileKey) {
    this._repoints.push({ rsId: rsId >>> 0, fn, tileKey, frameEnqueued: this._frame });
    return this;
  }

  /**
   * An EXCLUSIVE item — runs only as the sole item of a frame's slot
   * (array allocation/growth doubling, the terrain t1024 pair). P-88MIB
   * measured the largest of these at 87–96 ms whole / ~44 ms split.
   */
  enqueueExclusive(name, fn, { bytes = 0, tileKey } = {}) {
    this._exclusive.push({ kind: "exclusive", name, fn, bytes, tileKey, frameEnqueued: this._frame });
    return this;
  }

  /**
   * Chunked grow re-mark: ≤ GROW_LAYER_REMARKS_PER_FRAME layers per frame
   * until the prefix is re-homed (D-08.5 rule 5).
   */
  enqueueGrowRemark(markLayerFn, layerCount, tileKey) {
    for (let i = 0; i < layerCount; i++) {
      this._queue.push({
        kind: "grow", markLayer: markLayerFn, layer: i, cls: "U-TEX",
        bytes: 0, tileKey, frameEnqueued: this._frame,
      });
    }
    return this;
  }

  /** Feed byte accounting (buffers have no staging API — the cap is upstream,
   *  this is where it is OBSERVED). Returns false when the frame's U-BUF
   *  budget is spent, which is the feed's signal to stop appending. */
  noteBufferBytes(bytes) {
    this._spentBytes["U-BUF"] += bytes | 0;
    this.stats.stagedBytesByClass["U-BUF"] += bytes | 0;
    return this._spentBytes["U-BUF"] < this.budgets["U-BUF"].bytes;
  }

  bufferBudgetLeft() {
    return Math.max(0, this.budgets["U-BUF"].bytes - this._spentBytes["U-BUF"]);
  }

  hasPending() {
    return this._queue.length > 0 || this._exclusive.length > 0 || this._repoints.length > 0;
  }

  /** Slot vacation (pass-08 S2.6) — purge this tile's queued uploads. */
  purgeByTile(tileKey) {
    let n = 0;
    const keep = (q) => q.filter((it) => {
      if (it.tileKey !== undefined && it.tileKey === tileKey) { n += 1; return false; }
      return true;
    });
    this._queue = keep(this._queue);
    this._exclusive = keep(this._exclusive);
    this._repoints = keep(this._repoints);
    return n;
  }

  // ── the slot (a W2 item calls this) ─────────────────────────────────────

  beginFrame() {
    this._frame += 1;
    this._spentBytes = { "U-TEX": 0, "U-BUF": 0, "U-NRA": 0 };
    this._spentItems = { "U-TEX": 0, "U-BUF": 0, "U-NRA": 0 };
    this._growThisFrame = 0;
    this._ranThisFrame = false;
  }

  _budgetAllows(cls, bytes) {
    const b = this.budgets[cls] || this.budgets["U-TEX"];
    if (this._spentItems[cls] >= b.items) return false;
    if (this._spentItems[cls] > 0 && this._spentBytes[cls] + bytes > b.bytes) return false;
    return true;
  }

  _stageTexture(it) {
    // F-11.10: marks in BOTH arms; `initTexture` in the render arm only.
    try {
      if (it.texture && it.texture.isTexture !== false) it.texture.needsUpdate = true;
      if (typeof it.mark === "function") it.mark();
    } catch (e) {
      this.stats.lastError = String(e && e.message || e);
    }
    if (this.nullRender) {
      this.stats.marksOnly += 1;
    } else if (this.renderer && typeof this.renderer.initTexture === "function") {
      try {
        this.renderer.initTexture(it.texture);
        this.stats.initTextureCalls += 1;
      } catch (e) {
        this.stats.lastError = String(e && e.message || e);
      }
    } else {
      // No renderer surface: the driver will upload at next bind, which is
      // exactly the behaviour stage C exists to replace. Counted, not hidden.
      this.stats.noRenderer += 1;
    }
    if (it.rsId) this._staged.add(it.rsId);
    if (typeof it.onStaged === "function") {
      try { it.onStaged(); } catch (e) { this.stats.lastError = String(e && e.message || e); }
    }
  }

  /**
   * Drain under a byte/item budget. Returns the number of items run.
   * `deadline()` (optional) lets the FrameWorkScheduler cut the batch on ms.
   */
  drain(deadline = null) {
    let ran = 0;

    // Exclusive items run ONLY as the sole item of a frame's slot.
    if (!this._ranThisFrame && this._exclusive.length > 0) {
      const it = this._exclusive.shift();
      const t0 = this.now();
      try { it.fn(); } catch (e) { this.stats.lastError = String(e && e.message || e); }
      const ms = this.now() - t0;
      this.stats.exclusiveRuns += 1;
      if (ms > this.stats.maxItemMs) this.stats.maxItemMs = ms;
      this.stats.exclusive.push({ name: it.name, ms, frame: this._frame });
      if (this.stats.exclusive.length > 16) this.stats.exclusive.shift();
      this._ranThisFrame = true;
      this._publishDepth();
      return 1; // sole item of the frame, by contract
    }

    while (this._queue.length > 0) {
      const it = this._queue[0];
      const cls = it.cls || "U-TEX";
      if (!this._budgetAllows(cls, it.bytes)) { this.stats.deferredByBudget += 1; break; }
      if (ran > 0 && typeof deadline === "function" && deadline()) break;
      this._queue.shift();
      const t0 = this.now();
      if (it.kind === "grow") {
        // D-08.5 rule 5 — the grow re-mark is CHUNKED at
        // GROW_LAYER_REMARKS_PER_FRAME layers, never a whole-prefix re-mark.
        if (this._growThisFrame >= GROW_LAYER_REMARKS_PER_FRAME) {
          this._queue.unshift(it);
          this.stats.deferredByBudget += 1;
          break;
        }
        try { it.markLayer(it.layer); } catch (e) { this.stats.lastError = String(e && e.message || e); }
        this._growThisFrame += 1;
        this.stats.growRemarks += 1;
      } else {
        this._stageTexture(it);
      }
      const ms = this.now() - t0;
      if (ms > this.stats.maxItemMs) this.stats.maxItemMs = ms;
      this._spentBytes[cls] += it.bytes | 0;
      this._spentItems[cls] += 1;
      this.stats.stagedBytesByClass[cls] += it.bytes | 0;
      this.stats.itemsByClass[cls] += 1;
      ran += 1;
      this._ranThisFrame = true;
    }

    // Re-points LAST, and only for rsIds that have actually staged. This is
    // the ordering invariant's teeth: a re-point whose texture has not been
    // uploaded DEFERS rather than exposing an unuploaded texture.
    if (this._repoints.length > 0) {
      const held = [];
      for (const rp of this._repoints) {
        if (!this._staged.has(rp.rsId)) { this.stats.repointsDeferred += 1; held.push(rp); continue; }
        try { rp.fn(); this.stats.repointsRun += 1; } catch (e) { this.stats.lastError = String(e && e.message || e); }
        ran += 1;
        this._ranThisFrame = true;
      }
      this._repoints = held;
    }

    this._publishDepth();
    return ran;
  }

  _publishDepth() {
    this.stats.queueDepth = this._queue.length + this._exclusive.length + this._repoints.length;
  }

  /** Has rsId's texture been staged? (the ordering predicate the pool feed
   *  asks before flipping a tile LIVE) */
  isStaged(rsId) {
    return this._staged.has(rsId >>> 0);
  }

  /** Write into the FrameWorkScheduler's `uploads` bag (pass-08 S7). */
  statsInto(uploads) {
    const u = uploads || {};
    u.stagedBytesByClass = this.stats.stagedBytesByClass;
    u.initTextureCalls = this.stats.initTextureCalls;
    u.marksOnly = this.stats.marksOnly;
    u.exclusive = this.stats.exclusive;
    u.exclusiveItems = this.stats.exclusive.map((e) => e.name);
    u.queueDepth = this.stats.queueDepth;
    u.repointsDeferred = this.stats.repointsDeferred;
    return u;
  }
}
