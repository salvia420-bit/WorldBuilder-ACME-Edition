// "Empyrean Relief" — the accepted vitals-orb concept, live.
//
// Three liquid vessels (blood-red health, yellow-bile stamina, blue
// mana with a portal-purple shimmer) composed as heraldic badges:
// each vital is one impresa with a single figure attending the
// vessel, all standing on the same ground line.
//
//   health   Asheron       (supporter, dexter)
//   stamina  composite bow (charge, in base)
//   mana     Bael'Zharon   (supporter, sinister)
//
// The figures are real DAT Setup renders carrying their own Surface
// colours, baked to PNG and shipped under `data/orb-sprites/`. Panel
// order health / stamina / mana puts Asheron at the far left and
// Bael'Zharon at the far right, so the panel itself gains supporters.
//
// === v3 (2026-07-29) — three figures, one plaque each ===
// Four figures are GONE on the user's direction: the Atlan sword, the
// weeping wand and both slithis tendrils, with their sprites, their
// alpha-grid hit entries and their placement rules. Bael'Zharon is dark
// again — the shipped sprite had been rendered from his Setup's raw
// surfaces, which are a bone/putty grey, so he read as a white figure;
// he is now remapped through his OWN palette (the Shade of Bael'zharon
// weenie, LSD wcid 36928, names PaletteBase 0x04001071, whose 0..255
// ramp is his black-to-crimson value ramp and whose 320..447 ramp is
// his blood). The sprite's own shading is untouched; only its VALUES
// were remapped through those two ramps, so the geometry, the silhouette
// and the light on it are still the DAT render's.
//
// The readouts are no longer bare text over the world. Each vital now
// carries a brass plate on an oak board — see the "readout: the plaque"
// block in styleText() for the design and its perf contract.
//
// === Selection ===
// STRICT opt-in: `?vitalsOrbs=on` (exact match — see the url-flags
// "the `!== off` idiom is default-ON by design" box; an opt-in must
// never use it). When on, `plugins/vitals-hud.js` mounts a no-op via
// the shared `isVitalsOrbsActive()` reader exported below, so exactly
// one vitals presentation is ever in the DOM. Off = the bars, byte-
// identical to before this plugin existed.
//
// === Provenance ===
// Design card:  scratchpad ds-bundle/concepts/orb-b-empyrean-relief/
// Build notes:  scratchpad/agentF-report.md + agentG-report.md
// Liquid stack (bottom to top), all inline SVG, no libraries:
//   1 parallax back body      counter-phase, 1.5λ, 1.2× amplitude
//   2 front body              2.4λ, TWO summed sines (2.7:1 beat) —
//                             one sine reads as a drawn squiggle
//   3 absorption gradient     bright at the surface, dark at depth
//   4 wall darkening          radial multiply clipped to the liquid
//   5 caustics                feTurbulence → feDisplacementMap, clipped
//                             to the LIVE wave path (`?orbCaustics=off`)
//   6 subsurface glow         blurred ellipse under the surface, screen
//   7 bounce light            the same colour on the empty dome above
//   8 specular streak         drifting along the waterline
//   9 three-stroke meniscus   under-shadow / surface / hairline specular
//                             + two wall-climb crescents
//  10 bubbles, mana shimmer, vitae scum band
//
// === Live wiring ===
//   fill      current / buffedMax          (kind=8 + kind=42/43/44)
//   slosh     |current − oldValue| / buffedMax → amplitude + speed
//             impulse that decays over ~0.8 s (the card's "just hit")
//   glare     damage only (current < oldValue), one 1.15 s flicker
//   low       health < 15% → darker churn, heartbeat, fracture web
//   vitae     buffedMax < base → the fill ceiling is buffedMax/base,
//             with a scummed waterline and dimmed hatched headspace
//
// === v2 (2026-07-28) — three transparent panes ===
// The opaque stone panel is GONE. Each vital is its own fixed overlay
// (`#hb-vitals-orb-hp` / `-stam` / `-mana`) with its own WINDOW_ID, so
// the three badges are positioned and persisted independently and no
// chrome covers the world between them. The vessels themselves are
// transparent above the waterline: the headspace is glass, not a dark
// hole, so you see the game through a half-empty orb.
//
// Pointer policy: a pane is `pointer-events: none` by default and is
// switched to `auto` only while the cursor is actually over VISIBLE ART
// (the orb circle, tested analytically; the plaque, tested as a plain
// rect because it is opaque; the figure sprites, tested against a
// coarse alpha grid sampled from their PNGs at mount). A half-
// transparent HUD that still eats clicks over the world is exactly what
// this revision exists to remove.
//
// === Perf === (measured, see scratchpad/agentJ-report.md)
// ONE rAF drives every wave phase, meniscus and liquid clip path on the
// page, at a 30 Hz CADENCE rather than at vsync (`?orbHz=N`). It is not
// started under `prefers-reduced-motion` (a single still frame is
// painted instead) and is cancelled while the tab is hidden.
//
// Three rules keep the tick cheap, all trace-verified:
//   1. NO style-invalidating writes in the tick. The waterline group is
//      moved through `transform.baseVal` (an SVGTransform mutation,
//      which marks the layout object's transform dirty) — NOT through
//      `setAttribute("transform", …)`, which is a presentation
//      attribute that maps into CSS style and forces a style recalc of
//      the subtree on every one of the 30 ticks a second.
//   2. Per-orb PAINT CONTAINMENT. Each vessel sits in its own
//      `contain: layout paint style` box sized to the orb, so a wave
//      tick dirties ~92×92 px instead of the whole badge. The figure
//      sprites live OUTSIDE that box and are never re-rastered by a
//      tick.
//   3. The STATIC glass — dome vignette, the two blurred speculars, the
//      inner shadow ring and the brass collar — is pre-composed into
//      ONE baked raster (`<image>` from a self-contained SVG data URL)
//      at mount. Live gradients/filters/blends are spent only on
//      genuinely dynamic layers: the wave bodies, the caustics crop and
//      the meniscus.
// Every mix-blend-mode in the vessel is walled in by `isolation:
// isolate` on the vessel's own <svg> root, so no screen/multiply layer
// can reach past the orb and blend with the 3D canvas that is now
// visible THROUGH the empty headspace.
//
// THE ONE THING NOT TO UNDO: the concept card drove the caustic
// `feTurbulence baseFrequency` from its rAF. Re-evaluating a fractal-
// noise field every frame — or animating a transform on the FILTERED
// group, which has the same effect — measured a hard 60 → 44 fps cliff
// on this laptop. The noise here is STATIC and cacheable; the caustics
// appear to crawl because they are clipped to the live wave path.
// `?orbCaustics=off` / `?orbHz=15` / `?orbScale=` remain the levers.
//
// === ?orbRender — Canvas2D vessel cores, DEFAULT ON since 2026-10-31 ===
// Owner ask "make the orbs cheaper" (1070 S2-QUIET: ?hudOrbs=off +2.3 still /
// +1.75 tour fps). 1070 S2-ORB (3 quiet interleaved reps, paired vs mean(A,
// A-AA), noise +-0.4-0.6): canvas +4.18 still / +3.65 moving / +3.75 tour fps,
// renderJs -0.78 ms — the same as hiding the orbs (+3.55 / +3.42 / +4.75);
// SVG at ?orbHz=15 only +1.7 / +1.4 / +1.8. Flipped to the default under the
// owner's rule (fps winners ship; the look, delegated, passed at DPR 1 and 2).
// ESCAPE: `?orbRender=svg` (or off / 0 / false / no) = the signed-off SVG
// vessel, byte for byte as before the flag existed. The liquid core of each
// vessel is drawn into ONE <canvas>
// with Canvas2D instead of the SVG subtree above; figures, plaques, readouts
// and the pointer gate stay DOM. Same driver, same cadence, same state, same
// wave(): everything STATIC is pre-rendered once at canvas-pixel scale (glass
// + caustics from the very bitmaps the SVG path bakes, wall darkening, blurred
// subglow / specular / shimmer sprites, the vitae scum layer, the fracture
// web), so a tick is two wave fills, one wave clip, a handful of drawImage
// calls and the meniscus strokes; no Blink style / layout / paint and no
// filter evaluation per tick, and a tick whose drawn values moved less than
// CV_SKIP_PX device px is not drawn at all. See the "?orbRender=canvas" block
// below and docs/url-flags.md.

import { attachWindowPosition, WINDOW_ID } from "../ui/ac_window_position.js";
import { hudDietOn } from "../ui/hud_diet.js";

// One overlay PER VITAL. The ids are load-bearing: index.html's
// agent-mode chrome strip exempts all three by id.
const PANE_ID = {
  hp: "hb-vitals-orb-hp",
  stam: "hb-vitals-orb-stam",
  mana: "hb-vitals-orb-mana",
};
const DEFS_ID = "hb-vitals-orbs-defs";
const STYLE_ID = "hb-vitals-orbs-style";
// Scoping selector for the stylesheet — one rule set, three panes.
const PANE_SEL = `#${PANE_ID.hp}, #${PANE_ID.stam}, #${PANE_ID.mana}`;
const P = ".hbo-pane";  // every rule below is `.hbo-pane <thing>`

// Vital-type codes match `crates/holtburger-protocol/src/messages/
// movement/types.rs::VitalsKind` (Health=1, Stamina=3, Mana=5), the
// same map vitals-hud.js uses.
const TYPE_BY_KIND = { hp: 1, stam: 3, mana: 5 };
const KINDS = ["hp", "stam", "mana"];

// Design constants lifted from the card / orb_engine2.py.
const VB = 120;               // orb SVG viewBox is 120×120
const ORB_PX = 92;            // rendered orb size inside the badge
const VITAE_CY0 = VB - 0.85 * VB;  // the card baked its ceiling at 85%
const LOW_HP_FRAC = 0.15;     // below this, health churns and fractures
const GLARE_MS = 1150;        // one cycle of the hb-glare keyframe
// Each badge is authored at the concept card's 1:1 px scale (196×168 per
// vital) and scaled as ONE unit, so every heraldic offset below stays a
// card value. 0.72 lands a pane at ~141×121.
const PANE_W = 196;
const PANE_H = 168;
const DEFAULT_SCALE = 0.72;
const DEFAULT_HZ = 30;

// Where each pane sits the first time it is ever mounted. Side by side,
// spanning roughly the region the old combined panel occupied
// (left 260, top 6, 445×163) so an existing session sees the badges in
// the same place — just with the stone gone from between them.
const DEFAULT_POS = {
  hp:   { left: "260px", top: "6px" },
  stam: { left: "401px", top: "6px" },
  mana: { left: "542px", top: "6px" },
};
// Independent m_eWindowID surrogates: one saved position per vital.
const PANE_WINDOW_ID = {
  hp: WINDOW_ID.VITALS_ORB_HP,
  stam: WINDOW_ID.VITALS_ORB_STAM,
  mana: WINDOW_ID.VITALS_ORB_MANA,
};

// ── URL flags ────────────────────────────────────────────────────────
// Exact-match reads. `vitalsOrbs` is the opt-in; `orbCaustics` and
// `orbAnimSync` are ESCAPES from default-on sub-features, so they are the
// flags here allowed to read an off-form for their negative.
function urlParam(name) {
  try {
    return new URLSearchParams(window.location?.search ?? "").get(name);
  } catch (_) {
    return null;
  }
}

/** Single source of truth for "are the orbs replacing the bars?".
 *  `plugins/vitals-hud.js` imports this and returns a no-op unmount
 *  when it is true — that is the whole mutual-exclusion mechanism. */
export function isVitalsOrbsActive() {
  // DEFAULT ON — USER 1070 SIGN-OFF 2026-08-01 (in-person vistest).
  // `?vitalsOrbs=off` restores the classic bars (vitals-hud.js reads this
  // same function for its no-op mount, so the exclusion stays two-sided).
  const url = urlParam("vitalsOrbs");
  if (url === "off" || url === "0" || url === "false" || url === "no") return false;
  if (url === "on" || url === "1" || url === "true" || url === "yes") return true;
  try {
    const raw = localStorage.getItem("hb_vitals_orbs");
    if (raw === "0" || raw === "false" || raw === "off" || raw === "no") return false;
    if (raw === "1" || raw === "true" || raw === "on" || raw === "yes") return true;
    const gfx = JSON.parse(localStorage.getItem("holtburger_graphics_v1") || "{}");
    if (gfx?.extras?.vitalsOrbs === false) return false;
    if (gfx?.extras?.vitalsOrbs === true) return true;
  } catch (_) {}
  return true;
}

export function setVitalsOrbsActive(active) {
  try {
    localStorage.setItem("hb_vitals_orbs", active ? "1" : "0");
  } catch (_) {}
}

export function setOrbScale(scale) {
  try {
    localStorage.setItem("hb_orb_scale", String(scale));
  } catch (_) {}
}

export function getOrbScale() {
  return orbScale();
}

/** Caustics are the priciest layer (two feTurbulence + one
 *  feDisplacementMap, evaluated whenever the clipped region repaints).
 *  Default ON; `?orbCaustics=off` omits the group entirely. */
function causticsEnabled() {
  return urlParam("orbCaustics") !== "off";
}

/** The ambient CSS loops sampled at the orb cadence (see makeOrbAnimSync).
 *  Default ON; `?orbAnimSync=off` (or 0/false/no, any case) leaves them on
 *  Blink's own display-rate clock. Read once. */
let _animSyncFlag;
export function orbAnimSyncEnabled() {
  if (_animSyncFlag !== undefined) return _animSyncFlag;
  const v = String(urlParam("orbAnimSync") ?? "").trim().toLowerCase();
  _animSyncFlag = !(v === "off" || v === "0" || v === "false" || v === "no");
  return _animSyncFlag;
}
/** Test seam: true/false forces the flag, undefined re-reads the URL. */
export function __setOrbAnimSyncForTest(v) { _animSyncFlag = v; }

// Wave updates run at a CADENCE, not at vsync. Every wave write dirties
// an SVG subtree wrapped in blurs, blends and (optionally) a turbulence
// filter, so the render pipeline cost scales linearly with this number.
// 30 Hz is indistinguishable from 60 for a liquid surface and halves the
// style/layout/paint/raster the orbs charge the frame. `?orbHz=N`.
function orbHz() {
  const v = parseFloat(urlParam("orbHz") ?? "");
  return Number.isFinite(v) && v >= 5 && v <= 120 ? v : DEFAULT_HZ;
}

export function orbScale() {
  const v = parseFloat(urlParam("orbScale") ?? "");
  if (Number.isFinite(v) && v > 0.2 && v <= 2) return v;
  try {
    const raw = parseFloat(localStorage.getItem("hb_orb_scale") ?? "");
    if (Number.isFinite(raw) && raw > 0.2 && raw <= 2) return raw;
    const gfx = JSON.parse(localStorage.getItem("holtburger_graphics_v1") || "{}");
    const s = parseFloat(gfx?.extras?.orbScale);
    if (Number.isFinite(s) && s > 0.2 && s <= 2) return s;
  } catch (_) {}
  return DEFAULT_SCALE;
}

/** `?orbRender` — the vessel renderer. DEFAULT "canvas" (Canvas2D cores;
 *  1070 S2-ORB flip 2026-10-31). ESCAPE to the signed-off SVG vessel: `svg`,
 *  `off`, `0`, `false` or `no` (trimmed, any case). Anything else — absent,
 *  empty, `canvas`, `on`, junk — is canvas. Read once (memoized). */
const ORB_RENDER_SVG_FORMS = new Set(["svg", "off", "0", "false", "no"]);
let _renderFlag;
export function orbRenderMode() {
  if (_renderFlag !== undefined) return _renderFlag;
  const v = String(urlParam("orbRender") ?? "").trim().toLowerCase();
  _renderFlag = ORB_RENDER_SVG_FORMS.has(v) ? "svg" : "canvas";
  return _renderFlag;
}
/** Test seam: "canvas"/"svg" forces the mode, undefined re-reads the URL. */
export function __setOrbRenderForTest(v) { _renderFlag = v; }

