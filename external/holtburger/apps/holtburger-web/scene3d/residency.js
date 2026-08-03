// Residency policy — ONE landblock radius, four documented derived views
// (2026-08-03, residency task #9 + #12).
//
// WHY THIS FILE EXISTS
// --------------------
// The client used to carry five unrelated residency radii, each defined next to
// the code that happened to consume it, each with its own history block:
//
//   PVS_RING_RADIUS      = 5  (index.js)     prefetch/bake ring
//   REAP_PVS_RADIUS      = 8  (entities.js)  entity reaper keep-zone
//   STATICS_RING_RADIUS  = 6  (index.js)     LRU sizing input
//   BUILDINGS_RING_RADIUS= 6  (index.js)     LRU sizing input
//   ringMax = max(of the three above)        LRU cap sizing
//
// Nothing tied 5 to 8 to 6, so "how far does the world stay resident" could only
// be answered by reading three files and reconstructing the intent. The numbers
// were never independent in practice — every past tuning pass moved them
// together, and the reaper/LRU values are only ever meaningful RELATIVE to the
// bake ring (a keep-zone INSIDE the bake ring reaps things you can still see; an
// LRU cap BELOW the bake ring area thrashes evict↔re-bake).
//
// So: one base policy constant, and every other radius is a named offset off it
// with the relationship spelled out. Changing the world's residency footprint is
// now a one-line edit whose consequences are legible.
//
// DEFAULTS ARE BEHAVIOUR-PRESERVING. base 5 reproduces exactly the pre-refactor
// numbers: ring 5, reap 8, LRU sizing radius 6 → lbCap 203. Verified numerically
// (see the derivation table below) — this refactor changed no behaviour.
//
// URL OVERRIDES ARE UNCHANGED. Each derived value keeps its OWN flag with its
// OWN grammar, exactly as before the fold:
//   ?pvsRingRadius=N    (0..12, `?agentic=low` → 1)   → PVS_RING_RADIUS
//   ?entityReapRadius=N (1..64, "off" → default)      → REAP_PVS_RADIUS
//   ?staticsRadius=N    (0..6,  `?agentic=low` → 1)   → LRU sizing input
//   ?buildingsRadius=N  (0..6,  `?agentic=low` → 1)   → LRU sizing input
// The base constant is deliberately NOT url-exposed: it is a source-level policy
// knob, not a test arm. Flags override the derived value they always overrode.

/**
 * THE policy radius, in landblocks (1 LB = 192 m). Everything else in this file
 * is `RESIDENCY_RADIUS_LB + <named offset>`.
 *
 * 5 = an 11×11 ring ≈ 960 m horizon. History (the 2026-06-20 barren-wilderness
 * fix): the player-centered PVS expansion ring used to be a hardcoded 3×3
 * (radius 1, ~288 m) because an OUTDOOR `renderSet` is structurally always
 * {current} — the cell_portal_graph holds only indoor EnvCell portals
 * (scene.rs:990). Away from the (now-retired) Holtburg boot ring that produced
 * the "empty wilderness past ~480 m" symptom. Radius 5 makes the full visible
 * horizon follow the player.
 */
export const RESIDENCY_RADIUS_LB = 5;

/**
 * Bake/prefetch ring = the base itself. This IS the draw distance: it is the
 * only one of the four that decides what geometry gets fetched and baked.
 * Consumed as `scene3d.pvsRingRadius` by cells.js::tickPvsLoadExpansion.
 */
export const PVS_RING_OFFSET_LB = 0;

/**
 * Entity reaper keep-zone = base + 3 (→ 8, a 17×17 = 289-LB window).
 *
 * MUST stay WIDER than the bake ring: an entity inside the baked world that
 * falls outside the keep-zone gets its grace clock stopped and is reaped while
 * still potentially visible. +3 LBs of slack absorbs the reaper's 4 s scan
 * granularity plus in-flight ring expansion during fast transit.
 *
 * #11b (2026-07-14) measured the r=8 entity working set PEAK at ~3875 distinct
 * BufferGeometry on a 1070 corridor walk (town→wilderness), with a late ~2500-geom
 * bulk reap once the town fell 8 LBs behind; an (unpaired, spawn-noise-confounded)
 * r=3 arm peaked ~1636 and reaped continuously (no bulk drop). The reaper DOES
 * work at r=8 — the earlier "unbounded / zero-eviction" reading was a
 * stuck-character + backlog-drain artifact (corrected in RESULTS-task11a). So the
 * tighter radius is a DIRECTIONAL smoothness/peak win, NOT a validated default
 * change — left OPT-IN pending a multi-run A/B + live eye-test for creature
 * pop-out. Default stays base+3 = 8; `?entityReapRadius=N` opts into a tighter
 * (or wider) window.
 */
export const REAP_KEEP_OFFSET_LB = 3;

/**
 * LRU cap sizing radius = base + 1 (→ 6).
 *
 * MUST stay ≥ the bake ring, and the +1 perimeter is the anti-thrash margin: a
 * one-LB roam transiently holds the shifted ring AND its trailing edge before
 * eviction runs, so a cap sized to the bare ring area evicts LBs that are still
 * inside it and immediately re-bakes them. (Historically `?pvsRingRadius=6` hit
 * exactly this and needed a manual `?lbCap=225`.)
 *
 * ⚠ This value is NOT a draw distance and never has been an effective one since
 * the eager boot ring was retired (`docs/2026-06-30-spawn-driven-boot-retire-
 * holtburg-ring.md`). It reached today's shape as STATICS_RING_RADIUS /
 * BUILDINGS_RING_RADIUS — the old per-stream boot-ring radii, bumped 2→6 on
 * 2026-05-16 so the boot bake covered the visible horizon. With the boot ring
 * gone their ONLY surviving consumer is the LRU cap expression in index.js, so
 * that is what they are documented as now, and that is all `?staticsRadius` /
 * `?buildingsRadius` still do.
 */
