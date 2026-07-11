// scene3d/terrain_ring.js — A4 (2026-07-11 s13) batched 3×3 terrain-ring
// planner (docs/1120-appendix.md §1 A4, §2 Conflict C2 — Design B).
//
// Pure, injected-deps module (no `three`, no `window`, no wasm import — the
// world_stream.js pattern) so it unit-tests without a browser. The scene3d
// `loadTerrainRing(cx, cy)` facade in scene3d/index.js is a thin wrapper that
// injects the live deps.
//
// What it fixes (B3): the position-update streamer used to fire 9 solo
// loadTerrainForLandblock calls per 3×3 ring, each issuing its OWN
// single-element fetch_landblock_heightmaps (terrain.js:3153) — a 9× N+1.
// This planner batch-fetches the heightmaps for the not-yet-baked ring LBs in
// ONE wasm call, then fans out through the SAME guarded loadTerrainForLandblock
// path (guard + LRU + warm-park + subdiv) passing each prefetched base mesh, so
// per-LB behavior is byte-identical to the solo path. It never routes through
// the dead bakeTerrainRing (which lacks that machinery — Conflict C2).
//
// Ownership: bakeTerrainForLandblock NEVER frees a prefetchedMesh
// (terrain.js:3738) and reads the mesh data AFTER an await (its subdiv fetch),
// so this planner is the single owner and frees every prefetched base mesh
// only AFTER all per-LB bakes settle (mirrors bakeTerrainRing's free loop,
// terrain.js:3965). A guard-skipped / already-baked LB simply doesn't consume
// its mesh — the free-all-at-end sweep covers both the consumed (data copied
// synchronously in-bake) and the unconsumed cases: no double-free, no leak.
//
// F1 (all-or-nothing must-fix): fetch_landblock_heightmaps is a single wasm
// call that throws for the WHOLE ring if any one shard is bad (lib.rs:1406
// `?`) — the batch fetch is wrapped so ANY failure (sync throw OR async
// reject) falls back to the 9-solo path; one dead shard can't blank the ring.

function freeWasmMeshes(meshes) {
  if (!meshes) return;
  for (const m of meshes) {
    if (m && typeof m.free === "function") {
      // Already-freed wasm structs throw; swallow — we are the single owner
      // here so this only fires if a future refactor double-hands a mesh.
      try { m.free(); } catch (_) { /* single-owner free */ }
    }
  }
}

/**
 * Plan + dispatch the batched terrain ring. Resolves after the ring is
 * handed off (and, on the batch path, after the prefetched base meshes are
 * freed). Never rejects — the fan-out swallows per-LB errors (the guard
 * already records cooldowns).
 *
 * @param {object} deps
 * @param {number} deps.cx  centre LB x-byte (0..255)
 * @param {number} deps.cy  centre LB y-byte (0..255)
 * @param {boolean} deps.ringBatchEnabled  ?terrainRingBatch (false → solo loop)
 * @param {object|null} deps.wasmExports    holds fetch_landblock_heightmaps
 * @param {Set<number>|null} deps.terrainBakedLbs  cheap already-baked pre-filter
 * @param {(scene:any, lbKey:number)=>boolean} deps.isNearPlayerLb
 * @param {any} deps.scene3d  passed to isNearPlayerLb
 * @param {(lbX:number, lbY:number)=>number} deps.lbKeyFromXY
 * @param {(lbX:number, lbY:number, prefetchedMesh?:any)=>(Promise<any>|any)} deps.loadTerrainForLandblock
 * @param {(msg:string, err?:any)=>void} [deps.warn]
 * @returns {Promise<void>}
 */
