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
//   out: {type:'ready', id}
//        {type:'result', id, kind:'modelMeshes'|'surfaces', payload:[...]}  (+ transferables)
//        {type:'error', id, message}

import init, {
  fetch_model_meshes,
  fetch_surfaces_pixels,
  init_resource_source,
  init_scenery_base_url,
} from "../pkg/holtburger_web.js";

import { serializeModelMeshes, serializeSurfacePixelsBatch } from "./bake_transfer.js";

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
