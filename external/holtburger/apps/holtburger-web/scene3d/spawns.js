// Phase D.1 — synthetic ACE entity-spawn injector.
//
// The third placement stream (per `docs/hypotheticalmethod.md`'s three-
// stream merge contract). DAT-explicit objects come from
// `fetch_landblock_objects`. DAT-baked scenery comes from
// `fetch_landblock_scenery` (Phase C). ACE entity spawns come from
// THIS module — via `fetch_landblock_spawns` (Phase D's new wasm
// export) which reads pre-staged JSONL under `dist/spawns/`.
//
// The injector's load-bearing job is to feed each spawn record
// through the SAME entry point a live ACE would use: the
// `window.__scene3dEntityHook` shared-drain dispatcher set up in
// `scene3d/loop.js::installSharedDrainHook`. That dispatcher routes
// kind=1 events into `entityManager.spawn(toMeta(upd))` — which
// builds a THREE.Group under `scene3d.entitiesGroup` (the assertion
// target the Phase D capture checks).
//
// We DON'T bypass `__scene3dEntityHook` and call `em.spawn` directly.
// The whole point of Phase D is verifying THAT dispatch surface
// handles the full ACE-DB roster at radius=6.
//
// Also wires the 2D `window.handleEntitySpawn(upd)` path for
// completeness — calling both mirrors index.html:6529-6540 where the
// wire's drainEvents loop sends each spawn into BOTH paths (the 2D
// PIXI path stays a no-op in 3D mode because ensureEntitySprite
// returns null when `liveScene` isn't set).

// METERS_PER_LANDBLOCK was used by the previous double-snapshot
// dispatch path; B7's collapse to a single object construction
// removed the only reader. Re-introduce if a future dispatch path
// needs the constant.

// Phase D.1 — base URL for the staged ACE spawn JSONL files. Mirrors
// `scene3d/statics.js`'s SCENERY_BASE_URL. The dev server's
// `/dist/...` → `/mnt/wbterminal1/holtburger-dist-v2/...` mapping
// resolves this to `dist/spawns/0xXXXX.spawns.jsonl`.
const SPAWNS_BASE_URL = "../../dist/spawns/";
let _spawnsBaseUrlInitialized = false;

// Cached wcid → setupDid lookup (loaded once per page from
// `dist/spawns/wcid_to_setup.json`). The injector consults this for
// every spawn record; misses fall back to a documented placeholder
// model so capture scripts can still count "rendered with correct
// model" vs "placeholder".
//
// Placeholder choice: `0x0200016F` is the AC retail "Compass" SetupModel
// — a simple multi-part hand-held with no required animation tables.
// Pick rationale:
//   - Top byte 0x02 (SetupModel) → goes through the EntityManager's
//     rig-build path same as a real creature/NPC setup.
//   - Compact mesh (≲1 KB on disk) → low render cost for the 0-coverage
//     case (today: 0 misses in the 13×13 ring, but future LBs may
//     surface unknown wcids).
//   - Documented + visually distinguishable (rod with cardinal markers)
//     so the placeholder is identifiable in screenshots.
//
// IMPORTANT: a placeholder spawn marks `userData.placeholder = true`
// on the EntityInstance.meta object, so a capture script can count
// "real model" vs "placeholder" via `entityManager.entityMap` walk.
const PLACEHOLDER_SETUP_DID = 0x0200016F;

let _wcidToSetupMap = null;       // Map<number, number> when loaded
let _wcidToSetupFetchInFlight = null;  // Promise<Map> while loading
let _wcidToSetupLoadFailed = false;    // sticky flag — set on any error

// Idempotency: track which LBs have had their spawn channel injected.
// Re-firing for the same LB is a no-op (matches the
// `staticsBakedLbs`/`buildingsBakedLbs`/`cellContainers3d` patterns).
const _spawnsInjectedLbs = new Set();
const _spawnsInjectInFlight = new Set();
// Short per-LB cooldown after a transient fetch/inject failure. A throw no
// longer permanently poisons the LB (used to `.add` to `_spawnsInjectedLbs`
// in the catch, stripping its NPCs for the whole session); instead we record
// a retry-after timestamp so a transient failure retries once the window
// elapses rather than never.
const _spawnsFailUntil = new Map();
const _SPAWNS_FAIL_COOLDOWN_MS = 2500;

