// scene3d/pipeline_flags.js — the re-engineered pipeline's stage flags, read in ONE place.
//
// SPEC §0.1 flag policy: DEV (`=on` opt-in) → VALIDATED → DEFAULT-ON (`flagIsOff`-grammar
// reader, `=off` escape) → RETIRED. The whole chain shares ONE default, `PIPELINE_DEFAULT_ON`:
//   * false (DEV): a stage is ON only when its own flag says on / 1 / true / yes — the
//     exact-match opt-in every stage reader had before this module;
//   * true (DEFAULT-ON, today): a stage is ON unless its own flag says off / 0 / false / no.
// Either way a stage also needs every stage it depends on — the kill cascade of pass 9
// D-09.3.3: packSource → {geomBundles, texCompressedOnly, slotGrid} → drawPools, and
// geomBundles → reliefBundles — and must not be vetoed (PIPELINE_VETO below).
//
// 2026-10-25: built for the owner's "get that default on" ask and flipped, then put back to
// false the same day on the 1070 A/B (chain −8 to −11 % fps steady state, ultra and high; owner:
// "Hold until parity"), and flipped ON again once the fixes brought it to parity (still, moving
// and tour within the run-to-run noise at ultra and high, 0 errors, pinned-sky frames match).
// docs/2026-10-25-pipeline-default-on.md has the numbers. Turning the chain back off is this
// ONE constant plus the url-flags rows; the node suites read it and follow.
//
// No page, no pipeline: a call without a `search` string where there is no `window.location`
// (the node suites' default imports, workers — whose `self.location` is the worker script's own
// URL, not the page's) reads every stage OFF. Callers that need a stage in such a context pass
// the page's search explicitly.
//
// Dependency-free on purpose: index.html's boot script, every stage module and the node suites
// import it.

/** The chain's shared default (see the header). */
export const PIPELINE_DEFAULT_ON = true;

/** Each stage's prerequisites (the F-11.3 chain). `frameWork` schedules the legacy loops too. */
export const PIPELINE_PREREQS = Object.freeze({
  packSource: Object.freeze([]),
  geomBundles: Object.freeze(["packSource"]),
  reliefBundles: Object.freeze(["geomBundles"]),
  texCompressedOnly: Object.freeze(["packSource"]),
  slotGrid: Object.freeze(["packSource"]),
  frameWork: Object.freeze([]),
  drawPools: Object.freeze(["slotGrid", "packSource", "geomBundles", "texCompressedOnly"]),
});

export const PIPELINE_STAGES = Object.freeze(Object.keys(PIPELINE_PREREQS));

/** The slot grid's fixed ring (residency_grid.js R_LB: 6×6 tiles = the 11×11 LB ring). */
export const SLOT_GRID_RING_RADIUS = 5;

/**
 * The page's PVS ring radius, read the way residency.js `derivePvsRingRadius` reads it
 * (`?pvsRingRadius=N` for integer 0..12 wins, else `?agentic=low` → 1, else 5) — duplicated
 * here so this module stays import-free; harness/test_pipeline_flags.mjs pins the two equal.
 */
export function pipelineRingRadius(ps) {
  try {
    const raw = ps.get("pvsRingRadius");
    if (raw) {
      const n = Number.parseInt(raw, 10);
      if (Number.isFinite(n) && n >= 0 && n <= 12) return n;
    }
    if (ps.get("agentic") === "low") return 1;
  } catch (_) { /* fall through */ }
  return SLOT_GRID_RING_RADIUS;
}

/**
 * Conditions OUTSIDE a stage's own flag that keep it off. The slot grid implements one fixed
 * ring (R = 5, 144 LBs); a page that asks for another draw distance — the bots' `?agentic=low`
 * (radius 1, 9 LBs) or any `?pvsRingRadius` ≠ 5 — keeps the legacy residency, which honours it,
 * instead of silently streaming the whole 11×11 ring (2026-10-25, with the default flip). The
 * pools need the grid, so they stand down with it (the cascade).
 */
const PIPELINE_VETO = Object.freeze({
  slotGrid: (ps) => pipelineRingRadius(ps) !== SLOT_GRID_RING_RADIUS,
});

/** The house "switched off" grammar (the same words as bc7_textures.js `flagIsOff`). */
export function pipelineFlagIsOff(v) {
  if (v == null) return false;
  const t = String(v).toLowerCase();
  return t === "off" || t === "0" || t === "false" || t === "no";
}

