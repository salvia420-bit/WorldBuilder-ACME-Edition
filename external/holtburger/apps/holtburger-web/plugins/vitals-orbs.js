// "Empyrean Relief" — the accepted vitals-orb concept, live.
//
// Three liquid vessels (blood-red health, yellow-bile stamina, blue
// mana with a portal-purple shimmer) composed as heraldic badges:
// each vital is one impresa with supporters flanking and a charge
// balancing across the vessel, all standing on a shared plinth.
//
//   health   Asheron (supporter, dexter)       + Atlan sword (charge, sinister)
//   stamina  two slithis tendrils (supporters) + composite bow (charge, in base)
//   mana     weeping wand (charge, dexter)     + Bael'Zharon (supporter, sinister)
//
// The figures are real DAT Setup renders carrying their own Surface
// colours, baked to PNG and shipped under `data/orb-sprites/`. Panel
// order health / stamina / mana puts Asheron at the far left and
// Bael'Zharon at the far right, so the panel itself gains supporters.
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
// (the orb circle, tested analytically; the figure sprites, tested
// against a coarse alpha grid sampled from their PNGs at mount). A
// half-transparent HUD that still eats clicks over the world is exactly
// what this revision exists to remove.
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

import { attachWindowPosition, WINDOW_ID } from "../ui/ac_window_position.js";

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
// Both are exact-match reads. `vitalsOrbs` is the opt-in; `orbCaustics`
// is an ESCAPE from a default-on sub-feature, so it is the one flag
// here allowed to read `=== "off"` for its negative.
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
  return urlParam("vitalsOrbs") === "on";
}

/** Caustics are the priciest layer (two feTurbulence + one
 *  feDisplacementMap, evaluated whenever the clipped region repaints).
 *  Default ON; `?orbCaustics=off` omits the group entirely. */
function causticsEnabled() {
  return urlParam("orbCaustics") !== "off";
}

// Wave updates run at a CADENCE, not at vsync. Every wave write dirties
// an SVG subtree wrapped in blurs, blends and (optionally) a turbulence
// filter, so the render pipeline cost scales linearly with this number.
// 30 Hz is indistinguishable from 60 for a liquid surface and halves the
// style/layout/paint/raster the orbs charge the frame. `?orbHz=N`.
function orbHz() {
  const v = parseFloat(urlParam("orbHz") ?? "");
  return Number.isFinite(v) && v >= 5 && v <= 120 ? v : DEFAULT_HZ;
}

function orbScale() {
  const v = parseFloat(urlParam("orbScale") ?? "");
  return Number.isFinite(v) && v > 0.2 && v <= 2 ? v : DEFAULT_SCALE;
}

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

