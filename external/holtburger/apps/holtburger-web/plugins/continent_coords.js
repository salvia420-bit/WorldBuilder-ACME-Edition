/**
 * plugins/continent_coords.js — Multi-continent coordinate transformations
 * for Dereth, the Great Northern Ocean corridor, and Dericost.
 *
 * Sourced from AC retail decomp and WorldBuilder geodetic specifications:
 * - 1 Landblock = 8 cells = 192.0 m
 * - 1 Cell = 24.0 m = 0.1 map coordinate units
 * - 1 Map Coordinate Unit = 10 cells = 240.0 m
 * - Dereth spans 0.0 m .. 48,960.0 m (255 landblocks)
 * - Ocean corridor spans 48,960.0 m .. 68,928.0 m (104 landblocks = 19,968.0 m)
 * - Dericost spans 68,928.0 m .. 117,888.0 m (255 landblocks = 48,960.0 m)
 * - Dericost continent offset = +68,928.0 m (+287.2 NS)
 * - Dericost cells carry Continent Bit 15 (0x8000) in cell IDs.
 */

export const CONTINENT_DERETH = 0;
export const CONTINENT_DERICOST = 1;
export const CONTINENT_BIT_15 = 0x8000;

export const DERICOST_Y_OFFSET_M = 68928.0;
export const DERICOST_Y_OFFSET = 68928.0;
export const DERICOST_NS_OFFSET = 287.2;

export const DERETH_Y_MIN_M = 0.0;
export const DERETH_Y_MAX_M = 48960.0;
export const DERETH_Y_MIN = 0.0;
export const DERETH_Y_MAX = 48960.0;
export const OCEAN_Y_MIN_M = 48960.0;
export const OCEAN_Y_MAX_M = 68928.0;
export const OCEAN_GAP_M = 19968.0;
export const DERICOST_Y_MIN_M = 68928.0;
export const DERICOST_Y_MAX_M = 117888.0;
export const DERICOST_Y_MIN = 68928.0;
export const DERICOST_Y_MAX = 117888.0;

export const LB_METRES = 192.0;
export const CELL_METRES = 24.0;
export const METRES_PER_COORD = 240.0;
export const COORD_ORIGIN = 101.95;

export const TOTAL_WORLD_LBS_Y = 614; // 255 Dereth + 104 Ocean + 255 Dericost

/**
 * Determine whether a cellId indicates the continent of Dericost.
 * Checks Continent Bit 15 (0x8000) or high bit 31.
 * @param {number} cellId
 * @returns {boolean}
 */
export function isDericostCell(cellId) {
  const id = cellId >>> 0;
  return ((id & CONTINENT_BIT_15) !== 0) || (((id >>> 31) & 1) === 1);
}

/**
 * Return continent string ('dericost' vs 'dereth') for a cellId.
 * @param {number} cellId
 * @returns {string}
 */
export function continentFromCellId(cellId) {
  return isDericostCell(cellId) ? 'dericost' : 'dereth';
}

/**
 * Return continent index (0 = Dereth, 1 = Dericost) for a cellId.
 * @param {number} cellId
 * @returns {number}
 */
export function continentIndexFromCellId(cellId) {
  return isDericostCell(cellId) ? CONTINENT_DERICOST : CONTINENT_DERETH;
}

/**
 * Determine continent by global AC Y position (metres).
 * @param {number} y
 * @returns {number}
 */
export function continentFromY(y) {
  return y >= DERICOST_Y_OFFSET_M ? CONTINENT_DERICOST : CONTINENT_DERETH;
}

/**
 * Check if global Y position is on Dericost (at or north of southern coastline).
 * @param {number} y
 * @returns {boolean}
 */
export function isDericostY(y) {
  return y >= DERICOST_Y_OFFSET_M;
}

/**
 * Convert local landblock Y metres to global AC metres.
 * @param {number} localY - Y coordinate within landblock or Dereth frame
 * @param {number|boolean|string} [continent=0] - 0/'dereth'/false vs 1/'dericost'/true
 * @returns {number}
 */
