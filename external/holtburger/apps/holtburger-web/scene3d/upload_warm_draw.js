// scene3d/upload_warm_draw.js — `?uploadWarmDraw` (round 3 R3-2, 2026-10-30,
// DEFAULT OFF, `=on` opt-in; read once through rustFlag).
//
// THE HITCH. three uploads a geometry's vertex and index buffers lazily, the
// first frame something draws it (WebGLObjects.update → WebGLGeometries.update
// → WebGLAttributes, then the index in bindingStates.setup). Streamed content
// that arrives out of view therefore pays all its buffer uploads on the first
// camera turn that reveals it, together with everything else revealed by that
// turn (the 10-06 1070 census: 118 MB of buffer uploads and 1,887 objects drawn
// for the first time in a 12 s street sweep; first-turn max 686-1,645 ms in
// every RC-BENCH v2 arm).
//
// THE PATTERN (WebAC scene/RendererWarmup.ts:49-57, `warmAddedDuringPlay`):
// draw each newly arrived subtree once, at arrival, into a 1x1 scissor with an
// unlit override material, so its upload lands on the (budgeted) arrival frame
// instead of the turn. WebAC: turning max frame 208 ms → 18.5-18.7 ms with a
// fixed light count and warm-up (docs/performance-budgets.md:205-210, M3 Max).
//
// HOW IT IS DONE HERE (and where it differs from WebAC).
//   - Arrival: a `childadded` listener on the world groups (index.js passes
//     worldRoot, terrain, buildings, statics, cells, entities). Each new direct
//     child (a ROOT) is queued once. A geometry is drawn once, whichever
//     subtree brought it (WeakSet). A `childremoved` listener on the same
//     groups releases a root the moment it leaves (see EVICTION).
//   - Tick (index.js, once per frame, before the frame's render): queued roots
//     still in the scene are walked depth-first, visible nodes only (a hidden
//     node's subtree is skipped, as three's projectObject skips it), and every
//     not-yet-warmed Mesh geometry gets one PROXY Mesh: the shared geometry,
//     the module's unlit MeshBasicMaterial, frustumCulled off, under a private
//     Scene. One `renderer.render` of that Scene into a private 1x1 HalfFloat
//     target, scissored to (0,0,1,1), uploads exactly the buffers the real
//     first draw would have uploaded (three uploads every attribute of the
//     geometry and its index, whatever the program reads).
//   - WebAC draws the live subtree. Drawing PROXIES instead means no live
//     object's onBeforeRender runs against a foreign camera (BatchedMesh
//     per-camera range rebuilds, LOD.update, per-object uniform hooks), no LOD
//     level is re-selected, no instancing / batching program variant is
//     compiled, and nothing in the scene graph is touched.
//   - PROGRAMS: exactly two, one per r184 `vertexNormals` key bit (the only
//     geometry-dependent bit of a MeshBasicMaterial key for a plain Mesh: no
//     maps, no vertex colours, morph skipped). Each has its OWN material
//     (`_matP` position-only, `_matN` position + normal) and every proxy gets
//     the material of its geometry's variant. One material per variant matters:
//     three's compileAsync waits only on each material's `currentProgram`, so
//     with one shared material it awaited the last-prepared variant only, and
//     r184 setProgram does not re-key on vertexNormals, so whichever variant the
//     first proxy picked was drawn, ready or not (a synchronous link wait on the
//     1070, the hitch this flag exists to remove). Here the first tick with work
//     calls `renderer.compile` (the private target bound, so the key matches
//     the warm draw) and draws nothing; every later tick polls BOTH variants'
//     `program.isReady()` (KHR_parallel_shader_compile COMPLETION_STATUS,
//     non-blocking; cached true once linked, then no GL call) and draws only
//     when both are linked. A variant that loses its program (context restore
//     builds a new program cache) sends the module back through the compile
//     before any further draw (`stats.recompiles`). The private Scene carries no
//     `overrideMaterial`: an override would put both variants on one material
//     again. The proxies carry the unlit material themselves, so a live
//     material is never drawn either way.
//   - LATE CONTENT AND HIDDEN ROOTS (the WATCH). A root whose walk finished is
//     not done for good: content can be added under it later (BatchedMesh chunk
//     buckets replace `geometry` when `setGeometrySize` grows them; a BatchedMesh
//     added empty gets its first geometry later; ?interiorWallsFirst props land
//     in a cell container after the walls), and parts of it can be hidden at
//     its walk and shown later (PVS cells, degrade / LOD parts). A root that is
//     hidden at its first walk (itself or an ancestor) is not dropped either.
//     Both kinds of root go into a watch ring that is re-walked round robin,
//     visible nodes only, resuming where the last frame stopped. A geometry
//     already warmed costs a WeakSet test, so a pass over unchanged content
//     draws nothing and issues no GL call. A watched root removed from its
//     group is released at once (EVICTION); one that left the scene some other
//     way (its whole group detached) is released when the cursor reaches it.
//     A re-add queues a released root again.
//   - RESUMED WALKS. A walk that runs out of budget keeps its stack (parent,
//     next child) and resumes next frame; children are read live. Before it
//     reads any child, the resume re-checks the root (it must still reach the
//     scene, visibly) and EVERY stacked node (still a child of the node below
//     it, still visible). The stack is cut at the first node that fails: a
//     subtree removed since the pause, its geometries often disposed by then,
//     is never drawn (a draw would re-register the geometry with three and
//     re-create GL buffers that no dispose() would ever free), and a subtree
//     hidden since is not warmed while hidden (the watch warms it once shown).
//     `stats.prunedFrames` counts the cuts. The walk stacks at most
//     UPLOAD_WARM_MAX_WALK_DEPTH (32) nodes, the root included, so a resume
//     costs at most 32 visits, and every node budget is clamped to at least
//     33 (UPLOAD_WARM_MIN_NODE_BUDGET), so a walk always progresses (a
//     budget of 1 would stall: the resume's root check alone spends it).
//     Nodes more than 32 levels below their root are not walked
//     (`stats.depthCapped` counts the cuts; this client's graph is a few
//     levels deep, and three still uploads such content at its first draw).
//   - EVICTION (what the module holds, and until when). Every strong reference
//     to scene content is released promptly after the content leaves, at a
//     bounded cost, including during a streaming burst whose arrivals spend
//     the whole draw / byte budget every frame (a STARVED frame: no watch walk):
//       * a queued root (FIFO, at most UPLOAD_WARM_MAX_PENDING), the arrival
//         walk's root and the watch ring slot of a root (at most
//         UPLOAD_WARM_MAX_WATCHED) are released by the `childremoved` listener
//         when the root is removed from its group: O(1) (a WeakMap holds each
//         root's queue / ring slot). The ring release keeps the pass intact: a
//         slot before the cursor is refilled from the visited part, so no
//         unvisited root is skipped for a pass. Released queue slots are
//         squeezed out once more than UPLOAD_WARM_MAX_DEAD_SLOTS pile up
//         behind a slow head (O(live), amortized over the removals). Three
//         fires `childremoved` before the new parent's `childadded`, so a root
//         moved to another group is released and queued again;
//       * the stacks of a paused walk (at most 32 nodes each) hold nodes below
//         a root: both are re-checked on the next tick (above) and cut where a
//         node left, the watch walk's even on a starved frame (charged to the
//         watch budget, which a starved frame does not otherwise use);
//       * three keeps a render's items (proxy, geometry, material) in the
//         rendered scene's render list until that scene renders again, so the
//         private Scene's list is cleared after each warm render (no GL call):
//         the last warm batch's geometries, CPU arrays included, are not held
//         until the next warm render. The proxies get an empty geometry back.
//     Geometries already warmed, roots hidden at their first walk and roots
//     queued or watched are tracked in WeakSets / WeakMaps (no strong ref).
//   - BOUND (per frame, flag on): at most UPLOAD_WARM_MAX_NODES_PER_FRAME (1024)
//     node visits for arrivals plus UPLOAD_WARM_RESCAN_NODES_PER_FRAME (256) for
//     the watch. A visit reads one node's `visible` flag (and tests its
//     geometry), and every read of a root or of a node below one is charged:
//     a root examination (arrival or watch, new or resumed, hidden or
//     detached) is one visit, and so is each stacked node re-checked on a
//     resume. Not charged, on top: a root examination also walks the root's
//     ancestors up to the scene (at most 64; two or three in this client's
//     graph), finished stack frames are popped (one pop per pushed frame), a
//     queue slot released by the removal listener is stepped over (no node
//     read; once per slot), and the watch makes at most one pass over its ring
//     per frame. Never a whole-scene walk. The `childremoved` listener reads no
//     node: O(1) per removed root, at the removal (outside the tick).
//     Measured (node, laptop, a cold 10k-node watch): ~30 us
//     per frame for the 256-visit slice, ~0.12 us per visit, dominated by the
//     node loads (cache misses), linear in the budget. The watch runs after
//     the arrivals, on what the draw / byte budget leaves (heavy streaming
//     starves it, by design; a starved frame only re-checks the paused watch
//     walk's stack, at most 32 visits). A late geometry is warmed within one watch pass:
//     ceil(N / (256 - r)) frames, N = visible watched nodes + watched roots,
//     r = a frame's resume re-check (1 + the paused walk's stacked nodes below
//     its root; 1 to 3 for this client's roots), so ~40 frames for 10k nodes.
//   - Not caught: an in-place BatchedMesh add (same geometry, a dirty update
//     range): that is a bufferSubData the bucket's next real draw does, and the
//     bucket's bounds span all its members, so it draws whenever any member is
//     in view. A late geometry that the real render has already drawn is
//     drawn once more (no upload; draw budget bounded).
//   - Budget: at most UPLOAD_WARM_MAX_DRAWS_PER_FRAME proxies and
//     UPLOAD_WARM_MAX_BYTES_PER_FRAME attribute+index bytes per frame, shared
//     by arrivals and the watch (one proxy always goes, so a large geometry
//     still progresses); the rest waits.
//   - What it does not pre-upload: InstancedMesh instanceMatrix/instanceColor
//     and BatchedMesh data textures (object-level, not geometry), morph targets
//     (skipped: a morph variant would compile a third program), textures
//     (WebAC does not either: "a synchronous upload either way").
//   - State: the render target (and with it the framebuffer, viewport, scissor
//     box and scissor test), autoClear, sortObjects and, when `info.autoReset`
//     is off, the info counters are restored on every path. sortObjects is off
//     for the warm render so three never computes a bounding sphere on a
//     shared geometry for the proxies.
//
// FLAG OFF: index.js never installs (`installUploadWarmDraw` returns null
// before allocating anything; no listener; the per-frame tick is one null
// test). Under ?nullRender (`opts.nullRender`) it returns null too: no GPU work
// there, so no listener and no queue. No import side effects.
//
// STATS (`window.__uploadWarmDraw.stats()`; every key it returns, cumulative
// unless noted):
//   noted              roots queued by the `childadded` listener
//   roots              arrival walks completed (the root then joins the watch)
//   renders            warm renders (one per tick that drew)
//   draws              proxy draws (one per geometry warmed)
//   bytes              attribute + index bytes of those geometries
//   lateDraws          draws found by the watch (late content, parts / roots shown later)
//   lastDraws          draws of the latest tick (not cumulative)
//   droppedDetached    arrivals dropped because they left the scene before or during their walk
//   deferredHidden     arrivals parked in the watch because they (or an ancestor) were hidden
//   droppedHidden      roots parked hidden at arrival that left (or could not join) the watch before ever showing
//   droppedOverflow    queued roots dropped by the pending cap
//   droppedWatch       roots not watched because the watch was full
//   released           watch slots released (by the removal listener or the cursor)
//   releasedOnRemove   roots released by the `childremoved` listener (queue slot, arrival walk or watch slot)
//   rescanVisits       node visits charged to the watch budget
//   rescanCycles       full passes over the watch ring
//   prunedFrames       paused-walk stacks cut on resume (a node removed or hidden since the pause)
//   depthCapped        children not descended past UPLOAD_WARM_MAX_WALK_DEPTH
//   skippedMorph       geometries with morph targets, skipped
//   deferredFrames     ticks whose draw / byte budget ran out (starved the watch)
//   compileWaitFrames  ticks with work that waited for the two variant programs
//   recompiles         compiles redone because a variant lost its program (context restore)
//   pending            arrivals not yet fully walked (now; the walk in progress included)
//   watched            roots in the watch ring (now)
//   ready              both variant programs linked (now)
//
// Tests: tests/upload_warm_draw.test.mjs.