// ── static markup ────────────────────────────────────────────────────
//
// The fracture web is SEEDED geometry (`random.Random(11)` in
// orb_engine2.fracture) — it cannot be reproduced by a JS PRNG, so the
// generator's output is baked here verbatim and inserted lazily the
// first time health drops into the low band. 8 radials from one impact
// point at (78, 36), each in three chunks of decreasing stroke width;
// 0–2 branches per radial; 3 lateral cracks bridging neighbours; a
// crushed rosette of 7 facets at the strike. Drawn in four passes —
// dark offset copy (glass thickness), #hbRefract-displaced copy
// (refraction through the crack), the tapered main stroke, and four
// independently flickering glints.
const FRACTURE_SVG = `<g class="fx"><path class="fx-dark" d="M75.7 36.6 L69.4 38.5 L63.7 40.1 L57.9 41.2" stroke-width="2.63"/><path class="fx-dark" d="M57.9 41.2 L52.2 45.5 L45.8 47.7 L39.0 48.4" stroke-width="1.61"/><path class="fx-dark" d="M39.0 48.4 L31.0 46.1 L26.0 54.5 L20.8 60.6" stroke-width="0.85"/><path class="fx-dark" d="M75.9 34.8 L70.5 31.4 L65.8 28.0 L60.5 25.4" stroke-width="2.63"/><path class="fx-dark" d="M60.5 25.4 L54.7 22.4 L50.4 16.9 L46.1 11.6" stroke-width="1.61"/><path class="fx-dark" d="M46.1 11.6 L43.1 9.8 L44.2 9.4 L36.6 12.4" stroke-width="0.85"/><path class="fx-dark" d="M77.0 33.8 L74.4 30.7 L72.3 27.9 L70.1 25.2" stroke-width="2.63"/><path class="fx-dark" d="M70.1 25.2 L69.4 20.9 L67.6 17.5 L66.6 13.5" stroke-width="1.61"/><path class="fx-dark" d="M66.6 13.5 L64.7 9.8 L64.3 7.2 L62.1 7.0" stroke-width="0.85"/><path class="fx-dark" d="M70.6 19.8 L62.2 17.0 L53.4 17.1" stroke-width="1.05"/><path class="fx-dark" d="M79.0 33.8 L81.4 28.0 L85.5 23.8 L90.2 20.2" stroke-width="2.63"/><path class="fx-dark" d="M90.2 20.2 L88.9 15.6 L86.3 14.0 L89.2 15.8" stroke-width="1.61"/><path class="fx-dark" d="M89.2 15.8 L88.8 15.5 L92.8 18.4 L92.0 17.7" stroke-width="0.85"/><path class="fx-dark" d="M80.3 35.4 L84.2 34.7 L87.3 33.5 L90.3 31.9" stroke-width="2.63"/><path class="fx-dark" d="M90.3 31.9 L92.8 28.3 L95.9 26.0 L100.6 27.2" stroke-width="1.61"/><path class="fx-dark" d="M100.6 27.2 L100.0 25.2 L101.7 27.2 L99.2 24.4" stroke-width="0.85"/><path class="fx-dark" d="M96.5 23.9 L95.3 20.5 L93.2 18.7" stroke-width="0.84"/><path class="fx-dark" d="M92.0 26.9 L99.8 26.0 L105.4 32.6" stroke-width="0.78"/><path class="fx-dark" d="M79.9 37.5 L83.1 39.8 L85.1 42.6 L87.1 45.3" stroke-width="2.63"/><path class="fx-dark" d="M87.1 45.3 L91.3 46.5 L92.0 51.2 L96.2 52.4" stroke-width="1.61"/><path class="fx-dark" d="M96.2 52.4 L100.6 53.4 L102.0 58.0 L106.3 59.2" stroke-width="0.85"/><path class="fx-dark" d="M91.1 46.8 L102.1 48.9 L112.1 50.2" stroke-width="0.86"/><path class="fx-dark" d="M78.2 38.4 L78.4 43.3 L77.3 47.7 L78.6 52.0" stroke-width="2.63"/><path class="fx-dark" d="M78.6 52.0 L81.1 56.7 L78.5 61.9 L75.5 66.7" stroke-width="1.61"/><path class="fx-dark" d="M75.5 66.7 L77.9 72.0 L82.0 77.0 L78.9 82.4" stroke-width="0.85"/><path class="fx-dark" d="M78.5 63.1 L70.8 71.6 L68.9 78.7" stroke-width="1.17"/><path class="fx-dark" d="M77.2 38.2 L75.7 43.8 L73.0 48.3 L70.5 52.8" stroke-width="2.63"/><path class="fx-dark" d="M70.5 52.8 L69.7 58.8 L70.6 65.1 L66.8 70.1" stroke-width="1.61"/><path class="fx-dark" d="M66.8 70.1 L70.5 77.4 L73.5 84.0 L71.9 90.0" stroke-width="0.85"/><path class="fx-dark" d="M75.9 46.9 L71.6 44.4 L67.8 41.0 L66.2 35.9 L68.4 31.1 L71.4 27.1 L76.0 24.5 L81.5 24.3" stroke-width="1.53"/><path class="fx-dark" d="M95.0 54.5 L88.7 59.3 L80.8 59.7 L73.4 59.6 L66.6 56.5 L62.7 50.4 L59.5 44.7 L57.8 38.6" stroke-width="1.16"/><path class="fx-dark" d="M100.0 25.3 L106.0 33.6 L111.3 46.7 L108.1 58.9 L97.8 70.9 L82.1 72.1 L65.7 76.7 L56.1 62.2" stroke-width="0.78"/><path class="fx-refract" d="M75.7 36.6 L69.4 38.5 L63.7 40.1 L57.9 41.2" stroke-width="2.02"/><path class="fx-refract" d="M57.9 41.2 L52.2 45.5 L45.8 47.7 L39.0 48.4" stroke-width="1.23"/><path class="fx-refract" d="M39.0 48.4 L31.0 46.1 L26.0 54.5 L20.8 60.6" stroke-width="0.65"/><path class="fx-refract" d="M75.9 34.8 L70.5 31.4 L65.8 28.0 L60.5 25.4" stroke-width="2.02"/><path class="fx-refract" d="M60.5 25.4 L54.7 22.4 L50.4 16.9 L46.1 11.6" stroke-width="1.23"/><path class="fx-refract" d="M46.1 11.6 L43.1 9.8 L44.2 9.4 L36.6 12.4" stroke-width="0.65"/><path class="fx-refract" d="M77.0 33.8 L74.4 30.7 L72.3 27.9 L70.1 25.2" stroke-width="2.02"/><path class="fx-refract" d="M70.1 25.2 L69.4 20.9 L67.6 17.5 L66.6 13.5" stroke-width="1.23"/><path class="fx-refract" d="M66.6 13.5 L64.7 9.8 L64.3 7.2 L62.1 7.0" stroke-width="0.65"/><path class="fx-refract" d="M70.6 19.8 L62.2 17.0 L53.4 17.1" stroke-width="0.80"/><path class="fx-refract" d="M79.0 33.8 L81.4 28.0 L85.5 23.8 L90.2 20.2" stroke-width="2.02"/><path class="fx-refract" d="M90.2 20.2 L88.9 15.6 L86.3 14.0 L89.2 15.8" stroke-width="1.23"/><path class="fx-refract" d="M89.2 15.8 L88.8 15.5 L92.8 18.4 L92.0 17.7" stroke-width="0.65"/><path class="fx-refract" d="M80.3 35.4 L84.2 34.7 L87.3 33.5 L90.3 31.9" stroke-width="2.02"/><path class="fx-refract" d="M90.3 31.9 L92.8 28.3 L95.9 26.0 L100.6 27.2" stroke-width="1.23"/><path class="fx-refract" d="M100.6 27.2 L100.0 25.2 L101.7 27.2 L99.2 24.4" stroke-width="0.65"/><path class="fx-refract" d="M96.5 23.9 L95.3 20.5 L93.2 18.7" stroke-width="0.65"/><path class="fx-refract" d="M92.0 26.9 L99.8 26.0 L105.4 32.6" stroke-width="0.59"/><path class="fx-refract" d="M79.9 37.5 L83.1 39.8 L85.1 42.6 L87.1 45.3" stroke-width="2.02"/><path class="fx-refract" d="M87.1 45.3 L91.3 46.5 L92.0 51.2 L96.2 52.4" stroke-width="1.23"/><path class="fx-refract" d="M96.2 52.4 L100.6 53.4 L102.0 58.0 L106.3 59.2" stroke-width="0.65"/><path class="fx-refract" d="M91.1 46.8 L102.1 48.9 L112.1 50.2" stroke-width="0.66"/><path class="fx-refract" d="M78.2 38.4 L78.4 43.3 L77.3 47.7 L78.6 52.0" stroke-width="2.02"/><path class="fx-refract" d="M78.6 52.0 L81.1 56.7 L78.5 61.9 L75.5 66.7" stroke-width="1.23"/><path class="fx-refract" d="M75.5 66.7 L77.9 72.0 L82.0 77.0 L78.9 82.4" stroke-width="0.65"/><path class="fx-refract" d="M78.5 63.1 L70.8 71.6 L68.9 78.7" stroke-width="0.89"/><path class="fx-refract" d="M77.2 38.2 L75.7 43.8 L73.0 48.3 L70.5 52.8" stroke-width="2.02"/><path class="fx-refract" d="M70.5 52.8 L69.7 58.8 L70.6 65.1 L66.8 70.1" stroke-width="1.23"/><path class="fx-refract" d="M66.8 70.1 L70.5 77.4 L73.5 84.0 L71.9 90.0" stroke-width="0.65"/><path class="fx-refract" d="M75.9 46.9 L71.6 44.4 L67.8 41.0 L66.2 35.9 L68.4 31.1 L71.4 27.1 L76.0 24.5 L81.5 24.3" stroke-width="1.17"/><path class="fx-refract" d="M95.0 54.5 L88.7 59.3 L80.8 59.7 L73.4 59.6 L66.6 56.5 L62.7 50.4 L59.5 44.7 L57.8 38.6" stroke-width="0.88"/><path class="fx-refract" d="M100.0 25.3 L106.0 33.6 L111.3 46.7 L108.1 58.9 L97.8 70.9 L82.1 72.1 L65.7 76.7 L56.1 62.2" stroke-width="0.60"/><path class="fx-main" d="M75.7 36.6 L69.4 38.5 L63.7 40.1 L57.9 41.2" stroke-width="1.55"/><path class="fx-main" d="M57.9 41.2 L52.2 45.5 L45.8 47.7 L39.0 48.4" stroke-width="0.95"/><path class="fx-main" d="M39.0 48.4 L31.0 46.1 L26.0 54.5 L20.8 60.6" stroke-width="0.50"/><path class="fx-main" d="M75.9 34.8 L70.5 31.4 L65.8 28.0 L60.5 25.4" stroke-width="1.55"/><path class="fx-main" d="M60.5 25.4 L54.7 22.4 L50.4 16.9 L46.1 11.6" stroke-width="0.95"/><path class="fx-main" d="M46.1 11.6 L43.1 9.8 L44.2 9.4 L36.6 12.4" stroke-width="0.50"/><path class="fx-main" d="M77.0 33.8 L74.4 30.7 L72.3 27.9 L70.1 25.2" stroke-width="1.55"/><path class="fx-main" d="M70.1 25.2 L69.4 20.9 L67.6 17.5 L66.6 13.5" stroke-width="0.95"/><path class="fx-main" d="M66.6 13.5 L64.7 9.8 L64.3 7.2 L62.1 7.0" stroke-width="0.50"/><path class="fx-main" d="M70.6 19.8 L62.2 17.0 L53.4 17.1" stroke-width="0.62"/><path class="fx-main" d="M79.0 33.8 L81.4 28.0 L85.5 23.8 L90.2 20.2" stroke-width="1.55"/><path class="fx-main" d="M90.2 20.2 L88.9 15.6 L86.3 14.0 L89.2 15.8" stroke-width="0.95"/><path class="fx-main" d="M89.2 15.8 L88.8 15.5 L92.8 18.4 L92.0 17.7" stroke-width="0.50"/><path class="fx-main" d="M80.3 35.4 L84.2 34.7 L87.3 33.5 L90.3 31.9" stroke-width="1.55"/><path class="fx-main" d="M90.3 31.9 L92.8 28.3 L95.9 26.0 L100.6 27.2" stroke-width="0.95"/><path class="fx-main" d="M100.6 27.2 L100.0 25.2 L101.7 27.2 L99.2 24.4" stroke-width="0.50"/><path class="fx-main" d="M96.5 23.9 L95.3 20.5 L93.2 18.7" stroke-width="0.50"/><path class="fx-main" d="M92.0 26.9 L99.8 26.0 L105.4 32.6" stroke-width="0.46"/><path class="fx-main" d="M79.9 37.5 L83.1 39.8 L85.1 42.6 L87.1 45.3" stroke-width="1.55"/><path class="fx-main" d="M87.1 45.3 L91.3 46.5 L92.0 51.2 L96.2 52.4" stroke-width="0.95"/><path class="fx-main" d="M96.2 52.4 L100.6 53.4 L102.0 58.0 L106.3 59.2" stroke-width="0.50"/><path class="fx-main" d="M91.1 46.8 L102.1 48.9 L112.1 50.2" stroke-width="0.51"/><path class="fx-main" d="M78.2 38.4 L78.4 43.3 L77.3 47.7 L78.6 52.0" stroke-width="1.55"/><path class="fx-main" d="M78.6 52.0 L81.1 56.7 L78.5 61.9 L75.5 66.7" stroke-width="0.95"/><path class="fx-main" d="M75.5 66.7 L77.9 72.0 L82.0 77.0 L78.9 82.4" stroke-width="0.50"/><path class="fx-main" d="M78.5 63.1 L70.8 71.6 L68.9 78.7" stroke-width="0.69"/><path class="fx-main" d="M77.2 38.2 L75.7 43.8 L73.0 48.3 L70.5 52.8" stroke-width="1.55"/><path class="fx-main" d="M70.5 52.8 L69.7 58.8 L70.6 65.1 L66.8 70.1" stroke-width="0.95"/><path class="fx-main" d="M66.8 70.1 L70.5 77.4 L73.5 84.0 L71.9 90.0" stroke-width="0.50"/><path class="fx-main" d="M75.9 46.9 L71.6 44.4 L67.8 41.0 L66.2 35.9 L68.4 31.1 L71.4 27.1 L76.0 24.5 L81.5 24.3" stroke-width="0.90"/><path class="fx-main" d="M95.0 54.5 L88.7 59.3 L80.8 59.7 L73.4 59.6 L66.6 56.5 L62.7 50.4 L59.5 44.7 L57.8 38.6" stroke-width="0.68"/><path class="fx-main" d="M100.0 25.3 L106.0 33.6 L111.3 46.7 L108.1 58.9 L97.8 70.9 L82.1 72.1 L65.7 76.7 L56.1 62.2" stroke-width="0.46"/><path class="fx-shard" d="M78.0 36.0 L84.4 36.1 L84.8 38.6 L79.9 37.6 Z"/><path class="fx-shard" d="M78.0 36.0 L81.0 40.1 L79.5 41.7 L77.7 38.5 Z"/><path class="fx-shard" d="M78.0 36.0 L76.6 41.2 L74.3 40.9 L75.9 37.3 Z"/><path class="fx-shard" d="M78.0 36.0 L72.5 38.3 L71.1 36.1 L76.1 35.2 Z"/><path class="fx-shard" d="M78.0 36.0 L74.1 34.2 L74.4 32.6 L77.0 34.1 Z"/><path class="fx-shard" d="M78.0 36.0 L76.8 29.8 L79.5 28.9 L79.4 34.0 Z"/><path class="fx-shard" d="M78.0 36.0 L81.3 31.7 L83.3 32.7 L80.1 35.6 Z"/><path class="fx-glint" d="M61.4 43.1 L57.3 46.2"/><path class="fx-glint" d="M71.4 30.9 L65.9 26.9"/><path class="fx-glint" d="M73.5 26.2 L70.4 20.3"/><path class="fx-glint" d="M87.3 23.8 L92.5 19.6"/><circle class="fx-bloom" cx="78.0" cy="36.0" r="9" fill="url(#hbOrbBloom)"/></g>`;

// Shared filter defs. One copy per page keeps the turbulence cost to a
// handful of nodes instead of one set per orb.
// PERF (measured, see agentH-report): the concept card drove
// `baseFrequency` from the rAF, which forces Skia to RE-EVALUATE the
// whole fractal-noise field every frame — by far the single most
// expensive thing in the stack. Here the noise is STATIC (so its
// filtered output is cacheable) and the crawl comes from drifting the
// caustic group itself on a CSS transform. Visually the bands slide
// instead of morphing; at HUD scale that reads the same, and it is
// still CSS-driven, so `prefers-reduced-motion` stops it.
// numOctaves and the filter regions are trimmed for the same reason.
const SHARED_DEFS = `
<filter id="hbRefract" x="-15%" y="-15%" width="130%" height="130%"
        color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="0.09" numOctaves="2"
                seed="41" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="2.6"
                     xChannelSelector="R" yChannelSelector="G"/>
</filter>
<radialGradient id="hbOrbBloom" cx="0.5" cy="0.5" r="0.5">
  <stop offset="0" stop-color="var(--hb-orb-crack-glint)" stop-opacity="0.75"/>
  <stop offset="1" stop-color="var(--hb-orb-crack-glint)" stop-opacity="0"/>
</radialGradient>`;

// ── the baked caustics ───────────────────────────────────────────────
//
// PERF item 3, and the single biggest one: ablation measured the live
// caustics group at HALF the whole HUD's render pipeline. Two
// feTurbulence fields, an feDisplacementMap and three blurs were being
// re-evaluated every time the group repainted — which is every wave
// tick, because the group is clipped to the LIVE wave path.
//
// But nothing inside the group moves. The noise is static (see the
// do-not-undo note below), the ripple strokes are static, the pool and
// the sheen veil are static; only the CLIP moves. So the whole stack is
// pre-composed here into one self-contained raster and drawn as a
// single <image> that is still clipped to the live wave path. Identical
// on screen — the bands still slide under the surface — with the filter
// chain evaluated once per session instead of 30 times a second.
//
// The `--hb-orb-caustic` token is inlined because a data-URL document
// cannot see the page's custom properties. Keep the two in sync.
const CAUSTIC_INK = "#fff8e2";
const CAUSTIC_A = 0.9;
const CAUSTIC_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
<defs>
<filter id="c" x="-12%" y="-12%" width="124%" height="124%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.021 0.052" numOctaves="2" seed="7" result="n"/>
<feDisplacementMap in="SourceGraphic" in2="n" scale="11" xChannelSelector="R" yChannelSelector="G"/>
<feGaussianBlur stdDeviation="0.8"/>
</filter>
<filter id="s" x="-5%" y="-5%" width="110%" height="110%" color-interpolation-filters="sRGB">
<feTurbulence type="fractalNoise" baseFrequency="0.045 0.09" numOctaves="2" seed="19" result="n"/>
<feColorMatrix in="n" type="matrix" result="a" values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.9 0 0 0 -0.28"/>
<feComposite in="a" in2="SourceGraphic" operator="in"/>
<feGaussianBlur stdDeviation="0.6"/>
</filter>
<filter id="p" x="-50%" y="-50%" width="200%" height="200%"><feGaussianBlur stdDeviation="7"/></filter>
</defs>
<ellipse cx="60" cy="106" rx="34" ry="9" fill="${CAUSTIC_INK}" fill-opacity="${CAUSTIC_A}" opacity="0.26" filter="url(#p)"/>
<g filter="url(#c)" fill="none" stroke="${CAUSTIC_INK}" stroke-opacity="${CAUSTIC_A}" stroke-linecap="round" opacity="0.32">
<path stroke-width="1.9" d="M18 74 Q34 67 52 75"/><path stroke-width="1.3" d="M64 82 Q80 74 99 83"/><path stroke-width="1.2" d="M26 97 Q42 90 58 98"/><path stroke-width="1.0" d="M70 62 Q84 55 100 63"/><path stroke-width="0.9" d="M12 88 Q22 83 33 89"/><path stroke-width="1.5" d="M74 104 Q88 98 101 105"/></g>
<rect x="4" y="30" width="112" height="86" fill="${CAUSTIC_INK}" fill-opacity="${CAUSTIC_A}" opacity="0.12" filter="url(#s)"/>
</svg>`;
const CAUSTIC_URL = "data:image/svg+xml," + encodeURIComponent(CAUSTIC_SVG.replace(/\n/g, ""));

// The scummed vitae waterline. Built once at VITAE_CY0 and then simply
// TRANSLATED to the live ceiling, so a vitae change costs one transform
// write instead of regenerating a dozen paths.
function vitaeGroup(kind) {
  const cy = VITAE_CY0;
  let d = `M-4 ${cy.toFixed(1)}`;
  let x = -4;
  for (const h of [0.9, -0.6, 1.4, -0.3, 1.1, -0.8, 0.7, -0.5, 1.2, -0.4, 0.8]) {
    const x2 = x + 12;
    d += `Q${(x + 6).toFixed(1)} ${(cy + h * 1.9).toFixed(1)} ${x2.toFixed(1)} ${cy.toFixed(1)}`;
    x = x2;
  }
  const dots = [[18, 0.6, 1.1], [37, -0.4, 0.7], [55, 0.9, 1.4],
                [74, -0.2, 0.9], [92, 0.7, 1.2], [105, -0.5, 0.8]]
    .map(([gx, gy, gr]) => `<circle cx="${gx}" cy="${(cy + gy).toFixed(1)}" r="${gr}"/>`)
    .join("");
  // The dim/hatch rects run far ABOVE the orb so the group can be
  // translated up or down without ever exposing an unpainted band.
  const top = cy - 260;
  return `<g class="hbo-vitae" style="display:none">
<rect class="vitae-dim" x="-4" y="${top.toFixed(1)}" width="128" height="260"/>
<rect x="-4" y="${top.toFixed(1)}" width="128" height="260" fill="url(#hx-${kind})" opacity="0.30"/>
<path class="vitae-scum-band" d="${d} L124 ${(cy - 4.2).toFixed(1)} L-4 ${(cy - 4.2).toFixed(1)} Z"/>
<path class="vitae-grime" d="${d}"/>
<g class="vitae-grime-dots">${dots}</g></g>`;
}

// ── the baked glass plate ────────────────────────────────────────────
//
// PERF item 3. The dome vignette, the two blurred speculars, the inner
// shadow ring and the brass collar are STATIC — they never change for
// the life of a session — but as live SVG they are four gradient/filter
// stacking contexts per vessel that the compositor re-commits on every
// wave tick. Pre-composed here into ONE self-contained SVG data URL and
// drawn as a single <image>: one display item, no filter, no blend.
//
// It is authored TRANSPARENT. v1 painted an opaque `--hb-orb-void`
// circle behind the liquid and a dome gradient that went to 50% black
// at the rim; both are gone, because the whole point of v2 is that the
// empty half of the vessel shows the world through it. What is left is
// a whisper of top-left sheen, a soft edge darkening that reads as
// glass thickness, and the collar.
//
// Everything is inside r=59.25 so the 0..120 viewBox clips nothing and
// the orb box can carry `contain: paint` without shaving a hairline.
const GLASS_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" width="120" height="120">
<defs>
<radialGradient id="d" cx="0.34" cy="0.26" r="0.80">
<stop offset="0" stop-color="#ffffff" stop-opacity="0.15"/>
<stop offset="0.42" stop-color="#ffffff" stop-opacity="0.03"/>
<stop offset="0.86" stop-color="#000000" stop-opacity="0.05"/>
<stop offset="1" stop-color="#000000" stop-opacity="0.30"/>
</radialGradient>
<linearGradient id="c" x1="0" y1="0" x2="0.6" y2="1">
<stop offset="0" stop-color="#d8b968"/>
<stop offset="0.45" stop-color="#8a7544"/>
<stop offset="1" stop-color="#3e3218"/>
</linearGradient>
<filter id="b1" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.2"/></filter>
<filter id="b2" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2"/></filter>
</defs>
<circle cx="60" cy="60" r="55.5" fill="url(#d)"/>
<ellipse cx="42" cy="33" rx="16" ry="10" transform="rotate(-24 42 33)" fill="#ffffff" fill-opacity="0.5" filter="url(#b1)"/>
<ellipse cx="80" cy="88" rx="12" ry="5" transform="rotate(-18 80 88)" fill="#ffffff" fill-opacity="0.26" filter="url(#b2)"/>
<circle cx="60" cy="60" r="54.7" fill="none" stroke="#000000" stroke-opacity="0.34" stroke-width="1.6"/>
<circle cx="60" cy="60" r="56.9" fill="none" stroke="url(#c)" stroke-opacity="0.72" stroke-width="3.2"/>
<circle cx="60" cy="60" r="58.8" fill="none" stroke="#8a7544" stroke-opacity="0.6" stroke-width="0.9"/>
</svg>`;
const GLASS_URL = "data:image/svg+xml," + encodeURIComponent(GLASS_SVG.replace(/\n/g, ""));

