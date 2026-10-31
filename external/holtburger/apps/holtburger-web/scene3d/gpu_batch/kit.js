// scene3d/gpu_batch/kit.js — R3-3: the GPU batch kit's shared singletons
// (docs/2026-10-29-round3-gpu-driven.md §R3-3).
//
// The kit itself has no flag; its CONSUMERS do (`?animSceneryBatch`, later
// `?entityBatch`, `?interiorBatch`). Everything here is created lazily on
// the first call from a consumer, so with every consumer flag off nothing in
// this directory allocates, reads the URL or touches GL. Importing it has no
// side effect.
//
// SHARED, ON PURPOSE:
//   - ONE upload budget (upload_budget.js) for every consumer: the cap is
//     per frame for the whole kit, not per consumer. `kitBeginFrame(id)`
//     refills it; it is idempotent per id, so consumers ticking in the same
//     rAF batch pass the rAF timestamp and only the first one refills.
//   - ONE set of array pages per renderer (array_pages.js): two consumers
//     sampling the same texture share its layer (content-keyed). A WebGL
//     context restore keeps the renderer (three swaps renderer.properties),
//     so it keeps its ArrayPages too: the pages themselves notice the new
//     GL-context generation (`contextLost()`), and every consumer keys what
//     it built by `pages.generation` (bumped by `reset()`).
//   - ONE layer state table (layer_state.js) — slot rows, 4 texels each.
//
// THE UPLOAD-BUDGET CONTRACT EVERY CONSUMER FOLLOWS (R3-3 K3; R3-4 / R3-5
// reuse it; upload_budget.js has the detail):
//   1. The cap holds per UPLOAD frame: the rAF frame in which the bytes reach
//      GL. Layer admits upload inside ArrayPages.admit (this frame). Geometry
//      and row growth upload at three's NEXT render that draws them — in the
//      app the render loop runs before the consumers' rAF ticks, so in the
//      next rAF frame, next to that frame's layer admits (paced renders can
//      move it later, `?targetFps` / portal pacing can move it earlier).
//   2. So geometry is charged with `spendDeferred(bytes, "geometry")` in the
//      sync that makes it visible (it draws, and so uploads, at the next
//      render), and the consumer lands the ticket from three's upload
//      callbacks (`land(ticket, bytes)` per BufferAttribute
//      onUploadCallback) or drops it when it tears the resource down before
//      it uploaded (`drop(ticket)`). The budget books the bytes in the
//      charging frame and carries them into every later frame until the one
//      that begins after the upload: the layers that frame admits get only
//      the rest. (`trySpend` with a deferred kind = a ticket that lands at the
//      very next render: carried one frame.)
//   3. A refused spend changes nothing: nothing merged, allocated or shown;
//      the consumer keeps its previous state and asks again next frame.
//
// GL-CONTEXT GENERATIONS. `kitContextGeneration(renderer)` is the
// generation the kit keys GL state by (renderer.properties: three swaps it
// on a restore; the class-program warm set, the pages' `ctx`); every kit
// resource made on one generation is dropped WITHOUT GL deletes on another
// (array_pages.js "NO GL DELETES ON A DEAD GENERATION"): the pages re-check
// it themselves, the state-row texture is tracked by its generation
// (trackContextGenerations / disposeOnLiveContext), and so is every merged
// geometry a consumer builds (the same two calls).
//
// TIMINGS (S1). `kitSummary().budget.ms / maxMs / timed` per upload kind and
// `phaseMs` (geometry: merge at the charge, three's attribute upload, the
// first draw): CPU milliseconds, performance.now around the kit's own work
// and three's first touches, flag-on only (the kit exists only with a
// consumer flag on).
//
// Tunables (read once, at first use, S1 knobs; defaults = the plan's start):
//   ?gpuBatchUploadMB=<1..256>  per-frame upload bytes (default 8)
//   ?gpuBatchAdmits=<1..256>    per-frame layer admits (default 16)
//   ?gpuBatchVramMB=<8..2048>   THE STATED VRAM CAP of the kit's array pages
//                               (reserved page bytes, every consumer; default
//                               128 = page_allocator ALLOCATOR_BYTES_MAX_DEFAULT)
//
// AT THE CAP (R3-4 real boot, 2026-10-31): the kit pages reclaim idle-only
// pages and then fit a smaller page before they refuse an admit
// (page_allocator.js "AT THE CAP"); a refusal books no budget bytes.
//
// DEMAND-SIZED PAGES (R3-5 real boot, 2026-10-31; page_allocator.js
// "DEMAND-SIZED PAGES"): the kit pages size every page by its key's demand
// (a small first page — 4 layers or 256 KiB, whichever holds more — then
// the key doubling, 4 MiB at most a page), so the
// reserved bytes stay close to the resident layers instead of ~4 MiB per
// (format, size, levels, sampler) key — the laptop boot reserved 134.0 of
// 134.2 MB for 13 MB of layers and refused every new key. An empty page is
// destroyed at once; idle-only pages go at the cap (reclaimIdle).