// `?spawns=` URL flag — controls whether the pre-baked synthetic
// JSONL spawn records get injected. Background:
//
// Synthetic spawns are loaded from `<dist>/spawns/0xXXXX.spawns.jsonl`
// via wasm `fetch_landblock_spawns`. They give the renderer a populated
// scene WITHOUT a live ACE wsbridge connection — pre-baked retail
// presence for offline preview. Each record dispatches through the
// SAME `__scene3dEntityHook` an ACE wire feed uses, so when a live
// session IS connected, BOTH the synthetic injection AND the wire's
// KIND_SPAWN messages add the same entity (with different GUIDs —
// synthetic = FNV hash with high bit forced on; wire = ACE server-
// assigned), bypassing EntityManager's guid-based idempotency check.
// Result: every retail spawn appears twice at the same XYZ.
//
// Modes:
//   "auto"  (default) — synthetic injected ONLY when `window.__sessionHandle`
//                       is unset. Wire-active sessions skip synthetic.
//                       Pre-login or offline pages still get the synthetic
//                       offline-preview behaviour.
//   "force"           — always inject synthetic regardless of session.
//                       Legacy behaviour; use for testing the baked data
//                       directly when you know the session won't double-spawn
//                       (e.g. an ACE that's been wiped of spawns).
//   "off"             — never inject synthetic. Wire-only.
function readSpawnsMode() {
  if (typeof window === "undefined") return "auto";
  try {
    const m = new URLSearchParams(window.location.search).get("spawns");
    if (m === "force" || m === "auto" || m === "off") return m;
  } catch (_) { /* noop */ }
  return "auto";
}
const SPAWNS_MODE = readSpawnsMode();
let _spawnsModeLogged = false;
function logSpawnsModeOnce(sessionPresent) {
  if (_spawnsModeLogged) return;
  _spawnsModeLogged = true;
  // eslint-disable-next-line no-console
  console.log(
    `[scene3d.spawns] mode=${SPAWNS_MODE}, sessionHandle=${sessionPresent ? "present" : "absent"} ` +
      `→ synthetic injection ${(() => {
        if (SPAWNS_MODE === "off") return "DISABLED (?spawns=off)";
        if (SPAWNS_MODE === "force") return "ENABLED (?spawns=force)";
        return sessionPresent
          ? "SKIPPED (live session — wire feeds spawns; use ?spawns=force to override)"
          : "ENABLED (no live session — synthetic provides offline-preview spawns)";
      })()}`
  );
}
function shouldInjectSynthetic() {
  if (SPAWNS_MODE === "off") return false;
  if (SPAWNS_MODE === "force") return true;
  // auto
  return typeof window === "undefined" || !window.__sessionHandle;
}

/**
 * Phase D.1 — fail-soft spawns base-URL init. Mirrors
 * `ensureSceneryInit` in statics.js. Called once per page on first
 * `ensureSpawnsForLandblock` call. The wasm export
 * `init_spawns_base_url` is a no-arg side-effect; we never throw on
 * absence, because Phase D is OPTIONAL today (the renderer still
 * works without ACE spawns; it just lacks the third placement stream).
 */
function ensureSpawnsInit(wasmExports) {
  if (_spawnsBaseUrlInitialized) return;
  _spawnsBaseUrlInitialized = true;
  if (
    !wasmExports ||
    typeof wasmExports.init_spawns_base_url !== "function"
  ) {
    // eslint-disable-next-line no-console
    console.warn(
      "[scene3d.spawns] init_spawns_base_url not in wasmExports; " +
        "ACE spawn injection will be skipped"
    );
    return;
  }
  try {
    wasmExports.init_spawns_base_url(SPAWNS_BASE_URL);
    // eslint-disable-next-line no-console
    console.log(
      "[scene3d.spawns] spawns base URL initialized:",
      SPAWNS_BASE_URL
    );
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      "[scene3d.spawns] init_spawns_base_url threw; ACE spawn injection skipped:",
      String(e).slice(0, 120)
    );
  }
}

/**
 * Lazy-fetch the wcid → setupDid lookup table from
 * `dist/spawns/wcid_to_setup.json`. Cached for the page lifetime;
 * subsequent calls return the same Map.
 *
 * Each LB-entry call dedups via `_wcidToSetupFetchInFlight` so a burst
 * of `ensureSpawnsForLandblock` calls (e.g. the initial ring) only
 * fires one HTTP fetch.
 *
 * The JSON file is staged by `scripts/world-completeness/stage-ring-spawns.py`
 * — see that script's docstring for the schema (object keyed on
 * decimal-stringified wcid; values are setupDid as integer).
 *
 * On fetch failure (404, parse error, etc.) we set
 * `_wcidToSetupLoadFailed = true` and return null. Subsequent calls
 * short-circuit without retrying — the placeholder fallback covers
 * the no-lookup case.
 */
