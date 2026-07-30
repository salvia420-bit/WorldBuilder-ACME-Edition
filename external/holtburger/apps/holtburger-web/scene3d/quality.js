// Phase X.1 — Quality preset system.
//
// Single user-facing knob (`?quality=low|mid|high|ultra`) controlling
// every visual-fidelity toggle in the renderer. Individual features
// retain per-feature URL overrides (e.g. `?quality=mid&pom=on`) for
// A/B testing during development.
//
// Source of truth for the preset table is `docs/quality-presets.md`.
// If you change the table here, update the doc and vice versa.
//
// Consumed at scene init by `scene3d/index.js`. Each phase that gates
// on quality reads its flag from `liveScene3d.quality` directly; this
// module does not import from any renderer subsystem so it can be
// loaded in isolation (Node test harness, devtools console).

// Preset table. Keys are the four supported quality tiers; values are
// flat boolean/number bags consumed by per-phase gating code. Adding a
// new feature flag means: (a) add it here with sensible defaults
// across all four tiers, (b) document it in `docs/quality-presets.md`,
// (c) read it from `liveScene3d.quality[<flag>]` at the phase's gate.
export const PRESETS = {
    low: {
        antialias: false,
        shadows: false,
        // Wave 2.B (2026-05-28): procedural normal maps off on `low`.
        // Saves +texture memory and sampler bandwidth on integrated /
        // mobile GPUs where the Sobel-derived bumps don't visibly beat
        // 2026-07-30: flipped ON. Measured on a GTX 1070 at Dryreach,
        // quality=mid, 400 frames/arm — normal maps + statNra + texBc7 together
        // ran 35.2 ms median / 28.4 fps against 36.7 / 27.2 for the bare
        // default, i.e. no cost to pay for. `?normalMaps=off` is the escape.
        normalMaps: true,
        detailFlag: false,
        terrainDetailNormal: false,
        triplanar: false,
        triplanarSlopeThresholdPct: 100,
        // Anisotropic texture filtering cap (1 = isotropic / off). Driven into
        // setAdapterMaxAnisotropy at scene init and capped by the GPU max. Kept
        // OFF on `low` for integrated/mobile/swiftshader perf-worker GPUs.
        anisotropy: 1,
        subdivLevel: 1,
        // Geometry relief (gfx_remodel.rs OP1 — texture-blind convex-edge
        // rails) — see docs/url-flags.md `gfxRelief`.
        // DEFAULT-ON since 2026-07-30 after the 1070 eye-test: chamfer caps on
        // hard convex edges give AC's razor-sharp building corners a lit
        // transition band, so beams read as having thickness instead of being
        // painted on. `?gfxRelief=off` is the escape (the resolver in
        // scene3d/gfx_relief.js matches "on"/"off" EXACTLY and falls through to
        // this preset otherwise; it stays out of BOOL_FLAGS so parseBool cannot
        // widen it to "1"/"true"/"yes").
        // The operation is PURELY ADDITIVE — no existing vertex moves, no draw
        // call is added (rails inherit their parent's surface subset), and the
        // model gate leaves ~87% of GfxObjs byte-identical.
        // `low`: still off — added tris are paid TWICE at any tier with shadows
        // and low is the tier that exists to not pay.
        gfxRelief: false,
        gfxSubdivLevel: 0,
        gfxReliefScale: 0.6,
        hero: false,
        pom: false,
        pomStepsPrimary: 0,
        pomStepsSelfShadow: 0,
        csm: false,
        bloom: false,
        vignette: false,
        lensFlare: false,
        lightShafts: false,
        maxParticlesPerEmitter: 64,
    },
    mid: {
        antialias: true,
        shadows: true,
        // Wave 2.B (2026-05-28) turned these off on `mid`: the +texture memory
        // and per-fragment normal-map work were measured to cost more FPS than
        // the visual delta returned. RE-MEASURED 2026-07-30 on a GTX 1070 and
        // that no longer holds — with texBc7 also on, the compressed textures
        // cut enough bandwidth that the everything-on arm was FASTER (35.2 ms
        // median / 28.4 fps vs 36.7 / 27.2). `?normalMaps=off` is the escape.
        normalMaps: true,
        detailFlag: true,
        terrainDetailNormal: true,
        triplanar: true,
        triplanarSlopeThresholdPct: 60,
        // Anisotropic filtering — moderate on mid-tier to keep grazing-angle
        // terrain/road textures from smearing without the full 16× cost.
        anisotropy: 4,
        subdivLevel: 2,
        // 1 = 4x tris on world models. Shadows are ~half the GPU cost at
        // quality=high and are the ONLY vertex-stage-bound pass, so mid/high
        // both stop at 4x; 16x is an `ultra` opt-in.
        gfxRelief: true,
        gfxSubdivLevel: 1,
        gfxReliefScale: 1.0,
        hero: false,
        pom: false,
        pomStepsPrimary: 8,
        pomStepsSelfShadow: 4,
        csm: false,
        bloom: true,
        vignette: false,
        lensFlare: false,
        lightShafts: false,
        maxParticlesPerEmitter: 256,
    },
    high: {
        antialias: true,
        shadows: true,
        normalMaps: true,
        detailFlag: true,
        terrainDetailNormal: true,
        triplanar: true,
        triplanarSlopeThresholdPct: 30,
        // Full anisotropic filtering on high+ (capped by the GPU max in
        // index.js). Restores retail-sharp terrain/road textures at grazing
        // angles — the prior global `setAdapterMaxAnisotropy(1)` smeared them.
        anisotropy: 16,
        subdivLevel: 4,
        gfxRelief: true,
        gfxSubdivLevel: 1,
        gfxReliefScale: 1.0,
        hero: true,
        pom: true,
        pomStepsPrimary: 16,
        pomStepsSelfShadow: 8,
        csm: true,
        bloom: true,
        vignette: true,
        lensFlare: false,
        lightShafts: true,
        maxParticlesPerEmitter: 1024,
    },
    ultra: {
        antialias: true,
        shadows: true,
        normalMaps: true,
        detailFlag: true,
        terrainDetailNormal: true,
        triplanar: true,
        triplanarSlopeThresholdPct: 30,
        anisotropy: 16,
        subdivLevel: 8,
        // 2 = 16x tris. `ultra` is never auto-selected (see detectGpuTier), so
        // the shadow-pass vertex bill here is always a deliberate opt-in.
        gfxRelief: true,
        gfxSubdivLevel: 2,
        gfxReliefScale: 1.0,
        hero: true,
        pom: true,
        pomStepsPrimary: 24,
        pomStepsSelfShadow: 12,
        csm: true,
        bloom: true,
        vignette: true,
        lensFlare: false,
        lightShafts: true,
        maxParticlesPerEmitter: 2048,
    },
};