import * as THREE from "three";
import { rustFlag } from "./rust/scene_core.js";

/** `?uploadWarmDraw=on` (DEFAULT OFF). */
export function uploadWarmDrawEnabled() {
  return rustFlag("uploadWarmDraw", false);
}

export const UPLOAD_WARM_MAX_DRAWS_PER_FRAME = 32;
export const UPLOAD_WARM_MAX_BYTES_PER_FRAME = 4 * 1024 * 1024;
/**
 * Pending-root cap. Queued roots are held strongly until their walk or their
 * removal from their group (the `childremoved` listener); if the program
 * never becomes ready (a lost context) the oldest are dropped instead of
 * growing the queue without bound.
 */
export const UPLOAD_WARM_MAX_PENDING = 2048;
/**
 * Queue slots released by the removal listener that may pile up behind a
 * slow head before they are squeezed out (keeps the queue array bounded).
 */
export const UPLOAD_WARM_MAX_DEAD_SLOTS = 1024;
/** Node visits per frame for the walk of arrived roots. */
export const UPLOAD_WARM_MAX_NODES_PER_FRAME = 1024;
/** Node visits per frame for the round-robin re-walk of watched roots. */
export const UPLOAD_WARM_RESCAN_NODES_PER_FRAME = 256;
/** Watched-root cap (a root over the cap is not watched: `stats.droppedWatch`). */
export const UPLOAD_WARM_MAX_WATCHED = 8192;
/** Parent-chain depth the "still in the scene" test walks before giving up. */
const MAX_ANCESTRY = 64;
/**
 * Most nodes a walk stacks (the root included). It bounds the re-check of a
 * resumed walk (one visit for the root, one per stacked node below it).
 */