async function loadWcidToSetupMap() {
  if (_wcidToSetupMap) return _wcidToSetupMap;
  if (_wcidToSetupLoadFailed) return null;
  if (_wcidToSetupFetchInFlight) return _wcidToSetupFetchInFlight;

  _wcidToSetupFetchInFlight = (async () => {
    const url = SPAWNS_BASE_URL + "wcid_to_setup.json";
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();
      const map = new Map();
      for (const [k, v] of Object.entries(data)) {
        const wcid = Number(k);
        const setup = Number(v);
        if (Number.isFinite(wcid) && Number.isFinite(setup)) {
          map.set(wcid >>> 0, setup >>> 0);
        }
      }
      _wcidToSetupMap = map;
      // eslint-disable-next-line no-console
      console.log(
        `[scene3d.spawns] wcid_to_setup loaded: ${map.size} entries`
      );
      return map;
    } catch (e) {
      _wcidToSetupLoadFailed = true;
      // eslint-disable-next-line no-console
      console.warn(
        `[scene3d.spawns] wcid_to_setup.json fetch failed (${e}); ` +
          `all spawns will use placeholder setup 0x${PLACEHOLDER_SETUP_DID.toString(16).padStart(8, "0").toUpperCase()}`
      );
      return null;
    } finally {
      _wcidToSetupFetchInFlight = null;
    }
  })();

  return _wcidToSetupFetchInFlight;
}

/**
 * Derive a deterministic 32-bit GUID for a synthetic spawn from
 * `(landblockId, cell, wcid, xBits, yBits)`. The same record across
 * re-runs of the injector produces the same GUID — important so
 * EntityManager.spawn()'s idempotency check (entityMap.get(guid))
 * catches re-injections instead of allocating fresh entities.
 *
 * We use the FNV-1a 32-bit variant: simple, fast, well-distributed
 * for short-key inputs. The high bit is forced to 1 (`| 0x80000000`)
 * so synthetic GUIDs sit in a distinct subspace from real ACE GUIDs
 * (which stay under 0x80000000 for retail static-world ids).
 *
 * Why xBits + yBits are load-bearing: Holtburg has 18 "Door"
 * weenies (wcid 412) all at cell=0, all with landblockId=0xA9B4.
 * Without per-position mixing, the FNV hash collapses all 18 to
 * the same GUID and the EntityManager treats #2-#18 as re-spawns
 * of #1, tearing down and rebuilding the same rig and losing the
 * other 17 distinct placements. Per-position bytes give each
 * placement a unique identity.
 *
 * We mix the IEEE-754 32-bit float bits of x + y (not the integer
 * cm rounding — the bit pattern preserves full precision even at
 * sub-cm differences between two adjacent door placements).
 *
 * Collision risk: 2^32 ≈ 4.3B values vs ~427 records in the ring
 * (and ~365k records world-wide). Birthday-paradox collision
 * probability ≲ 1e-5 at 100k spawns — below the dispatcher's
 * tolerance for accidental re-spawn-same-guid (re-spawn re-builds
 * the older rig, so worst case is two spawns "fighting" for one
 * rig, never silent placement loss).
 */
function deriveSyntheticGuid(landblockId, cell, wcid, x, y) {
  const FNV_OFFSET = 0x811c9dc5;
  const FNV_PRIME = 0x01000193;
  let h = FNV_OFFSET;
  // FLoat bit punning via Float32Array — cheap, exact, identical
  // across browsers (IEEE-754 little-endian for both Wasm + JS).
  const fbuf = new ArrayBuffer(8);
  const fview = new Float32Array(fbuf);
  const uview = new Uint32Array(fbuf);
  fview[0] = x;
  fview[1] = y;
  const xBits = uview[0];
  const yBits = uview[1];
  // Mix six words: landblockId, cell, wcid, xBits, yBits, salt.
  const SALT = 0xD1500A12; // arbitrary 32-bit constant; "D1 spawn"
  const inputs = [landblockId >>> 0, cell >>> 0, wcid >>> 0, xBits, yBits, SALT];
  for (const v of inputs) {
    for (let i = 0; i < 4; i += 1) {
      const byte = (v >>> (i * 8)) & 0xff;
      h = (h ^ byte) >>> 0;
      h = Math.imul(h, FNV_PRIME) >>> 0;
    }
  }
  // Force high bit so synthetic GUIDs sit in a distinct subspace.
  return (h | 0x80000000) >>> 0;
}

/**
 * Resolve a (wcid, name) pair to a (setupDid, placeholder) tuple.
 * Placeholder fallback when the wcid isn't in the staged map.
 */
function resolveSetup(map, wcid) {
  if (map) {
    const setup = map.get(wcid >>> 0);
    if (setup) {
      return { setupDid: setup, placeholder: false };
    }
  }
  return { setupDid: PLACEHOLDER_SETUP_DID, placeholder: true };
}

/**
 * AC ItemType bits (subset). Mirrors index.html:2794+ ITEM_TYPE
 * constants — the wire `PublicWeenieDescription.item_type` IS this
 * bitmask. We use it to compute a category for the nameplate /
 * placeholder-glyph path on the 2D side. The 3D path doesn't read
 * itemType today, but we still wire it on the upd so a future
 * 3D placeholder phase can pick category-keyed visuals.
 */
const ITEM_TYPE = Object.freeze({
  MELEE_WEAPON: 0x00000001,
  ARMOR: 0x00000002,
  CLOTHING: 0x00000004,
  CREATURE: 0x00000010,
  CONTAINER: 0x00000200,
  WRITABLE: 0x00002000,
  KEY: 0x00004000,
  PORTAL: 0x00010000,
  LIFE_STONE: 0x10000000,
});