/** An explicit opt-in spelling (`on`/`1`/`true`/`yes`) — only used to decide whether a
 *  prerequisite conflict deserves a loud message. */
export function pipelineFlagIsOn(v) {
  if (v == null) return false;
  const t = String(v).toLowerCase();
  return t === "on" || t === "1" || t === "true" || t === "yes";
}

function _searchOf(search) {
  if (search !== undefined) return search == null ? "" : String(search);
  if (typeof window !== "undefined" && window.location) return window.location.search || "";
  return null; // no page
}

/** A stage's OWN flag under the shared default: default-on reads ON unless an off spelling,
 *  default-off (DEV) reads ON only for an on spelling. */
function _ownOn(v, defaultOn) {
  return defaultOn ? !pipelineFlagIsOff(v) : pipelineFlagIsOn(v);
}

/**
 * Is `stage`'s OWN flag on (ignoring prerequisites and vetoes)? For diagnostics that must name
 * the real cut. Unknown stage names throw.
 */
export function pipelineOwnFlagOn(stage, search, defaultOn = PIPELINE_DEFAULT_ON) {
  if (!Object.prototype.hasOwnProperty.call(PIPELINE_PREREQS, stage)) {
    throw new Error(`pipeline_flags: unknown stage ${stage}`);
  }
  const s = _searchOf(search);
  if (s == null) return false;
  try {
    return _ownOn(new URLSearchParams(s).get(stage), defaultOn);
  } catch (_) {
    return false;
  }
}

/**
 * Is `stage` on for this page? Its own flag under the shared default (PIPELINE_DEFAULT_ON, or
 * `defaultOn` when a suite pins the other polarity), not vetoed, and every prerequisite on
 * (recursively). Unknown stage names throw: a typo must not read ON.
 * @param {string} stage one of PIPELINE_STAGES
 * @param {string} [search] query string (defaults to the page's own)
 * @param {boolean} [defaultOn] the shared default (tests pin both polarities)
 */
export function pipelineStageEnabled(stage, search, defaultOn = PIPELINE_DEFAULT_ON) {
  if (!Object.prototype.hasOwnProperty.call(PIPELINE_PREREQS, stage)) {
    throw new Error(`pipeline_flags: unknown stage ${stage}`);
  }
  const s = _searchOf(search);
  if (s == null) return false;
  let ps;
  try {
    ps = new URLSearchParams(s);
  } catch (_) {
    return false;
  }
  const vetoed = (name) => !!(PIPELINE_VETO[name] && PIPELINE_VETO[name](ps));
  // Default-on: a prerequisite must itself be ON (the full kill cascade). Default-off (DEV): a
  // prerequisite only CUTS when it is explicitly switched off or vetoed — completeness stays with
  // the arming code exactly as it did for the old exact-match readers (packSource's controller
  // leg, checkDrawPoolsPrereqs naming every missing `=on`), so a DEV url reads as it always did.
  const notCut = (name) => !pipelineFlagIsOff(ps.get(name)) && !vetoed(name) && PIPELINE_PREREQS[name].every(notCut);
  const on = (name) => _ownOn(ps.get(name), defaultOn)
    && !vetoed(name)
    && PIPELINE_PREREQS[name].every(defaultOn ? on : notCut);
  return on(stage);
}

/**
 * The prerequisites that are off while `stage`'s own flag is EXPLICITLY on (`?slotGrid=on` with
 * `?packSource=off`). Empty when the stage is merely defaulted, so a cascade from an escape stays
 * quiet and only a contradictory URL is reported. Direct prerequisites only, each judged by
 * pipelineStageEnabled (so a prerequisite cut further up the chain is named too).
 */
export function pipelinePrereqConflicts(stage, search, defaultOn = PIPELINE_DEFAULT_ON) {
  if (!Object.prototype.hasOwnProperty.call(PIPELINE_PREREQS, stage)) {
    throw new Error(`pipeline_flags: unknown stage ${stage}`);
  }
  const s = _searchOf(search);
  if (s == null) return [];
  let ps;
  try {
    ps = new URLSearchParams(s);
  } catch (_) {
    return [];
  }
  if (!pipelineFlagIsOn(ps.get(stage))) return [];
  return PIPELINE_PREREQS[stage].filter((p) => !pipelineStageEnabled(p, s, defaultOn));
}