export const UPLOAD_WARM_MAX_WALK_DEPTH = 32;
/** Smallest node budget: a resume (at most UPLOAD_WARM_MAX_WALK_DEPTH visits) always leaves one visit for progress. */
export const UPLOAD_WARM_MIN_NODE_BUDGET = UPLOAD_WARM_MAX_WALK_DEPTH + 1;

const REACH_DETACHED = 0;
const REACH_HIDDEN = 1;
const REACH_VISIBLE = 2;

function _geometryBytes(g) {
  let n = 0;
  const attrs = g.attributes;
  for (const k in attrs) {
    const a = attrs[k];
    const arr = a && (a.isInterleavedBufferAttribute ? a.data && a.data.array : a.array);
    if (arr && typeof arr.byteLength === "number") n += arr.byteLength;
  }
  const idx = g.index;
  if (idx && idx.array && typeof idx.array.byteLength === "number") n += idx.array.byteLength;
  return n;
}

function _hasMorph(g) {
  const m = g.morphAttributes;
  if (!m) return false;
  for (const k in m) if (m[k] && m[k].length > 0) return true;
  return false;
}

/**
 * A resumable depth-first walk: parallel stacks of parents and the index of
 * the next child to visit. The bottom frame is a fixed sentinel whose only
 * child is the root, so the root is visited like any other node (`nodes[1]`,
 * once stacked, is the root). Children are read live from their parent at
 * visit time (a child removed meanwhile is simply not there; an index shift
 * skips or repeats one node in this pass). A walk resumed in a later frame is
 * re-checked first (`UploadWarmDraw._resume`).
 */