// Three bubbles, not the card's five: each is a running CSS animation on a
// non-compositable SVG node, i.e. a style recalc every vsync.
// [cx, r, duration s, delay s] at cy=112 — shared with the canvas renderer.
const BUBBLES = [[38, 2.1, 8.5, 0], [62, 1.5, 6.4, -2.4], [80, 2.6, 10.2, -5.1]];

// One vessel. `--orb-a` / `--orb-b` are set per kind on the <svg> so the
// low-HP variant is a two-token CSS override rather than a rebuild.
function orbSvg(kind) {
  const bubbles = BUBBLES
    .map(([bx, br, bd, dly]) =>
      `<circle class="bub" cx="${bx}" cy="112" r="${br}" style="--bd:${bd}s;animation-delay:${dly}s"/>`)
    .join("");

  const shimmer = kind === "mana"
    ? '<ellipse class="shimmer" cx="58" cy="74" rx="30" ry="20"/>' : "";

  const rip = causticsEnabled()
    ? `<g class="caustics" clip-path="url(#lqc-${kind})"><image href="${CAUSTIC_URL}" x="0" y="0" width="120" height="120"/></g>`
    : "";

  return `<svg class="orb" data-kind="${kind}" viewBox="0 0 ${VB} ${VB}" width="${ORB_PX}" height="${ORB_PX}" aria-hidden="true">
<defs>
<clipPath id="c-${kind}"><circle cx="60" cy="60" r="55.5"/></clipPath>
<clipPath id="lqc-${kind}"><path class="w-clip" d="M0 120L120 120L120 128L0 128Z"/></clipPath>
<pattern id="hx-${kind}" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(38)"><line x1="0" y1="0" x2="0" y2="7" stroke="#000" stroke-width="2.4" opacity="0.5"/></pattern>
<linearGradient id="lq-${kind}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" style="stop-color:var(--orb-a)" stop-opacity="1"/>
<stop offset="0.34" style="stop-color:var(--orb-a)" stop-opacity="0.92"/>
<stop offset="1" style="stop-color:var(--orb-b)"/></linearGradient>
<linearGradient id="lqb-${kind}" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" style="stop-color:var(--orb-b)"/>
<stop offset="1" style="stop-color:var(--hb-orb-void)"/></linearGradient>
<radialGradient id="sub-${kind}" cx="0.5" cy="0.5" r="0.5">
<stop offset="0" style="stop-color:var(--orb-a)" stop-opacity="0.85"/>
<stop offset="1" style="stop-color:var(--orb-a)" stop-opacity="0"/></radialGradient>
<radialGradient id="wal-${kind}" cx="0.5" cy="0.5" r="0.5">
<stop offset="0.32" stop-color="#fff" stop-opacity="1"/>
<stop offset="0.78" stop-color="#a08c78" stop-opacity="1"/>
<stop offset="1" stop-color="#3a2c22" stop-opacity="1"/></radialGradient>
</defs>
<g class="liquid" clip-path="url(#c-${kind})" style="--rise:-60px">
<path class="w-back" fill="url(#lqb-${kind})" opacity="0.85" d=""/>
<path class="w-front" fill="url(#lq-${kind})" d=""/>
${rip}
<circle class="lqwall" cx="60" cy="60" r="55.5" fill="url(#wal-${kind})" clip-path="url(#lqc-${kind})"/>
${shimmer}${bubbles}
<g class="wsurf">
<ellipse class="subglow" cx="60" cy="11" rx="46" ry="11" fill="url(#sub-${kind})"/>
<ellipse class="sspec" cx="52" cy="1.5" rx="21" ry="2.2"/>
<path class="men-wall" d="M4 -1 q4.5 3.4 9.5 3.9"/>
<path class="men-wall" d="M116 -1 q-4.5 3.4 -9.5 3.9"/>
</g>
<path class="men men-sh" d=""/><path class="men men-hi" d=""/><path class="men men-sp" d=""/>
${vitaeGroup(kind)}
</g>
<image class="glassplate" href="${GLASS_URL}" x="0" y="0" width="120" height="120"/>
<ellipse class="glare" cx="46" cy="40" rx="30" ry="17" transform="rotate(-28 46 40)"/>
<g class="hbo-fx"></g>
</svg>`;
}

// The heraldry around each vessel — one supporter or charge per vital,
// plus the seating glow.
//
// v3 (2026-07-29) cut the Atlan sword, the weeping wand and both slithis
// tendrils on the user's direction. What is left is the reading the
// panel order was always built around: Asheron supports health at the
// far left, Bael'Zharon flanks mana at the far right, and the composite
// bow lies in base under stamina between them — so the three badges
// still compose as one achievement, with a supporter at each end.
const HERALDRY = {
  hp: '<div class="hbo-glow g-hp"></div>'
    + '<div class="fig fig-asheron sup-l"></div>',
  stam: '<div class="hbo-glow g-stam"></div>'
    + '<div class="fig fig-bow"></div>',
  mana: '<div class="hbo-glow g-mana"></div>'
    + '<div class="fig fig-bael sup-r"></div>',
};

// ── stylesheet ───────────────────────────────────────────────────────
// Every rule is scoped under #hb-vitals-orbs so the new --hb-orb-* /
// --hb-badge-* tokens never leak onto :root and collide with the rest
// of the HUD. The base --hb-* palette tokens are inherited from
// index.html's :root block, exactly as the concept card assumed.
//
// `opts.orbLayer` (?hudDiet=orbLayer, R3-2) appends ONE rule; without it the
// text is the pre-diet stylesheet, byte for byte.
export function orbStyleText(opts) {
  return styleText() + (opts && opts.orbLayer ? ORB_LAYER_RULE : "");
}

// ?hudDiet=orbLayer. The vessel core already has its own PAINT chunk
// (`contain: paint`, the invalidation wall above), but it shares a compositor
// LAYER with the glow, the figure sprites and, on stamina, the bow that lies
// across its base (z-index 5, above the core). Raster replays every display
// item under an invalidated rect, so each 30 Hz wave tick also re-ran the
// figures' saturate/contrast + double drop-shadow filter chain and the glow
// gradient wherever they overlap the 92x92 box (inventory 2026-10-31 §2.1).
// `will-change: opacity` makes the core a composited effect: its chunks go to
// a layer of their own, the tick dirties only that layer, and the overlapping
// figures stay rastered once. Pixels: the core is already an isolated group
// (blend modes inside it never reach past it), so drawing it as a separate
// source-over layer is the same composite. NOT `will-change: transform`: cc
// treats that hint as "will animate" (raster scale pinned, no raster
// translation), so a fractional pane offset could be resampled instead of
// rastered in place. Opacity stays 1 and nothing animates it; the cost is one
// ~99x99 px layer per orb. The only lever with a look risk (compositing): it
// gets the owner glance in the HUD arm.
const ORB_LAYER_RULE = `
${P} .hbo-core { will-change: opacity; }
`;

function styleText() {
  return `
${P} {
  position: fixed;
  z-index: 50;
  /* DEFAULT-OFF pointer target. mount() flips this to auto only while
     the cursor is over visible art (orb circle / figure alpha), so an
     empty corner of a pane never eats a click meant for the world. */
  pointer-events: none;
  /* each badge is authored at the card's 1:1 px scale and then scaled
     as a unit — every offset below is a card value, unchanged.
     Keep in sync with DEFAULT_SCALE. */
  --hbo-scale: 0.72;
  width: ${PANE_W}px;
  height: ${PANE_H}px;
  transform: scale(var(--hbo-scale));
  transform-origin: top left;
  /* No paint containment on the PANE: the figures' drop-shadows are
     allowed to spill. The invalidation wall that matters is one level
     down, on .hbo-core (see below). */
  contain: layout style;

  --hb-orb-hp: #c8181e;
  --hb-orb-hp-deep: #45060a;
  --hb-orb-hp-low: #a81a20;
  --hb-orb-hp-low-deep: #3c0609;
  --hb-orb-stam: #f0c024;
  --hb-orb-stam-deep: #5e4004;
  --hb-orb-mana: #2f6ee2;
  --hb-orb-mana-deep: #081548;
  --hb-orb-mana-shimmer: #9a5cf0;
  --hb-orb-void: #100d09;
  --hb-orb-surface: rgba(255, 244, 232, 0.5);
  --hb-orb-glass-spec: rgba(255, 255, 255, 0.72);
  --hb-orb-glass-spec-soft: rgba(255, 255, 255, 0.26);
  --hb-orb-glare: rgba(255, 240, 220, 0.85);
  --hb-orb-bubble: rgba(255, 255, 255, 0.5);
  --hb-orb-collar: #8a7544;
  --hb-orb-collar-hi: #d8b968;
  --hb-orb-collar-deep: #3e3218;
  --hb-orb-vitae-dim: rgba(0, 0, 0, 0.26);
  --hb-orb-vitae-scum: #86825a;
  --hb-orb-men-shadow: rgba(0, 0, 0, 0.55);
  --hb-orb-men-spec: rgba(255, 252, 244, 0.95);
  --hb-orb-caustic: rgba(255, 248, 226, 0.9);
  --hb-orb-crack: rgba(255, 232, 208, 0.62);
  --hb-orb-crack-dark: rgba(0, 0, 0, 0.62);
  --hb-orb-crack-refract: rgba(190, 220, 255, 0.5);
  --hb-orb-crack-glint: #fffaf0;
  /* engraving ink. Dark enough to read as cut metal on the brass, tinted
     just far enough toward each humour that the three plaques still
     answer their vessels without breaking the matched set. */
  --hb-orb-read-hp: #4a1210;
  --hb-orb-read-stam: #40300a;
  --hb-orb-read-mana: #16204c;
  /* ── the plaque ───────────────────────────────────────────────────
     A brass plate on an oak board, one per vital, all three identical
     so the set reads as three signs off the same bench. Every layer is
     a plain CSS gradient — no filter, no blend, nothing to bake and
     nothing that can be re-rastered by a wave tick. */
  --hbo-plaque-w: 160px;
  --hbo-plaque-h: 36px;
  --hb-oak-hi: #6d4e2c;
  --hb-oak-mid: #4a3219;
  --hb-oak-lo: #2b1c0d;
  /* antiqued brass, NOT trophy gold: the yellow is pulled well down and
     the core is olive-warm, so the plate reads as a metal that has been
     handled rather than a UI colour ramp. */
  --hb-brass-hi: #e8dcb6;
  --hb-brass-mid: #c9b078;
  --hb-brass-core: #9c8449;
  --hb-brass-warm: #b79b5c;
  --hb-brass-lo: #6a5629;
  /* The figures are no longer knocked back behind a lit stone panel —
     there is no panel — so the grading is just a hair of desaturation
     plus a shadow that separates them from the world behind. */
  --hb-badge-fig-filter: saturate(0.95) contrast(1.04);
  --hb-badge-fig-shadow: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.85))
                         drop-shadow(0 0 2px rgba(0, 0, 0, 0.6));
}
${P}[hidden] { display: none; }
${P}.hbo-drag { cursor: move; }

/* ── the invalidation wall ───────────────────────────────────────────
   PERF item 2. Every wave tick dirties this box and NOTHING else: the
   vessel is 92x92 and lives alone inside a paint-contained square, so
   Blink's Paint clip is the orb rather than the union of orb + four
   filtered sprite layers + a readout. v1 put containment on the whole
   618x226 panel and measured a 618x192 Paint clip on every one of the
   30 ticks a second; this is the fix. The figures and the readout are
   SIBLINGS of this box, so a tick cannot reach them. */
${P} .hbo-core {
  position: absolute; left: 50%; bottom: 38px; margin-left: -${ORB_PX / 2}px;
  width: ${ORB_PX}px; height: ${ORB_PX}px;
  z-index: 4;
  contain: layout paint style;
}

/* supporters and charges are DAT setup renders in their own DAT
   colours. Extracted from the concept card into data/orb-sprites/.
   pointer-events stays NONE on every sprite: the pane as a whole is the
   drag target and mount() gates it on an alpha test, so the hit region
   follows the silhouette rather than these boxes. */
${P} .fig {
  position: absolute; bottom: 48px; z-index: 2; pointer-events: none;
  background-repeat: no-repeat; background-size: contain;
  background-position: bottom center;
  filter: var(--hb-badge-fig-filter) var(--hb-badge-fig-shadow);
}
${P} .fig-asheron { background-image: url("./data/orb-sprites/asheron.png");       width: 54.3px; height: 116px; }
${P} .fig-bael    { background-image: url("./data/orb-sprites/baelzharon-se.png"); width: 65.9px; height: 98px; }
${P} .fig-bow     { background-image: url("./data/orb-sprites/composite-bow.png"); width: 150px;  height: 38.8px; }

/* placement — the plinth is gone with the rest of the panel chrome, but
   its line (bottom:38px) is kept as the common ground the supporters
   stand on, so the heraldry reads exactly as the card. v3 lifts every
   ground line by 10px because the plaque now occupies the base of the
   badge (--hbo-plaque-h, set in the pane block above). */
${P} .sup-l { left: 10px; }
${P} .sup-r { right: 6px; }
/* the bow lies in base, arced under the vessel, cradling it */
${P} .fig-bow { left: 50%; bottom: 41px; margin-left: -75px; z-index: 5; }
/* The only thing that seats the badge against a BRIGHT sky: the
   colour reads as the vital's humour, and the dark core under it keeps
   the vessel from dissolving into a white background. */
${P} .hbo-glow {
  position: absolute; left: 50%; bottom: 44px; width: 168px; height: 116px;
  transform: translateX(-50%); z-index: 0; opacity: 0.5;
}
${P} .g-hp { background: radial-gradient(closest-side, rgba(200,24,30,0.30), rgba(20,6,6,0.20) 55%, rgba(0,0,0,0) 78%); }
${P} .g-stam { background: radial-gradient(closest-side, rgba(240,192,36,0.24), rgba(24,18,4,0.20) 55%, rgba(0,0,0,0) 78%); }
${P} .g-mana { background: radial-gradient(closest-side, rgba(47,110,226,0.28), rgba(6,10,32,0.20) 55%, rgba(0,0,0,0) 78%); }

/* ── orb engine ─────────────────────────────────────────────────────
   Only the wavy TOP edge of each closed wave path can draw: the bottom
   and side edges of the path fall outside the clip circle.

   TRANSPARENCY: there is no backdrop circle and no dome fill any more.
   Above the waterline the vessel is glass — the baked glass plate's
   sheen and rim, and nothing else — so the world shows through the
   empty half. Every mix-blend-mode in here is isolated by the
   contain:paint on .hbo-core (a stacking context isolates blending), so
   no screen/multiply layer can reach past the orb and read back the 3D
   canvas now visible through it. An explicit isolation:isolate on the
   svg is redundant AND measured worse: it widened the Paint clip from
   the 92x92 orb box back out to the whole pane. */
${P} .orb { display: block; }
${P} .orb.hp   { --orb-a: var(--hb-orb-hp);   --orb-b: var(--hb-orb-hp-deep); }
${P} .orb.hp.low { --orb-a: var(--hb-orb-hp-low); --orb-b: var(--hb-orb-hp-low-deep); }
${P} .orb.stam { --orb-a: var(--hb-orb-stam); --orb-b: var(--hb-orb-stam-deep); }
${P} .orb.mana { --orb-a: var(--hb-orb-mana); --orb-b: var(--hb-orb-mana-deep); }
/* PERF item 3: the dome vignette, both blurred speculars, the inner
   shadow ring and the brass collar, pre-composed into one raster at
   mount (GLASS_SVG). Five static gradient/filter layers become one
   image display item that a wave tick never has to re-examine. */
${P} .orb .glassplate { pointer-events: none; }

/* meniscus — three strokes of one path. The dark one sits BELOW the
   waterline (light is absorbed just under the surface), the bright one
   on it, the hairline specular just above it. */
${P} .orb .men { fill: none; stroke-linejoin: round; }
${P} .orb .men-sh { stroke: var(--hb-orb-men-shadow); stroke-width: 3.2; opacity: 0.75; transform: translateY(1.6px); }
${P} .orb .men-hi { stroke: var(--hb-orb-surface); stroke-width: 1.1; }
${P} .orb .men-sp { stroke: var(--hb-orb-men-spec); stroke-width: 0.55; opacity: 0.7; transform: translateY(-0.7px); }
${P} .orb .men-wall { fill: none; stroke: var(--hb-orb-surface); stroke-width: 1.2; opacity: 0.55; }

/* subsurface scattering just under the surface. v1 also had a .bounce
   ellipse throwing coloured light back onto the dome ABOVE the water —
   the tell that the empty half was glass and not a hole. v2 deletes it:
   the empty half is now genuinely see-through, and a screen-blended
   colour blob floating over the world is exactly the "big opaque pane"
   read this revision exists to remove. One blur + one blend layer per
   vessel goes with it. */
${P} .orb .subglow { filter: blur(6px); mix-blend-mode: screen; opacity: 0.5; }
/* the liquid is optically thicker toward the glass wall, so it goes
   darker there; this is what stops the body reading as flat poster colour */
${P} .orb .lqwall { mix-blend-mode: multiply; }
${P} .orb .sspec {
  fill: var(--hb-orb-men-spec); filter: blur(2.6px); mix-blend-mode: screen;
  opacity: 0.4; animation: hbo-sspec 9s ease-in-out infinite;
}
@keyframes hbo-sspec {
  0%, 100% { transform: translate(-9px, 0) scaleX(0.86); opacity: 0.26; }
  50%      { transform: translate(11px, 0) scaleX(1.14); opacity: 0.5; }
}
${P} .orb .caustics { mix-blend-mode: screen; }
${P} .orb .caustics image { pointer-events: none; }
/* MEASURED REGRESSION, do not re-add: animating a transform on the
   caustics (or the filter own baseFrequency) re-evaluates the fractal-
   noise field every vsync — a 60-to-44 fps cliff on this laptop. The
   caustics are static geometry AND static noise, which is why they can
   be baked (CAUSTIC_SVG); their apparent crawl comes from the live wave
   path they are clipped to, which moves at the orb cadence. */

${P} .orb .bub { fill: var(--hb-orb-bubble); animation: hbo-bub var(--bd, 7s) linear infinite; }
@keyframes hbo-bub {
  0%   { transform: translateY(0) scale(0.7); opacity: 0; }
  12%  { opacity: 0.55; }
  85%  { opacity: 0.4; }
  100% { transform: translateY(var(--rise, -60px)) scale(1.05); opacity: 0; }
}
${P} .orb .shimmer {
  fill: var(--hb-orb-mana-shimmer); opacity: 0.3; filter: blur(6px);
  animation: hbo-shimmer 7.5s ease-in-out infinite;
}
@keyframes hbo-shimmer {
  0%, 100% { transform: translate(-8px, 4px) scale(1); opacity: 0.16; }
  50%      { transform: translate(10px, -6px) scale(1.25); opacity: 0.4; }
}

/* vitae ceiling — a fill ceiling the liquid cannot rise past.
   REWORKED for transparency: v1 dimmed the dead band with 50% black,
   which only read because there was an opaque vessel behind it. Over a
   see-through headspace that would be a black smear on the world, so
   the dim drops to a light stain and the READ moves onto the hatch,
   the scum band and the grime line — marks ON the glass, which stay
   legible against anything behind them. */
${P} .orb .vitae-dim { fill: var(--hb-orb-vitae-dim); }
${P} .orb .vitae-scum-band { fill: var(--hb-orb-vitae-scum); opacity: 0.55; }
${P} .orb .vitae-grime { fill: none; stroke: var(--hb-orb-vitae-scum); stroke-width: 1.8; opacity: 1; }
${P} .orb .vitae-grime-dots { fill: var(--hb-orb-vitae-scum); opacity: 0.85; }

/* damage glare flicker — one cycle, armed by the .glaring class.
   display:none at rest so the blend layer only exists during the
   1.15 s a hit is being shown, instead of on every commit forever. */
${P} .orb .glare { display: none; fill: var(--hb-orb-glare); opacity: 0; mix-blend-mode: screen; }
${P} .orb.glaring .glare { display: block; animation: hbo-glare 1.15s steps(1, end) 1; }
@keyframes hbo-glare {
  0%, 100% { opacity: 0; }
  2%  { opacity: 0.62; }
  5%  { opacity: 0.08; }
  8%  { opacity: 0.44; }
  12% { opacity: 0; }
  16% { opacity: 0.22; }
  20% { opacity: 0; }
}

/* ── fracture ───────────────────────────────────────────────────────
   A real impact web, not hairlines: radials that branch and taper,
   lateral cracks bridging them, a crushed rosette at the impact point.
   Four passes give the glass some thickness. */
${P} .orb .fx-dark {
  fill: none; stroke: var(--hb-orb-crack-dark); stroke-linecap: round;
  opacity: 0.85; transform: translate(0.9px, 1.1px);
}
${P} .orb .fx-refract {
  fill: none; stroke: var(--hb-orb-crack-refract); stroke-linecap: round;
  opacity: 0.34; filter: url(#hbRefract);
}
${P} .orb .fx-main { fill: none; stroke: var(--hb-orb-crack); stroke-linecap: round; }
${P} .orb .fx-shard { fill: var(--hb-orb-crack); opacity: 0.16; stroke: none; }
${P} .orb .fx-glint {
  fill: none; stroke: var(--hb-orb-crack-glint); stroke-linecap: round;
  stroke-width: 0.9; opacity: 0; animation: hbo-glint 3.6s ease-in-out infinite;
}
${P} .orb .fx-glint:nth-of-type(2) { animation-delay: -1.2s; }
${P} .orb .fx-glint:nth-of-type(3) { animation-delay: -2.4s; }
${P} .orb .fx-glint:nth-of-type(4) { animation-delay: -0.6s; }
@keyframes hbo-glint { 0%, 72%, 100% { opacity: 0.06; } 84% { opacity: 0.95; } }
${P} .orb .fx-bloom { mix-blend-mode: screen; animation: hbo-bloom 3.6s ease-in-out infinite; }
@keyframes hbo-bloom { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.7; } }

/* heartbeat — applied to the orb wrapper on low HP */
${P} .hbo-core.beat { animation: hbo-beat 1.15s ease-out infinite; transform-origin: 50% 50%; }
@keyframes hbo-beat {
  0%   { transform: scale(1); filter: drop-shadow(0 0 0 rgba(200, 24, 30, 0)); }
  8%   { transform: scale(1.045); filter: drop-shadow(0 0 9px rgba(200, 24, 30, 0.75)); }
  16%  { transform: scale(1.005); }
  26%  { transform: scale(1.03); filter: drop-shadow(0 0 6px rgba(200, 24, 30, 0.5)); }
  45%, 100% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(200, 24, 30, 0)); }
}

/* ── readout: the plaque ─────────────────────────────────────────────
   v3 (2026-07-29). The old readout was bare text over a transparent
   badge, and to survive both a noon sky and dark ground behind it, it
   had to be painted TWICE — a thick dark -webkit-text-stroke clone laid
   down by a ::before, then the tinted fill, then a three-layer shadow
   stack. It was legible and it was ugly. Both are gone.

   Instead the numbers sit on a solid object: a brass plate let into an
   oak board, one per vital. Because the plaque is opaque, the text is a
   SINGLE clean paint — a dark engraving ink with one 1px highlight
   under it, which is what makes cut lettering read as cut rather than
   printed. Nothing else is drawn: the digits and the "/", and no vital
   name, because the vessel above already says which humour it is.

   The three plaques are deliberately IDENTICAL — same box, same board,
   same plate, same lettering, only the engraving ink shifts a few
   degrees toward each humour — so three independently draggable panes
   still read as one set of signs off the same bench. That is the
   "joined" reading, chosen over docking adjacent panes: docking would
   need each pane to watch the other two's rects on every drag and
   resize, and it would come apart the moment a pane is moved, whereas a
   matched set holds wherever the user puts them. The panes are NOT
   re-merged into one panel: that was v1's layout and it cost 41% of the
   render pipeline.

   PERF: every layer here is a plain CSS gradient. No SVG, no filter, no
   blend, no backdrop-filter — so there is nothing to bake through a
   canvas (v2's trap: an SVG data URL is replayed as a PaintRecord on
   every raster, it is not a bitmap) and nothing a wave tick can dirty.
   The plaque is a SIBLING of the contain:paint .hbo-core, painted once
   per commit and never again. Sizes are authored px and scale with the
   badge, so ?orbScale= moves the sign and its lettering as one object.
   The tick never writes a style here — only .v's textContent, and only
   when the number actually changed. */
${P} .orb-read {
  position: absolute; left: 50%; bottom: 0; z-index: 6;
  width: var(--hbo-plaque-w); height: var(--hbo-plaque-h);
  margin-left: calc(var(--hbo-plaque-w) / -2);
  box-sizing: border-box;
  padding: 5px 8px;
  border-radius: 3.5px;
  pointer-events: none;
  /* quarter-sawn oak: three grain passes at incommensurate periods (5 /
     9 / 17 px, tilted a degree or two off true so no pass lines up with
     another), over a top-lit board gradient. Rejected: a 1px brushed
     pattern on the plate — at ?orbScale=0.72 the 1px period aliased into
     visible corduroy, which is the tell of a fake metal. */
  background:
    repeating-linear-gradient(178deg, rgba(0, 0, 0, 0.20) 0 1px, rgba(0, 0, 0, 0) 1px 5px),
    repeating-linear-gradient(182deg, rgba(255, 206, 140, 0.09) 0 1px, rgba(0, 0, 0, 0) 1px 9px),
    repeating-linear-gradient(179deg, rgba(0, 0, 0, 0.13) 0 2px, rgba(0, 0, 0, 0) 2px 17px),
    linear-gradient(180deg, var(--hb-oak-hi), var(--hb-oak-mid) 45%, var(--hb-oak-lo));
  /* one bevel, cut from the light: lit top edge, shaded bottom edge,
     and a contact shadow that lifts the board off the world behind it */
  box-shadow:
    inset 0 1px 0 rgba(255, 222, 170, 0.30),
    inset 0 -1.5px 0 rgba(0, 0, 0, 0.65),
    inset 1px 0 0 rgba(255, 222, 170, 0.11),
    inset -1px 0 0 rgba(0, 0, 0, 0.40),
    0 2px 5px rgba(0, 0, 0, 0.72);
}
/* the plate: brass, let in flush, with a dark seat line around it so the
   board reads as routed out rather than painted gold. One soft raking
   sheen across it is the whole of its "polish". */
${P} .orb-read .plate {
  width: 100%; height: 100%;
  border-radius: 1.5px;
  display: flex; align-items: center; justify-content: center;
  background:
    linear-gradient(100deg,
      rgba(255, 255, 255, 0) 34%, rgba(255, 250, 232, 0.24) 47%,
      rgba(255, 255, 255, 0) 60%),
    linear-gradient(180deg,
      var(--hb-brass-hi) 0%, var(--hb-brass-mid) 20%, var(--hb-brass-core) 50%,
      var(--hb-brass-warm) 76%, var(--hb-brass-lo) 100%);
  box-shadow:
    inset 0 1px 0 rgba(255, 250, 228, 0.80),
    inset 0 -1px 0 rgba(58, 42, 12, 0.90),
    0 0 0 1px rgba(32, 20, 5, 0.62),
    0 1px 0 rgba(255, 228, 174, 0.16);
}
${P} .orb-read .v {
  font-family: var(--hb-font-serif);
  font-size: 19px;
  line-height: 1;
  letter-spacing: 0.6px;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  /* ONE paint. The engraving ink, plus the single hairline of light
     that sits in the bottom of a cut letter. No stroke clone, no
     shadow stack — the plate behind it is opaque. */
  color: var(--hbo-read, #3a2a0c);
  text-shadow: 0 1px 0 rgba(255, 246, 214, 0.45);
}

@media (prefers-reduced-motion: reduce) {
  ${P} .orb *, ${P} .hbo-core { animation: none !important; }
}
`;
}

