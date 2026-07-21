// nav_frame.js — the ONE copy of rynth's world-frame + cell-taxonomy math
// (C3 Stage-0; kills the D5 duplication where six modules each kept their own
// 2-line copy of this arithmetic — explore_memory.js, router.js,
// global_router.js, atlas.js, bot.js, ai/tools/dungeon_nav.js). Those sites now
// thin-re-export from here so the frame math has a single source of truth.
//
// AC packs an outdoor position into a 32-bit objCellId: the high byte is the
// landblock X, the next byte the landblock Y, and the low word the cell index
// (an indoor EnvCell in 0x0100..0xfffd, or an outdoor 1..64 LandCell). World-
// frame metres are landblock*192 + landblock-local metre.
//
// Pure, dependency-FREE leaf module: no imports, no host/session handle, no DOM.
// Safe to import from anywhere in rynth (including the node-testable atlas.js)
// without introducing a module cycle. Do NOT add imports here.

// ── world-frame metres from a full objCellId + landblock-local x/y ──────────
export function worldX(cellId, x) {
  return ((cellId >>> 24) & 0xff) * 192 + x;
}
export function worldY(cellId, y) {
  return ((cellId >>> 16) & 0xff) * 192 + y;
}
// Array form ([wx, wy]) — the shape router.js / global_router.js / atlas.js use.
export function worldXY(cellId, x, y) {
  return [worldX(cellId, x), worldY(cellId, y)];
}

// ── cell taxonomy ───────────────────────────────────────────────────────────
// 16-bit landblock number (the "lb word") of an objCellId.
export function landblockOf(cellId) {
  return (cellId >>> 16) & 0xffff;
}
// True if id's low word is a real indoor EnvCell index (DungeonPathfinder.cs:163).
// indoor_router.js exports its own copy under this same name for the indoor
// subsystem; explore_memory historically called it isIndoorCell (aliased below).
export function isEnvCellId(id) {
  const lo = (id >>> 0) & 0xffff;
  return lo >= 0x0100 && lo <= 0xfffd;
}
export { isEnvCellId as isIndoorCell };

// ── /loc degrees (observe.js frame): NS from world-Y, EW from world-X ────────
// Verbatim per observe.js:30-34 / VALIDATION COROLLARY. Do not "simplify": goto
// {ns,ew} feeds the sidecar's inverse DegToWorld.
export function worldToDeg(wx, wy) {
  return { ns: (wy / 24 - 1019.5) / 10, ew: (wx / 24 - 1019.5) / 10 };
}
export function locDegrees(cellId, x, y) {
  return worldToDeg(worldX(cellId, x), worldY(cellId, y));
}

// ── outdoor LandCell (LandDefs::gid_to_lcoord) from world-frame metres ───────
// Returns the FULL outdoor objCellId (landblock + cellIdx) plus the landblock-
// local x,y — the shape host.MoveToPosition / bot.goto need, NOT the 16-bit
// landblock number. Clamps to the 256x256 landblock grid and 8x8 cell grid so
// an out-of-range projection cannot wrap into a garbage landblock.
export function worldToOutdoorCell(wx, wy, z = 0) {
  const lbX = Math.max(0, Math.min(255, Math.floor(wx / 192)));
  const lbY = Math.max(0, Math.min(255, Math.floor(wy / 192)));
  const lx = wx - lbX * 192;
  const ly = wy - lbY * 192;
  const cellIdx = 1 + Math.min(7, Math.floor(lx / 24)) * 8 + Math.min(7, Math.floor(ly / 24));
  const lb = (((lbX << 24) | (lbY << 16) | cellIdx) >>> 0);
  return { lb, x: lx, y: ly, z };
}
