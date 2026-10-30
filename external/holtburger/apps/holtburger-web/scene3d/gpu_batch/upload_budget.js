// scene3d/gpu_batch/upload_budget.js — R3-3 K2: the per-frame upload cap
// (docs/2026-10-29-round3-gpu-driven.md §R3-3 item 4; lessons doc L12).
//
// ONE byte-denominated budget per frame for everything the GPU batch kit
// uploads, so a streaming burst (a landblock crossing, a crowd spawn) spreads
// over frames instead of hitching:
//   - texture uploads: layer admits (texSubImage3D / copyTexSubImage3D /
//     compressedTexSubImage3D) and row-texture growth;
//   - geometry (BufferAttribute) uploads of kit consumers (R3-3's merged
//     anim-scenery geometry, R3-4's merged entity geometry, R3-5's per-LB
//     interior batches).
// Layer admits are ALSO counted (`admitsPerFrame`): OpenAC caps composite
// uploads at 16 per frame and 8 MiB (CompositeTextureArrayCache.cs:238/:240;
// StreamingWorkBudgetOptions.cs:17-25). Start: 8 MiB + 16 admits [D]; the S1
// session measures.
//
// CONTRACT FOR CONSUMERS. A new or grown kit resource becomes VISIBLE (and so
// uploads) only in a frame whose budget admitted its bytes; until then the
// consumer keeps its previous state (the legacy meshes, or the batch before
// the append). `trySpend` / `spendDeferred` are that gate. Work that can wait
// goes through the FIFO (`enqueue` / `drain`): strict arrival order, so
// nothing starves.
//
// THE CAP HOLDS PER UPLOAD FRAME (K3, 2026-10-30). A "frame" is one rAF
// frame (`beginFrame(rafTimestamp)`), and the bytes that count against it are
// the bytes that reach GL in it. The kinds reach GL at different times:
//   - IMMEDIATE (`layer`): the GL upload happens INSIDE the call (ArrayPages
//     issues three's initTexture of the source and the per-level copies /
//     compressed uploads before admit() returns) — in the charging frame.
//   - DEFERRED (`rowGrow`, `geometry`): three uploads the resource at its
//     NEXT RENDER that draws it. In the app the render loop runs BEFORE the
//     consumers' rAF ticks (scene3d/index.js registers its rAF first), so
//     that render is in the NEXT rAF frame, next to that frame's layer
//     admits; with the portal / `?targetFps` pacing (a setTimeout-armed render
//     rAF) the order can flip, and paced or on-demand renders can skip
//     frames, so it can also be the same frame or a later one.
// So a deferred spend is booked in the charging frame (it may upload after
// the tick, in the same rAF) AND carried into every following frame's budget
// (`carriedBytes`, the first thing each `beginFrame` books) until the first
// frame that begins after its upload was seen. Whichever rAF the uploading
// render falls in, that frame's budget already holds the bytes, and what the
// frame admits besides (layers, other geometry) gets only the rest:
//   carried deferred bytes + this frame's spends <= bytesPerFrame.
// Two ways to spend a deferred kind:
//   - `trySpend(bytes, kind)`: the resource draws (and so uploads) at the
//     very next render — carried into the next frame once.
//   - `spendDeferred(bytes, kind)` -> ticket: the bytes stay carried until the
//     consumer reports the upload, `land(ticket, bytes)` from three's upload
//     callbacks (BufferAttribute.onUploadCallback, Texture.onUpdate; part by
//     part is fine), and then once more. A resource dropped before it
//     uploaded is `drop(ticket)`ped (nothing carried any more). A ticket held
//     DEFERRED_HOLD_FRAMES frames without landing stops being carried
//     (`stats.expired`): a liveness valve, so a resource that never draws
//     cannot shrink every later frame's budget for good.
// The conservative side: a deferred upload is booked in two frames (the one
// it was charged in and the one it landed before), so in the worst case kit
// geometry streams at half the cap per frame. R3-4 / R3-5 reuse this.
//
// OVERSIZE RULE. A single upload larger than the whole per-frame budget would
// never fit; it is admitted ALONE: as the first spend of a frame (counted in
// `stats.oversize`), and only when nothing else can reach GL in the same rAF
// frame — an immediate (layer) oversize waits until nothing is carried in
// (a carried upload lands in this frame's render), a deferred one until no
// deferred upload is still pending (it would land in the same render).
// Everything else that frame is then refused.
//
// TIMINGS (S1, K3). `addMs(kind, ms, phase)`: CPU milliseconds the consumers
// measured around their uploads (performance.now; plain number adds, no
// allocation): `stats.ms` / `stats.maxMs` / `stats.timed` per kind, and
// `stats.phaseMs` for where the geometry milliseconds went (the merge at the
// charge, three's attribute uploads, the first draw).
//
// Pure (no GL, no three): the node suite drives it directly.