export async function runTerrainRingBatch(deps) {
  const {
    cx, cy, ringBatchEnabled, wasmExports, terrainBakedLbs,
    isNearPlayerLb, scene3d, lbKeyFromXY, loadTerrainForLandblock,
  } = deps;
  const warn = deps.warn ?? ((m, e) => { try { console.warn(m, e); } catch (_) {} });
  const cxi = cx & 0xff;
  const cyi = cy & 0xff;

  // Clamped 3×3 ring coords (0x00/0xff edge clamp — identical to the
  // world_stream / legacy index.html solo loop).
  const ring = [];
  for (let dy = -1; dy <= 1; dy += 1) {
    for (let dx = -1; dx <= 1; dx += 1) {
      const nx = cxi + dx;
      const ny = cyi + dy;
      if (nx < 0 || nx > 0xff || ny < 0 || ny > 0xff) continue;
      ring.push({ x: nx, y: ny });
    }
  }

  const soloFanout = () => {
    for (const c of ring) loadTerrainForLandblock(c.x, c.y);
  };

  // Flag OFF (or no batch export) → pure solo loop, byte-identical to pre-A4.
  if (
    !ringBatchEnabled ||
    !wasmExports ||
    typeof wasmExports.fetch_landblock_heightmaps !== "function"
  ) {
    soloFanout();
    return;
  }

  // Cheap pre-filter: only batch-fetch not-yet-baked LBs. The per-LB guard +
  // bakeTerrainForLandblock idempotency still re-check, so a race that bakes
  // one of these between here and the fan-out is safe (its prefetched mesh
  // just goes unconsumed and is freed below).
  const toFetch = [];
  for (const c of ring) {
    const lbKey = lbKeyFromXY(c.x, c.y);
    if (terrainBakedLbs instanceof Set && terrainBakedLbs.has(lbKey)) continue;
    toFetch.push({ x: c.x, y: c.y, id: (lbKey | 0xffff) >>> 0 });
  }
  // Whole ring already baked → still fan out so the loader fast-path
  // unparks/touches each (warm-park seam); no fetch needed.
  if (toFetch.length === 0) {
    soloFanout();
    return;
  }

  // Urgent lane: the ring is centred on the (near-)player LB, which is
  // player-blocking — the SAME isNearPlayerLb semantics the solo bake path
  // uses per-LB (terrain.js:3150). Fail-soft false.
  let urgent = false;
  try { urgent = !!isNearPlayerLb(scene3d, lbKeyFromXY(cxi, cyi)); } catch (_) {}

  const ids = new Uint32Array(toFetch.map((c) => c.id));
  let batch;
  try {
    // fetch_landblock_heightmaps is async (wasm-bindgen) — a sync throw is
    // still possible on a bad-arg path, so guard here too.
    batch = await wasmExports.fetch_landblock_heightmaps(ids, urgent);
  } catch (err) {
    // F1: the batch is all-or-nothing — one bad shard rejects the whole ring.
    // Fall back to 9-solo so each LB re-fetches on its own lane; a truly dead
    // LB then fails in isolation instead of blanking the ring. No meshes were
    // handed out, so soloFanout is clean.
    warn("[terrain] loadTerrainRing batch fetch failed; solo fallback", err);
    soloFanout();
    return;
  }

  if (!batch || batch.length !== toFetch.length) {
    warn(
      `[terrain] loadTerrainRing expected ${toFetch.length} meshes, got ` +
        `${batch ? batch.length : 0}; solo fallback`,
      null
    );
    freeWasmMeshes(batch);
    soloFanout();
    return;
  }

  const meshByKey = new Map();
  for (let i = 0; i < toFetch.length; i += 1) {
    meshByKey.set(lbKeyFromXY(toFetch[i].x, toFetch[i].y), batch[i]);
  }
  const pending = [];
  for (const c of ring) {
    // Already-baked ring LBs (pre-filtered out of toFetch) get pm=null → a
    // solo call that hits the loader's unpark/touch fast-path.
    const pm = meshByKey.get(lbKeyFromXY(c.x, c.y)) ?? null;
    pending.push(
      Promise.resolve(loadTerrainForLandblock(c.x, c.y, pm)).catch(() => null)
    );
  }
  // Free every prefetched base mesh only AFTER all bakes settle — the baker
  // copies mesh data synchronously (post its subdiv await) and never frees a
  // prefetchedMesh, so this is the single owner: no use-after-free, no leak
  // for guard-skipped LBs, no double-free.
  try {
    await Promise.all(pending);
  } finally {
    freeWasmMeshes(batch);
  }
}
