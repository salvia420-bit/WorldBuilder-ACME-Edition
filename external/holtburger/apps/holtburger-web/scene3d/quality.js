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
        shadows: false,
        normalMaps: true,
        detailFlag: false,
        terrainDetailNormal: false,
        triplanar: false,
        subdivLevel: 1,
        hero: false,
        pom: false,
        csm: false,
    },
    mid: {
        shadows: true,
        normalMaps: true,
        detailFlag: true,
        terrainDetailNormal: true,
        triplanar: true,
        subdivLevel: 2,
        hero: false,
        pom: false,
        csm: false,
    },
    high: {
        shadows: true,
        normalMaps: true,
        detailFlag: true,
        terrainDetailNormal: true,
        triplanar: true,
        subdivLevel: 4,
        hero: true,
        pom: true,
        csm: true,
    },
    ultra: {
        shadows: true,
        normalMaps: true,
        detailFlag: true,
        terrainDetailNormal: true,
        triplanar: true,
        subdivLevel: 8,
        hero: true,
        pom: true,
        csm: true,
    },
};

export const PRESET_NAMES = ["low", "mid", "high", "ultra"];

// Boolean-typed flags. Values "on"/"true"/"1" → true; "off"/"false"/"0"
// → false. Used by parseOverrides to coerce per-feature URL params.
const BOOL_FLAGS = new Set([
    "shadows",
    "normalMaps",
    "detailFlag",
    "terrainDetailNormal",
    "triplanar",
    "hero",
    "pom",
    "csm",
]);

// Integer-typed flags.
const INT_FLAGS = new Set(["subdivLevel"]);

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

// Parse a `?quality=...` query string + per-feature overrides into a
// resolved preset bag. Mobile UAs default mid→low.
//
// Args (all optional; defaults read window/navigator when available):
//   url:        URL string or URL instance.
//   userAgent:  navigator.userAgent string.
//
// Returns: { preset: "low"|"mid"|"high"|"ultra", flags: {...}, source: "url"|"mobile-default"|"default" }
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

    let preset;
    let source;
    if (requested && PRESET_NAMES.includes(requested)) {
        preset = requested;
        source = "url";
    } else if (mobile) {
        preset = "low";
        source = "mobile-default";
    } else {
        preset = "mid";
        source = "default";
    }

    const flags = { ...PRESETS[preset] };
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