export const UPLOAD_BYTES_PER_FRAME_DEFAULT = 8 * 1024 * 1024;
export const UPLOAD_ADMITS_PER_FRAME_DEFAULT = 16;
/** Frames a held (`spendDeferred`) ticket is carried without landing before it expires. */
export const DEFERRED_HOLD_FRAMES = 600;

/** Upload kinds. Only `layer` counts against the admit cap. */
export const UPLOAD_KIND = Object.freeze({ LAYER: "layer", ROW_GROW: "rowGrow", GEOMETRY: "geometry" });

/** The kinds three uploads at its next render (not inside the call): carried. */
export const DEFERRED_UPLOAD_KINDS = Object.freeze([UPLOAD_KIND.ROW_GROW, UPLOAD_KIND.GEOMETRY]);

/** Does `kind` reach GL at the next render (true) or inside the call (false)? */
export function isDeferredUpload(kind) {
  return kind === UPLOAD_KIND.ROW_GROW || kind === UPLOAD_KIND.GEOMETRY;
}

/** The kit's clock for upload timings (ms). */
export const uploadNowMs = (typeof performance !== "undefined" && typeof performance.now === "function")
  ? () => performance.now()
  : () => Date.now();

// Ticket states.
const T_OPEN = 0;    // charged, not (fully) uploaded: carried every frame
const T_LANDED = 1;  // uploaded since the last beginFrame: carried once more
const T_DONE = 2;    // carried into the frame its upload fell in: finished
const T_VOID = 3;    // dropped before it uploaded
const T_EXPIRED = 4; // held too long: no longer carried

export class UploadBudget {
  /**
   * @param {object} [opts]
   * @param {number} [opts.bytesPerFrame]
   * @param {number} [opts.admitsPerFrame]
   */
  constructor(opts = {}) {
    this.bytesPerFrame = Math.max(1, opts.bytesPerFrame ?? UPLOAD_BYTES_PER_FRAME_DEFAULT);
    this.admitsPerFrame = Math.max(1, opts.admitsPerFrame ?? UPLOAD_ADMITS_PER_FRAME_DEFAULT);
    this.frame = -1;
    /** Bytes booked against this frame: carried + this frame's own spends. */
    this.spentBytes = 0;
    this.spentAdmits = 0;
    /** Deferred bytes of earlier frames that (may) reach GL in this frame. */
    this.carriedBytes = 0;
    this._ownBytes = 0;
    this._seq = 0;
    this._held = []; // deferred tickets still to be carried
    this._open = 0;  // of which still waiting for their upload
    this._queue = [];
    this._head = 0;
    this.stats = {
      frames: 0, bytes: 0, admits: 0, granted: 0, refused: 0, oversize: 0,
      maxQueue: 0, maxFrameBytes: 0, byKind: { layer: 0, rowGrow: 0, geometry: 0 },
      carried: 0, maxCarried: 0, tickets: 0, landed: 0, dropped: 0, expired: 0,
      ms: { layer: 0, rowGrow: 0, geometry: 0 },
      maxMs: { layer: 0, rowGrow: 0, geometry: 0 },
      timed: { layer: 0, rowGrow: 0, geometry: 0 },
      phaseMs: { geometryBuild: 0, geometryUpload: 0, geometryFirstDraw: 0 },
    };
  }

