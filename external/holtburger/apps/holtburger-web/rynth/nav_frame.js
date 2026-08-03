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
  // Both terms need the LOWER clamp too (2026-08-03 review F5). `lbX`/`lbY`
  // are clamped to >= 0 above but `lx`/`ly` are not, and NEGATIVE locals are
  // precisely what this module exists to handle — see normalizeLegWorldFrame's
  // header, which cites the live Town Network legs carrying y ~ -70. Town
  // Network cells are 0x0007xxxx, i.e. the landblock X byte is 0x00, so the
  // landblock base cannot lift a negative local back into range: without
  // Math.max(0, ...) the cell index goes negative and the OR below wraps into
  // a garbage landblock. Measured before the fix:
  //   normalizeLegWorldFrame({lb: 0x00070143, x: -12.5, y: -62.8})
  //     -> { lb: 0xfffffffe, x: -12.5 }
  // The duplicate of this function in goto_compose.js (:88-93) has always had
  // the Math.max — the two copies had silently diverged, and bot.js's
  // _walkGraphPath is the caller that got the unclamped one.
  const cellIdx = 1
    + Math.min(7, Math.max(0, Math.floor(lx / 24))) * 8
    + Math.min(7, Math.max(0, Math.floor(ly / 24)));
  const lb = (((lbX << 24) | (lbY << 16) | cellIdx) >>> 0);
  return { lb, x: lx, y: ly, z };
}

// ── router-leg world-frame normalization (goto_compose.js convention) ───────
// Re-bucket a router leg ({lb,x,y,z,...}) to the landblock whose base actually
// contains its world point — the sidecar WorldToLeg convention, and the
// live-proven treatment for dungeon EnvCell frames whose cell-local coords sit
// OUTSIDE [0,192) (live: Town Network 0x0007xxxx legs carry y ≈ −70; feeding
// those raw to MoveToPosition is the "internal cell re-derivation garbage"
// class goto_compose.js documents). goto_compose.js applies this to every
// indoor leg it issues (portal-approach, egress, wedge-repath — all
// live-proven in the Town Network); this shared copy lets the OTHER indoor leg
// producers (ai/tools/world.js indoorLegsTo, bot.js _walkGraphPath) issue the
// SAME frame instead of the raw EnvCell one. World-point identical (router.js
// worldXY of the result equals worldXY of the input); extra leg fields
// (portal/stitch/timeoutMs) are preserved by the spread.
export function normalizeLegWorldFrame(leg) {
  const wx = worldX(leg.lb >>> 0, leg.x);
  const wy = worldY(leg.lb >>> 0, leg.y);
  const cell = worldToOutdoorCell(wx, wy, leg.z);
  return { ...leg, lb: cell.lb, x: cell.x, y: cell.y };
}