function _newWalk() {
  return { root: null, nodes: [], idx: [], top: { children: [null] } };
}

function _startWalk(w, root) {
  w.root = root;
  w.top.children[0] = root;
  w.nodes.push(w.top);
  w.idx.push(0);
}

function _clearWalk(w) {
  w.root = null;
  w.top.children[0] = null;
  w.nodes.length = 0;
  w.idx.length = 0;
}

export class UploadWarmDraw {
  /**
   * @param {any} renderer THREE.WebGLRenderer
   * @param {THREE.Scene} scene the live scene (a root must still reach it to be warmed)
   * @param {{maxDraws?: number, maxBytes?: number, maxNodes?: number, rescanNodes?: number, maxWatched?: number}} [opts]
   *   (maxNodes / rescanNodes are clamped to at least UPLOAD_WARM_MIN_NODE_BUDGET)
   */
  constructor(renderer, scene, opts = {}) {
    this.renderer = renderer;
    this.scene = scene;
    this.maxDraws = Math.max(1, opts.maxDraws ?? UPLOAD_WARM_MAX_DRAWS_PER_FRAME);
    this.maxBytes = Math.max(1, opts.maxBytes ?? UPLOAD_WARM_MAX_BYTES_PER_FRAME);
    this.maxNodes = Math.max(UPLOAD_WARM_MIN_NODE_BUDGET, opts.maxNodes ?? UPLOAD_WARM_MAX_NODES_PER_FRAME);
    this.rescanNodes = Math.max(UPLOAD_WARM_MIN_NODE_BUDGET, opts.rescanNodes ?? UPLOAD_WARM_RESCAN_NODES_PER_FRAME);
    this.maxWatched = Math.max(1, opts.maxWatched ?? UPLOAD_WARM_MAX_WATCHED);
    // Arrivals: FIFO of roots (strong refs, capped), plus the walk in progress.
    // A slot released by the removal listener is set to null (stepped over).
    this._queue = [];
    this._head = 0;
    /** Live (non-null) slots in `_queue[_head..]`. */
    this._qLive = 0;
    /** Absolute index of `_queue[0]` (grows as the array is compacted). */
    this._qBase = 0;
    /** Queued root → its absolute queue index (O(1) release on removal). */
    this._qIdx = new WeakMap();
    /** Roots queued or under the arrival walk. */
    this._queued = new WeakSet();
    this._aWalk = _newWalk();
    // The watch: roots re-walked round robin for late content / hidden parts.
    this._watch = [];
    /** Watched root → its ring slot (O(1) release on removal). */
    this._wIdx = new WeakMap();
    this._wCursor = 0;
    this._wWalk = _newWalk();
    /** Roots hidden at their first walk and not seen visible since. */
    this._hiddenOnly = new WeakSet();
    this._warmedGeoms = new WeakSet();
    this._listeners = [];
    this._ready = false;
    this._compiling = false;
    // Lazily built on the first tick with work (_build).
    this._target = null;
    this._camera = null;
    this._root = null;
    this._matP = null;
    this._matN = null;
    this._noChildren = null;
    this._proxies = [];
    this._list = [];
    this._emptyGeom = null;
    // Per-tick scratch.
    this._nodesLeft = 0;
    this._visitBytes = 0;
    this._visitBudgetHit = false;
    this.stats = {
      noted: 0, roots: 0, renders: 0, draws: 0, bytes: 0, lateDraws: 0,
      droppedDetached: 0, deferredHidden: 0, droppedHidden: 0, droppedOverflow: 0, droppedWatch: 0,
      released: 0, releasedOnRemove: 0, rescanVisits: 0, rescanCycles: 0, prunedFrames: 0, depthCapped: 0,
      skippedMorph: 0, deferredFrames: 0, compileWaitFrames: 0, recompiles: 0, lastDraws: 0,
    };
  }

  /** Listen for direct children added to / removed from each of `groups`. */
  attach(groups) {
    for (const g of groups) {
      if (!g || typeof g.addEventListener !== "function") continue;
      const onAdd = (ev) => this.noteAdded(ev && ev.child);
      const onRemove = (ev) => this.noteRemoved(ev && ev.child);
      g.addEventListener("childadded", onAdd);
      g.addEventListener("childremoved", onRemove);
      this._listeners.push([g, "childadded", onAdd], [g, "childremoved", onRemove]);
    }
    return this;
  }

  detach() {
    for (const [g, type, fn] of this._listeners) {
      try { g.removeEventListener(type, fn); } catch (_) { /* best effort */ }
    }
    this._listeners.length = 0;
  }

  /** Queue a newly arrived subtree (once; a watched root is already covered by the watch). */
  noteAdded(obj) {
    if (!obj || obj.isObject3D !== true) return;
    if (this._queued.has(obj) || this._wIdx.has(obj)) return;
    this._queued.add(obj);
    this._qIdx.set(obj, this._qBase + this._queue.length);
    this._queue.push(obj);
    this._qLive += 1;
    this.stats.noted += 1;
    if (this._qLive > UPLOAD_WARM_MAX_PENDING) {
      // Drop the oldest not yet started (a later re-add queues it again).
      while (this._queue[this._head] === null) this._head += 1;
      const old = this._queue[this._head];
      this._queue[this._head] = null;
      this._head += 1;
      this._qLive -= 1;
      this._qIdx.delete(old);
      this._queued.delete(old);
      this.stats.droppedOverflow += 1;
      this._qCompact();
    }
  }