import { UploadBudget, UPLOAD_BYTES_PER_FRAME_DEFAULT, UPLOAD_ADMITS_PER_FRAME_DEFAULT } from "./upload_budget.js";
import {
  ArrayPages, glContextGeneration, liveContextGeneration, trackContextGenerations, disposeOnLiveContext,
} from "./array_pages.js";
import { ALLOCATOR_BYTES_MAX_DEFAULT } from "./page_allocator.js";
import { RowTexture } from "./row_texture.js";
import { LayerStateTable, LAYER_STATE_TEXELS } from "./layer_state.js";

let _budget = null;
let _pages = null;
let _pagesRenderer = null;
let _state = null;

function _numParam(name, def, min, max) {
  try {
    const search = globalThis.location?.search;
    if (search) {
      const v = Number(new URLSearchParams(search).get(name));
      if (Number.isFinite(v) && v >= min && v <= max) return v;
    }
  } catch (_) { /* default */ }
  return def;
}

/** The kit-wide per-frame upload budget. */
export function kitBudget() {
  if (!_budget) {
    _budget = new UploadBudget({
      bytesPerFrame: Math.round(_numParam("gpuBatchUploadMB", UPLOAD_BYTES_PER_FRAME_DEFAULT / (1024 * 1024), 1, 256) * 1024 * 1024),
      admitsPerFrame: Math.round(_numParam("gpuBatchAdmits", UPLOAD_ADMITS_PER_FRAME_DEFAULT, 1, 256)),
    });
  }
  return _budget;
}

/** The stated VRAM cap of the kit pages, bytes (`?gpuBatchVramMB`, default 128 MiB). */
export function kitVramCapBytes() {
  return Math.round(_numParam("gpuBatchVramMB", ALLOCATOR_BYTES_MAX_DEFAULT / (1024 * 1024), 8, 2048) * 1024 * 1024);
}

/** Refill the budget for frame `id` (idempotent per id). */
export function kitBeginFrame(id) {
  kitBudget().beginFrame(id);
}

/**
 * The array pages for `renderer`. Keyed by the renderer OBJECT: a context
 * restore is not a new renderer (it swaps `renderer.properties`, the
 * GL-context generation), so this hands back the same ArrayPages and its
 * `contextLost()` reports the generation change; the consumer then tears
 * down, calls `reset()` (new `generation`) and re-plans. Only a different
 * renderer object starts fresh.
 */
export function kitPages(renderer) {
  if (!renderer) return null;
  if (_pages && _pagesRenderer === renderer) return _pages;
  if (_pages) { try { _pages.dispose(); } catch (_) { /* fail-soft */ } }
  _pages = new ArrayPages(renderer, {
    maxBytes: kitVramCapBytes(), reclaimIdle: true, fitToCap: true, demand: true,
  });
  _pagesRenderer = renderer;
  return _pages;
}

// The state-row textures are uploaded by the kit's renderer (the one the
// pages live on); each is tagged with the generation that uploads it, so a
// texture uploaded before a restore is never deleted on the restored context.
const _kitLiveGeneration = () => liveContextGeneration(_pagesRenderer);
const _trackKitTexture = (tex) => trackContextGenerations(tex, _kitLiveGeneration);

/** The kit's layer state table. */
export function kitStateTable() {
  if (!_state) {
    _state = new LayerStateTable(new RowTexture({
      texelsPerRow: LAYER_STATE_TEXELS, rows: 64, name: "gpu-batch-layer-state",
      onTexture: _trackKitTexture, disposeTexture: disposeOnLiveContext,
    }));
  }
  return _state;
}

/** Once per frame, after every consumer wrote its rows: the one upload. */
export function kitFlush() {
  if (_state) _state.rows.flush();
}

/** Diag. */
export function kitSummary() {
  return {
    budget: _budget ? {
      bytesPerFrame: _budget.bytesPerFrame, admitsPerFrame: _budget.admitsPerFrame, pending: _budget.pending(),
      carriedBytes: _budget.carriedBytes, openTickets: _budget.openTickets(), heldTickets: _budget.heldTickets(),
      ..._budget.stats,
    } : null,
    pages: _pages ? _pages.summary() : null,
    stateRows: _state ? { used: _state.rows.rowsUsed, capacity: _state.rows.capacity, ..._state.rows.stats } : null,
  };
}

/**
 * The GL-context generation the kit keys GL state by (array_pages.js
 * glContextGeneration: `renderer.properties`, swapped by three on a context
 * restore) — of `renderer`, or of the renderer the kit pages live on.
 * Consumers read the generation through this (anim_scenery_batch.js keys its
 * class-program warm state by it).
 */
export function kitContextGeneration(renderer = _pagesRenderer) {
  return glContextGeneration(renderer);
}

/**
 * The generation whose GL objects are live NOW on the kit's renderer (or
 * `renderer`): array_pages.js liveContextGeneration — LOST_CONTEXT_GENERATION
 * between a loss and its restore. A consumer that drops a THREE resource
 * compares against it (no dispose, so no GL delete, while nothing is live).
 */
export function kitLiveGeneration(renderer = _pagesRenderer) {
  return liveContextGeneration(renderer);
}

/** Teardown (tests / full scene dispose by the last consumer). */
export function resetKit() {
  if (_pages) { try { _pages.dispose(); } catch (_) { /* fail-soft */ } }
  if (_state) { try { _state.rows.dispose(); } catch (_) { /* fail-soft */ } }
  _pages = null;
  _pagesRenderer = null;
  _state = null;
  _budget = null;
}