function ensureStyles(opts) {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = orbStyleText(opts);
  document.head.appendChild(style);
}

// ── the CSS ambient loops, on the orb cadence ───────────────────────
//
// The specular drift, the bubbles, the mana shimmer, the fracture glints
// and bloom and the low-HP heartbeat are CSS `infinite` animations on
// SVG children, so Blink advances them — and re-rasters the vessel — at
// DISPLAY rate (120 Hz on the owner's monitor), on top of the 30 Hz wave
// tick. A changed layer is rastered on the GPU process's main thread,
// the same thread that executes every WebGL call (fps review 2026-10-19:
// the 2026-10-06 gpu.angle trace measured ~4.7 ms/frame of DOM raster
// there). `?orbAnimSync` (default on) pauses each one and, on the
// driver's cadence ticks only, sets its currentTime from the document
// timeline — the same keyframes at the same phase, sampled 30 times a
// second instead of 120. Finite animations (the one-shot damage glare)
// keep Blink's clock. The set is re-collected every tick, so a loop that
// starts later (`.beat`, the lazily built fracture web) is picked up on
// the next one. Returns null when off or when `getAnimations` is missing.
const _animStart = new WeakMap();  // Animation -> its timeline start (ms)

// ?hudDiet=orbSync (R3-2 HUD diet, ui/hud_diet.js; default off; `opts.cached`
// forces it either way): a full step (the one below, unchanged) runs only when
// the loop set may have changed; every other cadence
// tick is a LIGHT step over the list the last full step left. The light step
// reads each live loop's currentTime (an Animation getter: no style flush,
// unlike getAnimations() and a CSSAnimation's playState) and, if every one is
// still live, writes `currentTime = now - start` to each, in the same order.
// That is exactly the write a full step makes for a loop it already adopted and
// paused (playState "paused" -> no pause() call), so the sampled phase is
// identical; what goes is one forced style flush, the subtree walks and the
// playState reads per tick. A full step runs instead when: invalidate() was
// called (driver.invalidateAnims(): mount's setHidden on a change, and
// applyLowState — the only events that start or cancel loops; a no-op for the
// uncached sync, so the default call pattern is unchanged), a live loop reads idle (null currentTime: CSS
// cancelled it), a light write threw, or ORB_SYNC_RECOLLECT_TICKS - 1 light
// steps have run (a ~1 s safety net for anything else, e.g. a reduced-motion
// change; a loop found late meanwhile runs on Blink's own clock, same frames).
export const ORB_SYNC_RECOLLECT_TICKS = 30;

export function makeOrbAnimSync(roots, opts) {
  if (!orbAnimSyncEnabled()) return null;
  if (!roots || !roots.some((r) => r && typeof r.getAnimations === "function")) return null;
  let live = [];
  // Reused per step: [animation, start, playState] triples (no per-tick garbage
  // beyond the `next` list release() needs).
  const todo = [];
  // `opts.cached` forces the mode (tests); otherwise ?hudDiet=orbSync decides.
  const cached = opts && opts.cached !== undefined ? !!opts.cached : hudDietOn("orbSync");
  let starts = [];   // cached: adoption start per `live` entry
  let dirty = true;  // cached: the next step must be a full one
  let light = 0;     // cached: light steps since the last full one
  function lightStep(now) {
    for (let i = 0; i < live.length; i++) {
      let ct;
      try { ct = live[i].currentTime; } catch (_) { return false; }
      if (ct == null) return false;
    }
    for (let i = 0; i < live.length; i++) {
      try { live[i].currentTime = now - starts[i]; } catch (_) { dirty = true; }
    }
    return true;
  }
  return {
    /** Sample every infinite loop under `roots` at timeline time `now`. */
    // 2026-10-26 (lane F hot spots) — READS FIRST, THEN WRITES. A CSSAnimation's
    // `playState` getter FLUSHES STYLE (Blink CSSAnimation::playState →
    // FlushStyles → Document::UpdateStyleAndLayoutTree), and so does each
    // root's getAnimations(); every `currentTime =` write dirties the target's
    // animation style. Read-write-read per animation therefore forced one style
    // recalc per loop per cadence tick, plus one per pane (1070 2026-10-23 run:
    // `step` 0.19 ms/frame self + 0.11 ms in getAnimations). Now every pane's
    // list, every adoption read and every playState read happen before the
    // first write: one flush per tick (the first getAnimations), the rest read
    // clean style. Each animation still gets exactly the same calls in the same
    // order (pause() only if it was not paused, then currentTime = now − start),
    // the same adoption, the same exceptions skipping it, and the live list
    // keeps getAnimations' order — the writes touch only that animation, so no
    // read can see a different value for being taken earlier.
    step(now) {
      if (cached && !dirty && light < ORB_SYNC_RECOLLECT_TICKS - 1 && lightStep(now)) {
        light += 1;
        return;
      }
      todo.length = 0;
      for (const root of roots) {
        if (!root || typeof root.getAnimations !== "function") continue;
        let anims;
        try { anims = root.getAnimations({ subtree: true }); } catch (_) { continue; }
        for (const a of anims) {
          let start = _animStart.get(a);
          if (start === undefined) {
            let inf = false;
            try { inf = a.effect?.getTiming?.().iterations === Infinity; } catch (_) {}
            const ct = a.currentTime;
            if (!inf || ct == null) continue;
            // Adopt: remember where on the timeline it started, so the phase
            // stays exactly what Blink's own clock would show.
            start = now - Number(ct);
            _animStart.set(a, start);
          }
          let ps;
          try { ps = a.playState; } catch (_) { continue; }
          todo.push(a, start, ps);
        }
      }
      const next = [];
      const nextStarts = cached ? [] : null;
      for (let i = 0; i < todo.length; i += 3) {
        const a = todo[i];
        try {
          if (todo[i + 2] !== "paused") a.pause();
          a.currentTime = now - todo[i + 1];
          next.push(a);
          if (nextStarts) nextStarts.push(todo[i + 1]);
        } catch (_) {}
      }
      todo.length = 0;
      live = next;
      if (cached) { starts = nextStarts; dirty = false; light = 0; }
    },
    /** Cached mode: make the next step a full one (no-op otherwise). */
    invalidate() { dirty = true; },
    /** Hand the loops back to Blink's clock at their current phase. */
    release(now) {
      for (const a of live) {
        try {
          const start = _animStart.get(a);
          if (start !== undefined) a.currentTime = now - start;
          a.play();
        } catch (_) {}
      }
      live = [];
      starts = [];
      dirty = true;
    },
    get count() { return live.length; },
  };
}

// ── the shared animation driver ──────────────────────────────────────
//
// ONE rAF for the whole overlay. `orbs` are plain records — no DOM
// reads happen in the loop, only attribute writes (plus ?orbAnimSync's
// getAnimations, a style flush), so nothing here can force a layout.
// Stopped entirely under prefers-reduced-motion and while the tab is
// hidden.
//
// STEP 6 (21 samples across 120 units) instead of the card's 4: at HUD
// scale the extra samples are invisible and every one of them is
// geometry the SVG layout has to re-measure on all five paths.
const WAVE_STEP = 6, WAVE_TAU = 6.283185307;
const WAVE_N = VB / WAVE_STEP + 1;  // 21 samples, x = 0, 6, …, 120

// Two summed sines (2.7:1) instead of one: a single sine reads as a
// drawn squiggle, a beat of two reads as water. ONE definition of the
// surface for both renderers (the SVG `d` string and the canvas samples).
function waveY(y0, u, phase, amp, freq) {
  return y0 + Math.sin(u * freq * WAVE_TAU + phase) * amp
            + Math.sin(u * freq * 2.7 * WAVE_TAU - phase * 1.63) * amp * 0.3;
}

