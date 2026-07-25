// scene3d/bake_worker.js
//
// M2 (worker-based asset bake) — a Web Worker that runs the heavy WASM
// asset decoders OFF the main thread. It owns its own wasm instance and
// resource source; the main thread drives it via `bake_worker_client.js`.
// Decoder output is serialized to transferable typed-array payloads
// (`bake_transfer.js`) so it returns zero-copy.
//
// COST: this worker re-inits the wasm module and re-calls
// `init_resource_source(manifestUrl)` → a second manifest fetch. The
// browser HTTP cache serves it warm after the main thread's fetch.
//
// Protocol (postMessage):
//   in : {type:'init', id, manifestUrl, sceneryBaseUrl,
//              locationSearch, verifyShards?, fetchConcurrency?,
//              shardBudgetBytes?, decodeAdmission?:{jobs,bytes,reserve},
//              decodePressure?:{t1MB,t2MB}}
//        (the last five are the page's host flags — see handleInit)
//        {type:'fetchModelMeshes', id, ids:[u32,...]}
//        {type:'fetchSurfacesPixels', id, dids:[u32,...]}
//        {type:'fetchEntitySurfacesPixels', id, dids:[u32,...], paletteId, subPalettes:[u32,...], urgent?}
//        {type:'fetchEntitySurfacesPixelsBatch', id, flatDids, lens, basePals, flatSubs, tripleCounts, urgent?}
//        {type:'datDecodeDiag', id}
//   out: {type:'ready', id}
//        {type:'result', id, kind:'modelMeshes'|'surfaces'|'entitySurfaces'|'entitySurfacesBatch', payload:[...], audit?}  (+ transferables)
//        {type:'result', id, kind:'diag', payload: <dat_decode_diag() JSON string|null>}
//        {type:'error', id, message}
//
// `audit` (P2↔P3 ABI, 2026-07-10) is the call-level decode audit
// (`{decodeMisses, provenAbsent}`) extracted from THIS worker instance's
// wasm result; the client re-applies it onto the reconstructed result so
// materials.js sees the same fields as on the main-thread path.

import init, {
  initSync,
  dat_decode_diag,
  fetch_model_meshes,
  fetch_surfaces_pixels,
  fetchEntitySurfacesPixels,
  fetchEntitySurfacesPixelsBatch,
  init_resource_source,
  init_scenery_base_url,
  seed_url_flag_search,
  url_flag_diag,
} from "../pkg/holtburger_web.js?v=netrev-20260709";

import {
  serializeModelMeshes,
  serializeSurfacePixelsBatch,
  serializeEntitySurfacesBatch,
} from "./bake_transfer.js";

let ready = false;