  /**
   * A direct child left a listened group: an unload, or a move (three fires
   * `childremoved` before the new parent's `childadded`, which queues it
   * again). Releases, in O(1) and without reading any node, every strong
   * reference the module holds to it: its queue slot, the arrival or watch
   * walk in progress on it (its stack included), its watch slot.
   */
  noteRemoved(obj) {
    if (!obj || obj.isObject3D !== true) return;
    // Already back under a parent (another listener re-added it): still covered.
    if (obj.parent !== null && obj.parent !== undefined) return;
    let hit = false;
    if (this._queued.has(obj)) {
      if (this._aWalk.root === obj) {
        _clearWalk(this._aWalk);
        hit = true;
      } else {
        const a = this._qIdx.get(obj);
        const i = a === undefined ? -1 : a - this._qBase;
        if (i >= this._head && i < this._queue.length && this._queue[i] === obj) {
          this._queue[i] = null;
          this._qLive -= 1;
          this._qIdx.delete(obj);
          hit = true;
        }
      }
      if (hit) {
        this._queued.delete(obj);
        this.stats.droppedDetached += 1;
      }
    }
    const s = this._wIdx.get(obj);
    if (s !== undefined && this._watch[s] === obj) {
      if (this._wWalk.root === obj) _clearWalk(this._wWalk);
      this._release(s);
      hit = true;
    }
    if (hit) {
      this.stats.releasedOnRemove += 1;
      this._qCompact();
    }
  }

  /**
   * Keep the queue array bounded: reset it once nothing live is left, squeeze
   * released slots out once more than UPLOAD_WARM_MAX_DEAD_SLOTS pile up
   * (O(live); every live root gets its new index), and drop the spent prefix
   * once the head is past 256.
   */
  _qCompact() {
    const q = this._queue;
    if (this._qLive === 0) {
      if (q.length > 0) { this._qBase += q.length; q.length = 0; this._head = 0; }
      return;
    }
    if (q.length - this._head - this._qLive > UPLOAD_WARM_MAX_DEAD_SLOTS) {
      this._qBase += q.length;
      let n = 0;
      for (let i = this._head; i < q.length; i++) {
        const r = q[i];
        if (r !== null) { q[n] = r; this._qIdx.set(r, this._qBase + n); n += 1; }
      }
      q.length = n;
      this._head = 0;
    } else if (this._head > 256) {
      this._qBase += this._head;
      q.splice(0, this._head);
      this._head = 0;
    }
  }

  /** Arrived roots not yet fully walked (the one in progress included). */
  get pending() { return this._qLive + (this._aWalk.root !== null ? 1 : 0); }

  /** Roots under the watch. */
  get watched() { return this._watch.length; }

  /** Detached / in the scene but hidden (itself or an ancestor) / in the scene and visible. */
  _reach(obj) {
    let o = obj;
    let vis = true;
    for (let i = 0; o && i < MAX_ANCESTRY; i++) {
      if (o.visible === false) vis = false;
      if (o === this.scene) return vis ? REACH_VISIBLE : REACH_HIDDEN;
      o = o.parent;
    }
    return REACH_DETACHED;
  }