function createDriver(orbs, reducedMotion, hz, syncRoots = null) {
  const W = VB, H = VB, STEP = WAVE_STEP;
  const minStep = hz > 0 ? 1 / hz - 0.002 : 0;  // −2 ms so 30 Hz isn't 20 Hz
  let raf = 0;
  let last = 0;
  let acc = 0;
  let clock = 0;
  let stopped = false;
  let held = false;  // __diag freeze (parity harness): start() stays a no-op
  // ?orbRender=canvas: the orbs carry a Canvas2D vessel (`o.cv`) instead of
  // SVG refs. Without it every branch below is the SVG path, unchanged.
  const hasCanvas = orbs.some((o) => o.cv);
  const allHidden = () => orbs.every((o) => o.group.hidden);
  let tickNow = 0;  // canvas: the timeline time of the tick being drawn

  function wave(level, phase, amp, freq, dy) {
    const y0 = H - level * H + dy;
    let d = "";
    for (let x = 0; x <= W; x += STEP) {
      const u = x / W;
      const y = waveY(y0, u, phase, amp, freq);
      d += (x === 0 ? "M" : "L") + x + " " + y.toFixed(2);
    }
    return d + "L" + W + " " + (H + 8) + "L0 " + (H + 8) + "Z";
  }

  function tick(_s, dt) {
    for (let i = 0; i < orbs.length; i++) {
      const o = orbs[i];
      // Ease the visible level toward the wire level so a hit glides
      // instead of teleporting (the bars used a 120 ms CSS width
      // transition for the same reason).
      if (o.level !== o.levelTarget) {
        const k = dt > 0 ? 1 - Math.exp(-dt / 0.18) : 1;
        o.level += (o.levelTarget - o.level) * k;
        if (Math.abs(o.levelTarget - o.level) < 0.0005) o.level = o.levelTarget;
      }
      // Slosh impulse decays over ~0.8 s back to the idle cadence.
      if (o.impulse > 0.0005) o.impulse *= Math.exp(-dt / 0.8);
      else o.impulse = 0;

      const amp = o.baseAmp + o.impulse * 4.0;
      const spd = o.baseSpd + o.impulse * 2.2;
      o.phase += dt * 1.05 * spd;
      const ph = o.phase + o.seed;
      // ?orbRender=canvas: same state, same surface, drawn (or skipped) by
      // the orb's own Canvas2D vessel; no DOM write at all.
      if (o.cv) { o.cv.frame(o, amp, ph, tickNow); continue; }

      o.back.setAttribute("d",
        wave(o.level, -o.phase * 0.59 + o.seed * 1.9, amp * 1.2, 1.5, 5.5));
      const d = wave(o.level, ph, amp, 2.4, 0);
      o.body.setAttribute("d", d);
      if (o.clip) o.clip.setAttribute("d", d);
      for (let j = 0; j < o.men.length; j++) o.men[j].setAttribute("d", d);
      // PERF item 1. `setAttribute("transform", …)` writes a
      // PRESENTATION ATTRIBUTE, and presentation attributes map into
      // CSS style — so it invalidated the whole vessel's style on every
      // one of the 30 ticks a second and UpdateLayoutTree was a quarter
      // of the HUD's render pipeline. Mutating the SVGTransform in
      // `transform.baseVal` marks the layout object's transform dirty
      // and nothing else. DO NOT put the attribute back.
      if (o.surfXform) {
        const sy = (H - o.level * H) + Math.sin(ph) * amp * 0.5;
        o.surfXform.setTranslate(0, sy);
      }
    }
  }

  // Rolling self-time of the driver, so "does the orb HUD cost a frame?"
  // is an answerable question in a live session instead of a guess.
  let tickMs = 0;
  let frames = 0;
  // ?orbAnimSync: the CSS loops follow this cadence too (makeOrbAnimSync).
  // Never built under reduced motion — the stylesheet turns them off there.
  // ?hudDiet=orbSync is read inside makeOrbAnimSync (cached sampling).
  const sync = reducedMotion ? null : makeOrbAnimSync(syncRoots);
  const timelineNow = (t) => {
    const ct = typeof document !== "undefined" ? document.timeline?.currentTime : null;
    return Number.isFinite(ct) ? ct : t;
  };

  function frame(t) {
    raf = 0;
    if (stopped) return;
    // ?orbRender=canvas: with every pane hidden there is nothing to draw, so
    // the loop stops outright; mount() restarts it when a pane is shown.
    if (hasCanvas && allHidden()) { last = 0; return; }
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    acc += dt;
    raf = requestAnimationFrame(frame);
    // ?orbRender=canvas: the one-shot damage glare stays on the display
    // clock, as the SVG path's finite CSS animation does — off-cadence, a
    // vessel is redrawn only when its glare flicker steps.
    if (hasCanvas) {
      tickNow = timelineNow(t);
      if (acc < minStep) {
        for (const o of orbs) if (o.cv && o.cv.glareActive(tickNow)) o.cv.redraw(o, tickNow);
      }
    }
    // Skip the write entirely on off-cadence vsync ticks: no attribute
    // is touched, so Blink schedules no style/layout/paint for us.
    if (acc < minStep) return;
    clock += acc;
    const t0 = performance.now();
    // Before the wave writes: getAnimations() flushes style, and here it
    // only finds what other callbacks dirtied this frame.
    if (sync) sync.step(timelineNow(t));
    tick(clock, acc);
    tickMs += (performance.now() - t0 - tickMs) * 0.05;  // EMA
    acc = 0;
    frames++;
  }

  return {
    /** Paint one still frame — the reduced-motion and first-paint path. */
    still() {
      if (hasCanvas) tickNow = timelineNow(performance.now());
      tick(0, 0);
    },
    start() {
      if (stopped || held || raf || document.hidden) return;
      if (reducedMotion) {
        // ?orbRender=canvas only: under reduced motion every vitals change
        // repaints ONE still frame at the new level (no slosh). The SVG path
        // keeps its mount-time still frame, unchanged.
        if (hasCanvas) {
          for (const o of orbs) o.impulse = 0;
          this.still();
        }
        return;
      }
      last = 0;
      acc = minStep;  // paint the first cadence step immediately
      raf = requestAnimationFrame(frame);
    },
    // A pause (hidden tab) leaves the loops paused where they were: nothing
    // is drawn meanwhile, and the next cadence tick puts each one back at
    // the phase Blink's own clock would show.
    pause() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    stop() {
      stopped = true;
      this.pause();
      if (sync) sync.release(timelineNow(performance.now()));
    },
    /** ?hudDiet=orbSync: the loop set may have changed; re-collect next tick. */
    invalidateAnims() { if (sync) sync.invalidate(); },
    /** __diag freeze: stop the loop and keep start() from restarting it. */
    hold() { held = true; this.pause(); },
    get running() { return raf !== 0; },
    get animSynced() { return sync ? sync.count : 0; },
    get tickMs() { return tickMs; },
    get frames() { return frames; },
  };
}

// ── ?orbRender=canvas — the vessel core in Canvas2D ──────────────────
//
// WHY. Every SVG wave tick rewrites six `d` attributes (back, front, the
// caustics/wall clip path, three meniscus strokes) and one transform inside
// a subtree of clip paths, CSS blurs (subglow, specular, mana shimmer), blend
// modes (screen x3-4, multiply) and the clipped caustics image. The core is a
// paint-contained box, so the whole 92x92 vessel is re-painted by Blink and
// re-rastered by the GPU process (every blur and blend layer re-run) 30 times
// a second, x3 vessels, plus the CSS ambient loops on the same subtree.
//
// WHAT. One <canvas> per vessel core (the panes stay independent: each badge
// is still dragged / persisted on its own). Per tick, in the core's own
// 0..120 user space at device scale:
//   circle clip → back body (wave, absorption gradient over its bbox, 0.85)
//   → front body → clip to the front wave → caustics (screen) + wall
//   darkening (multiply) → mana shimmer → 3 bubbles → subglow (screen) +
//   specular streak (screen) + wall-climb crescents, all on the waterline
//   → 3 meniscus strokes → vitae layer; unclipped: glass → glare (screen)
//   → fracture web + glints + bloom (low HP).
// That is the SVG vessel's paint order, layer for layer. The canvas box IS
// the core box (registration identical to the <svg>), its backing store is
// supersampled (W = 92 x orbScale x HUD zoom x DPR x cvSupersample()). PRE-
// BAKED once per backing size (re-baked on resize / hb-hud-scale-changed / a
// DPR change, only if the size changed): the glass plate and the
// caustics (drawn from the SAME 240 px bitmaps the SVG path bakes from
// GLASS_SVG / CAUSTIC_SVG — the browser's own feTurbulence, evaluated once,
// never per tick, never scrolled: the signed-off caustics are static and
// crawl only through the live clip), the wall darkening, the blurred subglow
// (per humour, + the low-HP colour band), specular streak and shimmer
// sprites (blurred once with ctx.filter, positioned per tick), the fracture
// web (the four static passes incl. the #hbRefract displacement, rasterized
// by the SVG engine directly on the canvas's own pixel grid — the SVG vessel
// draws it as live vectors), and the vitae dim / hatch / scum / grime layer
// (per ceiling).
// PER TICK: the two wave paths from waveY() (the SVG path's own math), one
// clip, <= 8 drawImage, 3-6 strokes, 0-3 small fills. The ambient CSS loops
// (hbo-sspec / -bub / -shimmer / -glint / -bloom) are sampled from the same
// keyframes in JS at the orb cadence (what ?orbAnimSync does to the SVG);
// the one-shot glare follows its keyframes on the display clock; the low-HP
// heartbeat stays the CSS animation on .hbo-core, in both modes.
// SKIP: a tick is drawn only if some drawn value moved more than CV_SKIP_PX
// device px (wave vertices, waterline, sprites) or CV_SKIP_A in alpha, or a
// discrete input changed (size, a bitmap landing, low band, ceiling, glare
// step); otherwise the canvas keeps the last frame. Hidden panes draw
// nothing, and the loop stops while all three are hidden.
//
// FIDELITY NOTES (kept on purpose, so the look is the signed-off one):
//   * #hbOrbBloom lives in the body-level shared <defs>, OUTSIDE the panes
//     that define --hb-orb-crack-glint, so its stop-color resolves to the
//     initial value (black): the SVG "bloom" is a black radial blob screened
//     over the vessel, i.e. a faint dark smudge where the glass is clear.
//     Drawn here as exactly that.
//   * `.fx-glint:nth-of-type(2..4)` counts every <path> sibling, so none of
//     the three delay rules matches and all four glints flicker in unison.
//     Same here.
//   * CSS transforms on SVG children scale about the user-space ORIGIN
//     (transform-origin 0 0), so a bubble's scale(0.7 → 1.05) also moves it;
//     sampled the same way.
const CV_SKIP_PX = 0.125;
const CV_SKIP_A = 1 / 255;
// Backing-store supersampling (canvas px per device px). The canvas is drawn
// into the core's device rect, which sits at a fractional position, so the
// compositor resamples it once (bilinear). At 1x that adds a ~1 px tent on
// top of the content's own antialiasing (sigma ~0.5 px: thin strokes read
// thinner and paler than the SVG's); at 2x (1.5x on DPR >= 1.5 screens,
// whose device px are already small) the total is about the SVG's own
// antialiasing footprint (sigma ~0.25-0.33 vs ~0.29). Cost: 4x (2.25x) the
// raster area of a 1x canvas.
function cvSupersample(dpr) { return dpr >= 1.5 ? 1.5 : 2; }
const CV_TAU = Math.PI * 2;
const DEG = Math.PI / 180;

// The --hb-orb-* tokens, read from the stylesheet text itself so the canvas
// colours can never drift from the CSS ones.
let _tokens = null;
function orbTokens() {
  if (_tokens) return _tokens;
  _tokens = Object.create(null);
  for (const m of styleText().matchAll(/--(hb-orb-[\w-]+):\s*([^;]+);/g)) _tokens[m[1]] = m[2].trim();
  return _tokens;
}

/** `#rrggbb` / `rgb[a](…)` → `rgba(…)` with its alpha multiplied by `a`. */
function rgba(color, a = 1) {
  const c = String(color).trim();
  let r, g, b, al = 1, m;
  if ((m = /^#([0-9a-f]{6})$/i.exec(c))) {
    const n = parseInt(m[1], 16);
    r = n >> 16; g = (n >> 8) & 255; b = n & 255;
  } else if ((m = /^rgba?\(([^)]+)\)$/i.exec(c))) {
    const p = m[1].split(",").map((x) => Number(x));
    [r, g, b] = p;
    if (p.length > 3) al = p[3];
  } else {
    return c;
  }
  return `rgba(${r},${g},${b},${+(al * a).toFixed(4)})`;
}

/** The two tokens behind --orb-a / --orb-b (`.orb.<kind>[.low]`). */
function orbColorTokens(kind, low) {
  if (kind === "hp") return low ? ["hb-orb-hp-low", "hb-orb-hp-low-deep"] : ["hb-orb-hp", "hb-orb-hp-deep"];
  return [`hb-orb-${kind}`, `hb-orb-${kind}-deep`];
}

// ── the ambient keyframes, sampled ──────────────────────────────────
// Mirrors of the @keyframes in styleText() (tests pin them against it).
function cubicBezier(x1, y1, x2, y2) {
  const cx = 3 * x1, bx = 3 * (x2 - x1) - cx, ax = 1 - cx - bx;
  const cy = 3 * y1, by = 3 * (y2 - y1) - cy, ay = 1 - cy - by;
  const X = (t) => ((ax * t + bx) * t + cx) * t;
  const Y = (t) => ((ay * t + by) * t + cy) * t;
  const dX = (t) => (3 * ax * t + 2 * bx) * t + cx;
  return (p) => {
    if (p <= 0) return 0;
    if (p >= 1) return 1;
    let t = p;
    for (let i = 0; i < 8; i++) {
      const e = X(t) - p;
      if (Math.abs(e) < 1e-7) return Y(t);
      const d = dX(t);
      if (Math.abs(d) < 1e-6) break;
      t -= e / d;
    }
    let lo = 0, hi = 1;
    t = p;
    for (let i = 0; i < 40; i++) {
      const v = X(t);
      if (Math.abs(v - p) < 1e-7) break;
      if (v < p) lo = t; else hi = t;
      t = (lo + hi) / 2;
    }
    return Y(t);
  };
}
const EASE_IN_OUT = cubicBezier(0.42, 0, 0.58, 1);

/** Iteration progress of an infinite loop at timeline time `tMs`. */
function loopFrac(tMs, durS, delayS) {
  const d = durS * 1000;
  let a = (tMs - delayS * 1000) % d;
  if (a < 0) a += d;
  return a / d;
}
/** 0%,100% = A / 50% = B under ease-in-out: the weight of B. */
function pingPong(f) {
  return f < 0.5 ? EASE_IN_OUT(f / 0.5) : 1 - EASE_IN_OUT((f - 0.5) / 0.5);
}
// hbo-glare, steps(1, end): [end of interval, opacity held until it].
const GLARE_STEPS = [[0.02, 0], [0.05, 0.62], [0.08, 0.08], [0.12, 0.44], [0.16, 0], [0.20, 0.22]];
function glareAlpha(ms) {
  if (!(ms >= 0) || ms >= GLARE_MS) return 0;
  const f = ms / GLARE_MS;
  for (const [end, v] of GLARE_STEPS) if (f < end) return v;
  return 0;
}
/** hbo-glint: 0%, 72%, 100% 0.06 / 84% 0.95, ease-in-out. */
function glintAlpha(f) {
  if (f < 0.72) return 0.06;
  if (f < 0.84) return 0.06 + 0.89 * EASE_IN_OUT((f - 0.72) / 0.12);
  return 0.95 - 0.89 * EASE_IN_OUT((f - 0.84) / 0.16);
}
/** hbo-bub opacity: 0 → 0.55 (12%) → 0.4 (85%) → 0, linear. */
function bubbleAlpha(f) {
  if (f < 0.12) return 0.55 * (f / 0.12);
  if (f < 0.85) return 0.55 - 0.15 * ((f - 0.12) / 0.73);
  return 0.4 * (1 - (f - 0.85) / 0.15);
}

// Per-tick parameter vector (the skip test compares it to the last DRAWN one).
const P_W = 0, P_GEN = 1, P_LOW = 2, P_CEIL = 3, P_GLARE = 4, P_SY = 5;
const P_SSPEC = 6;   // tx, scaleX, opacity
const P_SHIM = 9;    // tx, ty, scale, opacity
const P_GLINT = 13, P_BLOOM = 14;
const P_BUB = 15;    // 3 x (cx, cy, r, opacity)
const P_FRONT = 27, P_BACK = P_FRONT + WAVE_N, NP = P_BACK + WAVE_N;

/** Sample every ambient loop at loop time `t` (ms) into `out`. */
function sampleLoops(out, t, o, kind, reduced) {
  const rise = Number.isFinite(parseFloat(o.lastRise)) ? parseFloat(o.lastRise) : -60;
  for (let b = 0; b < BUBBLES.length; b++) {
    const [bx, br, bd, dly] = BUBBLES[b];
    const j = P_BUB + 4 * b;
    if (reduced) { out[j] = bx; out[j + 1] = 112; out[j + 2] = br; out[j + 3] = 1; continue; }
    const f = loopFrac(t, bd, dly);
    // translateY(rise·f) scale(0.7 → 1.05), about the user-space origin
    const sc = 0.7 + 0.35 * f;
    out[j] = sc * bx; out[j + 1] = rise * f + sc * 112; out[j + 2] = sc * br;
    out[j + 3] = bubbleAlpha(f);
  }
  if (reduced) {
    out[P_SSPEC] = 0; out[P_SSPEC + 1] = 1; out[P_SSPEC + 2] = 0.4;
  } else {
    const w = pingPong(loopFrac(t, 9, 0));
    out[P_SSPEC] = -9 + 20 * w; out[P_SSPEC + 1] = 0.86 + 0.28 * w; out[P_SSPEC + 2] = 0.26 + 0.24 * w;
  }
  if (kind !== "mana") {
    out[P_SHIM] = out[P_SHIM + 1] = out[P_SHIM + 2] = out[P_SHIM + 3] = 0;
  } else if (reduced) {
    out[P_SHIM] = 0; out[P_SHIM + 1] = 0; out[P_SHIM + 2] = 1; out[P_SHIM + 3] = 0.3;
  } else {
    const w = pingPong(loopFrac(t, 7.5, 0));
    out[P_SHIM] = -8 + 18 * w; out[P_SHIM + 1] = 4 - 10 * w;
    out[P_SHIM + 2] = 1 + 0.25 * w; out[P_SHIM + 3] = 0.16 + 0.24 * w;
  }
  if (!o.low) {
    out[P_GLINT] = 0; out[P_BLOOM] = 0;
  } else if (reduced) {
    out[P_GLINT] = 0; out[P_BLOOM] = 1;
  } else {
    out[P_GLINT] = glintAlpha(loopFrac(t, 3.6, 0));
    out[P_BLOOM] = 0.35 + 0.35 * pingPong(loopFrac(t, 3.6, 0));
  }
}

/** Test seam (tests/vitals_orbs_canvas.test.mjs): the keyframe samplers, the
 *  surface sampler, a bare vessel, and a reset of the SVG-bitmap cache. */
export const __orbCanvasInternals = {
  ease: EASE_IN_OUT,
  skipPx: CV_SKIP_PX,
  waveYs: (...a) => waveYs(...a),
  createVessel: (...a) => createCanvasVessel(...a),
  resetBitmaps() { _bitmaps.clear(); _fractureUrl.clear(); },
  supersample: (dpr) => cvSupersample(dpr),
  /** The CSS the crack-web bake applies (the page's `.orb .fx-*` rules). */
  fractureBakeCss: () => fractureBakeCss(),
  /** One loop's sampled values at loop time `ms` (bub = bubble 0). */
  sampleAt(name, ms, extra = {}) {
    const out = new Float64Array(NP);
    sampleLoops(out, ms, { lastRise: `${extra.rise ?? -60}px`, low: true }, "mana", false);
    switch (name) {
      case "sspec": return Array.from(out.subarray(P_SSPEC, P_SSPEC + 3));
      case "shimmer": return Array.from(out.subarray(P_SHIM, P_SHIM + 4));
      case "bub": return Array.from(out.subarray(P_BUB, P_BUB + 4));
      case "glint": return [out[P_GLINT]];
      case "bloom": return [out[P_BLOOM]];
      case "glare": return [glareAlpha(ms)];
      default: return null;
    }
  },
};

/** The 21 surface samples of one wave body into `out`; returns its top. */
function waveYs(out, level, phase, amp, freq, dy) {
  const y0 = VB - level * VB + dy;
  let top = Infinity;
  for (let i = 0, x = 0; x <= VB; x += WAVE_STEP, i++) {
    const y = waveY(y0, x / VB, phase, amp, freq);
    out[i] = y;
    if (y < top) top = y;
  }
  return top;
}

/** The SVG wave body (`…L120 128L0 128Z`), optionally shifted by dy. */
function traceBody(g, ys, dy) {
  g.beginPath();
  g.moveTo(0, ys[0] + dy);
  for (let i = 1; i < WAVE_N; i++) g.lineTo(i * WAVE_STEP, ys[i] + dy);
  g.lineTo(VB, VB + 8 + dy);
  g.lineTo(0, VB + 8 + dy);
  g.closePath();
}

// A tiny absolute/relative M L Q q Z reader for the markup's own path
// strings (vitae scum, fracture glints), used at bake time only.
function parsePath(d) {
  const toks = [];
  const re = /([MLQZmlqz])|(-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?)/g;
  let m;
  while ((m = re.exec(d))) toks.push(m[1] || Number(m[2]));
  const out = [];
  let i = 0, cx = 0, cy = 0;
  while (i < toks.length) {
    const c = toks[i++];
    if (c === "M" || c === "L") { cx = toks[i++]; cy = toks[i++]; out.push([c, cx, cy]); }
    else if (c === "Q") { const a = toks.slice(i, i + 4); i += 4; out.push(["Q", ...a]); cx = a[2]; cy = a[3]; }
    else if (c === "q") {
      const a = [cx + toks[i], cy + toks[i + 1], cx + toks[i + 2], cy + toks[i + 3]];
      i += 4; out.push(["Q", ...a]); cx = a[2]; cy = a[3];
    } else if (c === "Z" || c === "z") out.push(["Z"]);
    else break;
  }
  return out;
}
function tracePath(g, cmds, begin = true) {
  if (begin) g.beginPath();
  for (const c of cmds) {
    if (c[0] === "M") g.moveTo(c[1], c[2]);
    else if (c[0] === "L") g.lineTo(c[1], c[2]);
    else if (c[0] === "Q") g.quadraticCurveTo(c[1], c[2], c[3], c[4]);
    else g.closePath();
  }
}