/**
 * Map an ACE category string + weenieType to a plausible ItemType.
 * The source JSONL only carries the coarse `category` string
 * ("Creature", "Object", "NPC") plus `weenieType` (10=Creature,
 * 12=NPC, 19=Door, 20=Container, 7=Surface, 44=Book, …). The
 * renderer's 2D placeholder-glyph fallback uses ItemType bits to
 * pick a colour; we approximate from these two strings.
 *
 * Not load-bearing — getting it wrong means a wrongly-coloured glyph
 * on the 2D path, never a missing render. The 3D path doesn't use
 * itemType today.
 */
function deriveItemType(category, weenieType) {
  switch (category) {
    case "Creature":   return ITEM_TYPE.CREATURE;
    case "NPC":        return ITEM_TYPE.CREATURE;
    case "Container":  return ITEM_TYPE.CONTAINER;
    default: break;
  }
  // weenieType-keyed fallback for "Object" / unknown.
  switch (weenieType) {
    case 12:  return ITEM_TYPE.CREATURE;  // NPC
    case 19:  return 0;                   // Door — no glyph mapping
    case 20:  return ITEM_TYPE.CONTAINER;
    case 7:   return 0;                   // Surface (sign / portal frame)
    case 44:  return ITEM_TYPE.WRITABLE;  // Book
    default:  return 0;
  }
}

/**
 * Build an `upd` payload matching the wire `EntityUpdate` shape that
 * `window.__scene3dEntityHook` + `window.handleEntitySpawn` consume.
 *
 * Mirrors the wasm-bindgen `EntityUpdate` field set used by the 2D
 * drainEvents loop (see index.html:2670+ `__scene3dCloneEntityUpdate`).
 * `kind: 1` = KIND_SPAWN.
 *
 * Notes:
 *   - `guid` is synthetic-deterministic (re-fires are idempotent).
 *   - `modelId` carries the resolved setupDid; the 3D path reads this
 *     as the EntityManager rig setup_id.
 *   - `x, y, z` are LB-local metres (ACE convention; the wire ships
 *     them that way and the 3D path does the `lbX * 192 + x` add).
 *   - Identity quaternion (the source JSONL drops orientation).
 *   - All velocity / motion / sub-palette fields are zeroed — spawns
 *     arrive idle; ACE pushes the moving state separately via kind=5.
 */
function buildUpd(record, setupDid, isPlaceholder) {
  const wcid = record.wcid >>> 0;
  // The wasm-side `EntitySpawnJs.landblockId` getter (lib.rs:1768
  // `to_js`) already returns the full packed LB key `cell_id & 0xFFFF_0000`
  // (e.g. 0xA9B40000 for Holtburg), with the cell bits stripped. Don't
  // re-pack — just OR in the per-record cell for indoor placements (cell
  // is 0 for outdoor, non-zero for EnvCell complexes). The renderer's
  // hooks consume the same `(lbX<<24 | lbY<<16 | cell)` packed form
  // (matches index.html:4169 + scene3d/loop.js:571-573).
  //
  // Prior bug: `((lbId & 0xffff) << 16)` masked the high LB bits away,
  // producing packedLbId = `cell` only. _spawnImpl's world-frame
  // conversion at entities.js:1084-1090 then derived lbX = lbY = 0 and
  // emitted root.position in LB-local frame instead of AC-world — every
  // entity rendered at (meta.x, meta.y) ∈ [0, 192) instead of the
  // intended (lbX*192+meta.x, lbY*192+meta.y). The validator's entity
  // matcher (which buckets on `floor(world/192)`) then resolved every
  // spawn to bucket key `wcid|0|0` and got `entities: matched=0`.
  const lbId = record.landblockId >>> 0;
  const packedLbId = (lbId | (record.cell & 0xffff)) >>> 0;
  return {
    kind: 1, // KIND_SPAWN
    guid: deriveSyntheticGuid(lbId, record.cell, wcid, record.x, record.y),
    modelId: setupDid >>> 0,
    landblockId: packedLbId,
    x: record.x,
    y: record.y,
    z: record.z,
    // Identity quat — the source JSONL drops per-axis orientation
    // components. Future dumper upgrade plumbs real quats through.
    qw: record.qw ?? 1,
    qx: record.qx ?? 0,
    qy: record.qy ?? 0,
    qz: record.qz ?? 0,
    // Velocity / motion / animation: zero (idle spawn).
    vx: 0, vy: 0, vz: 0,
    omegaZ: 0,
    motionCommand: 0,
    motionStance: 0,
    // Weenie metadata.
    wcid,
    itemType: deriveItemType(record.category, record.weenieType) >>> 0,
    name: record.name || "",
    iconId: 0,
    objScale: 1.0,
    paletteId: 0,
    mtableId: 0,
    // Sub fields: empty Uint32Arrays — matches the wire's
    // `EntityUpdate.modelChanges / textureChanges / subPalettes` shape
    // for un-substituted entries.
    modelChanges: new Uint32Array(0),
    textureChanges: new Uint32Array(0),
    subPalettes: new Uint32Array(0),
    // H2 — no PhysicsScript (per-entity particle FX) on staged spawns
    // today. Future dumper can plumb default_script_id; the injector
    // absorbs it without change.
    physicsScriptDid: 0,
    soundTableDid: 0,
    // Phase D extension: mark synthetic-injected events so capture
    // scripts can count vs real ACE spawns. The renderer ignores
    // this field today; entityManager._spawnImpl stashes meta as-is.
    __synthetic: true,
    __placeholder: !!isPlaceholder,
    __category: record.category || "Object",
    // Stamp `kind` for the back-compat 2D path's switch (matches the
    // shared __scene3dCloneEntityUpdate clone shape).
  };
}

