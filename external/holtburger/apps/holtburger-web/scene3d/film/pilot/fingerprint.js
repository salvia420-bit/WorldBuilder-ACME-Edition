// scene3d/film/pilot/fingerprint.js — bucketed-scene fingerprint for the JEV pilot (SPEC §2.14).
//
// WHY: the jev-drone prior art consults JEV only when a decision is needed AND
// the bucketed scene changed; an unchanged scene reuses the last answer (≈110
// calls per 65 s flight instead of thousands). Because the pilot state is
// words only, "the scene changed" is exactly "some word changed". The
// fingerprint is a stable (key-order independent) serialisation of the state
// WITHOUT `current` — the pilot's own maneuver and how long it has been held
// change every tick and must not force a new consult.
//
// Film mode is DEFAULT OFF (`?filmMode=on`). Pure module: no DOM, no three,
// no wasm, no clocks. Deterministic.

import { hashString } from "../core/rng.js";

/**
 * JSON serialisation with object keys sorted at every level, so two states with the same
 * words always produce the same string regardless of property insertion order.
 * Arrays keep their order; `undefined` / function / symbol members are skipped (as JSON
 * does); non-finite numbers become null; cycles become the string "[cycle]".
 * @param {*} value
 * @returns {string}
 */
export function stableStringify(value) {
  const seen = new Set();
  const walk = (v) => {
    if (v === null) return "null";
    const t = typeof v;
    if (t === "string") return JSON.stringify(v);
    if (t === "number") return Number.isFinite(v) ? JSON.stringify(v) : "null";
    if (t === "boolean") return v ? "true" : "false";
    if (t === "bigint") return JSON.stringify(String(v));
    if (t !== "object") return undefined;
    if (seen.has(v)) return JSON.stringify("[cycle]");
    seen.add(v);
    let out;
    if (Array.isArray(v)) {
      out = `[${v.map((x) => walk(x) ?? "null").join(",")}]`;
    } else {
      const parts = [];
      for (const k of Object.keys(v).sort()) {
        const s = walk(v[k]);
        if (s !== undefined) parts.push(`${JSON.stringify(k)}:${s}`);
      }
      out = `{${parts.join(",")}}`;
    }
    seen.delete(v);
    return out;
  };
  return walk(value) ?? "null";
}

/**
 * Fingerprint of a pilot state: `stableStringify` of every field except `current`
 * (SPEC §2.14). Two ticks whose words are identical give identical fingerprints.
 * Non-object input is serialised as is.
 * @param {object} state a buildPilotState() result
 * @returns {string}
 */
export function sceneFingerprint(state) {
  if (state === null || typeof state !== "object" || Array.isArray(state)) return stableStringify(state);
  const rest = {};
  for (const k of Object.keys(state)) if (k !== "current") rest[k] = state[k];
  return stableStringify(rest);
}

/**
 * Short 8-hex-digit hash of a fingerprint (or of a state, fingerprinted first) for telemetry
 * and logs (FNV-1a + fmix32 via core/rng.js hashString). Equal fingerprints → equal hashes.
 * @param {string|object} fingerprintOrState
 * @returns {string}
 */
export function fingerprintHash(fingerprintOrState) {
  const fp = typeof fingerprintOrState === "string" ? fingerprintOrState : sceneFingerprint(fingerprintOrState);
  return hashString(fp).toString(16).padStart(8, "0");
}
