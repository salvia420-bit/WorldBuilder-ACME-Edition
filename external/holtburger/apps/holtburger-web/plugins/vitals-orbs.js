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
// === Perf === (measured, see scratchpad/agentH-report.md)
// ONE rAF drives every wave phase, meniscus and liquid clip path on the
// page, at a 30 Hz CADENCE rather than at vsync (`?orbHz=N`). It is not
// started under `prefers-reduced-motion` (a single still frame is
// painted instead) and is cancelled while the tab is hidden. Only `d`
// and `transform` attributes and CSS custom properties are written —
// no layout is ever read, and the panel is `contain`-ed so the
// invalidation cannot escape it.
//
// THE ONE THING NOT TO UNDO: the concept card drove the caustic
// `feTurbulence baseFrequency` from its rAF. Re-evaluating a fractal-
// noise field every frame — or animating a transform on the FILTERED
// group, which has the same effect — measured a hard 60 → 44 fps cliff
// on this laptop. The noise here is STATIC and cacheable; the caustics
// appear to crawl because they are clipped to the live wave path.
// Even so the orbs are ~4.4 ms/frame of render pipeline against the
// bars' ~0.1 ms: this is a rich HUD, and `?orbCaustics=off` /
// `?orbHz=15` / `?orbScale=` are the levers if that is too much.

import { attachDefaultTopDragHandle, WINDOW_ID } from "../ui/ac_window_position.js";

const OVERLAY_ID = "hb-vitals-orbs";
const STYLE_ID = "hb-vitals-orbs-style";

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
// The badge panel is authored at the concept card's 1:1 px scale (618×226)
// and scaled as ONE unit, so every heraldic offset below stays a card
// value. 0.72 lands it at ~445×163 in the bars' top-left region — it
// clears buffs-hud (top 40, left 32) and the top-right radar.
const DEFAULT_SCALE = 0.72;
const DEFAULT_HZ = 30;

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
<filter id="hbOrbCaustic" x="-12%" y="-12%" width="124%" height="124%"
        color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="0.021 0.052"
                numOctaves="2" seed="7" result="n"/>
  <feDisplacementMap in="SourceGraphic" in2="n" scale="11"
                     xChannelSelector="R" yChannelSelector="G"/>
  <feGaussianBlur stdDeviation="0.8"/>
</filter>
<filter id="hbOrbSheen" x="-5%" y="-5%" width="110%" height="110%"
        color-interpolation-filters="sRGB">
  <feTurbulence type="fractalNoise" baseFrequency="0.045 0.09"
                numOctaves="2" seed="19" result="n"/>
  <feColorMatrix in="n" type="matrix" result="a"
    values="0 0 0 0 1  0 0 0 0 1  0 0 0 0 1  0.9 0 0 0 -0.28"/>
  <feComposite in="a" in2="SourceGraphic" operator="in"/>
  <feGaussianBlur stdDeviation="0.6"/>
