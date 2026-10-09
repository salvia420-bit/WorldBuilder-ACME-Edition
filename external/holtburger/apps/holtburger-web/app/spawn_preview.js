// app/spawn_preview.js — start the cold load before Enter World (2026-10-09).
//
// The world streams from the local player's position (scene3d/world_stream.js),
// so a character-select screen used to mean the whole cold load waited for the
// player's choice: on the 1070 with a fresh profile a Holtburg spawn took 18 s
// to the first terrain and 83 s to a settled ring on the raw tailnet link, and
// ~10 min at 666 kbps. While the select screen is up this module streams the
// world around where the selected character last stood, so Enter lands in a
// place that is already loading (or loaded). The spot is remembered per
// server + account + character in localStorage: on every landblock change while
// in the world and at log-off / page close. A character never seen on this
// browser has no spot, and nothing location-specific is fetched for it.
//
// A wrong guess costs only bandwidth: before the player exists the landblock
// LRU evicts nothing, the real spawn streams exactly as it always did, and the
// terrain LOD re-centres on the first real landblock change
// (scene3d/index.js `previewSpawnArea`).
//
// `?spawnPreview=off` disables the warm-up (and the recording stays harmless).

export const LAST_LOCATION_PREFIX = "hb.lastLoc.v1:";

function isOff(v) {
  return v === "off" || v === "0" || v === "false";
}

/** `?spawnPreview` — default ON. */
export function spawnPreviewEnabled(search) {
  try {
    const s = search ?? globalThis.location?.search ?? "";
    return !isOff(new URLSearchParams(s).get("spawnPreview"));
  } catch (_) {
    return true;
  }
}

/** Storage key for one character on one server + account. */
export function lastLocationKey({ server = "", account = "", charId = 0 } = {}) {
  return `${LAST_LOCATION_PREFIX}${String(server).toLowerCase()}|${String(account).toLowerCase()}|${(Number(charId) >>> 0).toString(16)}`;
}

/**
 * A saved spot, or null when there is none / it is malformed. `cell` is the
 * full object-cell id (landblock in the high word, cell in the low word);
 * x/y/z are landblock-local metres.
 */
export function normalizeLocation(loc) {
  if (!loc || typeof loc !== "object") return null;
  const cell = Number(loc.cell) >>> 0;
  if (!cell || (cell >>> 16) === 0) return null;
  const x = Number(loc.x), y = Number(loc.y), z = Number(loc.z);
  if (![x, y, z].every(Number.isFinite)) return null;
  return { cell, x, y, z, t: Number.isFinite(+loc.t) ? +loc.t : 0 };
}

export function saveLastLocation(storage, key, loc) {
  const n = normalizeLocation(loc);
  if (!n || !storage || !key) return false;
  try {
    storage.setItem(key, JSON.stringify({ ...n, t: Date.now() }));
    return true;
  } catch (_) {
    return false;
  }
}

export function loadLastLocation(storage, key) {
  if (!storage || !key) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? normalizeLocation(JSON.parse(raw)) : null;
  } catch (_) {
    return null;
  }
}

/** Retail `(objcell_id & 0xffff) >= 0x100`: inside an EnvCell. */
export function isIndoorCell(cell) {
  return ((Number(cell) >>> 0) & 0xffff) >= 0x100;
}

/**
 * Where a NEW character starts: its start area's first location (ACE
 * PlayerFactory puts it at CharGen `StarterAreas[startArea].Locations[0]`, a
 * Training Academy). `startAreaId` null → the wizard's own default, the first
 * heritage's primary (else secondary) area. `catalog` is the plain char-gen
 * catalog (`client.characters.getCatalog()`); null when it has no spot for it.
 *
 * On the 1070 (fresh profile, raw link) the Holtburg academy's interior took
 * ~70 s after Enter to appear (~40 s fetching its 568 cells, ~20 s decoding
 * 232 surfaces), so a first-time player stood in a void unless this loads
 * while they are still on the character screen and in the wizard.
 */
export function newCharacterSpot(catalog, startAreaId = null) {
  const areas = Array.isArray(catalog?.starterAreas) ? catalog.starterAreas : [];
  let id = startAreaId == null ? null : Number(startAreaId);
  if (id == null || !Number.isFinite(id)) {
    const h = Array.isArray(catalog?.heritages) ? catalog.heritages[0] : null;
    const p = h?.primaryStartAreaIds?.[0], s = h?.secondaryStartAreaIds?.[0];
    id = typeof p === "number" && p >= 0 ? p : typeof s === "number" && s >= 0 ? s : null;
  }
  if (id == null) return null;
  const area = areas.find((a) => a?.startAreaId === id);
  return normalizeLocation(area?.firstLocation);
}

/**
 * Remembers where the local player is. `note(pose)` takes the wasm pose shape
 * ({landblockId, x, y, z}); it writes on a landblock change at once and
 * otherwise at most every `minIntervalMs`. `flush(pose)` always writes.
 */
export function createLocationRecorder({ storage, getKey, minIntervalMs = 15000, now = () => Date.now() } = {}) {
  let lastCell = 0;
  let lastWriteMs = -Infinity;
  const write = (pose) => {
    const key = getKey?.();
    if (!key || !pose) return false;
    const ok = saveLastLocation(storage, key, { cell: pose.landblockId, x: pose.x, y: pose.y, z: pose.z });
    if (ok) {
      lastCell = Number(pose.landblockId) >>> 0;
      lastWriteMs = now();
    }
    return ok;
  };
  return {
    note(pose) {
      if (!pose) return false;
      const cell = Number(pose.landblockId) >>> 0;
      if (!cell) return false;
      const lbChanged = (cell >>> 16) !== (lastCell >>> 16);
      if (!lbChanged && now() - lastWriteMs < minIntervalMs) return false;
      return write(pose);
    },
    flush(pose) {
      return write(pose);
    },
  };
}

/**
 * Start the warm-up for `loc` once the 3D scene exists (init3D runs right
 * after login, while the select screen is already up). Resolves with the
 * scene's preview record, or null (disabled, no spot, no scene in time, or a
 * player already in the world).
 */
export async function startSpawnPreview({ loc, getScene = () => globalThis.window?.liveScene3d, timeoutMs = 60000, pollMs = 250, search } = {}) {
  if (!spawnPreviewEnabled(search)) return null;
  const n = normalizeLocation(loc);
  if (!n) return null;
  const t0 = Date.now();
  let s3d = getScene();
  while (!s3d?.previewSpawnArea && Date.now() - t0 < timeoutMs) {
    await new Promise((r) => setTimeout(r, pollMs));
    s3d = getScene();
  }
  if (typeof s3d?.previewSpawnArea !== "function") return null;
  try {
    return s3d.previewSpawnArea(n) ?? null;
  } catch (_) {
    return null;
  }
}