// ── bakes ────────────────────────────────────────────────────────────
function makeCanvas(w, h) {
  if (typeof OffscreenCanvas === "function") return new OffscreenCanvas(w, h);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  return c;
}

// SVG documents rasterized ONCE by the browser's own SVG engine (the only
// place feTurbulence / feDisplacementMap ever run in canvas mode). A load
// bumps _bakeGen, which is part of every vessel's skip key, so the next
// tick draws the new layer.
const _bitmaps = new Map();  // `${w}x${h}@${url}` → { cv, failed }
let _bakeGen = 0;
const _cvStats = { bakes: 0 };
function svgBitmap(url, w, h = w) {
  const key = w + "x" + h + "@" + url;
  let b = _bitmaps.get(key);
  if (b) return b;
  b = { cv: null, failed: false };
  _bitmaps.set(key, b);
  if (typeof Image !== "function") { b.failed = true; return b; }
  const img = new Image();
  img.onload = () => {
    try {
      const c = makeCanvas(w, h);
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      b.cv = c;
    } catch (_) { b.failed = true; }
    _bakeGen++;
  };
  img.onerror = () => { b.failed = true; _bakeGen++; };
  img.src = url;
  return b;
}

// The four static fracture passes (dark / #hbRefract-displaced / main /
// shards) as one self-contained SVG; glints and bloom animate, so they are
// drawn live. The crack web is the one baked layer the SVG vessel draws as
// LIVE VECTORS (glass and caustics are 240 px bitmaps there too), so it is
// rasterized ON THE CANVAS'S OWN PIXEL GRID: intrinsic size = the canvas
// (W x H, supersampled), viewBox = the 0..120 user space. The browser's SVG
// engine draws every stroke, the #hbRefract displacement included, at the
// canvas's scale and the result is blitted 1:1. (2026-10-31 look review: a
// 240 px bake scaled down 1.8x / 3.6x blurred the cracks; the web is a
// gameplay warning and must read as boldly as the SVG one.) The styles are
// the page's own `.orb .fx-*` rules with var() resolved, so the two cannot
// drift (tests pin the page cascade on the crack elements too).
const FX_BAKE_CLASSES = ["fx-dark", "fx-refract", "fx-main", "fx-shard"];
function fractureBakeCss() {
  const css = styleText(), t = orbTokens();
  return FX_BAKE_CLASSES.map((cls) => {
    const body = new RegExp(`\\.orb \\.${cls} \\{([^}]*)\\}`).exec(css)[1];
    return `.${cls}{${body.replace(/var\(--([\w-]+)\)/g, (_, n) => t[n]).replace(/\s+/g, " ").trim()}}`;
  }).join("");
}
const _fractureUrl = new Map();  // geometry key → data URL (bounded)
function fractureBakeUrl(G) {
  const key = `${G.W}x${G.H}`;
  let u = _fractureUrl.get(key);
  if (u) return u;
  const filter = /<filter id="hbRefract"[\s\S]*?<\/filter>/.exec(SHARED_DEFS)[0];
  const body = FRACTURE_SVG.replace(/<path class="fx-glint"[^>]*\/>/g, "").replace(/<circle class="fx-bloom"[^>]*\/>/g, "");
  const vb = [0, 0, G.W / G.s, G.H / G.s].map((v) => +v.toFixed(6)).join(" ");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${vb}" width="${G.W}" height="${G.H}">`
    + `<defs>${filter.replace(/\s+/g, " ")}</defs><style>${fractureBakeCss()}</style>${body}</svg>`;
  u = "data:image/svg+xml," + encodeURIComponent(svg);
  // A few geometries at most (three panes, a drag, a DPR change): keep 8.
  if (_fractureUrl.size >= 8) {
    const [oldKey, oldUrl] = _fractureUrl.entries().next().value;
    _fractureUrl.delete(oldKey);
    for (const k of [..._bitmaps.keys()]) if (k.endsWith("@" + oldUrl)) _bitmaps.delete(k);
  }
  _fractureUrl.set(key, u);
  return u;
}
let _glintCmds = null;
function glintCmds() {
  if (!_glintCmds) {
    _glintCmds = [];
    for (const m of FRACTURE_SVG.matchAll(/<path class="fx-glint" d="([^"]+)"\/>/g)) _glintCmds.push(...parsePath(m[1]));
  }
  return _glintCmds;
}

/** A blurred sprite covering user rect (x0,y0)-(x1,y1), at device scale. */
function bakeSprite(s, x0, y0, x1, y1, blur, paint) {
  const pad = blur * 3;
  const px0 = Math.floor((x0 - pad) * s), py0 = Math.floor((y0 - pad) * s);
  const px1 = Math.ceil((x1 + pad) * s), py1 = Math.ceil((y1 + pad) * s);
  const w = Math.max(1, px1 - px0), h = Math.max(1, py1 - py0);
  const cv = makeCanvas(w, h);
  const g = cv.getContext("2d");
  // ctx.filter lengths are canvas px, independent of the transform; the CSS
  // blur(Npx) on an SVG child is N user units, i.e. N·s device px.
  if (blur > 0 && "filter" in g) g.filter = `blur(${+(blur * s).toFixed(4)}px)`;
  g.setTransform(s, 0, 0, s, -px0, -py0);
  paint(g);
  return { cv, x: px0 / s, y: py0 / s, w: w / s, h: h / s };
}

// Full-size layers are baked at the vessel's own canvas size (G = { W, H, s }:
// user 0..120 → canvas px is s·u), so they are blitted 1:1 with no resample;
// sprites are baked on their own grid at scale s and positioned per tick.
const BAKES = {
  /** lqwall: the radial multiply that darkens the liquid toward the glass. */
  wall(G) {
    const c = makeCanvas(G.W, G.H);
    const g = c.getContext("2d");
    g.setTransform(G.s, 0, 0, G.s, 0, 0);
    const gr = g.createRadialGradient(60, 60, 0, 60, 60, 55.5);
    gr.addColorStop(0.32, "#ffffff");
    gr.addColorStop(0.78, "#a08c78");
    gr.addColorStop(1, "#3a2c22");
    g.fillStyle = gr;
    g.beginPath(); g.arc(60, 60, 55.5, 0, CV_TAU); g.fill();
    return c;
  },
  /** .subglow: ellipse 60,11 46x11, bbox radial orb-a 0.85 → 0, blur(6px). */
  subglow(G, kind, low) {
    const a = orbTokens()[orbColorTokens(kind, low)[0]];
    return bakeSprite(G.s, 14, 0, 106, 22, 6, (g) => {
      g.translate(60, 11); g.scale(46, 11);
      const gr = g.createRadialGradient(0, 0, 0, 0, 0, 1);
      gr.addColorStop(0, rgba(a, 0.85));
      gr.addColorStop(1, rgba(a, 0));
      g.fillStyle = gr;
      g.beginPath(); g.arc(0, 0, 1, 0, CV_TAU); g.fill();
    });
  },
  /** .sspec: ellipse 52,1.5 21x2.2, --hb-orb-men-spec, blur(2.6px). */
  sspec(G) {
    return bakeSprite(G.s, 31, -0.7, 73, 3.7, 2.6, (g) => {
      g.fillStyle = orbTokens()["hb-orb-men-spec"];
      g.beginPath(); g.ellipse(52, 1.5, 21, 2.2, 0, 0, CV_TAU); g.fill();
    });
  },
  /** .shimmer (mana): ellipse 58,74 30x20, --hb-orb-mana-shimmer, blur(6px). */
  shimmer(G) {
    return bakeSprite(G.s, 28, 54, 88, 94, 6, (g) => {
      g.fillStyle = orbTokens()["hb-orb-mana-shimmer"];
      g.beginPath(); g.ellipse(58, 74, 30, 20, 0, 0, CV_TAU); g.fill();
    });
  },
  /** The vitae group (dim, 38° hatch, scum band, grime, dots) at ceiling c. */
  vitae(G, c) {
    const t = orbTokens();
    const cv = makeCanvas(G.W, G.H);
    const g = cv.getContext("2d");
    const cy0 = VITAE_CY0;
    const dy = Number(((VB - c * VB) - cy0).toFixed(2));  // the SVG path's own translate
    const markup = vitaeGroup("hp");
    const top = cy0 - 260;
    g.setTransform(G.s, 0, 0, G.s, 0, dy * G.s);
    g.fillStyle = t["hb-orb-vitae-dim"];
    g.fillRect(-4, top, 128, 260);
    // hatch: pattern 7x7 userSpaceOnUse rotate(38), a 2.4-wide line at x=0
    // clipped by its tile (so 1.2 wide), opacity 0.5 x the rect's 0.30.
    g.save();
    g.beginPath(); g.rect(-4, top, 128, 260); g.clip();
    g.rotate(38 * DEG);
    g.globalAlpha = 0.5 * 0.30;
    g.fillStyle = "#000000";
    // visible group-space box → pattern space (rotate −38°), padded a tile
    const ys = [Math.max(top, -dy), Math.min(cy0, G.H / G.s - dy)];
    const ca = Math.cos(-38 * DEG), sa = Math.sin(-38 * DEG);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const x of [-4, 124]) for (const y of ys) {
      const u = x * ca - y * sa, v = x * sa + y * ca;
      u0 = Math.min(u0, u); u1 = Math.max(u1, u); v0 = Math.min(v0, v); v1 = Math.max(v1, v);
    }
    for (let k = Math.floor(u0 / 7) - 1; k <= Math.ceil(u1 / 7) + 1; k++) g.fillRect(7 * k, v0 - 7, 1.2, v1 - v0 + 14);
    g.restore();
    const scum = /class="vitae-scum-band" d="([^"]+)"/.exec(markup)[1];
    const grime = /class="vitae-grime" d="([^"]+)"/.exec(markup)[1];
    g.globalAlpha = 0.55;
    g.fillStyle = t["hb-orb-vitae-scum"];
    tracePath(g, parsePath(scum)); g.fill();
    g.globalAlpha = 1;
    g.strokeStyle = t["hb-orb-vitae-scum"];
    g.lineWidth = 1.8;
    tracePath(g, parsePath(grime)); g.stroke();
    g.globalAlpha = 0.85;
    g.fillStyle = t["hb-orb-vitae-scum"];
    g.beginPath();
    for (const m of markup.matchAll(/<circle cx="([^"]+)" cy="([^"]+)" r="([^"]+)"\/>/g)) {
      g.moveTo(+m[1] + +m[3], +m[2]);
      g.arc(+m[1], +m[2], +m[3], 0, CV_TAU);
    }
    g.fill();
    return cv;
  },
};

// Layer sets per backing size, shared by every vessel at that size (the three
// panes) and dropped when no vessel uses it any more.
const _layerSets = new Map();  // key → { refs, map: Map(name → layer | null) }
function acquireLayerSet(key) {
  let set = _layerSets.get(key);
  if (!set) { set = { refs: 0, map: new Map() }; _layerSets.set(key, set); }
  set.refs++;
  return set;
}
function releaseLayerSet(key) {
  const set = _layerSets.get(key);
  if (set && --set.refs <= 0) _layerSets.delete(key);
}

function clockNow() {
  const ct = typeof document !== "undefined" ? document.timeline?.currentTime : null;
  return Number.isFinite(ct) ? ct : performance.now();
}

/**
 * One vessel core drawn into `canvas` (inside `pane`). The driver calls
 * frame() on its cadence ticks with the orb record and the tick's amplitude
 * and front phase; everything else is read off the orb record.
 */