export const PRESET_NAMES = ["low", "mid", "high", "ultra"];

// Boolean-typed flags. Values "on"/"true"/"1" → true; "off"/"false"/"0"
// → false. Used by parseOverrides to coerce per-feature URL params.
const BOOL_FLAGS = new Set([
    "antialias",
    "shadows",
    "normalMaps",
    "detailFlag",
    "terrainDetailNormal",
    "triplanar",
    "hero",
    "pom",
    "csm",
    "bloom",
    "vignette",
    "lensFlare",
    "lightShafts",
]);

// Integer-typed flags.
//
// NOTE `gfxRelief` (the MASTER geometry-relief opt-in) is deliberately absent
// from BOOL_FLAGS: `parseBool` also accepts "1"/"true"/"yes", which would widen
// an opt-in that docs/url-flags.md requires to be an exact `=== "on"` match.
// Its one decisive reader is `scene3d/gfx_relief.js::resolveGfxRelief`. The two
// NUMERIC knobs below are safe to expose here (they cannot turn the feature on
// by themselves) so the Graphics-settings localStorage bag can carry them;
// gfx_relief.js clamps whatever it reads, from either source.
const INT_FLAGS = new Set([
    "subdivLevel",
    "gfxSubdivLevel",
    "pomStepsPrimary",
    "pomStepsSelfShadow",
    "triplanarSlopeThresholdPct",
    "maxParticlesPerEmitter",
]);

// Float-typed flags.
const FLOAT_FLAGS = new Set([
    "gfxReliefScale",
]);

function parseBool(raw) {
    const v = String(raw).toLowerCase();
    if (v === "on" || v === "true" || v === "1" || v === "yes") return true;
    if (v === "off" || v === "false" || v === "0" || v === "no") return false;
    return null;
}

function parseInteger(raw) {
    const n = Number.parseInt(String(raw), 10);
    return Number.isFinite(n) ? n : null;
}

function parseFloatFlag(raw) {
    const n = Number.parseFloat(String(raw));
    return Number.isFinite(n) ? n : null;
}