export function localYToGlobalY(localY, continent = 0) {
  const isDericost = continent === 1 || continent === true || continent === 'dericost';
  return (isDericost ? DERICOST_Y_OFFSET_M : 0.0) + Number(localY);
}

/**
 * Convert global AC metres to continent-local Y metres.
 * @param {number} globalY
 * @returns {number}
 */
export function globalYToLocalY(globalY) {
  const gy = Number(globalY);
  return gy >= DERICOST_Y_OFFSET_M ? gy - DERICOST_Y_OFFSET_M : gy;
}

/**
 * Encode landblock, local cell, and continent into full uint32 cell ID.
 * Preserves Bit 15 (0x8000) for Dericost.
 * @param {number|boolean|string} continent - 0 or 1
 * @param {number} lbX - 0..254
 * @param {number} lbY - 0..254
 * @param {number} cell - 1..64
 * @returns {number} uint32
 */
export function encodeContinentCellId(continent, lbX, lbY, cell) {
  const isDericost = continent === 1 || continent === true || continent === 'dericost';
  const contBit = isDericost ? CONTINENT_BIT_15 : 0;
  return (((lbX & 0xff) << 24) | ((lbY & 0xff) << 16) | contBit | (cell & 0x7fff)) >>> 0;
}

/**
 * Decode cell ID into continent and coordinate components.
 * @param {number} cellId
 * @returns {{continent: number, isDericost: boolean, lbX: number, lbY: number, cell: number}}
 */
export function decodeContinentCellId(cellId) {
  const id = cellId >>> 0;
  const isDericost = isDericostCell(id);
  const continent = isDericost ? CONTINENT_DERICOST : CONTINENT_DERETH;
  return {
    continent,
    isDericost,
    lbX: (id >>> 24) & 0xff,
    lbY: (id >>> 16) & 0xff,
    cell: id & 0x7fff,
  };
}

/**
 * Global AC metres (wx, wy) → map coordinates (ew, ns); East/North positive.
 * Supports the entire multi-continent expanse from -102.0S up to +390.0N.
 * @param {number} wx
 * @param {number} wy
 * @param {boolean} [isDericost=false]
 * @returns {{ew: number, ns: number}}
 */
export function worldToCoords(wx, wy, isDericost = false) {
  let y = Number(wy);
  if (isDericost && y < DERICOST_Y_OFFSET_M) {
    y += DERICOST_Y_OFFSET_M;
  }
  return {
    ew: wx / METRES_PER_COORD - COORD_ORIGIN,
    ns: y / METRES_PER_COORD - COORD_ORIGIN,
  };
}

/**
 * Inverse of worldToCoords: map coordinates (ew, ns) → global AC metres (wx, wy).
 * @param {number} ew
 * @param {number} ns
 * @returns {{wx: number, wy: number}}
 */
export function coordsToWorld(ew, ns) {
  return {
    wx: (ew + COORD_ORIGIN) * METRES_PER_COORD,
    wy: (ns + COORD_ORIGIN) * METRES_PER_COORD,
  };
}

/**
 * Convert cell ID + cell-local offsets to global AC metres.
 * Handles continent bit 15 offset (+68,928 m) automatically.
 * @param {number} cellId
 * @param {number} [lx=0]
 * @param {number} [ly=0]
 * @param {number} [lz=0]
 * @returns {{x: number, y: number, z: number, continent: number, isDericost: boolean}}
 */
export function cellToGlobal(cellId, lx = 0, ly = 0, lz = 0) {
  const decoded = decodeContinentCellId(cellId);
  const gx = decoded.lbX * LB_METRES + Number(lx);
  const gy = (decoded.isDericost ? DERICOST_Y_OFFSET_M : 0.0) + decoded.lbY * LB_METRES + Number(ly);
  return { x: gx, y: gy, z: Number(lz), continent: decoded.continent, isDericost: decoded.isDericost };
}