/**
 * Inject one record's worth of spawn events through the
 * canonical dispatch surfaces. Returns `{ injected: true, guid }` on
 * success, `null` when neither dispatcher is wired.
 *
 * Routes:
 *   1. `window.__scene3dEntityHook(upd)` — the 3D path's shared-drain
 *      dispatcher. Routes kind=1 to `entityManager.spawn(toMeta(upd))`.
 *      This is the load-bearing call for Phase D's assertion target
 *      (entitiesGroup.children growth).
 *   2. `window.handleEntitySpawn(upd)` — the 2D path. A no-op in 3D
 *      mode (ensureEntitySprite returns null when liveScene is unset)
 *      but firing it here mirrors the wire's index.html:6529-6540
 *      "dispatch through BOTH paths" loop.
 *
 * Both calls share the same upd object, mirroring how the wire
 * dispatches a single wasm-side `EntityUpdate` into both paths.
 */
function dispatchSpawnUpd(upd) {
  // 3D path — the assertion target.
  if (typeof window.__scene3dEntityHook === "function") {
    try {
      window.__scene3dEntityHook(upd);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.spawns] __scene3dEntityHook threw:", e);
    }
  }
  // 2D path — no-op in 3D mode but fired for parity with the wire.
  if (typeof window.handleEntitySpawn === "function") {
    try {
      window.handleEntitySpawn(upd);
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn("[scene3d.spawns] handleEntitySpawn threw:", e);
    }
  }
  return { injected: true, guid: upd.guid >>> 0 };
}

/**
 * Phase D.1.c — fetch + replay one LB's worth of staged ACE spawns
 * through the canonical entity-spawn dispatch surfaces.
 *
 * Called by the lazy LB-entry hook in index.html (mirrors the
 * `loadStaticsForLandblock` shape from Phase C). Idempotent — repeat
 * calls for the same LB are O(1) hash hits.
 *
 * Signature mirrors `loadStaticsForLandblock(lbX, lbY)` for symmetry,
 * but takes the full `scene3d` so the function can probe
 * `scene3d.entityManager` and `scene3d.wasmExports`.
 *
 * Returns an awaitable summary `{ lbKey, fetched, injected,
 * placeholdersCount, idempotent: false }` (or `{ idempotent: true }`
 * for already-injected LBs).
 */