  /**
   * Start a frame: the budget refills, less what earlier deferred uploads
   * carry into it (see the header). Idempotent per `frameId`.
   */
  beginFrame(frameId) {
    if (frameId !== undefined && frameId === this.frame) return;
    this.frame = frameId !== undefined ? frameId : this.frame + 1;
    this._seq += 1;
    let carry = 0;
    let w = 0;
    const held = this._held;
    for (let i = 0; i < held.length; i += 1) {
      const t = held[i];
      if (t.state === T_VOID) continue;
      if (t.state === T_OPEN && this._seq - t.seq > DEFERRED_HOLD_FRAMES) {
        t.state = T_EXPIRED;
        this._open -= 1;
        this.stats.expired += 1;
        continue;
      }
      carry += t.bytes;
      if (t.state === T_LANDED) { t.state = T_DONE; continue; }
      held[w] = t;
      w += 1;
    }
    held.length = w;
    this.carriedBytes = carry;
    this.spentBytes = carry;
    this._ownBytes = 0;
    this.spentAdmits = 0;
    this.stats.frames += 1;
    this.stats.carried += carry;
    if (carry > this.stats.maxCarried) this.stats.maxCarried = carry;
    if (carry > this.stats.maxFrameBytes) this.stats.maxFrameBytes = carry;
  }

  /** Bytes left this frame. */
  remainingBytes() {
    return Math.max(0, this.bytesPerFrame - this.spentBytes);
  }

  /** Would `trySpend(bytes, kind)` succeed? No side effects. */
  canSpend(bytes, kind) {
    const b = Math.max(0, bytes | 0);
    const isLayer = kind === UPLOAD_KIND.LAYER;
    if (isLayer && this.spentAdmits >= this.admitsPerFrame) return false;
    if (this.spentBytes + b <= this.bytesPerFrame) return true;
    // Oversize: alone — the first spend of this frame, with nothing else
    // reaching GL in the same rAF frame (see the header).
    if (b <= this.bytesPerFrame || this._ownBytes !== 0 || this.spentAdmits !== 0) return false;
    return isDeferredUpload(kind) ? this._open === 0 : this.carriedBytes === 0;
  }

  _book(b, kind) {
    if (this._ownBytes === 0 && this.spentAdmits === 0 && b > this.bytesPerFrame) this.stats.oversize += 1;
    this.spentBytes += b;
    this._ownBytes += b;
    if (kind === UPLOAD_KIND.LAYER) { this.spentAdmits += 1; this.stats.admits += 1; }
    this.stats.bytes += b;
    this.stats.granted += 1;
    if (this.stats.byKind[kind] !== undefined) this.stats.byKind[kind] += b;
    if (this.spentBytes > this.stats.maxFrameBytes) this.stats.maxFrameBytes = this.spentBytes;
  }

  _hold(b, kind, state) {
    const t = { bytes: b, kind, seq: this._seq, state, remaining: b };
    this._held.push(t);
    if (state === T_OPEN) this._open += 1;
    this.stats.tickets += 1;
    return t;
  }

  /**
   * Spend now if the frame has room; returns whether the upload may happen.
   * A deferred kind (`rowGrow`, `geometry`) is also carried into the next
   * frame: it uploads at the next render (see the header).
   */
  trySpend(bytes, kind) {
    if (!this.canSpend(bytes, kind)) { this.stats.refused += 1; return false; }
    const b = Math.max(0, bytes | 0);
    this._book(b, kind);
    if (isDeferredUpload(kind)) this._hold(b, kind, T_LANDED);
    return true;
  }