function parseOverrides(params) {
    const overrides = {};
    for (const flag of BOOL_FLAGS) {
        if (!params.has(flag)) continue;
        const v = parseBool(params.get(flag));
        if (v !== null) overrides[flag] = v;
    }
    for (const flag of INT_FLAGS) {
        if (!params.has(flag)) continue;
        const v = parseInteger(params.get(flag));
        if (v !== null) overrides[flag] = v;
    }
    for (const flag of FLOAT_FLAGS) {
        if (!params.has(flag)) continue;
        const v = parseFloatFlag(params.get(flag));
        if (v !== null) overrides[flag] = v;
    }
    return overrides;
}

// Mobile UA detection. Matches common mobile + tablet user-agents
// without trying to be perfect — the goal is "downgrade mid→low on
// likely-mobile hardware by default" not "perfectly classify every
// device". Users can always pass `?quality=high` explicitly to opt
// back into the higher tier.
export function isMobileUA(ua) {
    if (!ua || typeof ua !== "string") return false;
    return /Android|webOS|iPhone|iPad|iPod|BlackBerry|IEMobile|Opera Mini|Mobile/i.test(ua);
}

// A5 — GPU tier classification heuristics.
//
// HIGH allowlist: modern desktop discrete cards + Apple-silicon GPUs
// known to comfortably handle the `high` preset. Conservative on
// purpose — we abstain to MID for anything we don't explicitly
// recognise.
//
// LOW deny-list: integrated GPUs, older mobile GPUs, and embedded
// chips that should run the `low` preset by default.
//
// Anything matched by neither list defaults to MID. We NEVER auto-
// promote to ULTRA — that tier is a deliberate opt-in via
// `?quality=ultra`.
const GPU_HIGH_RE = /RTX 30\d\d|RTX 40\d\d|RTX 20[678]0|RX 7[890]\d\d|RX 6[89]\d\d|M[1-4]( Pro| Max| Ultra)?|Apple GPU|Radeon Pro/i;
const GPU_LOW_RE = /Mali|Adreno [0-5]\d\d|PowerVR SGX|Intel\(R\) (HD|UHD|Iris Plus)|Intel\(R\) Atom|Tegra/i;

// Detect coarse GPU tier via a throwaway 1×1 probe canvas.
//
// Creates a `<canvas>`, asks for a WebGL context, queries the
// `WEBGL_debug_renderer_info` extension's unmasked renderer string,
// then destroys both. Returns one of "high" | "low" or null when the
// probe can't run (no document, no WebGL, no debug-renderer ext, or
// renderer string was masked/unrecognised). MID is encoded as the
// "unrecognised → fall through to existing default" path; we return
// null for the unrecognised case so the caller's chain still gets a
// chance to apply mobile-UA logic below.
//
// Browser-only. Guarded with a `typeof document` check so Node test
// harnesses don't trip.
export function detectGpuTier() {
    if (typeof document === "undefined") return null;
    let canvas = null;
    let gl = null;
    try {
        canvas = document.createElement("canvas");
        canvas.width = 1;
        canvas.height = 1;
        gl =
            canvas.getContext("webgl") ||
            canvas.getContext("experimental-webgl");
        if (!gl) return null;
        const ext = gl.getExtension("WEBGL_debug_renderer_info");
        if (!ext) return null;
        const renderer = String(
            gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || "",
        );
        if (!renderer) return null;
        if (GPU_HIGH_RE.test(renderer)) {
            return { tier: "high", renderer };
        }
        if (GPU_LOW_RE.test(renderer)) {
            return { tier: "low", renderer };
        }
        // Unrecognised string (incl. Firefox-strict "Mozilla" /
        // "WebGL Generic" masking) — abstain.
        return { tier: null, renderer };
    } catch (_e) {
        return null;
    } finally {
        // Throwaway-context cleanup: browsers cap to ~16 live WebGL
        // contexts, so we MUST release this one explicitly. Force a
        // context loss where available, drop the DOM node, and null
        // out our local references.
        try {
            if (gl) {
                const loseExt = gl.getExtension("WEBGL_lose_context");
                if (loseExt && typeof loseExt.loseContext === "function") {
                    loseExt.loseContext();
                }
            }
        } catch (_e) {
            // ignore — best-effort
        }
        gl = null;
        if (canvas) {
            try {
                canvas.remove();
            } catch (_e) {
                // ignore — best-effort
            }
            canvas = null;
        }
    }
}