// One vessel. `--orb-a` / `--orb-b` are set per kind on the <svg> so the
// low-HP variant is a two-token CSS override rather than a rebuild.
function orbSvg(kind) {
  // Three bubbles, not the card's five: each is a running CSS animation
  // on a non-compositable SVG node, i.e. a style recalc every vsync.
  const bubbles = [[38, 2.1, 8.5, 0], [62, 1.5, 6.4, -2.4], [80, 2.6, 10.2, -5.1]]
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

// The heraldry around each vessel — supporters, charges, aureole, glow.
const HERALDRY = {
  hp: '<div class="hbo-glow g-hp"></div>'
    + '<div class="aureole r g-hp"></div>'
    + '<div class="fig fig-asheron sup-l"></div>'
    + '<div class="fig fig-sword chg-r front"></div>',
  stam: '<div class="hbo-glow g-stam"></div>'
    + '<div class="fig fig-tent-l tent l"></div>'
    + '<div class="fig fig-tent-r tent r front"></div>'
    + '<div class="fig fig-bow"></div>',
  mana: '<div class="hbo-glow g-mana"></div>'
    + '<div class="aureole l g-mana"></div>'
    + '<div class="fig fig-wand chg-l front"></div>'
    + '<div class="fig fig-bael sup-r"></div>',
};

// ── stylesheet ───────────────────────────────────────────────────────
// Every rule is scoped under #hb-vitals-orbs so the new --hb-orb-* /
// --hb-badge-* tokens never leak onto :root and collide with the rest
// of the HUD. The base --hb-* palette tokens are inherited from
// index.html's :root block, exactly as the concept card assumed.
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
  --hbo-inv: calc(1 / var(--hbo-scale));
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
  --hb-orb-read-hp: #f0b8b0;
  --hb-orb-read-stam: #f0dca8;
  --hb-orb-read-mana: #b8cdf4;
  /* The figures are no longer knocked back behind a lit stone panel —
     there is no panel — so the grading is just a hair of desaturation
     plus a shadow that separates them from the world behind. */
  --hb-badge-fig-filter: saturate(0.95) contrast(1.04);
  --hb-badge-fig-shadow: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.85))
                         drop-shadow(0 0 2px rgba(0, 0, 0, 0.6));
  --hb-badge-aureole: 0.13;
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
  position: absolute; left: 50%; bottom: 28px; margin-left: -${ORB_PX / 2}px;
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
  position: absolute; bottom: 38px; z-index: 2; pointer-events: none;
  background-repeat: no-repeat; background-size: contain;
  background-position: bottom center;
  filter: var(--hb-badge-fig-filter) var(--hb-badge-fig-shadow);
}
${P} .fig.front { z-index: 5; }
${P} .fig-asheron { background-image: url("./data/orb-sprites/asheron.png");       width: 54.3px; height: 116px; }
${P} .fig-bael    { background-image: url("./data/orb-sprites/baelzharon-se.png"); width: 65.9px; height: 98px; }
${P} .fig-tent-l  { background-image: url("./data/orb-sprites/tentacle-l.png");    width: 46.3px; height: 78px; }
${P} .fig-tent-r  { background-image: url("./data/orb-sprites/tentacle-r.png");    width: 46.3px; height: 78px; }
${P} .fig-sword   { background-image: url("./data/orb-sprites/atlan-sword.png");   width: 15.6px; height: 124px; }
${P} .fig-wand    { background-image: url("./data/orb-sprites/weeping-wand.png");  width: 18.2px; height: 120px; }
${P} .fig-bow     { background-image: url("./data/orb-sprites/composite-bow.png"); width: 150px;  height: 38.8px; }

/* placement — the plinth is gone with the rest of the panel chrome, but
   its line (bottom:38px) is kept as the common ground the supporters
   and charges stand on, so the heraldry reads exactly as the card. */
${P} .sup-l { left: 10px; }
${P} .sup-r { right: 6px; }
${P} .chg-l { left: 26px; }
${P} .chg-r { right: 26px; }
/* the weapons are planted, so they cant slightly outward */
${P} .fig-sword.chg-r { transform: rotate(7deg); transform-origin: 50% 100%; }
${P} .fig-wand.chg-l { transform: rotate(-7deg); transform-origin: 50% 100%; }
/* the bow lies in base, arced under the vessel, cradling it; its
   recurved tips rise just inside the tendrils so the charges nest */
${P} .fig-bow { left: 50%; bottom: 31px; margin-left: -75px; z-index: 5; }
/* tendrils grip the lower quadrants, thick end rooted low, thin tip
   sweeping UP and INWARD. Splayed outward they read as spider legs —
   which is what killed the first pass; the sprite's whip tip was
   morphologically opened away, and -r is a pre-mirrored PNG so the CSS
   never has to compose scaleX(-1) with a rotation origin. */
${P} .tent { bottom: 36px; }
${P} .tent.l { left: 1px; transform: rotate(-6deg); }
${P} .tent.r { right: 1px; transform: rotate(6deg); }

/* an aureole behind a lone charge — just enough veiled mass for a slim
   weapon to answer a whole figure across the vessel. Kept very low: at
   any real opacity it stops being a halo and becomes a coloured panel.
   PERF: painted as a radial-gradient rather than a blurred solid, so it
   is a plain background instead of a filter layer per pane. */
${P} .aureole {
  position: absolute; bottom: 46px; width: 78px; height: 122px; z-index: 1;
  opacity: var(--hb-badge-aureole);
}
${P} .aureole.r { right: -3px; }
${P} .aureole.l { left: -3px; }
/* Also the only thing that seats the badge against a BRIGHT sky: the
   colour reads as the vital's humour, and the dark core under it keeps
   the vessel from dissolving into a white background. */