export async function ensureSpawnsForLandblock(lbX, lbY, scene3d, wasmExports) {
  // Sanity gates — fail soft when the renderer hasn't given us a
  // working 3D stack (e.g. a synthetic capture path that skipped
  // init3D's entity-manager setup).
  if (!scene3d) return null;
  // Expose the per-LB injected-state evictor on scene3d so landblock_lru
  // (which holds the same object as `this.scene3d` and takes no imports)
  // can clear our idempotency mark when it evicts the LB — letting a
  // re-walk into the LB re-inject its spawns. Idempotent assignment.
  if (scene3d._evictSpawnsInjectedLb !== _evictSpawnsInjectedLb) {
    scene3d._evictSpawnsInjectedLb = _evictSpawnsInjectedLb;
  }
  if (!wasmExports || typeof wasmExports.fetch_landblock_spawns !== "function") {
    if (!scene3d._spawnsFetchUnavailableWarned) {
      scene3d._spawnsFetchUnavailableWarned = true;
      // eslint-disable-next-line no-console
      console.warn(
        "[scene3d.spawns] fetch_landblock_spawns not in wasmExports; " +
          "ACE spawn injection skipped"
      );
    }
    return null;
  }

  // `?spawns=` gate — skip synthetic when a live wire session is
  // delivering the same entities (else every retail spawn renders
  // twice with different GUIDs). See `readSpawnsMode` comment above.
  const sessionPresent = typeof window !== "undefined" && !!window.__sessionHandle;
  logSpawnsModeOnce(sessionPresent);
  if (!shouldInjectSynthetic()) {
    const skipKey = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
    return { lbKey: skipKey, modeGated: true, mode: SPAWNS_MODE };
  }

  const lbKey = (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16)) >>> 0;
  if (_spawnsInjectedLbs.has(lbKey)) {
    return { lbKey, idempotent: true };
  }
  if (_spawnsInjectInFlight.has(lbKey)) {
    return { lbKey, inFlight: true };
  }
  // Transient-failure cooldown: a recent throw set a retry-after timestamp.
  // Skip until it elapses so we don't hammer the failing fetch every
  // position update, but DO retry once the window passes (unlike the old
  // permanent-poison behaviour).
  const failUntil = _spawnsFailUntil.get(lbKey);
  if (failUntil !== undefined) {
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (nowMs < failUntil) {
      return { lbKey, failCooldown: true };
    }
    _spawnsFailUntil.delete(lbKey);
  }
  _spawnsInjectInFlight.add(lbKey);

  // First-call init — at most one each per page.
  ensureSpawnsInit(wasmExports);
  const wcidToSetup = await loadWcidToSetupMap();

  try {
    // `fetch_landblock_spawns` takes a Vec<u32> of LandblockInfo
    // cell IDs (XXYYFFFE). We pass exactly one; the wasm helper
    // strips the low 16 bits to derive the LB key for the cache
    // lookup, then fetches `<base>/0xXXXX.spawns.jsonl`.
    const cellId = (lbKey | 0x0000fffe) >>> 0;
    const records = await wasmExports.fetch_landblock_spawns(
      new Uint32Array([cellId])
    );
    const fetched = records?.length ?? 0;

    let injected = 0;
    let placeholdersCount = 0;
    const dispatchedGuids = [];

    // F.40 (2026-05-14) — collect per-record snapshots + resolved
    // setupDids first, then run a SINGLE batched
    // fetchEntityAnimationKeyframes pre-warm before dispatching
    // any spawn events. The animation cache's `getBatch` pre-warms
    // the wasm-side `shards` cache for every unique setupDid in
    // ONE prefetch loop instead of N independent loops (one per
    // entityManager.spawn). F.36 measured the per-entity rig-build
    // serialization at 4-19s per cold walk × 25 unique setups in a
    // populated Holtburg LB = 100-475s sequential drain. Batched
    // walk drops that to one prefetch loop's worth of round-trips
    // total (~3 rounds × ~1 RTT) — the JS-side cache fills lazily
    // via the existing AnimationCache.get path on first spawn.
    //
    // B7 (2026-05-18) — collapse the double-snapshot pattern. Earlier
    // revisions built a JS-side `snapshot` here just to capture `rec`'s
    // fields before `rec.free()`, then re-shaped that snapshot into an
    // `upd` via `buildUpd` in the dispatch loop below. With 427 Holtburg
    // spawns at cold-start that was 854 object literals for a single
    // logical event. We now build `upd` directly from `rec` (the only
    // wire-shape consumer is `dispatchSpawnUpd`); the snapshot is gone.
    // `buildUpd` only reads — it never mutates — so calling it eagerly
    // before `rec.free()` is safe. `setupDid` is kept as a sibling field
    // on the pending entry so the F.40/F.41 pre-warm loops below stay
    // O(1) lookups instead of fishing `upd.modelId` back out per pass.
    const pendingDispatches = [];
    for (const rec of records || []) {
      const wcid = rec.wcid >>> 0;
      const resolved = resolveSetup(wcidToSetup, wcid);
      if (resolved.placeholder) placeholdersCount += 1;
      const upd = buildUpd(rec, resolved.setupDid, resolved.placeholder);
      // Free the wasm EntitySpawnJs handle now that `upd` has captured
      // every field `buildUpd` reads. `buildUpd` is pure read; `upd`
      // holds its own scalars + freshly-allocated Uint32Arrays.
      if (typeof rec.free === "function") {
        try { rec.free(); } catch (_) { /* ignore */ }
      }
      pendingDispatches.push({ upd, setupDid: resolved.setupDid });
    }

    // F.40 pre-warm: collect unique setupDids and call the batched
    // wasm fetcher through the AnimationCache. Idempotent across
    // re-entries for the same LB (the cache filters already-warmed
    // setupIds) and across adjacent LBs that share weenies. We tolerate
    // missing prerequisites (no entityManager, no wasm export, etc.)
    // — the pre-warm is a pure perf optimisation; correctness still
    // holds via the per-spawn lazy fetch in entities.js::_spawnImpl.
    const animCache = scene3d?.entityManager?.animationCache;
    const fetchBatch = wasmExports?.fetchEntityAnimationKeyframesBatch;
    if (
      animCache &&
      typeof animCache.getBatch === "function" &&
      typeof fetchBatch === "function" &&
      pendingDispatches.length > 0
    ) {
      const uniqueSetupIds = [
        ...new Set(pendingDispatches.map((d) => d.setupDid >>> 0)),
      ];
      const tPrewarmStart =
        typeof performance !== "undefined" ? performance.now() : 0;
      try {
        const summary = await animCache.getBatch(uniqueSetupIds, fetchBatch);
        const tPrewarmMs =
          (typeof performance !== "undefined" ? performance.now() : 0) -
          tPrewarmStart;
        if (summary && summary.prewarmedCount > 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[scene3d.spawns] LB 0x${((lbKey >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, "0")}: ` +
              `F.40 pre-warm ${summary.prewarmedCount} setups ` +
              `(${summary.skippedCount} already warm) in ${tPrewarmMs.toFixed(1)}ms`
          );
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[scene3d.spawns] F.40 pre-warm threw (${String(e).slice(0, 200)}); ` +
            `continuing with per-spawn lazy fetch`
        );
      }
    }

    // F.41 (2026-05-15) — batched surfaces pre-warm. After F.40 warms
    // every setup's wasm `shards`, walk each unique setupDid via the
    // (warm, sync-fast) `collectSurfaceDidsForSetups` export to extract
    // per-entity surface DIDs. Then call `materialCache.preloadBatch`
    // (which wraps `fetchEntitySurfacesPixelsBatch`) to fetch ALL
    // entities' surface pixels in ONE prefetch loop — collapsing the
    // F.40-report's "65 surface walks, none batched" into one shared
    // walk.
    //
    // Synthetic spawns have no palette overrides (`paletteId=0`, no
    // subPalettes — see `buildUpd` above), so each entity's group is
    // `{ surfaceDids: extractedDids, baseplaletteId: 0, subPalettes: [] }`.
    // Live ACE spawns with palette state will reach this path later
    // via the same wire entry; the batch handles palette per-entity
    // correctly (see `tests_entity_surfaces_pixels_batch::
    // batch_palette_overlays_apply_per_entity`).
    //
    // Fail-soft on every missing prerequisite: materialCache absent,
    // wasm exports absent, helper throws. The per-spawn lazy fetch in
    // entities.js::_spawnImpl remains the correctness floor.
    const matCache = scene3d?.materialCache;
    const collectDidsFn = wasmExports?.collectSurfaceDidsForSetups;
    const fetchSurfBatch = wasmExports?.fetchEntitySurfacesPixelsBatch;
    if (
      matCache &&
      typeof matCache.preloadBatch === "function" &&
      typeof collectDidsFn === "function" &&
      typeof fetchSurfBatch === "function" &&
      pendingDispatches.length > 0
    ) {
      const tSurfStart =
        typeof performance !== "undefined" ? performance.now() : 0;
      try {
        // Step 1: collect per-setup surface DIDs from the warm cache.
        const uniqueSetupIds = [
          ...new Set(pendingDispatches.map((d) => d.setupDid >>> 0)),
        ];
        const surfDidsResult = await collectDidsFn(
          new Uint32Array(uniqueSetupIds)
        );
        // Result is `{ flatSurfaceDids: Uint32Array, surfaceDidsLens: Uint32Array }`
        // parallel to uniqueSetupIds order. Build a map for per-entity lookup.
        const flatDids = surfDidsResult.flatSurfaceDids;
        const didsLens = surfDidsResult.surfaceDidsLens;
        const setupToDids = new Map();
        let off = 0;
        for (let i = 0; i < uniqueSetupIds.length; i += 1) {
          const len = didsLens[i] >>> 0;
          const dids = [];
          for (let k = 0; k < len; k += 1) dids.push(flatDids[off + k]);
          setupToDids.set(uniqueSetupIds[i], dids);
          off += len;
        }
        try {
          if (surfDidsResult && typeof surfDidsResult.free === "function") {
            surfDidsResult.free();
          }
        } catch (_) { /* ignore */ }

        // Step 2: build per-entity groups + call materialCache.preloadBatch.
        // One group per unique setupDid is enough (entities sharing a
        // setupDid share materials via this.materials in the cache).
        // For synthetic spawns, every group has paletteId=0 + empty
        // subPalettes so they all install into the shared cache.
        const groups = uniqueSetupIds
          .map((setupDid) => ({
            surfaceDids: setupToDids.get(setupDid) || [],
            baseplaletteId: 0,
            subPalettes: [],
          }))
          .filter((g) => g.surfaceDids.length > 0);
        if (groups.length > 0) {
          await matCache.preloadBatch(groups, fetchSurfBatch);
          const tSurfMs =
            (typeof performance !== "undefined" ? performance.now() : 0) -
            tSurfStart;
          // eslint-disable-next-line no-console
          console.log(
            `[scene3d.spawns] LB 0x${((lbKey >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, "0")}: ` +
              `F.41 surfaces pre-warm ${groups.length} setups in ${tSurfMs.toFixed(1)}ms`
          );
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[scene3d.spawns] F.41 surfaces pre-warm threw (${String(e).slice(0, 200)}); ` +
            `continuing with per-spawn lazy fetch`
        );
      }
    }

    // Dispatch every spawn through the canonical __scene3dEntityHook
    // path. Each entityManager.spawn(meta) → _spawnImpl runs its own
    // `fetchEntityAnimationKeyframes` (lazy single-call) which now
    // hits the warm wasm-side shards cache (F.40) and short-circuits
    // its prefetch loop. Surface fetches inside _spawnImpl (whether
    // via `fetch_surfaces_pixels` or `fetchEntitySurfacesPixels`) ALSO
    // hit the warm wasm-side shards cache (F.41) so the
    // materialCache.preload / fetchEntitySurfacesPixels call there
    // short-circuits ITS prefetch loop too.
    for (const pending of pendingDispatches) {
      // B7 (2026-05-18) — `upd` was constructed in the collection loop
      // above (one allocation per spawn instead of snapshot+upd = two).
      const result = dispatchSpawnUpd(pending.upd);
      if (result?.injected) {
        injected += 1;
        dispatchedGuids.push(result.guid);
      }
    }

    _spawnsInjectedLbs.add(lbKey);
    // Stash per-LB diag on scene3d so capture scripts can probe the
    // last-injected-set without re-reading the JSONL.
    if (!scene3d.spawnsByLb) scene3d.spawnsByLb = new Map();
    scene3d.spawnsByLb.set(lbKey, {
      fetched,
      injected,
      placeholdersCount,
      guids: dispatchedGuids,
    });
    // Bump aggregate counters too — mirrors the other baker summary
    // shapes (terrain.lbCount, statics.objectCount, etc.).
    if (!scene3d.spawnsSummary) {
      scene3d.spawnsSummary = {
        lbCount: 0,
        recordCount: 0,
        injectedCount: 0,
        placeholderCount: 0,
      };
    }
    scene3d.spawnsSummary.lbCount += 1;
    scene3d.spawnsSummary.recordCount += fetched;
    scene3d.spawnsSummary.injectedCount += injected;
    scene3d.spawnsSummary.placeholderCount += placeholdersCount;

    // eslint-disable-next-line no-console
    if (fetched > 0) {
      console.log(
        `[scene3d.spawns] LB 0x${((lbKey >>> 16) & 0xffff).toString(16).toUpperCase().padStart(4, "0")}: ` +
          `${fetched} record(s), ${injected} injected, ` +
          `${placeholdersCount} placeholder(s)`
      );
    }

    return {
      lbKey,
      fetched,
      injected,
      placeholdersCount,
      idempotent: false,
    };
  } catch (e) {
    // eslint-disable-next-line no-console
    console.warn(
      `[scene3d.spawns] LB 0x${((lbKey >>> 16) & 0xffff).toString(16)}: ` +
        `fetch/inject failed: ${String(e).slice(0, 200)}`
    );
    // Record a short retry-after cooldown so we don't retry on every
    // position update, but DO retry once the window elapses — a single
    // transient fetch reject must NOT permanently strip this LB's NPCs
    // for the whole session (the old `_spawnsInjectedLbs.add` did exactly
    // that). The success-path add (above) is the only permanent mark.
    const nowMs = typeof performance !== "undefined" ? performance.now() : Date.now();
    _spawnsFailUntil.set(lbKey, nowMs + _SPAWNS_FAIL_COOLDOWN_MS);
    return { lbKey, error: String(e) };
  } finally {
    _spawnsInjectInFlight.delete(lbKey);
  }
}

/**
 * Phase D.1 hand-test / capture support — clear the injection state
 * so a capture script can re-fire `ensureSpawnsForLandblock` after a
 * cache reset (e.g. testing wasm cache miss behaviour). The injected
 * entities themselves are NOT removed — those persist in the
 * EntityManager until `entityManager.remove(guid)`.
 *
 * NOT called in normal page flow.
 */
export function _resetSpawnsInjectorState() {
  _spawnsInjectedLbs.clear();
  _spawnsInjectInFlight.clear();
  _spawnsFailUntil.clear();
}

/**
 * LRU-eviction hook — drop the per-LB injected/cooldown state so roaming
 * back into a previously-evicted landblock re-injects its spawns. Called
 * from landblock_lru when it evicts the LB's terrain/buildings/statics
 * baked sets — reached via the `scene3d._evictSpawnsInjectedLb` reference
 * installed in `ensureSpawnsForLandblock` (landblock_lru takes no imports).
 * The injected EntityInstances themselves are evicted by the LRU's own
 * entity sweep; this just clears the idempotency marks.
 */
export function _evictSpawnsInjectedLb(lbKey) {
  _spawnsInjectedLbs.delete(lbKey);
  _spawnsFailUntil.delete(lbKey);
}

/** Test helper — read-only view of injected LB keys. */
export function _injectedSpawnLbs() {
  return new Set(_spawnsInjectedLbs);
}

export const _internals = {
  deriveSyntheticGuid,
  buildUpd,
  resolveSetup,
  PLACEHOLDER_SETUP_DID,
  SPAWNS_BASE_URL,
};