function createCanvasVessel(kind, canvas, pane, opts = {}) {
  const reduced = !!opts.reduced;
  const caustics = opts.caustics !== false;
  const core = opts.core || canvas.parentNode || null;
  const cur = new Float64Array(NP);
  const tol = new Float64Array(NP);
  const front = new Float64Array(WAVE_N);
  const back = new Float64Array(WAVE_N);
  // G: canvas size W x H and canvas px per user unit s; dev: DEVICE px per
  // user unit (s / the supersampling factor).
  let ctx = null, W = 0, H = 0, s = 1, dev = 1, G = null;
  let set = null, setKey = "", last = null, force = true;
  let sizeDirty = true, t0 = null, glareStart = -Infinity;
  let frozenT = null, frozenGlare = null;
  let lastAmp = 0, lastPh = 0;
  let grad = null, gradKey = "", vitae = null, vitaeKey = NaN, bloomGrad = null;
  const stats = { draws: 0, skips: 0, bakes: 0, resizes: 0 };

  // REGISTRATION: the canvas box IS the core box (the markup's 92x92 CSS
  // px, no offset), exactly as the <svg> it replaces, so wherever Blink puts
  // the core both renderers land on the same device rect. (2026-10-31 look
  // review, measured: a whole-device-pixel canvas nudged by fractional CSS
  // left/top drifted 0.3-0.7 device px, because Blink pixel-snaps a canvas's
  // box in the pane's LOCAL, pre-scale space; every crack read thinner and
  // paler. Do not re-add sub-pixel CSS offsets.)
  // SHARPNESS: that rect sits at a fractional device position, so the bitmap
  // is always resampled once; the backing store is SUPERSAMPLED (see
  // cvSupersample) so that resample costs about what the SVG's own
  // antialiasing does. Size = the core's device width (the pane's rect width
  // carries orbScale, the HUD zoom and the DPR) x the factor. Read only on a
  // size invalidation (resize / HUD zoom / DPR change).
  function measure() {
    const dpr = Number(globalThis.devicePixelRatio) > 0 ? Number(globalThis.devicePixelRatio) : 1;
    const pr = pane.getBoundingClientRect();
    if (!(pr.width > 0)) return null;
    const dev = ORB_PX * (pr.width / PANE_W) * dpr / VB;  // device px per user unit
    const w = Math.max(8, Math.round(VB * dev * cvSupersample(dpr)));
    return { dev, s: w / VB, W: w, H: w };
  }

  function resize() {
    const m = measure();
    if (!m) return false;  // not laid out yet: stay dirty, draw nothing
    sizeDirty = false;
    const key = `${m.W}x${m.H}`;
    if (key === setKey && ctx) return true;
    if (set) releaseLayerSet(setKey);
    setKey = key;
    set = acquireLayerSet(key);
    W = m.W; H = m.H; s = m.s; dev = m.dev;
    G = { W, H, s };
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    ctx = canvas.getContext("2d");
    grad = null; gradKey = ""; vitae = null; vitaeKey = NaN; bloomGrad = null;
    force = true;
    stats.resizes++;
    // Skip tolerances in the quantity's own units: CV_SKIP_PX DEVICE px of
    // on-screen motion (scale factors: over the sprite's farthest point
    // from the user-space origin they scale about), CV_SKIP_A of alpha.
    const px = CV_SKIP_PX / dev;
    tol.fill(0);
    tol[P_SY] = px;
    tol[P_SSPEC] = px; tol[P_SSPEC + 1] = px / 81; tol[P_SSPEC + 2] = CV_SKIP_A;
    tol[P_SHIM] = px; tol[P_SHIM + 1] = px; tol[P_SHIM + 2] = px / 112; tol[P_SHIM + 3] = CV_SKIP_A;
    tol[P_GLINT] = CV_SKIP_A; tol[P_BLOOM] = CV_SKIP_A;
    for (let b = 0; b < BUBBLES.length; b++) {
      const j = P_BUB + 4 * b;
      tol[j] = px; tol[j + 1] = px; tol[j + 2] = px; tol[j + 3] = 2 * CV_SKIP_A;  // fill alpha 0.5
    }
    for (let i = 0; i < WAVE_N; i++) { tol[P_FRONT + i] = px; tol[P_BACK + i] = px; }
    return true;
  }

  // Shared, size-keyed layer; `bake` returns a layer, null (failed: cached)
  // or undefined (an SVG bitmap still loading: retried on a later draw).
  function layerOf(name, bake) {
    let v = set.map.get(name);
    if (v === undefined) {
      v = bake();
      if (v !== undefined) {
        set.map.set(name, v);
        if (v) { stats.bakes++; _cvStats.bakes++; }
      }
    }
    return v || null;
  }
  /** An SVG bitmap resampled ONCE into a full-size layer at the canvas's
   *  scale (the SVG <image> resamples the same 240 px bitmap per raster). */
  function fromBitmap(url, px) {
    const b = svgBitmap(url, px);
    if (b.failed) return null;
    if (!b.cv) return undefined;
    const c = makeCanvas(W, H);
    const g = c.getContext("2d");
    g.imageSmoothingEnabled = true;
    g.imageSmoothingQuality = "high";
    g.setTransform(s, 0, 0, s, 0, 0);
    g.drawImage(b.cv, 0, 0, VB, VB);
    return c;
  }
  /** The fracture web: rasterized by the SVG engine on this canvas's own
   *  pixel grid (see fractureBakeUrl), so the bitmap IS the layer. */
  function fractureLayer() {
    const b = svgBitmap(fractureBakeUrl(G), W, H);
    if (b.failed) return null;
    return b.cv || undefined;
  }
  /** A full-size layer, 1:1 (it was baked on this canvas's own pixel grid). */
  function blit(g, layer) {
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(layer, 0, 0);
    g.setTransform(s, 0, 0, s, 0, 0);
  }
  function gradients(low) {
    const key = low ? "low" : "base";
    if (grad && gradKey === key) return grad;
    const t = orbTokens();
    const [aT, bT] = orbColorTokens(kind, low);
    const a = t[aT], b = t[bT];
    // Unit gradients; fillSpan() maps them onto the body's bbox.
    const f = ctx.createLinearGradient(0, 0, 0, 1);
    f.addColorStop(0, rgba(a, 1)); f.addColorStop(0.34, rgba(a, 0.92)); f.addColorStop(1, rgba(b, 1));
    const k = ctx.createLinearGradient(0, 0, 0, 1);
    k.addColorStop(0, rgba(b, 1)); k.addColorStop(1, rgba(t["hb-orb-void"], 1));
    grad = { front: f, back: k };
    gradKey = key;
    return grad;
  }
  /** Fill the current (already traced) path with a unit gradient stretched
   *  over y = top..128: the SVG objectBoundingBox gradient of a wave body. */
  function fillSpan(g, gr, top, alpha) {
    g.setTransform(s, 0, 0, s * (VB + 8 - top), 0, s * top);
    g.fillStyle = gr;
    g.globalAlpha = alpha;
    g.fill();
    g.setTransform(s, 0, 0, s, 0, 0);
    g.globalAlpha = 1;
  }

  function draw(o, frontTop, backTop) {
    const g = ctx;
    const t = orbTokens();
    const low = cur[P_LOW] === 1;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = "source-over";
    g.clearRect(0, 0, W, H);
    g.setTransform(s, 0, 0, s, 0, 0);
    const gr = gradients(low);
    g.save();
    g.beginPath(); g.arc(60, 60, 55.5, 0, CV_TAU); g.clip();
    // 1-2 the parallax back body and the front body
    traceBody(g, back, 0); fillSpan(g, gr.back, backTop, 0.85);
    traceBody(g, front, 0); fillSpan(g, gr.front, frontTop, 1);
    // 3-4 caustics (screen) and wall darkening (multiply), clipped to the
    // LIVE front wave (still the current path)
    const cau = caustics ? layerOf("caustic", () => fromBitmap(CAUSTIC_URL, BAKE_PX)) : null;
    const wall = layerOf("wall", () => BAKES.wall(G));
    g.save();
    g.clip();
    if (cau) { g.globalCompositeOperation = "screen"; blit(g, cau); }
    g.globalCompositeOperation = "multiply";
    blit(g, wall);
    g.restore();
    // mana shimmer (normal blend, blur baked; transform about the origin)
    if (kind === "mana") {
      const sp = layerOf("shimmer", () => BAKES.shimmer(G));
      const sc = cur[P_SHIM + 2];
      g.globalAlpha = cur[P_SHIM + 3];
      g.drawImage(sp.cv, cur[P_SHIM] + sc * sp.x, cur[P_SHIM + 1] + sc * sp.y, sc * sp.w, sc * sp.h);
    }
    // bubbles
    g.fillStyle = t["hb-orb-bubble"];
    for (let b = 0; b < BUBBLES.length; b++) {
      const j = P_BUB + 4 * b;
      if (!(cur[j + 3] > 0)) continue;
      g.globalAlpha = cur[j + 3];
      g.beginPath(); g.arc(cur[j], cur[j + 1], cur[j + 2], 0, CV_TAU); g.fill();
    }
    // the waterline group (.wsurf, translate(0, sy))
    const sy = cur[P_SY];
    const sg = layerOf(`subglow-${kind}-${low ? 1 : 0}`, () => BAKES.subglow(G, kind, low));
    const ss = layerOf("sspec", () => BAKES.sspec(G));
    g.globalCompositeOperation = "screen";
    g.globalAlpha = 0.5;
    g.drawImage(sg.cv, sg.x, sg.y + sy, sg.w, sg.h);
    const sx = cur[P_SSPEC + 1];
    g.globalAlpha = cur[P_SSPEC + 2];
    g.drawImage(ss.cv, cur[P_SSPEC] + sx * ss.x, ss.y + sy, sx * ss.w, ss.h);
    g.globalCompositeOperation = "source-over";
    g.globalAlpha = 0.55;
    g.strokeStyle = t["hb-orb-surface"];
    g.lineWidth = 1.2;
    g.lineJoin = "miter";
    g.lineCap = "butt";
    g.beginPath();
    g.moveTo(4, sy - 1); g.quadraticCurveTo(8.5, sy + 2.4, 13.5, sy + 2.9);
    g.moveTo(116, sy - 1); g.quadraticCurveTo(111.5, sy + 2.4, 106.5, sy + 2.9);
    g.stroke();
    // meniscus: under-shadow / surface / hairline specular, of the front path
    g.lineJoin = "round";
    g.globalAlpha = 0.75; g.strokeStyle = t["hb-orb-men-shadow"]; g.lineWidth = 3.2;
    traceBody(g, front, 1.6); g.stroke();
    g.globalAlpha = 1; g.strokeStyle = t["hb-orb-surface"]; g.lineWidth = 1.1;
    traceBody(g, front, 0); g.stroke();
    g.globalAlpha = 0.7; g.strokeStyle = t["hb-orb-men-spec"]; g.lineWidth = 0.55;
    traceBody(g, front, -0.7); g.stroke();
    // vitae ceiling
    if (o.ceiling < 1) {
      if (!vitae || vitaeKey !== o.ceiling) {
        vitae = BAKES.vitae(G, o.ceiling);
        vitaeKey = o.ceiling;
        stats.bakes++; _cvStats.bakes++;
      }
      g.globalAlpha = 1;
      blit(g, vitae);
    }
    g.restore();  // the liquid's circle clip
    // the glass plate
    const glass = layerOf("glass", () => fromBitmap(GLASS_URL, BAKE_PX));
    if (glass) blit(g, glass);
    // damage glare
    const ga = cur[P_GLARE];
    if (ga > 0) {
      g.save();
      g.globalCompositeOperation = "screen";
      g.globalAlpha = ga;
      g.fillStyle = t["hb-orb-glare"];
      g.translate(46, 40); g.rotate(-28 * DEG);
      g.beginPath(); g.ellipse(0, 0, 30, 17, 0, 0, CV_TAU); g.fill();
      g.restore();
    }
    // low-HP fracture
    if (low) {
      const fx = layerOf("fracture", fractureLayer);
      if (fx) { g.globalAlpha = 1; blit(g, fx); }
      g.globalAlpha = cur[P_GLINT];
      g.strokeStyle = t["hb-orb-crack-glint"];
      g.lineWidth = 0.9;
      g.lineCap = "round";
      tracePath(g, glintCmds()); g.stroke();
      if (!bloomGrad) {
        // #hbOrbBloom's stops resolve to BLACK in the page (see FIDELITY).
        bloomGrad = g.createRadialGradient(78, 36, 0, 78, 36, 9);
        bloomGrad.addColorStop(0, "rgba(0,0,0,0.75)");
        bloomGrad.addColorStop(1, "rgba(0,0,0,0)");
      }
      g.globalCompositeOperation = "screen";
      g.globalAlpha = cur[P_BLOOM];
      g.fillStyle = bloomGrad;
      g.beginPath(); g.arc(78, 36, 9, 0, CV_TAU); g.fill();
      g.globalCompositeOperation = "source-over";
    }
    g.globalAlpha = 1;
  }

  /** One cadence tick (or an off-cadence glare step). True if it drew. */
  function frame(o, amp, ph, now) {
    lastAmp = amp; lastPh = ph;
    if (o.group.hidden) return false;  // paused while the pane is hidden
    if ((sizeDirty || !ctx) && !resize()) return false;
    if (t0 === null) t0 = now;
    const t = frozenT !== null ? frozenT : now - t0;
    const gT = frozenGlare !== null ? frozenGlare : now - glareStart;
    cur[P_W] = W;
    cur[P_GEN] = _bakeGen;
    cur[P_LOW] = o.low ? 1 : 0;
    cur[P_CEIL] = o.ceiling;
    cur[P_GLARE] = reduced ? 0 : glareAlpha(gT);
    const frontTop = waveYs(front, o.level, ph, amp, 2.4, 0);
    const backTop = waveYs(back, o.level, -o.phase * 0.59 + o.seed * 1.9, amp * 1.2, 1.5, 5.5);
    cur.set(front, P_FRONT);
    cur.set(back, P_BACK);
    cur[P_SY] = (VB - o.level * VB) + Math.sin(ph) * amp * 0.5;
    sampleLoops(cur, t, o, kind, reduced);
    let changed = force || last === null;
    if (!changed) {
      for (let i = 0; i < NP; i++) {
        if (Math.abs(cur[i] - last[i]) > tol[i]) { changed = true; break; }
      }
    }
    if (!changed) { stats.skips++; return false; }
    force = false;
    draw(o, frontTop, backTop);
    if (!last) last = new Float64Array(NP);
    last.set(cur);
    stats.draws++;
    return true;
  }

  return {
    frame,
    /** Re-sample at `now` with the last tick's wave (glare steps). */
    redraw(o, now) { return frame(o, lastAmp, lastPh, now); },
    armGlare(now) { glareStart = now; },
    glareActive(now) {
      return !reduced && frozenGlare === null && now - glareStart >= 0 && now - glareStart < GLARE_MS;
    },
    /** resize / HUD zoom / DPR changed: re-measure (and maybe re-bake). */
    invalidateSize() { sizeDirty = true; },
    /** Parity harness: loops at `animT` ms, glare at `glareT` ms (or none). */
    freeze(animT, glareT) {
      frozenT = Number(animT) || 0;
      frozenGlare = glareT == null ? Infinity : Number(glareT);
      force = true;
    },
    /** Every SVG bitmap this vessel will draw has loaded (or failed). */
    layersSettled(low) {
      const urls = [[GLASS_URL, BAKE_PX, BAKE_PX]];
      if (caustics) urls.push([CAUSTIC_URL, BAKE_PX, BAKE_PX]);
      if (low && G) urls.push([fractureBakeUrl(G), W, H]);
      return urls.every(([u, w, h]) => { const b = svgBitmap(u, w, h); return b.failed || !!b.cv; });
    },
    destroy() { if (set) releaseLayerSet(setKey); set = null; setKey = ""; },
    get W() { return W; },
    /** Canvas (backing) px per user unit (0..120 across the core). */
    get s() { return s; },
    /** DEVICE px per user unit (what the skip tolerance is measured in). */
    get deviceScale() { return dev; },
    get stats() { return { ...stats, W, H, s: +s.toFixed(5), dev: +dev.toFixed(5), totalBakes: _cvStats.bakes }; },
  };
}

// ── the panes ────────────────────────────────────────────────────────
//
// The shared filter defs are ONE hidden zero-size SVG on <body>, not a
// copy inside each pane: `url(#hbRefract)` resolves document-wide, so
// three panes share one refraction filter between them.
// ── raster baking ────────────────────────────────────────────────────
//
// THE TRAP, measured 2026-07-28: pointing an <image> at an SVG data URL
// does NOT get you a bitmap. Blink keeps an SVG image as a PaintRecord
// and REPLAYS it on every raster, so a baked-to-SVG caustics layer still
// ran its feTurbulence + feDisplacementMap on every wave tick — the
// first attempt at this measured slightly WORSE than the live filter
// group it replaced. The bake only pays once the vector is drawn
// through a <canvas> and read back as a PNG, which is a real bitmap.
//
// 240 px covers ?orbScale= up to its 2.0 ceiling (ORB_PX 92 x 2) with
// room to spare; both rasters are shared by all three vessels.
const BAKE_PX = 240;
const bakedRaster = new Map();  // svg data url -> Promise<png data url>

function bakeRaster(svgUrl) {
  let pending = bakedRaster.get(svgUrl);
  if (pending) return pending;
  pending = new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = BAKE_PX; c.height = BAKE_PX;
        c.getContext("2d").drawImage(img, 0, 0, BAKE_PX, BAKE_PX);
        resolve(c.toDataURL("image/png"));
      } catch (_) {
        resolve(svgUrl);  // tainted / no canvas: the vector still draws
      }
    };
    img.onerror = () => resolve(svgUrl);
    img.src = svgUrl;
  });
  bakedRaster.set(svgUrl, pending);
  return pending;
}

/** Swap every vector placeholder for its baked bitmap, once. */
function bakeRasters(paneList) {
  for (const [sel, url] of [[".glassplate", GLASS_URL], [".caustics image", CAUSTIC_URL]]) {
    bakeRaster(url).then((png) => {
      if (png === url) return;
      for (const pane of paneList) {
        for (const el of pane.querySelectorAll(sel)) el.setAttribute("href", png);
      }
    }).catch(() => {});
  }
}

function ensureSharedDefs() {
  let defs = document.getElementById(DEFS_ID);
  if (defs) return defs;
  defs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  defs.id = DEFS_ID;
  defs.setAttribute("width", "0");
  defs.setAttribute("height", "0");
  defs.setAttribute("aria-hidden", "true");
  defs.style.cssText = "position:fixed;width:0;height:0;pointer-events:none";
  defs.innerHTML = `<defs>${SHARED_DEFS}</defs>`;
  document.body.appendChild(defs);
  return defs;
}

/** ?orbRender=canvas: the vessel core is one <canvas> (backing store sized
 *  per device pixel by the renderer on its first frame), CSS-sized to the
 *  92 px the <svg> occupies, so the box, the hit gate and the heartbeat on
 *  .hbo-core are unchanged. */
function orbCanvasMarkup(kind) {
  const dpr = Number(globalThis.devicePixelRatio) > 0 ? Number(globalThis.devicePixelRatio) : 1;
  const w = Math.max(8, Math.round(ORB_PX * orbScale() * dpr * cvSupersample(dpr)));
  return `<canvas class="orb-cv ${kind}" data-kind="${kind}" width="${w}" height="${w}"`
    + ` style="display:block;width:${ORB_PX}px;height:${ORB_PX}px" aria-hidden="true"></canvas>`;
}

/** One vital = one independently placed, independently persisted pane. */
function buildPane(kind, canvasMode = false) {
  const pane = document.createElement("div");
  pane.id = PANE_ID[kind];
  pane.className = "hbo-pane";
  pane.dataset.kind = kind;
  // NOT hidden yet — mount() hides it only after attachWindowPosition has
  // measured it. `hidden` is display:none, so a pane hidden at attach time
  // has a zero rect and ac_window_position's viewport clamp falls back to
  // its 300 px guess, which drags a saved position left by up to ~160 px
  // on every reload. (Caught by the persistence test: 829 -> 800.)
  const scale = orbScale();
  if (scale !== DEFAULT_SCALE) pane.style.setProperty("--hbo-scale", String(scale));
  pane.innerHTML = HERALDRY[kind]
    + `<div class="hbo-core">${canvasMode ? orbCanvasMarkup(kind) : orbSvg(kind)}</div>`
    + `<div class="orb-read" style="--hbo-read:var(--hb-orb-read-${kind})">`
    + `<div class="plate"><span class="v"></span></div></div>`;
  return pane;
}

// ── the pointer gate ─────────────────────────────────────────────────
//
// A HUD you can see the world through must also let clicks through.
// The panes are `pointer-events: none` in CSS and are flipped to `auto`
// only while the cursor is genuinely over art:
//
//   • the vessel — an analytic circle test against the glass rim, so
//     the corners of the orb's own 92×92 box are NOT part of it;
//   • the figures — a coarse alpha grid sampled once per sprite PNG at
//     mount, so the hollow between Asheron's arm and the vessel, or the
//     wide empty span the bow's 150×39 box spends being an arc, is
//     transparent to the game underneath.
//
// Nothing here reads layout on a pointermove: the pane rect and the
// per-pane geometry are cached and only re-read on resize or after a
// drag. A miss writes nothing at all (the style write is guarded on an
// actual change), so waving the mouse across the HUD is free.
const MASK_N = 32;      // alpha grid is MASK_N × MASK_N per sprite
const MASK_ALPHA = 10;  // 0-255; low, because downsampling thins strokes
const spriteMasks = new Map();  // url → {w,h,bits} | null (absent/failed)

function loadSpriteMask(url) {
  if (!url || spriteMasks.has(url)) return;
  spriteMasks.set(url, null);  // in flight; a miss until it resolves
  const img = new Image();
  img.decoding = "async";
  img.onload = () => {
    try {
      const n = MASK_N;
      const c = document.createElement("canvas");
      c.width = n; c.height = n;
      const g = c.getContext("2d", { willReadFrequently: true });
      g.drawImage(img, 0, 0, n, n);
      const d = g.getImageData(0, 0, n, n).data;
      const raw = new Uint8Array(n * n);
      for (let i = 0; i < n * n; i++) raw[i] = d[i * 4 + 3] > MASK_ALPHA ? 1 : 0;
      // One cell of dilation: a silhouette you have to hit dead-on is
      // worse than one that is a pixel generous.
      const bits = new Uint8Array(n * n);
      for (let y = 0; y < n; y++) {
        for (let x = 0; x < n; x++) {
          let on = 0;
          for (let j = -1; j <= 1 && !on; j++) {
            for (let i = -1; i <= 1 && !on; i++) {
              const yy = y + j, xx = x + i;
              if (yy >= 0 && yy < n && xx >= 0 && xx < n && raw[yy * n + xx]) on = 1;
            }
          }
          bits[y * n + x] = on;
        }
      }
      spriteMasks.set(url, { n, bits });
    } catch (_) { spriteMasks.set(url, null); }
  };
  img.onerror = () => { spriteMasks.set(url, null); };
  img.src = url;
}

// The masks are wanted before the first pointermove, not on the first
// hit test — otherwise the very first grab at a figure misses while the
// PNG decodes. Kicked off at mount; the panes are still hidden then, so
// this is the only place the sprite list has to be named in JS.
const SPRITE_FILES = ["asheron.png", "baelzharon-se.png", "composite-bow.png"];
function preloadSpriteMasks() {
  for (const f of SPRITE_FILES) {
    try { loadSpriteMask(new URL("./data/orb-sprites/" + f, document.baseURI).href); }
    catch (_) { /* exotic base URL — the lazy path in measure() still runs */ }
  }
}