  _build() {
    if (this._target !== null) return;
    this._target = new THREE.WebGLRenderTarget(1, 1, {
      type: THREE.HalfFloatType,
      depthBuffer: false,
      stencilBuffer: false,
    });
    this._target.texture.name = "uploadWarmDraw.target";
    this._target.texture.generateMipmaps = false;
    this._target.viewport.set(0, 0, 1, 1);
    this._target.scissor.set(0, 0, 1, 1);
    this._target.scissorTest = true;
    this._camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    this._camera.name = "uploadWarmDraw.camera";
    this._camera.updateMatrixWorld(true);
    // The unlit materials, one per vertexNormals variant: no lights, no
    // textures, no fog, no depth.
    this._matP = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, fog: false });
    this._matP.name = "uploadWarmDraw.unlit";
    this._matN = new THREE.MeshBasicMaterial({ color: 0xffffff, depthTest: false, depthWrite: false, fog: false });
    this._matN.name = "uploadWarmDraw.unlitNormals";
    this._root = new THREE.Scene();
    this._root.name = "uploadWarmDraw.root";
    this._root.matrixWorldAutoUpdate = false;
    this._noChildren = this._root.children;
    this._emptyGeom = new THREE.BufferGeometry();
  }

  _proxy(i) {
    let p = this._proxies[i];
    if (!p) {
      p = new THREE.Mesh(this._emptyGeom, this._matP);
      p.name = "uploadWarmDraw.proxy";
      p.frustumCulled = false;
      p.matrixAutoUpdate = false;
      p.matrixWorldAutoUpdate = false;
      this._proxies[i] = p;
    }
    return p;
  }

  /** The variant's program exists and has finished linking (non-blocking poll). */
  _variantReady(mat) {
    const props = this.renderer.properties; // re-read: a context restore replaces it
    const mp = props && typeof props.get === "function" ? props.get(mat) : null;
    const prog = mp ? mp.currentProgram : undefined;
    if (!prog) return false;
    return typeof prog.isReady === "function" ? prog.isReady() === true : true;
  }

  /** Create both variant programs for the private target (their links run in parallel). */
  _compile() {
    const r = this.renderer;
    const tri = [0, 0, 0, 1, 0, 0, 0, 1, 0];
    const seedP = new THREE.BufferGeometry();
    seedP.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
    const seedPN = new THREE.BufferGeometry();
    seedPN.setAttribute("position", new THREE.Float32BufferAttribute(tri, 3));
    seedPN.setAttribute("normal", new THREE.Float32BufferAttribute([0, 0, 1, 0, 0, 1, 0, 0, 1], 3));
    const a = this._proxy(0);
    const b = this._proxy(1);
    a.geometry = seedP;
    a.material = this._matP;
    b.geometry = seedPN;
    b.material = this._matN;
    this._root.children = [a, b];
    const prevTarget = r.getRenderTarget();
    const prevFace = typeof r.getActiveCubeFace === "function" ? r.getActiveCubeFace() : 0;
    const prevMip = typeof r.getActiveMipmapLevel === "function" ? r.getActiveMipmapLevel() : 0;
    try {
      r.setRenderTarget(this._target);
      r.compile(this._root, this._camera);
    } catch (_) {
      /* a failed compile leaves a variant without a program: _variantReady stays false */
    } finally {
      this._root.children = this._noChildren;
      a.geometry = this._emptyGeom;
      b.geometry = this._emptyGeom;
      try { r.setRenderTarget(prevTarget, prevFace, prevMip); } catch (_) { /* restore best effort */ }
      seedP.dispose();
      seedPN.dispose();
    }
  }

  /**
   * True when both variant programs are linked. The tick that starts the
   * compile never draws; later ticks poll until both are ready.
   */
  _ensureReady() {
    if (this._ready) {
      if (this._variantReady(this._matP) && this._variantReady(this._matN)) return true;
      // A variant lost its program (context restore): compile again before any draw.
      this._ready = false;
      this._compiling = false;
      this.stats.recompiles += 1;
    }
    if (!this._compiling) {
      this._compiling = true;
      this._compile();
      return false;
    }
    if (this._variantReady(this._matP) && this._variantReady(this._matN)) {
      this._ready = true;
      this._compiling = false;
      return true;
    }
    return false;
  }

  /**
   * One node: queue its geometry for a proxy draw if it needs one. False when
   * the draw / byte budget is spent (the node is visited again next frame).
   */
  _take(o) {
    if (o.isMesh !== true) return true;
    const g = o.geometry;
    if (!g || g.isBufferGeometry !== true || !g.attributes || !g.attributes.position) return true;
    if (this._warmedGeoms.has(g)) return true;
    if (_hasMorph(g)) { this._warmedGeoms.add(g); this.stats.skippedMorph += 1; return true; }
    const list = this._list;
    const b = _geometryBytes(g);
    if (list.length >= this.maxDraws || (list.length > 0 && this._visitBytes + b > this.maxBytes)) {
      this._visitBudgetHit = true;
      return false;
    }
    this._warmedGeoms.add(g);
    this._visitBytes += b;
    const p = this._proxy(list.length);
    p.geometry = g;
    p.material = g.attributes.normal !== undefined ? this._matN : this._matP;
    list.push(p);
    return true;
  }

  /**
   * Advance a walk (visible nodes only) until it finishes (true) or the node
   * or draw budget runs out (false: it resumes at the same node next frame).
   * Each node visit costs one unit of `_nodesLeft`; a frame is pushed only for
   * a visible node that has children (and only while fewer than
   * UPLOAD_WARM_MAX_WALK_DEPTH nodes are stacked), and popped once its
   * children are done.
   */
  _walkStep(w) {
    const ns = w.nodes;
    const ix = w.idx;
    let left = this._nodesLeft;
    let done = true;
    while (ns.length > 0) {
      const k = ns.length - 1;
      const ch = ns[k].children;
      const i = ix[k];
      if (i >= ch.length) { ns.pop(); ix.pop(); continue; }
      if (left <= 0) { done = false; break; }
      const c = ch[i];
      if (c.visible !== false) {
        // Hidden: its subtree is skipped, as three's projectObject skips it.
        if (!this._take(c)) { done = false; break; }
        if (c.children.length > 0) {
          // ns[0] is the sentinel: at most UPLOAD_WARM_MAX_WALK_DEPTH real nodes stacked.
          if (ns.length <= UPLOAD_WARM_MAX_WALK_DEPTH) { ix[k] = i + 1; ns.push(c); ix.push(0); left -= 1; continue; }
          this.stats.depthCapped += 1;
        }
      }
      ix[k] = i + 1;
      left -= 1;
    }
    this._nodesLeft = left;
    return done;
  }

  /**
   * Re-check a walk paused in an earlier frame, before it reads any child.
   * The root must still reach the scene, visibly (one visit); every stacked
   * node below it must still be a child of the node below it in the stack and
   * still visible (one visit each). The stack is cut at the first node that
   * fails, so nothing removed (and maybe disposed) or hidden since the pause
   * is walked. A removed node's former next sibling has shifted down to its
   * slot, so the parent resumes at that slot. Returns the root's reach (the
   * stack is left alone unless it is REACH_VISIBLE).
   */
  _resume(w) {
    this._nodesLeft -= 1;
    const reach = this._reach(w.root);
    if (reach !== REACH_VISIBLE) return reach;
    const ns = w.nodes;
    const ix = w.idx;
    for (let k = 2; k < ns.length; k++) {
      this._nodesLeft -= 1;
      const o = ns[k];
      const moved = o.parent !== ns[k - 1];
      if (moved || o.visible === false) {
        ns.length = k;
        ix.length = k;
        if (moved && ix[k - 1] > 0) ix[k - 1] -= 1;
        this.stats.prunedFrames += 1;
        break;
      }
    }
    return reach;
  }

  _watchAdd(root) {
    if (this._wIdx.has(root)) return;
    if (this._watch.length >= this.maxWatched) {
      this.stats.droppedWatch += 1;
      if (this._hiddenOnly.has(root)) { this._hiddenOnly.delete(root); this.stats.droppedHidden += 1; }
      return;
    }
    this._wIdx.set(root, this._watch.length);
    this._watch.push(root);
  }

  /**
   * Release watch slot `i` in O(1) without breaking the pass. Slots before the
   * cursor were visited this pass, the rest were not: a visited slot is
   * refilled with the last visited root and the cursor steps back onto that
   * freed slot; the freed slot (or `i` itself, when unvisited) is refilled
   * with the ring's last root. No unvisited root moves before the cursor.
   */
  _release(i) {
    const w = this._watch;
    const root = w[i];
    let j = i;
    if (i < this._wCursor) {
      const c = this._wCursor - 1;
      if (i !== c) { const m = w[c]; w[i] = m; this._wIdx.set(m, i); }
      this._wCursor = c;
      j = c;
    }
    const last = w.pop();
    if (j < w.length) { w[j] = last; this._wIdx.set(last, j); }
    this._wIdx.delete(root);
    this.stats.released += 1;
    if (this._hiddenOnly.has(root)) { this._hiddenOnly.delete(root); this.stats.droppedHidden += 1; }
  }

  /** Walk arrived roots (FIFO) within the arrival node budget. */
  _arrivals() {
    const w = this._aWalk;
    if (w.root !== null) {
      // Resuming a walk from an earlier frame: the root or any stacked node may
      // have moved or been hidden since (re-checked, charged to the budget).
      const reach = this._resume(w);
      if (reach !== REACH_VISIBLE) {
        const root = w.root;
        _clearWalk(w);
        this._queued.delete(root);
        if (reach === REACH_DETACHED) this.stats.droppedDetached += 1;
        else { this.stats.deferredHidden += 1; this._watchAdd(root); }
      }
    }
    for (;;) {
      if (w.root === null) {
        if (this._qLive <= 0) break;
        if (this._nodesLeft <= 0) break;
        const root = this._queue[this._head];
        this._queue[this._head] = null;
        this._head += 1;
        if (root === null) continue; // released by noteRemoved: no node to read
        this._qLive -= 1;
        this._qIdx.delete(root);
        this._nodesLeft -= 1; // examining a root is one visit, whatever it finds
        const reach = this._reach(root);
        if (reach === REACH_DETACHED) {
          // Removed before its walk: forget it (a later re-add queues it again).
          this._queued.delete(root);
          this.stats.droppedDetached += 1;
          continue;
        }
        if (reach === REACH_HIDDEN) {
          // Hidden (itself or an ancestor): the watch warms it once it shows.
          this._queued.delete(root);
          this.stats.deferredHidden += 1;
          this._hiddenOnly.add(root);
          this._watchAdd(root);
          continue;
        }
        _startWalk(w, root);
      }
      if (!this._walkStep(w)) break;
      const done = w.root;
      _clearWalk(w);
      this._queued.delete(done);
      this.stats.roots += 1;
      this._watchAdd(done);
    }
    this._qCompact();
  }

  /** Re-walk watched roots round robin within the rescan node budget (one pass per frame at most). */
  _rescan() {
    const w = this._wWalk;
    // Resuming: re-check the root and the stack (charged). A detached root's
    // ring slot is released when the cursor reaches it.
    if (w.root !== null && this._resume(w) !== REACH_VISIBLE) _clearWalk(w);
    let examined = 0;
    for (;;) {
      if (w.root === null) {
        const ring = this._watch;
        if (ring.length === 0 || examined >= ring.length || this._nodesLeft <= 0) break;
        if (this._wCursor >= ring.length) { this._wCursor = 0; this.stats.rescanCycles += 1; }
        const root = ring[this._wCursor];
        examined += 1;
        this._nodesLeft -= 1;
        const reach = this._reach(root);
        if (reach === REACH_DETACHED) { this._release(this._wCursor); continue; }
        this._wCursor += 1;
        if (reach === REACH_HIDDEN) continue;
        this._hiddenOnly.delete(root);
        _startWalk(w, root);
      }
      if (!this._walkStep(w)) break;
      _clearWalk(w);
    }
  }

  /**
   * Once per frame, before the frame's render. Returns the number of warm
   * draws issued (0 with nothing queued and nothing new under the watch: no
   * GL call at all).
   */
  tick() {
    const arrivals = this._qLive > 0 || this._aWalk.root !== null;
    if (!arrivals) {
      this._qCompact();
      if (this._watch.length === 0) return 0;
    }
    this._build();
    if (!this._ensureReady()) { this.stats.compileWaitFrames += 1; return 0; }
    const list = this._list;
    list.length = 0;
    this._visitBytes = 0;
    this._visitBudgetHit = false;
    if (arrivals) {
      this._nodesLeft = this.maxNodes;
      this._arrivals();
    }
    if (this._watch.length > 0) {
      this._nodesLeft = this.rescanNodes;
      if (!this._visitBudgetHit) {
        const before = list.length;
        this._rescan();
        this.stats.lateDraws += list.length - before;
      } else if (this._wWalk.root !== null && this._resume(this._wWalk) !== REACH_VISIBLE) {
        // STARVED (the arrivals spent the draw / byte budget): no watch walk,
        // but the paused watch walk is still re-checked (the cut above), so a
        // subtree removed since its pause is not held for the whole burst.
        _clearWalk(this._wWalk);
      }
      this.stats.rescanVisits += this.rescanNodes - this._nodesLeft;
    }
    if (this._visitBudgetHit) this.stats.deferredFrames += 1;
    const n = list.length;
    this.stats.lastDraws = n;
    if (n === 0) return 0;
    this._render(list);
    this.stats.renders += 1;
    this.stats.draws += n;
    this.stats.bytes += this._visitBytes;
    return n;
  }

  _render(list) {
    const r = this.renderer;
    const root = this._root;
    const prevTarget = r.getRenderTarget();
    const prevFace = typeof r.getActiveCubeFace === "function" ? r.getActiveCubeFace() : 0;
    const prevMip = typeof r.getActiveMipmapLevel === "function" ? r.getActiveMipmapLevel() : 0;
    const prevAutoClear = r.autoClear;
    const prevSort = r.sortObjects;
    const info = r.info;
    const keepCounts = !!(info && info.autoReset === false && info.render);
    const c0 = keepCounts ? info.render.calls : 0;
    const t0 = keepCounts ? info.render.triangles : 0;
    const p0 = keepCounts ? info.render.points : 0;
    const l0 = keepCounts ? info.render.lines : 0;
    try {
      r.autoClear = false;
      r.sortObjects = false;
      r.setRenderTarget(this._target);
      root.children = list;
      r.render(root, this._camera);
    } finally {
      root.children = this._noChildren;
      // three keeps this render's items (proxy, geometry, material) in the
      // private Scene's render list until that Scene renders again: clear them
      // (no GL call), or the batch's geometries stay held after an eviction.
      try {
        const rl = r.renderLists && typeof r.renderLists.get === "function" ? r.renderLists.get(root, 0) : null;
        if (rl && typeof rl.init === "function" && typeof rl.finish === "function") { rl.init(); rl.finish(); }
      } catch (_) { /* best effort */ }
      for (let i = 0; i < list.length; i++) list[i].geometry = this._emptyGeom;
      list.length = 0;
      r.setRenderTarget(prevTarget, prevFace, prevMip);
      r.autoClear = prevAutoClear;
      r.sortObjects = prevSort;
      if (keepCounts) {
        info.render.calls = c0;
        info.render.triangles = t0;
        info.render.points = p0;
        info.render.lines = l0;
      }
    }
  }

  /** The unlit materials [position-only, position + normal] (tests / diag). */
  get materials() { return [this._matP, this._matN]; }
  /** The private 1x1 target (tests / diag). */
  get target() { return this._target; }

  dispose() {
    this.detach();
    this._queue.length = 0;
    this._head = 0;
    this._qLive = 0;
    this._qIdx = new WeakMap();
    _clearWalk(this._aWalk);
    _clearWalk(this._wWalk);
    this._watch.length = 0;
    this._wIdx = new WeakMap();
    this._wCursor = 0;
    try { this._target?.dispose(); } catch (_) {}
    try { this._matP?.dispose(); } catch (_) {}
    try { this._matN?.dispose(); } catch (_) {}
  }
}

let _instance = null;

/**
 * Install for the live renderer (index.js init3D). Null, with nothing
 * allocated and no listener, while the flag is off, and under ?nullRender
 * (`opts.nullRender`: no render, so nothing to warm; a listener there would
 * only fill the queue with evicted subtrees).
 */
export function installUploadWarmDraw(renderer, scene, groups, opts) {
  if (!uploadWarmDrawEnabled()) return null;
  if (opts && opts.nullRender) return null;
  if (_instance !== null) return _instance;
  if (!renderer || !scene) return null;
  _instance = new UploadWarmDraw(renderer, scene, opts).attach(groups || []);
  try {
    if (typeof window !== "undefined" && window) {
      const inst = _instance;
      window.__uploadWarmDraw = {
        enabled: true,
        stats: () => ({ ...inst.stats, pending: inst.pending, watched: inst.watched, ready: inst._ready }),
      };
    }
  } catch (_) { /* diag only */ }
  return _instance;
}

/** Test seam: drop the singleton (does not dispose it). */
export function __resetUploadWarmDrawForTest() {
  _instance = null;
}