${P} .hbo-glow {
  position: absolute; left: 50%; bottom: 34px; width: 168px; height: 116px;
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

/* ── readout ─────────────────────────────────────────────────────────
   The vital NAME is gone; the liquid colour identifies the orb, so only
   the number is left and it carries a tint of its humour.

   With the stone panel removed the number has to hold up over ANY world
   pixel — a night sky and a noon sky in the same session — so it is
   painted twice: a thick dark -webkit-text-stroke laid down FIRST by a
   ::before clone (z-index:-1 puts it behind the fill; paint-order is
   an SVG property and is not dependable for HTML text), then the tinted
   fill on top, then a tight multi-layer shadow to soften the transition
   into whatever is behind. Sizes are divided back out of --hbo-scale so
   the glyphs land at a constant on-screen size whatever ?orbScale= is.
   Judged from screenshots over a night sky and over bare noon sky. */
${P} .orb-read {
  position: absolute; left: 0; right: 0; bottom: 2px; z-index: 6;
  text-align: center; font-family: var(--hb-font-serif);
  pointer-events: none;
}
${P} .orb-read .v {
  position: relative; display: inline-block;
  font-size: calc(13.5px * var(--hbo-inv));
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
  color: var(--hbo-read, var(--hb-text-cream-bright));
  text-shadow:
    0 0 calc(2px * var(--hbo-inv)) rgba(0, 0, 0, 0.95),
    0 calc(1px * var(--hbo-inv)) calc(2px * var(--hbo-inv)) rgba(0, 0, 0, 0.95),
    0 0 calc(7px * var(--hbo-inv)) rgba(0, 0, 0, 0.75);
}
${P} .orb-read .v::before {
  content: attr(data-v);
  position: absolute; left: 0; top: 0; z-index: -1;
  color: transparent;
  -webkit-text-stroke: calc(2.8px * var(--hbo-inv)) rgba(0, 0, 0, 0.88);
}

@media (prefers-reduced-motion: reduce) {
  ${P} .orb *, ${P} .hbo-core { animation: none !important; }
}
`;
}

function ensureStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = styleText();
  document.head.appendChild(style);
}

// ── the shared animation driver ──────────────────────────────────────
//
// ONE rAF for the whole overlay. `orbs` are plain records — no DOM
// reads happen in the loop, only attribute writes, so nothing here can
// force a layout. Stopped entirely under prefers-reduced-motion and
// while the tab is hidden.
function createDriver(orbs, reducedMotion, hz) {
  // STEP 6 (21 samples across 120 units) instead of the card's 4: at HUD
  // scale the extra samples are invisible and every one of them is
  // geometry the SVG layout has to re-measure on all five paths.
  const W = VB, H = VB, STEP = 6, TAU = 6.283185307;
  const minStep = hz > 0 ? 1 / hz - 0.002 : 0;  // −2 ms so 30 Hz isn't 20 Hz
  let raf = 0;
  let last = 0;
  let acc = 0;
  let clock = 0;
  let stopped = false;

  // Two summed sines (2.7:1) instead of one: a single sine reads as a
  // drawn squiggle, a beat of two reads as water.
  function wave(level, phase, amp, freq, dy) {
    const y0 = H - level * H + dy;
    let d = "";
    for (let x = 0; x <= W; x += STEP) {
      const u = x / W;
      const y = y0 + Math.sin(u * freq * TAU + phase) * amp
                   + Math.sin(u * freq * 2.7 * TAU - phase * 1.63) * amp * 0.3;
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

  function frame(t) {
    raf = 0;
    if (stopped) return;
    const dt = last ? Math.min(0.1, (t - last) / 1000) : 0;
    last = t;
    acc += dt;
    raf = requestAnimationFrame(frame);
    // Skip the write entirely on off-cadence vsync ticks: no attribute
    // is touched, so Blink schedules no style/layout/paint for us.
    if (acc < minStep) return;
    clock += acc;
    const t0 = performance.now();
    tick(clock, acc);
    tickMs += (performance.now() - t0 - tickMs) * 0.05;  // EMA
    acc = 0;
    frames++;
  }

  return {
    /** Paint one still frame — the reduced-motion and first-paint path. */
    still() { tick(0, 0); },
    start() {
      if (stopped || reducedMotion || raf || document.hidden) return;
      last = 0;
      acc = minStep;  // paint the first cadence step immediately
      raf = requestAnimationFrame(frame);
    },
    pause() {
      if (raf) { cancelAnimationFrame(raf); raf = 0; }
    },
    stop() {
      stopped = true;
      this.pause();
    },
    get running() { return raf !== 0; },
    get tickMs() { return tickMs; },
    get frames() { return frames; },
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

/** One vital = one independently placed, independently persisted pane. */
function buildPane(kind) {
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
    + `<div class="hbo-core">${orbSvg(kind)}</div>`
    + `<div class="orb-read" style="--hbo-read:var(--hb-orb-read-${kind})">`
    + `<span class="v" data-v=""></span></div>`;
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
const SPRITE_FILES = ["asheron.png", "baelzharon-se.png", "tentacle-l.png",
  "tentacle-r.png", "atlan-sword.png", "weeping-wand.png", "composite-bow.png"];
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
    return {
      scale,
      cx: core.offsetLeft + core.offsetWidth / 2,
      cy: core.offsetTop + core.offsetHeight / 2,
      // the outermost glass rim is r=58.8 of the 0..120 viewBox
      cr: (58.8 / VB) * core.offsetWidth,
      figs,
    };
  }

  function hits(r, px, py) {
    if (r.el.hidden) { r.geo = null; r.rect = null; return false; }
    if (!r.geo) r.geo = measure(r);
    if (!r.geo) return false;
    if (!r.rect) r.rect = r.el.getBoundingClientRect();
    const g = r.geo;
    const x = (px - r.rect.left) / g.scale;
    const y = (py - r.rect.top) / g.scale;
    if (x < 0 || y < 0 || x > PANE_W || y > PANE_H) return false;
    const dx = x - g.cx, dy = y - g.cy;
    if (dx * dx + dy * dy <= g.cr * g.cr) return true;
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

  // Exposed for the headless tests: "is (x, y) over art?" without a
  // synthetic pointer event.
  installHitGate.probe = (x, y) => recs.map((r) => hits(r, x, y));

  return () => {
    document.removeEventListener("pointermove", onMove, { capture: true });
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("pointerup", onUp, true);
    document.removeEventListener("pointercancel", onUp, true);
    window.removeEventListener("resize", onResize);
    installHitGate.probe = null;
  };
}

/** Per-orb mutable state + the DOM refs the driver writes to.
 *  `panes` is the kind → pane element map built by mount(). */
function collectOrbs(panes) {
  const orbs = [];
  KINDS.forEach((kind, i) => {
    const group = panes[kind];
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
    orb.liquid.style.setProperty("--rise", riseStr);
    orb.lastRise = riseStr;
  }

  const nums = `${current} / ${buffedMax}`;
  if (orb.lastNums !== nums) {
    orb.num.textContent = nums;
    // The ::before clone that lays down the dark stroke reads this.
    orb.num.dataset.v = nums;
    orb.lastNums = nums;
  }

  if (Number.isFinite(oldValue) && oldValue !== current && buffedMax > 0) {
    const mag = Math.abs(current - oldValue) / buffedMax;
    orb.impulse = Math.max(orb.impulse, Math.min(1, mag * 4.5));
    // Damage ONLY gets the glass-glare flicker — a heal that lit the
    // glass would read as another hit.
    if (current < oldValue && mag > 0.01) armGlare(orb);
  }

  if (orb.kind === "hp") applyLowState(orb, frac);
  driver?.start();
}

function armGlare(orb) {
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

function applyLowState(orb, frac) {
  const low = frac > 0 && frac < LOW_HP_FRAC;
  if (low === orb.low) return;
  orb.low = low;
  orb.svg.classList.toggle("low", low);
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

  ensureStyles();
  ensureSharedDefs();
  preloadSpriteMasks();

  const panes = {};
  const paneList = [];
  for (const kind of KINDS) {
    const old = document.getElementById(PANE_ID[kind]);
    if (old) old.remove();
    const pane = buildPane(kind);
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
  const setHidden = (h) => { for (const p of paneList) p.hidden = h; };

  const orbs = collectOrbs(panes);
  const byType = new Map(orbs.map((o) => [o.type, o]));
  const stopHitGate = installHitGate(paneList);
  bakeRasters(paneList);

  const reduceQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)") ?? null;
  const reduced = !!reduceQuery?.matches;
  const driver = createDriver(orbs, reduced, orbHz());
  // Paint the still frame immediately so the vessels are never empty
  // rectangles for a frame, then hand over to the loop.
  driver.still();
  driver.start();

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
    };
  } catch (_) {}

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    if (unsubscribe) unsubscribe();
    document.removeEventListener("visibilitychange", onVisibility);
    for (const o of orbs) if (o.glareTimer) clearTimeout(o.glareTimer);
    driver.stop();
    stopHitGate();
    try { delete window.__diag?.vitalsOrbs; } catch (_) {}
    for (const p of paneList) p.remove();
    document.getElementById(DEFS_ID)?.remove();
  };
}