export const LRU_SIZING_OFFSET_LB = 1;

/** Accepted URL range for the LRU-sizing flags: 0..default (historically 0..6). */
const LRU_SIZING_DEFAULT = RESIDENCY_RADIUS_LB + LRU_SIZING_OFFSET_LB;
/** Accepted URL range for `?pvsRingRadius`. */
const PVS_RING_DEFAULT = RESIDENCY_RADIUS_LB + PVS_RING_OFFSET_LB;
const PVS_RING_MAX = 12;
/** Accepted URL range for `?entityReapRadius`. */
const REAP_KEEP_DEFAULT = RESIDENCY_RADIUS_LB + REAP_KEEP_OFFSET_LB;
const REAP_KEEP_MIN = 1;
const REAP_KEEP_MAX = 64;

/** Query string, or null in unit/capture (no-`window`) contexts. */
function searchParams() {
  try {
    if (typeof window === "undefined" || !window.location) return null;
    return new URLSearchParams(window.location.search);
  } catch (_) {
    return null;
  }
}

/**
 * Player-centered PVS prefetch/bake ring radius.
 *
 * Grammar preserved verbatim from index.js's pre-fold IIFE: `?pvsRingRadius=N`
 * for integer 0..12 wins, else `?agentic=low` → 1, else the derived default.
 * The 0..12 ceiling was raised from 6 on 2026-06-22 once cells.js's bounded
 * stream-queue (`?pvsStreamQueue`, default-ON) capped concurrent bake fan-out —
 * resident geometry/VRAM still grows as (2N+1)², so very large radii want
 * texture-compression headroom.
 */
function derivePvsRingRadius() {
  const ps = searchParams();
  if (!ps) return PVS_RING_DEFAULT;
  try {
    const raw = ps.get("pvsRingRadius");
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n <= PVS_RING_MAX) return n;
    }
    if (ps.get("agentic") === "low") return 1;
  } catch (_) { /* fallthrough */ }
  return PVS_RING_DEFAULT;
}

/**
 * One LRU-sizing input (`?staticsRadius` or `?buildingsRadius`). Grammar
 * preserved verbatim from the pre-fold IIFEs: integer 0..default wins, else
 * `?agentic=low` → 1, else the derived default. Both flags survive because
 * they are still real arms for the LRU cap (`agentic=low` shrinking the cap to
 * its floor is the whole point of the low-agentic boot path).
 */
function deriveLruSizingInput(flagName) {
  const ps = searchParams();
  if (!ps) return LRU_SIZING_DEFAULT;
  try {
    const raw = ps.get(flagName);
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n <= LRU_SIZING_DEFAULT) return n;
    }
    if (ps.get("agentic") === "low") return 1;
  } catch (_) { /* fallthrough */ }
  return LRU_SIZING_DEFAULT;
}

/**
 * Entity-reaper keep-zone radius. Grammar preserved verbatim from entities.js's
 * pre-fold `readReapRadius()`: `?entityReapRadius=N` for 1..64 (floored) wins,
 * `off` / absent / garbage → the derived default.
 */
function deriveReapRadius() {
  const ps = searchParams();
  if (!ps) return REAP_KEEP_DEFAULT;
  try {
    const v = ps.get("entityReapRadius");
    if (v == null || v.toLowerCase() === "off") return REAP_KEEP_DEFAULT;
    const n = Number(v);
    return Number.isFinite(n) && n >= REAP_KEEP_MIN && n <= REAP_KEEP_MAX
      ? Math.floor(n)
      : REAP_KEEP_DEFAULT;
  } catch (_) {
    return REAP_KEEP_DEFAULT;
  }
}

/** Draw distance / bake ring. Default 5 (11×11 ≈ 960 m). */
export const PVS_RING_RADIUS = derivePvsRingRadius();

/** Entity keep-zone. Default 8 (17×17 = 289 LBs). */
export const REAP_PVS_RADIUS = deriveReapRadius();

/** LRU-sizing inputs. Default 6 each; exported for diagnosis, not consumed directly. */
export const STATICS_LRU_RADIUS = deriveLruSizingInput("staticsRadius");
export const BUILDINGS_LRU_RADIUS = deriveLruSizingInput("buildingsRadius");

/**
 * The radius index.js sizes the landblock LRU from (`ringMax`).
 *
 * `max(...)` — NOT just the derived default — because a deliberately large
 * `?pvsRingRadius=N` must still get a cap big enough to hold its ring, or the
 * bigger ring thrashes the moment the player moves. Same expression as the
 * pre-fold `Math.max(STATICS_RING_RADIUS, BUILDINGS_RING_RADIUS,
 * PVS_RING_RADIUS)`; at defaults it resolves to 6 → span 13 → lbCap
 * 13² + 2·13 + 8 = 203 (unchanged).
 */
export const LRU_SIZING_RADIUS = Math.max(
  STATICS_LRU_RADIUS,
  BUILDINGS_LRU_RADIUS,
  PVS_RING_RADIUS
);