</filter>
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

  const rip = causticsEnabled() ? `<g class="caustics" clip-path="url(#lqc-${kind})">
<ellipse class="pool" cx="60" cy="106" rx="34" ry="9"/>
<g filter="url(#hbOrbCaustic)"><path class="rip" stroke-width="1.9" d="M18 74 Q34 67 52 75"/><path class="rip" stroke-width="1.3" d="M64 82 Q80 74 99 83"/><path class="rip" stroke-width="1.2" d="M26 97 Q42 90 58 98"/><path class="rip" stroke-width="1.0" d="M70 62 Q84 55 100 63"/><path class="rip" stroke-width="0.9" d="M12 88 Q22 83 33 89"/><path class="rip" stroke-width="1.5" d="M74 104 Q88 98 101 105"/></g>
<rect class="sheen" x="4" y="30" width="112" height="86" filter="url(#hbOrbSheen)"/>
</g>` : "";

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
<radialGradient id="gl-${kind}" cx="0.34" cy="0.26" r="0.80">
<stop offset="0" stop-color="#fff" stop-opacity="0.26"/>
<stop offset="0.42" stop-color="#fff" stop-opacity="0.04"/>
<stop offset="0.86" stop-color="#000" stop-opacity="0.16"/>
<stop offset="1" stop-color="#000" stop-opacity="0.5"/></radialGradient>
<linearGradient id="col-${kind}" x1="0" y1="0" x2="0.6" y2="1">
<stop offset="0" style="stop-color:var(--hb-orb-collar-hi)"/>
<stop offset="0.45" style="stop-color:var(--hb-orb-collar)"/>
<stop offset="1" style="stop-color:var(--hb-orb-collar-deep)"/></linearGradient>
</defs>
<circle cx="60" cy="60" r="55.5" fill="var(--hb-orb-void)"/>
<g class="liquid" clip-path="url(#c-${kind})" style="--rise:-60px">
<path class="w-back" fill="url(#lqb-${kind})" opacity="0.85" d=""/>
<path class="w-front" fill="url(#lq-${kind})" d=""/>
${rip}
<circle class="lqwall" cx="60" cy="60" r="55.5" fill="url(#wal-${kind})" clip-path="url(#lqc-${kind})"/>
${shimmer}${bubbles}
<g class="wsurf">
<ellipse class="bounce" cx="60" cy="-17" rx="40" ry="13" fill="url(#sub-${kind})"/>
<ellipse class="subglow" cx="60" cy="11" rx="46" ry="11" fill="url(#sub-${kind})"/>
<ellipse class="sspec" cx="52" cy="1.5" rx="21" ry="2.2"/>
<path class="men-wall" d="M4 -1 q4.5 3.4 9.5 3.9"/>
<path class="men-wall" d="M116 -1 q-4.5 3.4 -9.5 3.9"/>
</g>
<path class="men men-sh" d=""/><path class="men men-hi" d=""/><path class="men men-sp" d=""/>
${vitaeGroup(kind)}
</g>
<circle cx="60" cy="60" r="55.5" fill="url(#gl-${kind})"/>
<ellipse class="spec" cx="42" cy="33" rx="16" ry="10" transform="rotate(-24 42 33)"/>
<ellipse class="spec-2" cx="80" cy="88" rx="12" ry="5" transform="rotate(-18 80 88)"/>
<ellipse class="glare" cx="46" cy="40" rx="30" ry="17" transform="rotate(-28 46 40)"/>
<circle class="rim-inner" cx="60" cy="60" r="54.2"/>
<g class="hbo-fx"></g>
<circle cx="60" cy="60" r="57.5" fill="none" stroke="url(#col-${kind})" stroke-width="5.5"/>
<circle class="rim-thin" cx="60" cy="60" r="60.6" stroke-width="1"/>
</svg>`;
}

// The heraldry around each vessel — supporters, charges, aureole, glow.
const HERALDRY = {
  hp: '<div class="hbo-glow g-hp"></div>'
    + '<div class="aureole r" style="background:var(--hb-orb-hp)"></div>'
    + '<div class="fig fig-asheron sup-l"></div>'
    + '<div class="fig fig-sword chg-r front"></div>',
  stam: '<div class="hbo-glow g-stam"></div>'
    + '<div class="fig fig-tent-l tent l"></div>'
    + '<div class="fig fig-tent-r tent r front"></div>'
    + '<div class="fig fig-bow"></div>',
  mana: '<div class="hbo-glow g-mana"></div>'
    + '<div class="aureole l" style="background:var(--hb-orb-mana)"></div>'
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
#${OVERLAY_ID} {
  position: fixed;
  top: 6px;
  left: 260px;
  z-index: 50;
  pointer-events: none;
  /* the badge panel is authored at the card's 1:1 px scale and then
     scaled as a unit — every offset below is a card value, unchanged.
     Keep in sync with DEFAULT_SCALE. */
  --hbo-scale: 0.72;
  width: calc(618px * var(--hbo-scale));
  height: calc(226px * var(--hbo-scale));

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
  --hb-orb-vitae-dim: rgba(0, 0, 0, 0.5);
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
  --hb-badge-fig-filter: saturate(0.92) brightness(0.94) contrast(1.06);
  --hb-badge-fig-shadow: drop-shadow(0 3px 4px rgba(0, 0, 0, 0.75));
  --hb-badge-aureole: 0.13;
  --hb-badge-plinth-top: #4a412a;
  --hb-badge-plinth-bottom: #221d12;
}
#${OVERLAY_ID}[hidden] { display: none; }
#${OVERLAY_ID} .hbo-defs { position: absolute; width: 0; height: 0; }

#${OVERLAY_ID} .hbo-panel {
  transform: scale(var(--hbo-scale));
  transform-origin: top left;
  /* The wave writes dirty a subtree full of blurs and blend modes.
     CSS containment walls that invalidation into this box so the rest
     of the HUD (and the canvas' own compositing) is never re-examined.
     No will-change here: promoting the panel MEASURED WORSE (extra
     Layerize/Commit every frame for a subtree that is repainted, not
     transformed). (No backticks in this stylesheet — template literal.) */
  contain: layout paint style;
  display: flex; gap: 2px; align-items: flex-end; padding: 12px;
  width: 594px;
  box-sizing: content-box;
  background: linear-gradient(180deg, var(--hb-bg-stone-top) 0%, var(--hb-bg-stone-bottom) 100%);
  border: 1px solid var(--hb-border-brass-deep);
  border-radius: var(--hb-radius-panel);
  box-shadow: var(--hb-shadow-panel), inset 0 1px 0 var(--hb-edge-light);
  overflow: hidden;
}
#${OVERLAY_ID} .hbo-group {
  position: relative; width: 196px; height: 168px;
  display: flex; justify-content: center; align-items: flex-end;
}
#${OVERLAY_ID} .hbo-core { position: relative; z-index: 4; }

/* supporters and charges are DAT setup renders in their own DAT
   colours; the only grading is a light knock-back so they sit behind
   the gauge. Extracted from the concept card into data/orb-sprites/. */
#${OVERLAY_ID} .fig {
  position: absolute; bottom: 38px; z-index: 2; pointer-events: none;
  background-repeat: no-repeat; background-size: contain;
  background-position: bottom center;
  filter: var(--hb-badge-fig-filter) var(--hb-badge-fig-shadow);
}
#${OVERLAY_ID} .fig.front { z-index: 5; }
#${OVERLAY_ID} .fig-asheron { background-image: url("./data/orb-sprites/asheron.png");       width: 54.3px; height: 116px; }
#${OVERLAY_ID} .fig-bael    { background-image: url("./data/orb-sprites/baelzharon-se.png"); width: 65.9px; height: 98px; }
#${OVERLAY_ID} .fig-tent-l  { background-image: url("./data/orb-sprites/tentacle-l.png");    width: 46.3px; height: 78px; }
#${OVERLAY_ID} .fig-tent-r  { background-image: url("./data/orb-sprites/tentacle-r.png");    width: 46.3px; height: 78px; }
#${OVERLAY_ID} .fig-sword   { background-image: url("./data/orb-sprites/atlan-sword.png");   width: 15.6px; height: 124px; }
#${OVERLAY_ID} .fig-wand    { background-image: url("./data/orb-sprites/weeping-wand.png");  width: 18.2px; height: 120px; }
#${OVERLAY_ID} .fig-bow     { background-image: url("./data/orb-sprites/composite-bow.png"); width: 150px;  height: 38.8px; }

/* placement — supporters and charges stand ON the plinth line
   (bottom:38px == plinth top) so nothing floats. */
#${OVERLAY_ID} .sup-l { left: 10px; }
#${OVERLAY_ID} .sup-r { right: 6px; }
#${OVERLAY_ID} .chg-l { left: 26px; }
#${OVERLAY_ID} .chg-r { right: 26px; }
/* the weapons are planted, so they cant slightly outward off the plinth */
#${OVERLAY_ID} .fig-sword.chg-r { transform: rotate(7deg); transform-origin: 50% 100%; }
#${OVERLAY_ID} .fig-wand.chg-l { transform: rotate(-7deg); transform-origin: 50% 100%; }
/* the bow lies in base, arced under the vessel, cradling it; its
   recurved tips rise just inside the tendrils so the charges nest */
#${OVERLAY_ID} .fig-bow { left: 50%; bottom: 31px; margin-left: -75px; z-index: 5; }
/* tendrils grip the lower quadrants, thick end rooted on the plinth,
   thin tip sweeping UP and INWARD. Splayed outward they read as spider
   legs — which is what killed the first pass; the sprite's whip tip was
   morphologically opened away, and -r is a pre-mirrored PNG so the CSS
   never has to compose scaleX(-1) with a rotation origin. */
#${OVERLAY_ID} .tent { bottom: 36px; }
#${OVERLAY_ID} .tent.l { left: 1px; transform: rotate(-6deg); }
#${OVERLAY_ID} .tent.r { right: 1px; transform: rotate(6deg); }

/* an aureole behind a lone charge — just enough veiled mass for a slim
   weapon to answer a whole figure across the vessel. Kept very low: at
   any real opacity it stops being a halo and becomes a coloured panel. */
#${OVERLAY_ID} .aureole {
  position: absolute; bottom: 46px; width: 52px; height: 96px; z-index: 1;
  border-radius: 50%; filter: blur(17px); opacity: var(--hb-badge-aureole);
}
#${OVERLAY_ID} .aureole.r { right: 10px; }
#${OVERLAY_ID} .aureole.l { left: 10px; }
#${OVERLAY_ID} .hbo-glow {
  position: absolute; left: 50%; bottom: 46px; width: 130px; height: 84px;
  transform: translateX(-50%); border-radius: 50%; z-index: 0;
  filter: blur(24px); opacity: 0.10;
}
#${OVERLAY_ID} .g-hp { background: var(--hb-orb-hp); }
#${OVERLAY_ID} .g-stam { background: var(--hb-orb-stam); }
#${OVERLAY_ID} .g-mana { background: var(--hb-orb-mana); }
#${OVERLAY_ID} .hbo-plinth {
  position: absolute; left: 50%; bottom: 30px; width: 178px; height: 8px;
  transform: translateX(-50%); z-index: 3;
  background: linear-gradient(180deg, var(--hb-badge-plinth-top) 0%,
              var(--hb-badge-plinth-bottom) 100%);
  border-top: 1px solid var(--hb-edge-light);
  border-radius: 1px;
}

/* ── orb engine ─────────────────────────────────────────────────────
   Only the wavy TOP edge of each closed wave path can draw: the bottom
   and side edges of the path fall outside the clip circle. */
#${OVERLAY_ID} .orb { display: block; overflow: visible; }
#${OVERLAY_ID} .orb.hp   { --orb-a: var(--hb-orb-hp);   --orb-b: var(--hb-orb-hp-deep); }
#${OVERLAY_ID} .orb.hp.low { --orb-a: var(--hb-orb-hp-low); --orb-b: var(--hb-orb-hp-low-deep); }
#${OVERLAY_ID} .orb.stam { --orb-a: var(--hb-orb-stam); --orb-b: var(--hb-orb-stam-deep); }
#${OVERLAY_ID} .orb.mana { --orb-a: var(--hb-orb-mana); --orb-b: var(--hb-orb-mana-deep); }
#${OVERLAY_ID} .orb .rim-thin { fill: none; stroke: var(--hb-orb-collar); stroke-width: 1.4; opacity: 0.85; }
#${OVERLAY_ID} .orb .rim-inner { fill: none; stroke: #000; stroke-width: 3; opacity: 0.55; }
#${OVERLAY_ID} .orb .spec { fill: var(--hb-orb-glass-spec); opacity: 0.5; filter: blur(2.2px); }
#${OVERLAY_ID} .orb .spec-2 { fill: var(--hb-orb-glass-spec-soft); filter: blur(2px); opacity: 0.5; }

/* meniscus — three strokes of one path. The dark one sits BELOW the
   waterline (light is absorbed just under the surface), the bright one
   on it, the hairline specular just above it. */
#${OVERLAY_ID} .orb .men { fill: none; stroke-linejoin: round; }
#${OVERLAY_ID} .orb .men-sh { stroke: var(--hb-orb-men-shadow); stroke-width: 3.2; opacity: 0.75; transform: translateY(1.6px); }
#${OVERLAY_ID} .orb .men-hi { stroke: var(--hb-orb-surface); stroke-width: 1.1; }
#${OVERLAY_ID} .orb .men-sp { stroke: var(--hb-orb-men-spec); stroke-width: 0.55; opacity: 0.7; transform: translateY(-0.7px); }
#${OVERLAY_ID} .orb .men-wall { fill: none; stroke: var(--hb-orb-surface); stroke-width: 1.2; opacity: 0.55; }

/* subsurface scattering under the surface, and the coloured light that
   bounces back OFF the liquid onto the dome above it — the tell that
   the empty half is glass and not a hole */
#${OVERLAY_ID} .orb .subglow { filter: blur(6px); mix-blend-mode: screen; opacity: 0.5; }
#${OVERLAY_ID} .orb .bounce { filter: blur(9px); mix-blend-mode: screen; opacity: 0.4; }
/* the liquid is optically thicker toward the glass wall, so it goes
   darker there; this is what stops the body reading as flat poster colour */
#${OVERLAY_ID} .orb .lqwall { mix-blend-mode: multiply; }
#${OVERLAY_ID} .orb .sspec {
  fill: var(--hb-orb-men-spec); filter: blur(2.6px); mix-blend-mode: screen;
  opacity: 0.4; animation: hbo-sspec 9s ease-in-out infinite;
}
@keyframes hbo-sspec {
  0%, 100% { transform: translate(-9px, 0) scaleX(0.86); opacity: 0.26; }
  50%      { transform: translate(11px, 0) scaleX(1.14); opacity: 0.5; }
}
#${OVERLAY_ID} .orb .caustics { mix-blend-mode: screen; }
#${OVERLAY_ID} .orb .rip { fill: none; stroke: var(--hb-orb-caustic); stroke-linecap: round; opacity: 0.32; }
/* MEASURED REGRESSION, do not re-add: animating a transform on the
   FILTERED group (or the filter's own baseFrequency) re-evaluates the
   fractal-noise field every vsync — a 60→44 fps cliff on this laptop.
   The caustics are static geometry; their apparent crawl comes from the
   live wave path they are clipped to, which moves at the orb cadence. */
#${OVERLAY_ID} .orb .pool { fill: var(--hb-orb-caustic); filter: blur(7px); opacity: 0.26; }
#${OVERLAY_ID} .orb .sheen { fill: var(--hb-orb-caustic); mix-blend-mode: screen; opacity: 0.12; }

#${OVERLAY_ID} .orb .bub { fill: var(--hb-orb-bubble); animation: hbo-bub var(--bd, 7s) linear infinite; }
@keyframes hbo-bub {
  0%   { transform: translateY(0) scale(0.7); opacity: 0; }
  12%  { opacity: 0.55; }
  85%  { opacity: 0.4; }
  100% { transform: translateY(var(--rise, -60px)) scale(1.05); opacity: 0; }
}
#${OVERLAY_ID} .orb .shimmer {
  fill: var(--hb-orb-mana-shimmer); opacity: 0.3; filter: blur(6px);
  animation: hbo-shimmer 7.5s ease-in-out infinite;
}
@keyframes hbo-shimmer {
  0%, 100% { transform: translate(-8px, 4px) scale(1); opacity: 0.16; }
  50%      { transform: translate(10px, -6px) scale(1.25); opacity: 0.4; }
}

/* vitae ceiling — a fill ceiling the liquid cannot rise past */
#${OVERLAY_ID} .orb .vitae-dim { fill: var(--hb-orb-vitae-dim); }
#${OVERLAY_ID} .orb .vitae-scum-band { fill: var(--hb-orb-vitae-scum); opacity: 0.4; }
#${OVERLAY_ID} .orb .vitae-grime { fill: none; stroke: var(--hb-orb-vitae-scum); stroke-width: 1.6; opacity: 0.95; }
#${OVERLAY_ID} .orb .vitae-grime-dots { fill: var(--hb-orb-vitae-scum); opacity: 0.75; }

/* damage glare flicker — one cycle, armed by the .glaring class */
#${OVERLAY_ID} .orb .glare { fill: var(--hb-orb-glare); opacity: 0; mix-blend-mode: screen; }
#${OVERLAY_ID} .orb.glaring .glare { animation: hbo-glare 1.15s steps(1, end) 1; }
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
#${OVERLAY_ID} .orb .fx-dark {
  fill: none; stroke: var(--hb-orb-crack-dark); stroke-linecap: round;
  opacity: 0.85; transform: translate(0.9px, 1.1px);
}
#${OVERLAY_ID} .orb .fx-refract {
  fill: none; stroke: var(--hb-orb-crack-refract); stroke-linecap: round;
  opacity: 0.34; filter: url(#hbRefract);
}
#${OVERLAY_ID} .orb .fx-main { fill: none; stroke: var(--hb-orb-crack); stroke-linecap: round; }
#${OVERLAY_ID} .orb .fx-shard { fill: var(--hb-orb-crack); opacity: 0.16; stroke: none; }
#${OVERLAY_ID} .orb .fx-glint {
  fill: none; stroke: var(--hb-orb-crack-glint); stroke-linecap: round;
  stroke-width: 0.9; opacity: 0; animation: hbo-glint 3.6s ease-in-out infinite;
}
#${OVERLAY_ID} .orb .fx-glint:nth-of-type(2) { animation-delay: -1.2s; }
#${OVERLAY_ID} .orb .fx-glint:nth-of-type(3) { animation-delay: -2.4s; }
#${OVERLAY_ID} .orb .fx-glint:nth-of-type(4) { animation-delay: -0.6s; }
@keyframes hbo-glint { 0%, 72%, 100% { opacity: 0.06; } 84% { opacity: 0.95; } }
#${OVERLAY_ID} .orb .fx-bloom { mix-blend-mode: screen; animation: hbo-bloom 3.6s ease-in-out infinite; }
@keyframes hbo-bloom { 0%, 100% { opacity: 0.35; } 50% { opacity: 0.7; } }

/* heartbeat — applied to the orb wrapper on low HP */
#${OVERLAY_ID} .hbo-core.beat { animation: hbo-beat 1.15s ease-out infinite; transform-origin: 50% 50%; }
@keyframes hbo-beat {
  0%   { transform: scale(1); filter: drop-shadow(0 0 0 rgba(200, 24, 30, 0)); }
  8%   { transform: scale(1.045); filter: drop-shadow(0 0 9px rgba(200, 24, 30, 0.75)); }
  16%  { transform: scale(1.005); }
  26%  { transform: scale(1.03); filter: drop-shadow(0 0 6px rgba(200, 24, 30, 0.5)); }
  45%, 100% { transform: scale(1); filter: drop-shadow(0 0 0 rgba(200, 24, 30, 0)); }
}

/* readout — the vital NAME is gone; the liquid colour identifies the
   orb, so only the number is left and it carries a tint of its humour */
#${OVERLAY_ID} .orb-read { text-align: center; margin-top: 12px; font-family: var(--hb-font-serif); }
#${OVERLAY_ID} .orb-read .v {
  display: block; font-size: 12.5px; font-variant-numeric: tabular-nums;
  color: var(--hbo-read, var(--hb-text-cream-bright));
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.95);
}

@media (prefers-reduced-motion: reduce) {
  #${OVERLAY_ID} .orb *, #${OVERLAY_ID} .hbo-core { animation: none !important; }
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
      if (o.surf) {
        const sy = (H - o.level * H) + Math.sin(ph) * amp * 0.5;
        o.surf.setAttribute("transform", "translate(0," + sy.toFixed(2) + ")");
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

// ── the overlay ──────────────────────────────────────────────────────
function buildOverlay() {
  const overlay = document.createElement("div");
  overlay.id = OVERLAY_ID;
  overlay.hidden = true;
  const scale = orbScale();
  if (scale !== DEFAULT_SCALE) overlay.style.setProperty("--hbo-scale", String(scale));

  const defs = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  defs.setAttribute("class", "hbo-defs");
  defs.setAttribute("width", "0");
  defs.setAttribute("height", "0");
  defs.setAttribute("aria-hidden", "true");
  defs.innerHTML = `<defs>${SHARED_DEFS}</defs>`;
  overlay.appendChild(defs);

  const panel = document.createElement("div");
  panel.className = "hbo-panel";
  panel.innerHTML = KINDS.map((kind) =>
    `<div class="hbo-group" data-kind="${kind}">${HERALDRY[kind]}`
    + `<div class="hbo-plinth"></div>`
    + `<div class="hbo-core">${orbSvg(kind)}`
    + `<div class="orb-read" style="--hbo-read:var(--hb-orb-read-${kind})"><span class="v"></span></div>`
    + `</div></div>`).join("");
  overlay.appendChild(panel);
  return overlay;
}

/** Per-orb mutable state + the DOM refs the driver writes to. */
function collectOrbs(overlay) {
  const orbs = [];
  KINDS.forEach((kind, i) => {
    const group = overlay.querySelector(`.hbo-group[data-kind="${kind}"]`);
    const svg = group.querySelector("svg.orb");
    svg.classList.add(kind);
    const liquid = svg.querySelector(".liquid");
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
      surf: liquid.querySelector(".wsurf"),
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
  const existing = document.getElementById(OVERLAY_ID);
  if (existing) existing.remove();
  const overlay = buildOverlay();
  document.body.appendChild(overlay);
  attachDefaultTopDragHandle(overlay, WINDOW_ID.VITALS_ORBS);

  const orbs = collectOrbs(overlay);
  const byType = new Map(orbs.map((o) => [o.type, o]));

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
      overlay.hidden = true;
      return;
    }
    for (let i = 0; i + 3 < vitals.length; i += 4) {
      const orb = byType.get(vitals[i]);
      if (!orb) continue;
      applyVital(orb, vitals[i + 1], vitals[i + 3], vitals[i + 2], undefined, driver);
    }
    overlay.hidden = false;
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
        overlay.hidden = true;
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
      if (overlay.hidden) overlay.hidden = false;
    };
    const onHealth = perVital(1);
    const onStamina = perVital(3);
    const onMana = perVital(5);
    client.events.on("vitalChangedHealth", onHealth);
    client.events.on("vitalChangedStamina", onStamina);
    client.events.on("vitalChangedMana", onMana);

    const onSharedCooldown = (e) => {
      const active = ((e?.activeCount ?? e?.detail?.activeCount) ?? 0) >>> 0;
      overlay.dataset.cooldownActive = active > 0 ? "1" : "0";
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
        overlay.hidden = false;
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
    try { delete window.__diag?.vitalsOrbs; } catch (_) {}
    overlay.remove();
  };
}