async function handleInit(msg) {
  // Host-flag plumbing (defects 1/3/4 of HANDOFF-wasm-threads-SAB-2026-07-24).
  // These two globals are read by Rust via `js_sys::global()`, which in a worker
  // is THIS scope — never the page's — so they were unset here and the worker
  // ignored the page's settings (it kept sha256-verifying shards after
  // `__hbVerifyShards = false`, and minted its own full-size fetch semaphore on
  // top of the main thread's → a real page cap of 64). Set BEFORE `init()` so
  // the values are in place before any wasm read.
  if (typeof msg.fetchConcurrency === "number" && msg.fetchConcurrency >= 1) {
    self.__hbFetchConcurrency = msg.fetchConcurrency;
  }
  if (msg.verifyShards !== undefined && msg.verifyShards !== null) {
    self.__hbVerifyShards = msg.verifyShards;
  }
  // A15 §1: shard-record cache byte budget for THIS instance's resource source
  // (`?shardBudgetMB=`). Unset → Rust's unbounded default. Must precede
  // `init_resource_source`, which sizes the cache once at connect.
  if (typeof msg.shardBudgetBytes === "number" && msg.shardBudgetBytes >= 1) {
    self.__hbShardBudgetBytes = msg.shardBudgetBytes;
  }
  // Surface-budget S2: THIS instance's surface-pixel cache byte budget
  // (`?surfaceBudgetMB=`, the worker half of an `N:M` split). Unset → Rust's
  // 96 MiB `SURFACE_CACHE_BUDGET_BYTES` default. Must precede `init()` below:
  // the budget is read ONCE at the `SURFACE_PIXEL_CACHE` LazyLock init and
  // `surface_pixel_cache_clear_all()` clears without resizing, so a later
  // assignment is a silent no-op.
  if (typeof msg.surfaceBudgetBytes === "number" && msg.surfaceBudgetBytes >= 1) {
    self.__hbSurfaceBudgetBytes = msg.surfaceBudgetBytes;
  }
  // A15 §2.5 (S4): THIS instance's decode-admission bound (`?decodeAdmission*`,
  // parsed page-side by `resolveDecodeAdmission`). Unset ⇒ Rust's unbounded
  // default, i.e. the S1 gate. Must precede `init_resource_source`/any
  // `fetch_*`, which is where the gate's LazyLock first reads these.
  if (msg.decodeAdmission && typeof msg.decodeAdmission.jobs === "number") {
    self.__hbDecodeMaxJobs = msg.decodeAdmission.jobs;
    if (msg.decodeAdmission.bytes > 0) {
      self.__hbDecodeMaxBytes = msg.decodeAdmission.bytes;
    }
    if (msg.decodeAdmission.reserve > 0) {
      self.__hbDecodeUrgentReserve = msg.decodeAdmission.reserve;
    }
  }
  // A15 §2.2 item 3 (S5): THIS instance's wasm-memory pressure thresholds, in
  // MB (`?decodePressure=<t1>:<t2>`, parsed page-side). Unset ⇒ inert. Same
  // ordering requirement as above — the gate's LazyLock reads these once.
  if (msg.decodePressure && msg.decodePressure.t1MB > 0) {
    self.__hbDecodePressureT1MB = msg.decodePressure.t1MB;
    if (msg.decodePressure.t2MB > 0) {
      self.__hbDecodePressureT2MB = msg.decodePressure.t2MB;
    }
  }
  // EXPERIMENT (threads-lite, 2026-07-24): when the main thread hands us its
  // compiled module + shared memory, initialise INTO that memory — this worker
  // becomes a second thread of one wasm instance rather than a second instance.
  // Absent -> the unchanged path below (own module, own memory).
  if (msg.sharedModule && msg.sharedMemory) {
    initSync({ module: msg.sharedModule, memory: msg.sharedMemory });
    console.log(
      "[threads-lite] worker initSync into shared memory; SAB:",
      msg.sharedMemory.buffer instanceof SharedArrayBuffer,
    );
  } else {
    // Instantiate the wasm module in this worker's context.
    await init();
  }
  // Seed the page's query string into this instance (defect 1). Rust's
  // `js_location_search()` returns "" with no `window`, and the house flag rule
  // is "absent reads ON, only an explicit off-form is OFF" — so every Rust-side
  // URL flag read at its DEFAULT in here, and an A/B arm like `?surfaceCache=off`
  // was honoured on the main thread and ignored in the worker. MUST run after
  // wasm init (it is a wasm export) and before ANY flag-gated work: the flags
  // cache into `OnceLock`s on first read, and `init_resource_source` below is
  // already flag-gated work.
  if (typeof seed_url_flag_search === "function") {
    seed_url_flag_search(msg.locationSearch || "");
  }
  // `init_resource_source` is async (fetches the manifest) and MUST precede
  // any `fetch_*` call — the wasm panics otherwise.
  await init_resource_source(msg.manifestUrl);
  if (msg.sceneryBaseUrl && typeof init_scenery_base_url === "function") {
    // Scenery base is optional for the mesh/surface decoders; never fatal.
    try {
      init_scenery_base_url(msg.sceneryBaseUrl);
    } catch (_) {
      /* scenery placements just won't resolve in-worker; not needed here */
    }
  }
  ready = true;
  // One-line readback so the worker's view of the host flags can be diffed
  // against the main thread's (index.html logs the same shape after
  // `init_resource_source`). This is the evidence that defects 1 + 4 are fixed.
  try {
    if (typeof url_flag_diag === "function") {
      console.log("[bake_worker] flags:", url_flag_diag());
    }
  } catch (_) {
    /* diagnostics must never fail init */
  }
  self.postMessage({ type: "ready", id: msg.id });
}

