// harness/lib/wasm_profile.mjs — which wasm-pack PROFILE built a .wasm, read
// from the module's own custom sections (test-tooling-8, 2026-10-13).
//
// WHY NOT A SIZE THRESHOLD
// ------------------------
// ci-smoke S0 called anything >= 6,000,000 B a dev build ("release ~4.25MB",
// measured 2026-07-09). The crate grew past that: the shipping RELEASE
// pkg/holtburger_web_bg.wasm is 7,182,909 B (2026-10-12) and pkg-release/ was
// already 6,423,996 B on 2026-08-10, so S0 has failed every release build
// since ~August and a real dev ship looked no different. Size tracks crate
// growth; the profile is a property of what the toolchain KEPT:
//
//   wasm-pack --dev       keeps the `name` section (function names for stack
//                         traces — 4.86 MB of the 16.65 MB pkg-A dev build)
//                         and `.debug_*` DWARF when debuginfo is on
//   wasm-pack --release   strips both: only `producers` + `target_features`
//                         (every pkg-*/ release build on this box, 2026-10-13)
//
// So a `name` or `.debug_*` custom section = DEV-WASM, otherwise release.
// (`wasm-pack --profiling` keeps `name` too and lands DEV-WASM: it is not the
// shipping profile, and it must never share a perf baseline with one.)
// Only when the bytes cannot be walked (truncated download, not a wasm) does
// it fall back to size, with the band raised to 12 MB (release ~7 MB, dev
// ~16.6 MB today) and the reason saying so.
//
// `wasmCustomSectionNames` is SELF-CONTAINED (no module-scope references) so
// moving-bench can ship its source into the page and walk the module the page
// actually loaded, instead of hauling 7-17 MB back over CDP.
//
// CLI:  node harness/lib/wasm_profile.mjs [--profile-only] <file.wasm>
//   prints {profile, reason, size, customSections}, or just the profile word
//   with --profile-only (ci-smoke.sh S0 reads that). Exit 1 if unreadable.

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Above this, a wasm whose sections could not be walked is called dev. */
export const DEV_SIZE_FALLBACK_BYTES = 12_000_000;

/** The labels hb-results-v2 `wasmProfile` uses (report.mjs header doc). */
export const WASM_PROFILES = Object.freeze(["release", "DEV-WASM", "unknown"]);

/**
 * Names of every custom section (id 0) in a wasm binary, in file order.
 * Walks section HEADERS only (id byte + LEB128 u32 size), so it is O(sections)
 * whatever the module size. Throws on a bad magic/version or a section that
 * runs past the end (a truncated fetch must not read as "no debug sections").
 *
 * SELF-CONTAINED on purpose — see the file header.
 * @param {Uint8Array} bytes
 * @returns {string[]}
 */
export function wasmCustomSectionNames(bytes) {
  const b = bytes;
  const n = b ? b.length : 0;
  if (n < 8 || b[0] !== 0x00 || b[1] !== 0x61 || b[2] !== 0x73 || b[3] !== 0x6d) {
    throw new Error("not a wasm module (bad magic)");
  }
  if (b[4] !== 0x01 || b[5] !== 0x00 || b[6] !== 0x00 || b[7] !== 0x00) {
    throw new Error("unsupported wasm version");
  }
  let p = 8;
  const u32 = () => {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 5; i++) {
      if (p >= n) throw new Error("truncated LEB128");
      const byte = b[p++];
      result += (byte & 0x7f) * scale;
      if ((byte & 0x80) === 0) return result;
      scale *= 128;
    }
    throw new Error("LEB128 u32 longer than 5 bytes");
  };
  const names = [];
  while (p < n) {
    const id = b[p++];
    const size = u32();
    const start = p;
    if (start + size > n) throw new Error(`section ${id} runs past the end (truncated module?)`);
    if (id === 0) {
      const len = u32();
      if (p + len > start + size) throw new Error("custom section name runs past its section");
      names.push(new TextDecoder("utf-8").decode(b.subarray(p, p + len)));
    }
    p = start + size;
  }
  return names;
}

/** A section the dev profile keeps and the release profile strips. */
export function isDevSection(name) {
  return name === "name" || String(name).startsWith(".debug_");
}

/**
 * Classify from already-walked section names (the in-page path) and/or the
 * byte size. `sections` null/undefined = the walk failed or never ran.
 * @param {{sections?: string[]|null, size?: number|null, error?: string|null}} probe
 * @returns {{profile: string, reason: string, size: number|null, customSections: string[]|null}}
 */
export function classifyWasmProfile({ sections = null, size = null, error = null } = {}) {
  const sz = Number.isFinite(size) ? size : null;
  if (Array.isArray(sections)) {
    const dev = sections.filter(isDevSection);
    return dev.length
      ? { profile: "DEV-WASM", reason: `custom section(s) ${dev.slice(0, 3).join(", ")}${dev.length > 3 ? ", ..." : ""}`, size: sz, customSections: sections }
      : { profile: "release", reason: "no name/.debug_* custom section", size: sz, customSections: sections };
  }
  if (sz != null) {
    const why = error ? `sections unreadable (${error}); ` : "";
    return sz > DEV_SIZE_FALLBACK_BYTES
      ? { profile: "DEV-WASM", reason: `${why}size-fallback ${sz} B > ${DEV_SIZE_FALLBACK_BYTES}`, size: sz, customSections: null }
      : { profile: "release", reason: `${why}size-fallback ${sz} B <= ${DEV_SIZE_FALLBACK_BYTES}`, size: sz, customSections: null };
  }
  return { profile: "unknown", reason: error ? `probe failed: ${error}` : "no wasm probed", size: null, customSections: null };
}

/** Walk + classify a byte array (node side: a file, a fetched body). */
export function detectWasmProfile(bytes) {
  const size = bytes ? bytes.length : null;
  try {
    return classifyWasmProfile({ sections: wasmCustomSectionNames(bytes), size });
  } catch (e) {
    return classifyWasmProfile({ sections: null, size, error: e && e.message ? e.message : String(e) });
  }
}

function main(argv) {
  const profileOnly = argv.includes("--profile-only");
  const file = argv.find((a) => !a.startsWith("--"));
  if (!file) {
    console.error("usage: node harness/lib/wasm_profile.mjs [--profile-only] <file.wasm>");
    return 2;
  }
  let bytes;
  try { bytes = readFileSync(file); } catch (e) {
    console.error(`wasm_profile: cannot read ${file}: ${e.message}`);
    return 1;
  }
  const r = detectWasmProfile(bytes);
  console.log(profileOnly ? r.profile : JSON.stringify(r));
  return 0;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) process.exit(main(process.argv.slice(2)));
