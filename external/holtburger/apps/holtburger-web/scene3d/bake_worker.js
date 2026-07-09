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
//        {type:'fetchEntitySurfacesPixels', id, dids:[u32,...], paletteId, subPalettes:[u32,...]}
//        {type:'fetchEntitySurfacesPixelsBatch', id, flatDids, lens, basePals, flatSubs, tripleCounts}
//   out: {type:'ready', id}
//        {type:'result', id, kind:'modelMeshes'|'surfaces'|'entitySurfaces'|'entitySurfacesBatch', payload:[...]}  (+ transferables)
//        {type:'error', id, message}

import init, {
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
  // Instantiate the wasm module in this worker's context.
  await init();
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
  const { surfaces: payload, transfer } = serializeSurfacePixelsBatch(surfaces);
  self.postMessage({ type: "result", id: msg.id, kind: "surfaces", payload }, transfer);
}

// Entity surface decode — the dyed/paletted path (`fetch_entity_surface_
// pixels_impl`). Runs the same per-pixel `to_rgba8` + `normal_gen` the
// statics path does, plus the per-entity palette/sub-palette overlay, in
// THIS worker's wasm instance so it stays off the main thread.
async function handleEntitySurfaces(msg) {
  const surfaces = await fetchEntitySurfacesPixels(
    Uint32Array.from(msg.dids),
    msg.paletteId >>> 0,
    Uint32Array.from(msg.subPalettes || []),
  );
  const { surfaces: payload, transfer } = serializeSurfacePixelsBatch(surfaces);
  self.postMessage({ type: "result", id: msg.id, kind: "entitySurfaces", payload }, transfer);
}

// F.41 batch — N entity groups in one prefetch loop, one postMessage back.
async function handleEntitySurfacesBatch(msg) {
  const batch = await fetchEntitySurfacesPixelsBatch(
    Uint32Array.from(msg.flatDids || []),
    Uint32Array.from(msg.lens || []),
    Uint32Array.from(msg.basePals || []),
    Uint32Array.from(msg.flatSubs || []),
    Uint32Array.from(msg.tripleCounts || []),
  );
  // Drains + frees the batch (and per-group SurfacePixels) handles.
  const { groups: payload, transfer } = serializeEntitySurfacesBatch(batch);
  self.postMessage({ type: "result", id: msg.id, kind: "entitySurfacesBatch", payload }, transfer);
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
