// tests/surface_walk_lite.test.mjs — `?surfaceWalkLite` (A1-lite, 2026-10-09).
//
// `fetch_surfaces_pixels` (the surface decode the bake worker runs for Step B,
// Step C and every outdoor bake) discovers its records with the iterative
// prefetch loop: round N's misses are round N+1's fetch list. Its discovery
// walk ran the FULL memo-through decode (`fetch_surface_pixels_cached`: texture
// expansion + the Sobel normal and height planes) every round, so a round's
// decode CPU sat between it and the next round's requests — the academy
// baselines show the worker's palette (0x04) round leaving ~3 s after its
// texture (0x06) round. ON: discovery walks the records only
// (`walk_surface_pixel_records`, the decode's exact read set) and the loop
// after the walk decodes each DID once. Same output bytes.
//
// Source contract (the build is wasm; no Rust toolchain here):
//
//   W1  lib.rs reads the flag DEFAULT-ON (off|0|false|no), once per instance,
//       through the seeded flag_search() (so the bake worker honours =off).
//   W2  fetch_surfaces_pixels' discovery closure calls the records-only walk
//       when ON and the full decode when OFF; the post-walk decode loop is
//       unchanged (fetch_surface_pixels_cached on the real source).
//   W3  the walker mirrors the decode's reads: alias resolve, Surface, solid
//       stop, SurfaceTexture (alias override), highest_res Texture, palette
//       only for P8/Index16 after the w*h overflow check, orig palette over
//       the default — and a native test pins walk reads == decode reads.
//   W4  docs/url-flags.md carries the row.
//
// Run: node tests/surface_walk_lite.test.mjs   (from apps/holtburger-web/)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");
const LIB = readFileSync(path.join(APP, "src", "lib.rs"), "utf8");

let passed = 0;
let failed = 0;
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [OK] ${label}`);
  } catch (err) {
    failed += 1;
    console.log(`  [FAIL] ${label} — ${err.message}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function itemBody(src, signature) {
  const at = src.indexOf(signature);
  assert(at >= 0, `missing \`${signature}\``);
  const end = src.indexOf("\n}\n", at);
  assert(end > at, `no closing brace for \`${signature}\``);
  return src.slice(at, end + 2);
}
function idx(hay, needle, what) {
  const i = hay.indexOf(needle);
  assert(i >= 0, `${what}: \`${needle}\` not found`);
  return i;
}

console.log("W1 — flag reader");
check("parse_surface_walk_lite_flag: default on, off|0|false|no", () => {
  const body = itemBody(LIB, "fn parse_surface_walk_lite_flag(search: &str) -> bool");
  assert(/!trimmed\.split\('&'\)\.any\(/.test(body), "absent reads ON");
  assert(
    /"surfaceWalkLite=off"\s*\|\s*"surfaceWalkLite=0"\s*\|\s*"surfaceWalkLite=false"\s*\|\s*"surfaceWalkLite=no"/.test(body),
    "the four off spellings",
  );
  const reader = itemBody(LIB, "fn surface_walk_lite_flag() -> bool");
  assert(/static FLAG: std::sync::OnceLock<bool>/.test(reader), "OnceLock");
  assert(/parse_surface_walk_lite_flag\(&flag_search\(\)\)/.test(reader), "seeded flag_search() (bake worker honours it)");
  assert(/fn surface_walk_lite_flag_defaults_on_with_off_0_false_no_escape\(\)/.test(LIB), "native grammar test");
});

console.log("W2 — fetch_surfaces_pixels");
check("discovery walks records when ON, decodes when OFF; final decode unchanged", () => {
  const fn = itemBody(LIB, "pub async fn fetch_surfaces_pixels(");
  const flag = idx(fn, "let walk_lite = surface_walk_lite_flag();", "flag read");
  const walk = idx(fn, "let walk = move |s: &dyn holtburger_dat::ResourceSource| {", "walk closure");
  assert(flag < walk, "flag read before the closure (captured by move)");
  assert(
    /if walk_lite \{\s*walk_surface_pixel_records\(s, id\);\s*\} else \{\s*let _ = fetch_surface_pixels_cached\(s, id\);\s*\}/.test(fn),
    "ON: records-only walk; OFF: the full memo-through decode",
  );
  assert(/if !surface_memo_contains\(id\) \{\s*if walk_lite/.test(fn), "memo-hit DIDs still skipped in discovery");
  assert(
    /let \(sp, misses\) = fetch_surface_pixels_cached\(source\.as_ref\(\), id\);/.test(fn),
    "post-walk decode on the real source, unchanged",
  );
});

console.log("W3 — the walker mirrors the decode's reads");
check("walk_surface_pixel_records: step order and palette rule", () => {
  const w = itemBody(LIB, "fn walk_surface_pixel_records<S: holtburger_dat::ResourceSource + ?Sized>(");
  const alias = idx(w, "resolve_tex_swap_alias(surface_did)", "alias");
  const surf = idx(w, 'source.get_file_shared(ResourceKey::new("eor/portal", surface_did))', "Surface read");
  const solid = idx(w, "if surface.solid_color().is_some() {", "solid stop");
  const st = idx(w, 'source.get_file_shared(ResourceKey::new("eor/portal", surf_tex_id))', "SurfaceTexture read");
  const rs = idx(w, "surf_tex.highest_res()", "highest_res");
  const tex = idx(w, 'source.get_file_shared(ResourceKey::new("eor/portal", rs_id))', "Texture read");
  const pal = idx(w, 'source.get_file_shared(ResourceKey::new("eor/portal", pal_id))', "Palette read");
  assert(alias < surf && surf < solid && solid < st && st < rs && rs < tex && tex < pal, "decode order");
  assert(/let surf_tex_id = tex_override\.unwrap_or\(surf_tex_id\);/.test(w), "alias SurfaceTexture override");
  assert(/if !tex\.format\(\)\.needs_palette\(\) \{\s*return;/.test(w), "palette only for P8/Index16");
  assert(/\(tex\.width as usize\)\.checked_mul\(tex\.height as usize\)\.is_none\(\)/.test(w), "w*h overflow check before the palette");
  assert(/\.filter\(\|&p\| p != 0\)\s*\.or\(tex\.default_palette_id\)/.test(w), "orig palette over the texture default");
  assert(!/to_rgba8|normal_and_height_pixels|compute_stats/.test(w), "no decode work");
  assert(/fn walk_reads_exactly_what_the_decode_reads\(\)/.test(LIB), "native parity test (walk reads == decode reads)");
});

console.log("W4 — docs row");
check("url-flags.md: surfaceWalkLite row", () => {
  const docs = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  const row = docs.split("\n").find((l) => l.startsWith("| `surfaceWalkLite` |"));
  assert(row, "row `| \\`surfaceWalkLite\\` |` missing");
  assert(row.includes("| `off`/`0`/`false`/`no` to disable |"), "accepted values column");
  assert(row.includes("surface_walk_lite_flag"), "names the wasm reader");
  assert(row.includes("tests/surface_walk_lite.test.mjs"), "names this test");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