  /**
   * A deferred spend whose upload the consumer reports: the same gate as
   * `trySpend`; returns a ticket (null when refused). Its bytes are booked
   * now and carried into every following frame until the frame that begins
   * after `land(ticket)` took its last byte (or `drop(ticket)`).
   */
  spendDeferred(bytes, kind) {
    if (!this.canSpend(bytes, kind)) { this.stats.refused += 1; return null; }
    const b = Math.max(0, bytes | 0);
    this._book(b, kind);
    return this._hold(b, kind, b > 0 ? T_OPEN : T_LANDED);
  }

  /** `bytes` (default: all that is left) of a ticket reached GL. */
  land(ticket, bytes) {
    if (!ticket || ticket.state !== T_OPEN) return;
    ticket.remaining = bytes === undefined ? 0 : ticket.remaining - Math.max(0, bytes | 0);
    if (ticket.remaining <= 0) {
      ticket.remaining = 0;
      ticket.state = T_LANDED;
      this._open -= 1;
      this.stats.landed += 1;
    }
  }

  /**
   * The resource behind `ticket` was dropped before (all of) it uploaded:
   * stop carrying it. What already landed is still carried once.
   */
  drop(ticket) {
    if (!ticket || ticket.state !== T_OPEN) return;
    ticket.state = ticket.remaining < ticket.bytes ? T_LANDED : T_VOID;
    this._open -= 1;
    this.stats.dropped += 1;
  }

  /** Is `ticket` still waiting for its upload? */
  isOpen(ticket) {
    return !!ticket && ticket.state === T_OPEN;
  }

  /** Deferred tickets still carried (diag / tests). */
  heldTickets() {
    return this._held.length;
  }

  /** Deferred uploads charged and still waiting for three to upload them. */
  openTickets() {
    return this._open;
  }

  /**
   * CPU milliseconds a consumer measured around an upload of `kind`
   * (`phase`: one of `stats.phaseMs`, optional). Numbers only.
   */
  addMs(kind, ms, phase) {
    if (!(ms >= 0)) return;
    const s = this.stats;
    if (s.ms[kind] === undefined) return;
    s.ms[kind] += ms;
    s.timed[kind] += 1;
    if (ms > s.maxMs[kind]) s.maxMs[kind] = ms;
    if (phase !== undefined && s.phaseMs[phase] !== undefined) s.phaseMs[phase] += ms;
  }

  /**
   * Queue a job `{ bytes, kind, run }`; `run()` is called by `drain()` in a
   * frame that admits its bytes. Returns the queue length.
   */
  enqueue(job) {
    this._queue.push(job);
    const n = this._queue.length - this._head;
    if (n > this.stats.maxQueue) this.stats.maxQueue = n;
    return n;
  }

  /** Jobs waiting. */
  pending() {
    return this._queue.length - this._head;
  }

  /**
   * Run queued jobs in arrival order while the frame admits them; stops at
   * the first refusal (head-of-line: a big job is never overtaken, so it
   * cannot starve — at worst it waits for a fresh frame and the oversize
   * rule). A job whose `run()` returns false is dropped (it no longer
   * applies), its bytes still spent. Returns the number of jobs run.
   */
  drain() {
    let ran = 0;
    while (this._head < this._queue.length) {
      const job = this._queue[this._head];
      if (!this.trySpend(job.bytes, job.kind)) break;
      this._queue[this._head] = undefined;
      this._head += 1;
      ran += 1;
      try { job.run(); } catch (_) { /* a consumer failure must not wedge the queue */ }
    }
    if (this._head > 64 && this._head * 2 > this._queue.length) {
      this._queue = this._queue.slice(this._head);
      this._head = 0;
    }
    return ran;
  }

  /** Drop queued jobs matching `pred` (a consumer tore its resource down). */
  cancel(pred) {
    let n = 0;
    const keep = [];
    for (let i = this._head; i < this._queue.length; i += 1) {
      const j = this._queue[i];
      if (pred(j)) n += 1; else keep.push(j);
    }
    this._queue = keep;
    this._head = 0;
    return n;
  }
}