function figUrl(el) {
  const m = /url\(["']?(.*?)["']?\)/.exec(getComputedStyle(el).backgroundImage || "");
  return m ? m[1] : null;
}

function installHitGate(paneList) {
  const recs = paneList.map((el) => ({ el, rect: null, geo: null, on: false }));
  let dragging = false;

  function measure(r) {
    const el = r.el;
    if (el.hidden || !el.offsetWidth) return null;
    const core = el.querySelector(".hbo-core");
    if (!core) return null;
    const scale = parseFloat(getComputedStyle(el).getPropertyValue("--hbo-scale"))
                  || DEFAULT_SCALE;
    const figs = [...el.querySelectorAll(".fig")].map((f) => {
      const url = figUrl(f);
      loadSpriteMask(url);
      return { x: f.offsetLeft, y: f.offsetTop, w: f.offsetWidth, h: f.offsetHeight, url };
    });
    // The plaque is opaque art, so unlike the sprites it needs no alpha
    // grid — its own box IS the silhouette. Included so the badge drags
    // by its sign, which is the part of it that looks most like a handle.
    const read = el.querySelector(".orb-read");
    return {
      scale,
      cx: core.offsetLeft + core.offsetWidth / 2,
      cy: core.offsetTop + core.offsetHeight / 2,
      // the outermost glass rim is r=58.8 of the 0..120 viewBox
      cr: (58.8 / VB) * core.offsetWidth,
      plaque: read && read.offsetWidth
        ? { x: read.offsetLeft, y: read.offsetTop,
            w: read.offsetWidth, h: read.offsetHeight }
        : null,
      figs,
    };
  }

  function hits(r, px, py) {
    if (r.el.hidden) { r.geo = null; r.rect = null; return false; }
    if (!r.geo) r.geo = measure(r);
    if (!r.geo) return false;
    if (!r.rect) r.rect = r.el.getBoundingClientRect();
    const g = r.geo;
    // HUD overhaul 2026-10-05 — the pane sits inside the HUD's CSS zoom
    // (ui/hud_scale.js): pointer + rect are screen px, the measured
    // geometry is the pane's own px, so divide by both scales.
    const z = Number(r.el.currentCSSZoom) > 0 ? Number(r.el.currentCSSZoom) : 1;
    const x = (px - r.rect.left) / (g.scale * z);
    const y = (py - r.rect.top) / (g.scale * z);
    if (x < 0 || y < 0 || x > PANE_W || y > PANE_H) return false;
    const dx = x - g.cx, dy = y - g.cy;
    if (dx * dx + dy * dy <= g.cr * g.cr) return true;
    const q = g.plaque;
    if (q && x >= q.x && y >= q.y && x < q.x + q.w && y < q.y + q.h) return true;
    for (const f of g.figs) {
      if (!f.w || x < f.x || y < f.y || x >= f.x + f.w || y >= f.y + f.h) continue;
      const m = spriteMasks.get(f.url);
      if (!m) continue;
      const gx = Math.min(m.n - 1, ((x - f.x) / f.w * m.n) | 0);
      const gy = Math.min(m.n - 1, ((y - f.y) / f.h * m.n) | 0);
      if (m.bits[gy * m.n + gx]) return true;
    }
    return false;
  }

  const onMove = (ev) => {
    if (dragging) return;  // never yank pointer-events out from under a capture
    for (const r of recs) {
      const on = hits(r, ev.clientX, ev.clientY);
      if (on === r.on) continue;
      r.on = on;
      r.el.style.pointerEvents = on ? "auto" : "none";
      r.el.classList.toggle("hbo-drag", on);
    }
  };
  const onDown = (ev) => {
    if (ev.target?.closest?.(".hbo-pane")) dragging = true;
  };
  const onUp = () => {
    if (!dragging) return;
    dragging = false;
    for (const r of recs) r.rect = null;  // it may have just moved
  };
  const onResize = () => { for (const r of recs) { r.rect = null; r.geo = null; } };

  document.addEventListener("pointermove", onMove, { passive: true, capture: true });
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("pointerup", onUp, true);
  document.addEventListener("pointercancel", onUp, true);
  window.addEventListener("resize", onResize);
  document.addEventListener("hb-hud-scale-changed", onResize);

  // Exposed for the headless tests: "is (x, y) over art?" without a
  // synthetic pointer event.
  installHitGate.probe = (x, y) => recs.map((r) => hits(r, x, y));

  return () => {
    document.removeEventListener("pointermove", onMove, { capture: true });
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("pointercancel", onUp, true);
    window.removeEventListener("resize", onResize);
    document.removeEventListener("hb-hud-scale-changed", onResize);
    installHitGate.probe = null;
  };
}

/** The wire + animation state every orb record carries, in both modes. */
function orbAnimState(kind, i) {
  return {
    // wire state
    base: 0,
    current: null,
    buffedMax: 0,
    ceiling: 1,
    // animation state
    level: 0,
    levelTarget: 0,
    impulse: 0,
    phase: 0,
    seed: i * 1.37,
    baseAmp: kind === "hp" ? 1.6 : 1.5,
    baseSpd: 1.0,
    lastNums: null,
    lastRise: null,
    low: false,
    glareTimer: 0,
  };
}

/** Per-orb mutable state + the DOM refs the driver writes to.
 *  `panes` is the kind → pane element map built by mount().
 *  `canvasOpts` (?orbRender=canvas) swaps the SVG refs for a Canvas2D vessel. */
function collectOrbs(panes, canvasOpts = null) {
  const orbs = [];
  KINDS.forEach((kind, i) => {
    const group = panes[kind];
    if (canvasOpts) {
      const core = group.querySelector(".hbo-core");
      orbs.push({
        kind, type: TYPE_BY_KIND[kind], group, core,
        svg: null, liquid: null, back: null, body: null, clip: null, men: [],
        surf: null, surfXform: null, vitae: null, fx: null,
        num: group.querySelector(".orb-read .v"),
        cv: createCanvasVessel(kind, core.querySelector("canvas.orb-cv"), group, { ...canvasOpts, core }),
        ...orbAnimState(kind, i),
      });
      return;
    }
    const svg = group.querySelector("svg.orb");
    svg.classList.add(kind);
    const liquid = svg.querySelector(".liquid");
    const surf = liquid.querySelector(".wsurf");
    // One SVGTransform, created once and mutated in place by the driver
    // (see PERF item 1 in tick()). `createSVGTransform` must come off an
    // <svg> element; the list then owns the object.
    let surfXform = null;
    if (surf) {
      const list = surf.transform.baseVal;
      list.clear();
      surfXform = svg.createSVGTransform();
      surfXform.setTranslate(0, 0);
      list.appendItem(surfXform);
    }
    orbs.push({
      kind,
      type: TYPE_BY_KIND[kind],
      group,
      svg,
      core: group.querySelector(".hbo-core"),
      liquid,
      back: liquid.querySelector(".w-back"),
      body: liquid.querySelector(".w-front"),
      // The caustics clipPath lives in the SVG's <defs>, i.e. OUTSIDE
      // .liquid — querying it off the group silently returns null and
      // the caustics never draw (the bug the concept card shipped with
      // for a build; see agentG-report §2).
      clip: svg.querySelector("defs .w-clip"),
      men: [...liquid.querySelectorAll(".men")],
      surf,
      surfXform,
      vitae: liquid.querySelector(".hbo-vitae"),
      fx: svg.querySelector(".hbo-fx"),
      num: group.querySelector(".orb-read .v"),
      ...orbAnimState(kind, i),
    });
  });
  return orbs;
}

// ── per-orb updates ──────────────────────────────────────────────────
//
// `impulseMag` is |Δ| / buffedMax — the fraction of the vessel that just
// moved. A 25% hit therefore sloshes four times harder than a 6% regen
// tick, which is what makes the orb read as a gauge you can feel.
function applyVital(orb, current, buffedMax, base, oldValue, driver) {
  if (Number.isFinite(base) && base > 0) orb.base = base;
  orb.current = current;
  orb.buffedMax = buffedMax;

  // Vitae: the wire packs [type, current, base, buffedMax]. A buffedMax
  // BELOW base is the vitae penalty — the vessel can only ever fill to
  // buffedMax/base of its height, and the dead space above that line is
  // dimmed, hatched and scummed.
  const ceiling = (orb.base > 0 && buffedMax > 0 && buffedMax < orb.base)
    ? Math.max(0, Math.min(1, buffedMax / orb.base))
    : 1;
  if (ceiling !== orb.ceiling) {
    orb.ceiling = ceiling;
    if (orb.vitae) {
      if (ceiling < 1) {
        const cy = VB - ceiling * VB;
        orb.vitae.setAttribute("transform", `translate(0,${(cy - VITAE_CY0).toFixed(2)})`);
        orb.vitae.style.display = "";
      } else {
        orb.vitae.style.display = "none";
      }
    }
  }

  const frac = buffedMax > 0 ? Math.max(0, Math.min(1, current / buffedMax)) : 0;
  orb.levelTarget = frac * ceiling;

  // Bubbles rise to the waterline, not to a fixed height.
  const rise = -Math.max(8, orb.levelTarget * VB - 18);
  const riseStr = `${rise.toFixed(0)}px`;
  if (orb.lastRise !== riseStr) {
    // (canvas: no .liquid; the vessel samples hbo-bub with orb.lastRise)
    if (orb.liquid) orb.liquid.style.setProperty("--rise", riseStr);
    orb.lastRise = riseStr;
  }

  const nums = `${current} / ${buffedMax}`;
  if (orb.lastNums !== nums) {
    orb.num.textContent = nums;
    orb.lastNums = nums;
  }

  if (Number.isFinite(oldValue) && oldValue !== current && buffedMax > 0) {
    const mag = Math.abs(current - oldValue) / buffedMax;
    orb.impulse = Math.max(orb.impulse, Math.min(1, mag * 4.5));
    // Damage ONLY gets the glass-glare flicker — a heal that lit the
    // glass would read as another hit.
    if (current < oldValue && mag > 0.01) armGlare(orb);
  }

  if (orb.kind === "hp") applyLowState(orb, frac, driver);
  driver?.start();
}

function armGlare(orb) {
  // ?orbRender=canvas: the flicker is sampled from hbo-glare's keyframes on
  // the timeline clock — no class, no forced style recalc, no timer.
  if (orb.cv) { orb.cv.armGlare(clockNow()); return; }
  orb.svg.classList.remove("glaring");
  // Force a style recalc so the one-shot keyframe restarts. This is the
  // single place the plugin touches layout, and only on a damage event.
  void orb.svg.getBoundingClientRect().width;
  orb.svg.classList.add("glaring");
  if (orb.glareTimer) clearTimeout(orb.glareTimer);
  orb.glareTimer = setTimeout(() => {
    orb.svg.classList.remove("glaring");
    orb.glareTimer = 0;
  }, GLARE_MS);
}

function applyLowState(orb, frac, driver) {
  const low = frac > 0 && frac < LOW_HP_FRAC;
  if (low === orb.low) return;
  orb.low = low;
  // ?hudDiet=orbSync: `.beat` and the fracture glints / bloom start or stop.
  driver?.invalidateAnims?.();
  // (canvas: no <svg>; the vessel reads orb.low for its colour band + web)
  if (orb.svg) orb.svg.classList.toggle("low", low);
  orb.core.classList.toggle("beat", low);
  // The fracture web is ~120 path nodes; build it the first time it is
  // actually needed rather than shipping it in every session's DOM.
  if (low && orb.fx && !orb.fx.childElementCount) orb.fx.innerHTML = FRACTURE_SVG;
  if (orb.fx) orb.fx.style.display = low ? "" : "none";
  // A low-HP vessel churns even without a fresh hit.
  orb.baseAmp = low ? 3.2 : 1.6;
  orb.baseSpd = low ? 2.2 : 1.0;
}

export const manifest = {
  id: "vitals-orbs",
  name: "Vitals Orbs",
  // No bar icon — the overlay IS the presentation, same as vitals-hud.
  icon: "🔮",
  iconHidden: true,
  version: "0.1.0",
  description: "Empyrean Relief vitals orbs (?vitalsOrbs=on; replaces the bars)",
};

export function mount(ctx) {
  // Strict opt-in. When absent the plugin costs one URLSearchParams
  // read and nothing else — no DOM, no styles, no rAF.
  if (!isVitalsOrbsActive()) return () => {};

  // R3-2 HUD diet levers (ui/hud_diet.js; default off), read once per mount.
  const dietSync = hudDietOn("orbSync");
  ensureStyles({ orbLayer: hudDietOn("orbLayer") });
  // ?orbRender (default canvas; `=svg` escape): Canvas2D vessel cores need no
  // shared SVG <defs> (the fracture bake carries its own #hbRefract) and no
  // <image> bake swap; the stylesheet is the same text in both modes.
  const canvasMode = orbRenderMode() === "canvas";
  if (!canvasMode) ensureSharedDefs();
  preloadSpriteMasks();

  const panes = {};
  const paneList = [];
  for (const kind of KINDS) {
    const old = document.getElementById(PANE_ID[kind]);
    if (old) old.remove();
    const pane = buildPane(kind, canvasMode);
    document.body.appendChild(pane);
    // The pane IS its own drag handle — see hitGate() below, which only
    // lets a pointer reach it when it is over visible art, so "drag it
    // by the orb or by Asheron" works without a titlebar and without a
    // rectangle of dead space that swallows clicks meant for the world.
    attachWindowPosition(pane, {
      windowId: PANE_WINDOW_ID[kind],
      dragHandle: pane,
      defaultPos: DEFAULT_POS[kind],
    });
    pane.hidden = true;  // see buildPane: measured first, then hidden
    panes[kind] = pane;
    paneList.push(pane);
  }
  // ?hudDiet=orbSync: a pane that is shown or hidden starts or cancels its
  // loops, so a CHANGE re-collects them (the getter only runs with the diet on).
  const setHidden = (h) => {
    let changed = false;
    for (const p of paneList) {
      if (dietSync && p.hidden !== h) changed = true;
      p.hidden = h;
    }
    if (changed) driver.invalidateAnims();
    // ?orbRender=canvas: the loop stops while every pane is hidden.
    if (canvasMode && !h) driver.start();
  };

  const reduceQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  const reduced = !!reduceQuery?.matches;
  const orbs = collectOrbs(panes, canvasMode ? { reduced, caustics: causticsEnabled() } : null);
  const byType = new Map(orbs.map((o) => [o.type, o]));
  const stopHitGate = installHitGate(paneList);
  if (!canvasMode) bakeRasters(paneList);

  const driver = createDriver(orbs, reduced, orbHz(), paneList);
  // Paint the still frame immediately so the vessels are never empty
  // rectangles for a frame, then hand over to the loop.
  driver.still();
  driver.start();

  // ?orbRender=canvas: the backing store follows device pixels, so a window
  // resize, a HUD-scale change or a DPR change (browser zoom, another
  // monitor) re-measures each vessel on its next frame — and re-bakes its
  // static layers only if its size actually changed. (Position never
  // matters: the canvas box is the core box.)
  let stopSizeWatch = null;
  if (canvasMode) {
    let mq = null;
    const invalidate = () => {
      for (const o of orbs) o.cv.invalidateSize();
      driver.start();
    };
    const onDpr = () => { invalidate(); watchDpr(); };
    const watchDpr = () => {
      try {
        mq?.removeEventListener?.("change", onDpr);
        mq = window.matchMedia?.(`(resolution: ${Number(window.devicePixelRatio) || 1}dppx)`) ?? null;
        mq?.addEventListener?.("change", onDpr);
      } catch (_) { mq = null; }
    };
    watchDpr();
    window.addEventListener("resize", invalidate);
    document.addEventListener("hb-hud-scale-changed", invalidate);
    stopSizeWatch = () => {
      window.removeEventListener("resize", invalidate);
      document.removeEventListener("hb-hud-scale-changed", invalidate);
      try { mq?.removeEventListener?.("change", onDpr); } catch (_) {}
      for (const o of orbs) o.cv.destroy();
    };
  }

  const onVisibility = () => {
    if (document.hidden) driver.pause();
    else driver.start();
  };
  document.addEventListener("visibilitychange", onVisibility);

  // Full snapshot (kind=8). Wire layout matches vitals-hud.js's
  // renderVitals: `[type, current, base, buffed_max] × N`.
  function renderVitals(vitals) {
    if (!vitals || vitals.length === 0) {
      setHidden(true);
      return;
    }
    for (let i = 0; i + 3 < vitals.length; i += 4) {
      const orb = byType.get(vitals[i]);
      if (!orb) continue;
      applyVital(orb, vitals[i + 1], vitals[i + 3], vitals[i + 2], undefined, driver);
    }
    setHidden(false);
  }

  let pollTimer = null;
  let unsubscribe = null;

  function tryHook() {
    const client = ctx?.client ?? window.__pluginClient ?? null;
    if (!client?.events?.on || !client?.player) return false;

    const render = () => {
      try {
        renderVitals(client.player.stats?.vitals);
      } catch (_) {
        // Stats accessor throws before the player biota lands — stay
        // hidden until the next event, same contract as vitals-hud.
        setHidden(true);
      }
    };
    client.events.on("playerStatsUpdated", render);

    // Per-vital fast path (kind=42/43/44). These carry current /
    // buffedMax / oldValue but NOT base, so `orb.base` keeps whatever
    // the last kind=8 snapshot established — which is exactly what the
    // vitae ceiling needs.
    const perVital = (type) => (e) => {
      const orb = byType.get(type);
      if (!orb) return;
      applyVital(orb, e.detail?.current ?? 0, e.detail?.buffedMax ?? 0,
                 undefined, e.detail?.oldValue, driver);
      if (paneList[0].hidden) setHidden(false);
    };
    const onHealth = perVital(1);
    const onStamina = perVital(3);
    const onMana = perVital(5);
    client.events.on("vitalChangedHealth", onHealth);
    client.events.on("vitalChangedStamina", onStamina);
    client.events.on("vitalChangedMana", onMana);

    const onSharedCooldown = (e) => {
      const active = ((e?.activeCount ?? e?.detail?.activeCount) ?? 0) >>> 0;
      for (const p of paneList) p.dataset.cooldownActive = active > 0 ? "1" : "0";
    };
    client.events.on("sharedCooldownChanged", onSharedCooldown);

    unsubscribe = () => {
      client.events.off("playerStatsUpdated", render);
      client.events.off("vitalChangedHealth", onHealth);
      client.events.off("vitalChangedStamina", onStamina);
      client.events.off("vitalChangedMana", onMana);
      client.events.off("sharedCooldownChanged", onSharedCooldown);
    };
    render();
    return true;
  }

  if (!tryHook()) {
    if (typeof window !== "undefined" && window.__pluginClientReady?.then) {
      window.__pluginClientReady.then(() => { tryHook(); });
    } else {
      pollTimer = setInterval(() => {
        if (tryHook()) { clearInterval(pollTimer); pollTimer = null; }
      }, 500);
    }
  }

  // Diagnostics surface — lets a headless agent assert fill levels and
  // slosh state without screenshotting, and lets the eye test preview
  // the low-HP fracture / vitae ceiling without actually dying.
  //   __diag.vitalsOrbs.poke("hp", 37, 312, 312)        // low-HP web
  //   __diag.vitalsOrbs.poke("hp", 265, 265, 312)       // 15% vitae
  //   __diag.vitalsOrbs.poke("hp", 137, 312, 312, 218)  // a 26% hit
  // `poke` is presentation-only — it never touches the wire, and the
  // next real vitals event overwrites whatever it set.
  try {
    window.__diag = window.__diag || {};
    window.__diag.vitalsOrbs = {
      running: () => driver.running,
      // Which pane ids exist, and where they sit — the split-pane test
      // hook (each pane persists its own position under its own key).
      panes: () => paneList.map((p) => ({
        id: p.id, hidden: p.hidden,
        left: p.style.left, top: p.style.top,
        pointerEvents: getComputedStyle(p).pointerEvents,
      })),
      // "would a click at (x, y) land on the HUD or go to the world?"
      hitAt: (x, y) => (installHitGate.probe ? installHitGate.probe(x, y) : null),
      // EMA of the shared rAF's JS self-time, in ms per frame.
      tickMs: () => +driver.tickMs.toFixed(4),
      frames: () => driver.frames,
      // ?orbAnimSync: CSS loops currently sampled at the orb cadence.
      animSynced: () => driver.animSynced,
      state: () => orbs.map((o) => ({
        kind: o.kind, current: o.current, buffedMax: o.buffedMax, base: o.base,
        ceiling: o.ceiling, level: +o.level.toFixed(4), target: +o.levelTarget.toFixed(4),
        impulse: +o.impulse.toFixed(4), low: o.low,
      })),
      poke: (kind, current, buffedMax, base, oldValue) => {
        const orb = orbs.find((o) => o.kind === kind);
        if (!orb) return false;
        applyVital(orb, current, buffedMax, base, oldValue, driver);
        setHidden(false);
        return true;
      },
      // ?orbRender: which vessel renderer this mount drew with.
      renderMode: () => (canvasMode ? "canvas" : "svg"),
      // ?orbRender=canvas: per vessel draws / skipped ticks / bakes / size.
      canvasStats: () => (canvasMode ? orbs.map((o) => ({ kind: o.kind, ...o.cv.stats })) : null),
      // Parity harness (harness/glsl_smoke/orb_canvas_parity_*): stop the
      // loop for good, put every orb at its target level, wave phase `phase`,
      // slosh `impulse`, the ambient loops at `animT` ms and (if given) the
      // damage glare `glareT` ms in, and paint that one frame — the SVG
      // vessel by pausing its CSS animations at those times, the canvas one
      // by sampling the same keyframes there. Unmount to resume.
      freeze: ({ phase = 0, impulse = 0, animT = 0, glareT = null } = {}) => {
        driver.hold();
        for (const o of orbs) {
          o.level = o.levelTarget; o.phase = phase; o.impulse = impulse;
          if (canvasMode) o.cv.freeze(animT, glareT);
          else if (glareT != null) {
            armGlare(o);
            if (o.glareTimer) { clearTimeout(o.glareTimer); o.glareTimer = 0; }
          }
        }
        driver.still();
        // Every CSS animation still on the page side (SVG: the ambient loops
        // + glare; both modes: the low-HP heartbeat on .hbo-core) is pinned
        // at the same times, so the two renderers are compared at one phase.
        for (const p of paneList) {
          let anims = [];
          try { anims = p.getAnimations?.({ subtree: true }) ?? []; } catch (_) {}
          for (const a of anims) {
            try {
              const finite = a.effect?.getTiming?.().iterations !== Infinity;
              a.pause();
              a.currentTime = finite ? (glareT ?? 0) : animT;
            } catch (_) {}
          }
        }
        return true;
      },
      // Resolves once the static rasters this renderer draws have landed.
      bakeReady: () => {
        if (!canvasMode) {
          return Promise.all([bakeRaster(GLASS_URL), bakeRaster(CAUSTIC_URL)]).then(() => true);
        }
        return new Promise((resolve) => {
          const t0 = Date.now();
          const poll = () => {
            if (orbs.every((o) => o.cv.layersSettled(o.low)) || Date.now() - t0 > 10000) resolve(true);
            else setTimeout(poll, 20);
          };
          poll();
        });
      },
    };
  } catch (_) {}

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    if (unsubscribe) unsubscribe();
    document.removeEventListener("visibilitychange", onVisibility);
    for (const o of orbs) if (o.glareTimer) clearTimeout(o.glareTimer);
    driver.stop();
    if (stopSizeWatch) stopSizeWatch();
    stopHitGate();
    try { delete window.__diag?.vitalsOrbs; } catch (_) {}
    for (const p of paneList) p.remove();
    document.getElementById(DEFS_ID)?.remove();
  };
}
