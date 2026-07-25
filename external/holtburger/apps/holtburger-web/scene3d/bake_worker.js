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
//   in : {type:'init', id, manifestUrl, sceneryBaseUrl}
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
} from "../pkg/holtburger_web.js?v=netrev-20260709";

import {
  serializeModelMeshes,
  serializeSurfacePixelsBatch,
  serializeEntitySurfacesBatch,
} from "./bake_transfer.js";

let ready = false;

async function handleInit(msg) {
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