async function handleModelMeshes(msg) {
  // streamFix urgent lane (2026-07-02): `msg.urgent` (player-blocking
  // current-LB bake) routes the walk's prefetches around THIS worker's own
  // fetch semaphore — the worker wasm instance has its own FIFO that
  // otherwise backlogs identically to the main thread's under rapid
  // teleports. Absent/false = pre-fix normal lane.
  const meshes = await fetch_model_meshes(Uint32Array.from(msg.ids), msg.urgent === true);
  const { meshes: payload, transfer } = serializeModelMeshes(meshes);
  self.postMessage({ type: "result", id: msg.id, kind: "modelMeshes", payload }, transfer);
}

async function handleSurfaces(msg) {
  const surfaces = await fetch_surfaces_pixels(Uint32Array.from(msg.dids), msg.urgent === true);
  const { surfaces: payload, transfer, audit } = serializeSurfacePixelsBatch(surfaces);
  self.postMessage({ type: "result", id: msg.id, kind: "surfaces", payload, audit }, transfer);
}

// Entity surface decode — the dyed/paletted path (`fetch_entity_surface_
// pixels_impl`). Runs the same per-pixel `to_rgba8` + `normal_gen` the
// statics path does, plus the per-entity palette/sub-palette overlay, in
// THIS worker's wasm instance so it stays off the main thread.
async function handleEntitySurfaces(msg) {
  // decode-priority (2026-07-10): `msg.urgent` = entity on the player's
  // current/server LB — same semaphore bypass as handleModelMeshes.
  const surfaces = await fetchEntitySurfacesPixels(
    Uint32Array.from(msg.dids),
    msg.paletteId >>> 0,
    Uint32Array.from(msg.subPalettes || []),
    msg.urgent === true,
  );
  const { surfaces: payload, transfer, audit } = serializeSurfacePixelsBatch(surfaces);
  self.postMessage({ type: "result", id: msg.id, kind: "entitySurfaces", payload, audit }, transfer);
}

// F.41 batch — N entity groups in one prefetch loop, one postMessage back.
async function handleEntitySurfacesBatch(msg) {
  const batch = await fetchEntitySurfacesPixelsBatch(
    Uint32Array.from(msg.flatDids || []),
    Uint32Array.from(msg.lens || []),
    Uint32Array.from(msg.basePals || []),
    Uint32Array.from(msg.flatSubs || []),
    Uint32Array.from(msg.tripleCounts || []),
    msg.urgent === true,
  );
  // Drains + frees the batch (and per-group SurfacePixels) handles.
  const { groups: payload, transfer, audit } = serializeEntitySurfacesBatch(batch);
  self.postMessage(
    { type: "result", id: msg.id, kind: "entitySurfacesBatch", payload, audit },
    transfer,
  );
}

self.onmessage = async (ev) => {
  const msg = ev.data;
  try {
    switch (msg && msg.type) {
      case "init":
        return await handleInit(msg);
      case "fetchModelMeshes":
        if (!ready) throw new Error("bake_worker: fetchModelMeshes before init");
        return await handleModelMeshes(msg);
      case "fetchSurfacesPixels":
        if (!ready) throw new Error("bake_worker: fetchSurfacesPixels before init");
        return await handleSurfaces(msg);
      case "fetchEntitySurfacesPixels":
        if (!ready) throw new Error("bake_worker: fetchEntitySurfacesPixels before init");
        return await handleEntitySurfaces(msg);
      case "fetchEntitySurfacesPixelsBatch":
        if (!ready) throw new Error("bake_worker: fetchEntitySurfacesPixelsBatch before init");
        return await handleEntitySurfacesBatch(msg);
      case "datDecodeDiag":
        // A07 §3.6 — expose THIS instance's decode counters + negative-cache
        // state (otherwise invisible from the main thread). Init-gated like
        // the fetchers; typeof-guarded so a stale pkg without the export
        // answers null instead of throwing.
        if (!ready) throw new Error("bake_worker: datDecodeDiag before init");
        return self.postMessage({
          type: "result",
          id: msg.id,
          kind: "diag",
          payload: typeof dat_decode_diag === "function" ? dat_decode_diag() : null,
        });
      default:
        throw new Error(`bake_worker: unknown message type ${msg && msg.type}`);
    }
  } catch (e) {
    self.postMessage({
      type: "error",
      id: msg && msg.id,
      message: String((e && e.message) || e),
    });
  }
};
