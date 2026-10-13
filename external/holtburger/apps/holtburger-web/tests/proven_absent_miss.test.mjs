// tests/proven_absent_miss.test.mjs — streaming-residency-3 (2026-10-13).
//
// Two wasm-side fixes, pinned as a source contract (the build is wasm and this
// suite runs without a Rust toolchain; the behaviour itself is pinned by the
// native `cargo test -p holtburger-web --lib` tests named below):
//
//   M1  `MissCountingSource` (the model memo's completeness gate, and the
//       `decodeMisses` the statics / buildings bakers read) counts a failed
//       read ONLY when the catalog cannot prove the record absent — the same
//       rule as `DecodeAuditSource`. A dangling DAT ref no longer marks a
//       model starved on every bake or keeps it out of MODEL_TRI_CACHE.
//       Escape: `?provenAbsentExempt=off` (count every Err again).
//   M2  it FORWARDS `key_known_absent` (area note MISSED-1): decode impls run
//       inside it (relief priming → fetch_surface_pixels_impl's R-7
//       negative-cache insert), and the trait default is `false`.
//   B1  both prefetch loops (`prefetch::run_walk_loop`,
//       `batch_walk::run_batch_walk_paced`) pause before a RETRY of a failed
//       round (250 / 750 ms) — never after a success, never after the last
//       try. Escape: `?prefetchRetryDelay=off` (back-to-back retries again).
//
// Run: node tests/proven_absent_miss.test.mjs   (from apps/holtburger-web/)

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, "..");

const LIB = readFileSync(path.join(APP, "src", "lib.rs"), "utf8");
const BW = readFileSync(path.join(APP, "src", "batch_walk.rs"), "utf8");
const PF = readFileSync(path.join(APP, "src", "prefetch.rs"), "utf8");

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

/** Body of a top-level Rust item: from its signature to the first `\n}\n`. */
function itemBody(src, signature) {
  const at = src.indexOf(signature);
  assert(at >= 0, `missing \`${signature}\``);
  const end = src.indexOf("\n}\n", at);
  assert(end > at, `no closing brace for \`${signature}\``);
  return src.slice(at, end + 2);
}

/** Body of one `fn name(` inside an item body, up to its 4-space-indented `}`. */
function methodBody(item, signature) {
  const at = item.indexOf(signature);
  assert(at >= 0, `missing \`${signature}\``);
  const end = item.indexOf("\n    }\n", at);
  assert(end > at, `no closing brace for \`${signature}\``);
  return item.slice(at, end + 6);
}