/**
 * Convert global AC metres to landblock-local cell and coordinate offsets.
 * @param {number} gx
 * @param {number} gy
 * @param {number} [gz=0]
 * @returns {{cell: number, cellId: number, x: number, y: number, z: number, continent: number, isDericost: boolean}}
 */
export function globalToCell(gx, gy, gz = 0) {
  const isDericost = gy >= DERICOST_Y_OFFSET_M;
  const continent = isDericost ? 1 : 0;
  const localGy = isDericost ? gy - DERICOST_Y_OFFSET_M : gy;
  const lbX = Math.max(0, Math.min(254, Math.floor(gx / LB_METRES)));
  const lbY = Math.max(0, Math.min(254, Math.floor(localGy / LB_METRES)));
  const lx = Math.max(0, Math.min(191.999, gx - lbX * LB_METRES));
  const ly = Math.max(0, Math.min(191.999, localGy - lbY * LB_METRES));
  const cellX = Math.floor(lx / CELL_METRES);
  const cellY = Math.floor(ly / CELL_METRES);
  const cellIdx = (cellX * 8 + cellY + 1) & 0x7fff;
  const contBit = isDericost ? CONTINENT_BIT_15 : 0;
  const cell = (((lbX << 24) | (lbY << 16) | contBit | cellIdx) >>> 0);
  return { cell, cellId: cell, x: lx, y: ly, z: Number(gz), continent, isDericost };
}

/**
 * 2D Euclidean distance between two positions, properly respecting continent offsets.
 * @param {{cell?: number, continent?: number, x: number, y: number}} posA
 * @param {{cell?: number, continent?: number, x: number, y: number}} posB
 * @returns {number} distance in metres
 */
export function continentDistance2D(posA, posB) {
  const contA = posA.continent != null ? posA.continent : (posA.cell ? continentIndexFromCellId(posA.cell) : continentFromY(posA.y));
  const contB = posB.continent != null ? posB.continent : (posB.cell ? continentIndexFromCellId(posB.cell) : continentFromY(posB.y));

  let gyA = Number(posA.y);
  let gyB = Number(posB.y);

  // If positions are given with landblock-relative cell and offsets
  if (posA.cell && (posA.cell >>> 16) !== 0 && gyA < 192.0) {
    const lbY = (posA.cell >>> 16) & 0xff;
    gyA = (contA === 1 ? DERICOST_Y_OFFSET_M : 0.0) + lbY * LB_METRES + gyA;
  }
  if (posB.cell && (posB.cell >>> 16) !== 0 && gyB < 192.0) {
    const lbY = (posB.cell >>> 16) & 0xff;
    gyB = (contB === 1 ? DERICOST_Y_OFFSET_M : 0.0) + lbY * LB_METRES + gyB;
  }

  let gxA = Number(posA.x);
  let gxB = Number(posB.x);
  if (posA.cell && (posA.cell >>> 24) !== 0 && gxA < 192.0) {
    gxA = ((posA.cell >>> 24) & 0xff) * LB_METRES + gxA;
  }
  if (posB.cell && (posB.cell >>> 24) !== 0 && gxB < 192.0) {
    gxB = ((posB.cell >>> 24) & 0xff) * LB_METRES + gxB;
  }

  const dx = gxA - gxB;
  const dy = gyA - gyB;
  return Math.sqrt(dx * dx + dy * dy);
}

/**
 * Format coordinates string: NS first, e.g. "287.2N, 45.1E".
 * @param {number} ew
 * @param {number} ns
 * @returns {string}
 */
export function formatContinentCoords(ew, ns) {
  if (!Number.isFinite(ew) || !Number.isFinite(ns)) return "—";
  const nsSuffix = ns > 0 ? "N" : ns < 0 ? "S" : "";
  const ewSuffix = ew > 0 ? "E" : ew < 0 ? "W" : "";
  return `${Math.abs(ns).toFixed(1)}${nsSuffix}, ${Math.abs(ew).toFixed(1)}${ewSuffix}`;
}