// Read user overrides persisted by the Graphics settings tab. Returns
// `null` when no localStorage entry exists, when localStorage is
// unavailable (Node test harness), or when the payload is malformed.
//
// The shape mirrors `ui/graphics_settings.js` exactly:
//   { preset?: "low"|..., flags?: { antialias: bool, ... }, extras?: {...} }
function readLocalGraphicsOverrides() {
    if (typeof localStorage === "undefined") return null;
    try {
        const raw = localStorage.getItem("holtburger_graphics_v1");
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== "object") return null;
        return parsed;
    } catch (_e) {
        return null;
    }
}

// Parse a `?quality=...` query string + per-feature overrides into a
// resolved preset bag. Mobile UAs default mid→low.
//
// Merge precedence (highest → lowest):
//   1. URL `?quality=` / per-flag `?antialias=on` overrides
//   2. `localStorage.holtburger_graphics_v1` user overrides
//   3. GPU-tier probe via `WEBGL_debug_renderer_info` (A5)
//   4. Mobile UA default ("low") / desktop default ("mid")
//
// Args (all optional; defaults read window/navigator when available):
//   url:        URL string or URL instance.
//   userAgent:  navigator.userAgent string.
//
// Returns: { preset: "low"|"mid"|"high"|"ultra", flags: {...},
//            source: "url"|"localstorage"|"gpu-probe"
//                    |"mobile-default"|"default" }
//
// The returned `flags` is a fresh object — callers can mutate without
// affecting `PRESETS`.
export function getQuality(url, userAgent) {
    const resolvedUrl =
        url ??
        (typeof window !== "undefined" && window.location
            ? window.location.href
            : null);
    const resolvedUa =
        userAgent ??
        (typeof navigator !== "undefined" ? navigator.userAgent : "");

    let params;
    try {
        params = resolvedUrl
            ? new URL(resolvedUrl).searchParams
            : new URLSearchParams("");
    } catch (_) {
        params = new URLSearchParams("");
    }

    const requested = params.get("quality");
    const mobile = isMobileUA(resolvedUa);
    const lsState = readLocalGraphicsOverrides();

    let preset;
    let source;
    if (requested && PRESET_NAMES.includes(requested)) {
        preset = requested;
        source = "url";
    } else if (lsState && typeof lsState.preset === "string"
        && PRESET_NAMES.includes(lsState.preset)) {
        preset = lsState.preset;
        source = "localstorage";
    } else {
        // A5 — GPU-tier probe. Runs only in the browser; abstains
        // (returns null) under Node, when WebGL is unavailable, when
        // `WEBGL_debug_renderer_info` is stripped, or when the
        // renderer string isn't on the HIGH allowlist or LOW
        // deny-list. NEVER auto-promotes to ULTRA.
        const probe = detectGpuTier();
        if (probe && probe.tier === "high") {
            preset = "high";
            source = "gpu-probe";
            // eslint-disable-next-line no-console
            console.log(
                `[quality] gpu-probe → high (renderer="${probe.renderer}")`,
            );
        } else if (probe && probe.tier === "low") {
            preset = "low";
            source = "gpu-probe";
            // eslint-disable-next-line no-console
            console.log(
                `[quality] gpu-probe → low (renderer="${probe.renderer}")`,
            );
        } else if (mobile) {
            preset = "low";
            source = "mobile-default";
        } else {
            preset = "mid";
            source = "default";
        }
    }

    const flags = { ...PRESETS[preset] };

    // localStorage flag overrides (sanitized — only known flag names
    // with correct types are accepted; everything else is dropped).
    if (lsState && lsState.flags && typeof lsState.flags === "object") {
        for (const k of Object.keys(lsState.flags)) {
            const v = lsState.flags[k];
            if (BOOL_FLAGS.has(k) && typeof v === "boolean") {
                flags[k] = v;
            } else if (INT_FLAGS.has(k) && Number.isFinite(v)) {
                flags[k] = v;
            } else if (FLOAT_FLAGS.has(k) && Number.isFinite(v)) {
                flags[k] = v;
            }
        }
    }

    // URL per-flag overrides win.
    const overrides = parseOverrides(params);
    Object.assign(flags, overrides);

    return { preset, flags, source };
}

// Install a `window.__quality` mirror for devtools inspection. Idempotent;
// safe to call multiple times. Returns the resolved object so callers
// can store it on liveScene3d in one go.
export function installQualityOnWindow(quality) {
    if (typeof window === "undefined") return quality;
    window.__quality = quality;
    return quality;
}