console.log("M1 — MissCountingSource counts only unprovable misses");
const MCS_TRAIT = itemBody(
  LIB,
  "impl<S: holtburger_dat::ResourceSource + ?Sized> holtburger_dat::ResourceSource\n    for MissCountingSource<'_, S>",
);
const MCS_INHERENT = itemBody(
  LIB,
  "impl<S: holtburger_dat::ResourceSource + ?Sized> MissCountingSource<'_, S> {",
);
check("both read paths route a failed read through note_failed_read", () => {
  for (const sig of ["fn get_file_by_key(", "fn get_file_shared("]) {
    const body = methodBody(MCS_TRAIT, sig);
    assert(/if r\.is_err\(\) \{\s*self\.note_failed_read\(key\);\s*\}/.test(body), `${sig} counts via note_failed_read`);
    assert(!/fetch_add/.test(body), `${sig} has no unconditional count left`);
  }
});
check("note_failed_read skips exactly the catalog-proven absences (flag-gated)", () => {
  const body = methodBody(MCS_INHERENT, "fn note_failed_read(");
  assert(
    /if proven_absent_exempt_flag\(\) && self\.inner\.key_known_absent\(key\) \{\s*return;\s*\}\s*self\.misses\s*\.fetch_add\(1, std::sync::atomic::Ordering::Relaxed\);/.test(body),
    "skip iff flag on AND inner proves absence; otherwise count",
  );
});
check("same rule as DecodeAuditSource (the surface path's audit)", () => {
  const audit = itemBody(
    LIB,
    "impl<S: holtburger_dat::ResourceSource + ?Sized> holtburger_dat::ResourceSource\n    for DecodeAuditSource<'_, S>",
  );
  assert(/r\.is_err\(\) && !self\.inner\.key_known_absent\(key\)/.test(audit), "DecodeAuditSource reference rule");
});
check("?provenAbsentExempt: default ON, off|0|false|no escape, parsed once over flag_search()", () => {
  const parse = itemBody(LIB, "fn parse_proven_absent_exempt_flag(search: &str) -> bool {");
  assert(/!trimmed\.split\('&'\)\.any\(/.test(parse), "absent reads ON");
  assert(
    /"provenAbsentExempt=off"\s*\|\s*"provenAbsentExempt=0"\s*\|\s*"provenAbsentExempt=false"\s*\|\s*"provenAbsentExempt=no"/.test(parse),
    "the four off spellings",
  );
  const flag = itemBody(LIB, "fn proven_absent_exempt_flag() -> bool {");
  assert(/static FLAG: std::sync::OnceLock<bool>/.test(flag), "OnceLock");
  assert(/parse_proven_absent_exempt_flag\(&flag_search\(\)\)/.test(flag), "seeded flag_search()");
  assert(/#\[cfg\(not\(target_arch = "wasm32"\)\)\]\s*\{\s*true\s*\}/.test(flag), "native tests take the default");
});

console.log("M2 — key_known_absent is forwarded");
check("MissCountingSource forwards the provability probe to its inner source", () => {
  const body = methodBody(MCS_TRAIT, "fn key_known_absent(");
  assert(/self\.inner\.key_known_absent\(key\)/.test(body), "forwarded, not the trait default");
});
check("the shared-read forward (A15 S2) is still in place", () => {
  const body = methodBody(MCS_TRAIT, "fn get_file_shared(");
  assert(/self\.inner\.get_file_shared\(key\)/.test(body), "get_file_shared forwarded");
});
check("native Rust tests pin the behaviour", () => {
  for (const name of [
    "proven_absent_part_is_not_a_miss_and_memoizes",
    "unhydrated_part_still_counts_and_is_not_memoized",
    "miss_counting_source_forwards_key_known_absent",
    "proven_absent_exempt_flag_defaults_on_with_off_0_false_no_escape",
  ]) {
    assert(new RegExp(`fn ${name}\\(\\)`).test(LIB), `lib.rs test ${name}`);
  }
});

console.log("B1 — failure-only retry pause in both prefetch loops");
check("schedule: 250 ms before try 2, 750 ms before try 3; one entry per retry", () => {
  assert(/pub\(crate\) const ROUND_RETRY_DELAYS_MS: \[u32; 2\] = \[250, 750\];/.test(BW), "250 / 750");
  assert(/const _: \(\) = assert!\(ROUND_RETRY_DELAYS_MS\.len\(\) as u32 == BATCH_WALK_ROUND_TRIES - 1\);/.test(BW), "batch loop: compile-time length check");
  assert(/ROUND_RETRY_DELAYS_MS\.len\(\) as u32 == PREFETCH_ROUND_TRIES - 1/.test(PF), "legacy loop: compile-time length check");
  const delay = itemBody(BW, "pub(crate) fn round_retry_delay_ms(failed_attempt: u32) -> u32 {");
  assert(/ROUND_RETRY_DELAYS_MS\.get\(i as usize\)\.copied\(\)\.unwrap_or\(0\)/.test(delay), "out of range → 0");
});
check("backoff: wasm setTimeout behind the flag; native tests record instead of sleeping", () => {
  const body = itemBody(BW, "pub(crate) async fn round_retry_backoff(failed_attempt: u32) {");
  assert(/if ms == 0 \{\s*return;\s*\}/.test(body), "nothing to wait → no await");
  assert(/#\[cfg\(target_arch = "wasm32"\)\]\s*\{\s*if prefetch_retry_delay_flag\(\) \{\s*gloo_timers::future::TimeoutFuture::new\(ms\)\.await;/.test(body), "wasm: TimeoutFuture under the flag");
  assert(/#\[cfg\(test\)\]\s*\{\s*RETRY_BACKOFF_LOG\.with/.test(body), "native: recorded");
  const parse = itemBody(BW, "pub(crate) fn parse_prefetch_retry_delay_flag(search: &str) -> bool {");
  assert(/!trimmed\.split\('&'\)\.any\(/.test(parse), "absent reads ON");
  assert(
    /"prefetchRetryDelay=off"\s*\|\s*"prefetchRetryDelay=0"\s*\|\s*"prefetchRetryDelay=false"\s*\|\s*"prefetchRetryDelay=no"/.test(parse),
    "the four off spellings",
  );
  const flag = itemBody(BW, "fn prefetch_retry_delay_flag() -> bool {");
  assert(/static FLAG: std::sync::OnceLock<bool>/.test(flag) && /parse_prefetch_retry_delay_flag\(&crate::flag_search\(\)\)/.test(flag), "OnceLock over the seeded flag_search()");
});
check("batch loop: the pause sits in the retrying branch only", () => {
  const body = itemBody(BW, "pub(crate) async fn run_batch_walk_paced<");
  assert((body.match(/round_retry_backoff\(/g) || []).length === 1, "exactly one call site");
  assert(
    /if attempt < BATCH_WALK_ROUND_TRIES \{\s*warn\(format!\([\s\S]*?retrying[\s\S]*?\)\);[\s\S]*?round_retry_backoff\(attempt\)\.await;\s*\} else \{/.test(body),
    "after the 'retrying' warn, before the else (last try)",
  );
  const okArm = body.slice(body.indexOf("Ok(()) => {"), body.indexOf("Err(f) => {"));
  assert(okArm.length > 0 && !/round_retry_backoff/.test(okArm), "a successful attempt never waits");
});
check("legacy loop: the pause sits in the `attempt < PREFETCH_ROUND_TRIES` arm only", () => {
  const loop = itemBody(PF, "async fn run_walk_loop<F>(");
  assert((loop.match(/round_retry_backoff\(/g) || []).length === 1, "exactly one call site");
  assert(
    /Err\(e\) if attempt < PREFETCH_ROUND_TRIES => \{\s*log::warn!\([\s\S]*?\);[\s\S]*?crate::batch_walk::round_retry_backoff\(attempt\)\.await;\s*\}\s*Err\(e\) => \{/.test(loop),
    "retry arm awaits the pause; the final-failure arm does not",
  );
  const okArm = loop.slice(loop.indexOf("Ok(()) => {"), loop.indexOf("Err(e) if attempt"));
  assert(okArm.length > 0 && !/round_retry_backoff/.test(okArm), "a successful round never waits");
});
check("native Rust tests pin the schedule with a fake sleeper", () => {
  for (const name of [
    "successful_rounds_never_back_off",
    "transient_failure_backs_off_once_between_the_attempts",
    "persistent_failure_takes_the_full_schedule_and_no_trailing_pause",
  ]) {
    assert(new RegExp(`async fn ${name}\\(\\)`).test(BW), `batch_walk.rs test ${name}`);
  }
  for (const name of ["round_retry_delay_schedule", "prefetch_retry_delay_flag_defaults_on_with_off_0_false_no_escape"]) {
    assert(new RegExp(`fn ${name}\\(\\)`).test(BW), `batch_walk.rs test ${name}`);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
