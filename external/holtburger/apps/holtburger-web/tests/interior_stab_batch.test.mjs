// tests/interior_stab_batch.test.mjs — `?interiorStabBatch` (A0, 2026-10-09).
//
// The academy's record fetch (0x8602: 568 cells, 200 distinct stabs = 170
// Setups + 30 GfxObjs, 215 Setup parts) was ~85% one serial chain: inside
// `fetch_env_cells_in_landblock`'s per-cell loop every first-seen Setup awaited
// its own urgent keyed walk, i.e. one network round for its parts (~70 bursts,
// 10.0→23.9 s on the 1070 baselines). ON: one urgent keyed walk over every
// 0x01/0x02 stab, joined with the Environment prefetch, BEFORE the per-cell
// loop; the per-stab walks stay as the fallback; the loop yields every 8 ms.
//
// This is a source contract (the build is wasm; no Rust toolchain here), so a
// refactor cannot silently drop the batch or move it behind the loop:
//
//   S1  lib.rs reads the flag DEFAULT-ON with the off|0|false|no escape,
//       parsed once (OnceLock over flag_search()).
//   S2  the stab-batch walk sits after the EnvCell parse and BEFORE
//       `for envcell in cells_raw`, joined with the Environment prefetch, and
//       walks 0x02 with walk_setup_parts_with_geom / 0x01 by top record — in
//       BATCH MODE (`ensure_walk_prefetched_keyed_batch`).
//   S3  the per-stab fallback walk is still inside the loop (ON: through
//       `interior_stab_memo_entry`, batch mode; OFF: the legacy keyed walk),
//       under a key that differs from the batch key.
//   S4  OFF keeps the pre-A0 sequence: the fatal Environment prefetch, then
//       the best-effort top-record batch, then the per-placement arms.
//   S5  the cooperative yield: once after the joined stage (before the light
//       collection) and first thing in each cell iteration; 12 ms budget;
//       scheduler.yield / MessageChannel (no setTimeout clamp); none while the
//       document is hidden.
//   S6  one `[interiorStabBatch] 0x…: N stabs, K ms, rounds R, fetched F,
//       failed X, perStabFallback P, loop cpu C ms / wall W ms, Y yields`
//       console line per build.
//   S7  docs/url-flags.md carries the row (default on, off|0|false|no).
//   S8  the batch-mode loop (src/batch_walk.rs) excludes a round's failed keys
//       and keeps discovering; never fails; native unit tests pin it.
//   S9  the per-build stab memo: armed only by a SETTLED batch, keyed by stab
//       id, the same products in the same order as the per-placement arms.
//   S10 `?interiorStabChunk` (2026-10-09 follow-up, default 40): the batch runs
//       as concurrent PACED sub-walks of <= N stabs (balanced chunks, keyed by
//       LB + ids), merged stats (summed; settled = every sub-walk settled);
//       `=off` keeps the one unpaced walk under today's key.
//   S11 `?walkPace` (default on): the legacy loop yields one turn before a
//       discovery that follows a prefetch round that SUSPENDED (a warm,
//       fully-resident prefetch is not paced); main thread only, not hidden;
//       the batch loop's pace hook never runs before the first discovery.
//
// Run: node tests/interior_stab_batch.test.mjs   (from apps/holtburger-web/)

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

/** Body of a top-level Rust item: from its signature to the first `\n}\n`. */
function itemBody(src, signature) {
  const at = src.indexOf(signature);
  assert(at >= 0, `missing \`${signature}\``);
  const end = src.indexOf("\n}\n", at);
  assert(end > at, `no closing brace for \`${signature}\``);
  return src.slice(at, end + 2);
}

/** Index of `needle` in `hay`, asserting it is present. */
function idx(hay, needle, what) {
  const i = hay.indexOf(needle);
  assert(i >= 0, `${what}: \`${needle}\` not found`);
  return i;
}

console.log("S1 — flag reader");
check("parse_interior_stab_batch_flag: default on, off|0|false|no escape", () => {
  const body = itemBody(LIB, "fn parse_interior_stab_batch_flag(search: &str) -> bool");
  assert(/!trimmed\.split\('&'\)\.any\(/.test(body), "absent reads ON (negated any)");
  assert(
    /"interiorStabBatch=off"\s*\|\s*"interiorStabBatch=0"\s*\|\s*"interiorStabBatch=false"\s*\|\s*"interiorStabBatch=no"/.test(body),
    "the four off spellings",
  );
  assert(!/interiorStabBatch=on/.test(body), "no opt-in spelling (default-on reader)");
});
check("interior_stab_batch_flag(): OnceLock over flag_search()", () => {
  const body = itemBody(LIB, "fn interior_stab_batch_flag() -> bool");
  assert(/static FLAG: std::sync::OnceLock<bool>/.test(body), "OnceLock");
  assert(/parse_interior_stab_batch_flag\(&flag_search\(\)\)/.test(body), "seeded flag_search()");
});
check("native unit test pins the grammar", () => {
  assert(/fn interior_stab_batch_flag_defaults_on_with_off_0_false_no_escape\(\)/.test(LIB), "unit test");
});

const FN = itemBody(LIB, "pub async fn fetch_env_cells_in_landblock(");

console.log("S2 — the batch walk sits before the per-cell loop");
check("source order: EnvCell parse < gate < batch walk < join < loop", () => {
  const parse = idx(FN, "EnvCell::unpack(", "EnvCell parse");
  const gate = idx(FN, "let stab_batch_on = interior_stab_batch_flag();", "flag gate");
  const walk = idx(FN, "prefetch::ensure_walk_prefetched_keyed_batch(", "keyed batch-mode walk");
  const key = idx(FN, '"fetchEnvCellsInLandblock:stab-batch"', "batch WalkCacheKey");
  const join = idx(FN, "futures::future::join(env_round, stab_walk).await", "join with env prefetch");
  const loop = idx(FN, "for envcell in cells_raw {", "per-cell loop");
  assert(parse < gate, "the gate is read after the EnvCells are parsed");
  assert(gate < walk && walk < key && key < join, "batch walk under the gate, keyed, then joined");
  assert(join < loop, "the batch completes BEFORE `for envcell in cells_raw`");
});
check("batch walk: 0x02 via walk_setup_parts_with_geom, 0x01 by top record, distinct + per LB", () => {
  const from = idx(FN, '"fetchEnvCellsInLandblock:stab-batch"', "batch key");
  const to = idx(FN, "futures::future::join(env_round, stab_walk)", "join");
  const walk = FN.slice(from, to);
  assert(/\.with_u32\(landblock_high\)/.test(walk), "keyed per landblock");
  const reads = idx(FN, "fn stab_batch_reads(s: &dyn holtburger_dat::ResourceSource, ids: &[u32]) {", "shared reads fn");
  const readsBody = FN.slice(reads, from);
  assert(/walk_setup_parts_with_geom\(s, id\)/.test(readsBody), "Setup walk = the per-stab walk");
  assert(/s\.get_file_by_key\(holtburger_dat::ResourceKey::new\("eor\/portal", id\)\)/.test(readsBody), "GfxObj top record");
  assert((walk.match(/stab_batch_reads\(s, &/g) || []).length === 2, "both arms walk the same reads");
  const gate = idx(FN, "let stab_batch_on = interior_stab_batch_flag();", "gate");
  const ids = FN.slice(gate, from);
  assert(/matches!\(\(stab\.stab_id >> 24\) as u8, 0x01 \| 0x02\)/.test(ids), "same 0x01|0x02 filter as the loop");
  assert(/batch_ids\.sort_unstable\(\);\s*batch_ids\.dedup\(\);/.test(ids), "sorted + deduplicated");
});
check("the Environment prefetch stays fatal; an unsettled walk only warns", () => {
  const gate = idx(FN, "let stab_batch_on = interior_stab_batch_flag();", "gate");
  const join = idx(FN, "futures::future::join(env_round, stab_walk)", "join");
  const elseAt = FN.indexOf("} else {", join); // the gate's else (OFF arm)
  assert(elseAt > join, "OFF arm after the join");
  const on = FN.slice(gate, elseAt);
  assert(/let env_round = async \{[\s\S]*?source\.prefetch_urgent\(&env_keys\)\.await\.map_err/.test(on), "env round = prefetch_urgent(env_keys)");
  assert(/env_result\?;/.test(on), "env failure propagates");
  assert(/if !walk_stats\.settled\(\) \{\s*log::warn!/.test(on), "an unsettled batch warns (and arms no memo)");
  assert(/move \|s\| stab_batch_reads\(s, &batch_ids\),\s*true,\s*\)\s*\.await/.test(on), "=off arm: the one walk stays on the urgent lane");
  assert(/move \|s\| stab_batch_reads\(s, &chunk\),\s*true,\s*true,\s*\)\);/.test(on), "sub-walks: urgent lane, paced");
});

console.log("S3 — per-stab fallback");
check("per-stab keyed walk still inside the loop, under its own key", () => {
  const loop = idx(FN, "for envcell in cells_raw {", "loop");
  const perStab = idx(FN, '"fetchEnvCellsInLandblock:static-bsp:0x02"', "per-stab key (OFF arm)");
  assert(perStab > loop, "OFF: the legacy fallback walk is inside the loop");
  const memoCall = idx(FN, "interior_stab_memo_entry(&source, stab.stab_id, &mut per_stab_fallback)", "ON: memo entry");
  assert(memoCall > loop, "ON: the fallback runs from inside the loop");
  assert(
    FN.indexOf('"fetchEnvCellsInLandblock:stab-batch"', loop) === -1,
    "the batch key is never used inside the loop (no dedup latch with the per-stab walks)",
  );
  const entry = itemBody(LIB, "async fn interior_stab_memo_entry(");
  assert(/prefetch::ensure_walk_prefetched_keyed_batch\(\s*prefetch::WalkCacheKey::new\("fetchEnvCellsInLandblock:static-bsp:0x02"\)\s*\.with_u32\(stab_id\)/.test(entry), "ON per-stab walk: batch mode, same key");
  assert(/if stats\.rounds > 0 \{\s*\*per_stab_fallback \+= 1;/.test(entry), "a per-stab walk that still had misses is counted");
});

console.log("S4 — OFF keeps today's sequence");
check("else-branch: fatal env prefetch then the best-effort top-record batch", () => {
  const join = idx(FN, "futures::future::join(env_round, stab_walk)", "join");
  const loop = idx(FN, "for envcell in cells_raw {", "loop");
  const elseAt = FN.indexOf("} else {", join);
  assert(elseAt > join && elseAt < loop, "an else-branch between the join and the loop");
  const off = FN.slice(elseAt, loop);
  const env = idx(off, "source.prefetch_urgent(&env_keys).await.map_err(", "OFF env prefetch");
  const tops = idx(off, "let _ = source.prefetch_urgent(&stab_keys).await;", "OFF top-record batch");
  assert(env < tops, "Environments first, then the stab tops");
  const envErr = FN.split('"fetchEnvCellsInLandblock: prefetch Environments: {e}"').length - 1;
  assert(envErr === 2, `the same Environment error text on both arms (found ${envErr})`);
});
check("OFF per-placement arms unchanged (legacy keyed urgent walk, no memo)", () => {
  const loop = idx(FN, "for envcell in cells_raw {", "loop");
  const inLoop = FN.slice(loop);
  const onArm = idx(inLoop, "if stab_batch_on {", "ON per-stab arm");
  const offAabb = idx(inLoop, "let aabb_local = static_object_local_aabb(source.as_ref(), stab.stab_id);", "OFF aabb");
  assert(onArm < offAabb, "the ON arm `continue`s before the OFF per-placement code");
  assert(/continue;\s*\}\s*let aabb_local = static_object_local_aabb/.test(inLoop), "ON arm ends in `continue`");
  assert(
    /prefetch::ensure_walk_prefetched_keyed_urgent\(cache_key, &source, &initial, move \|s\| \{/.test(inLoop),
    "OFF 0x02 arm: the legacy keyed urgent walk",
  );
});

console.log("S5 — cooperative yield");
check("first statement of each cell iteration, flag-gated (Option), 12 ms", () => {
  const loop = idx(FN, "for envcell in cells_raw {", "loop");
  const head = FN.slice(loop, loop + 1500);
  const y = idx(head, "if let Some(y) = build_yield.as_mut() {", "yield gate");
  const firstStmt = idx(head, "let env_did = 0x0D00_0000", "first cell statement");
  assert(y < firstStmt, "the yield precedes the cell's work");
  assert(/y\.maybe_yield\(false\)\.await;/.test(head), "budgeted yield");
  assert(/const INTERIOR_BUILD_YIELD_MS: f64 = 12\.0;/.test(LIB), "12 ms budget");
});
check("one forced yield after the joined stage, before the light collection", () => {
  const join = idx(FN, "futures::future::join(env_round, stab_walk)", "join");
  const post = idx(FN, "y.maybe_yield(true).await;", "post-stage yield");
  const lights = idx(FN, "let bake_lights_by_cell = collect_landblock_bake_lights(", "light collection");
  assert(join < post && post < lights, "join < forced yield < lights");
  assert(/let mut build_yield: Option<InteriorBuildYield> = None;\s*if stab_batch_on \{/.test(FN), "ON only (None when OFF)");
});
check("yield = MessageChannel (not scheduler.yield), none while hidden", () => {
  const helper = itemBody(LIB, "async fn yield_to_event_loop()");
  assert(/wasm_bindgen_futures::JsFuture::from\(js_yield_turn\(\)\)\.await/.test(helper), "awaits js_yield_turn()");
  assert(!/gloo_timers/.test(helper), "no setTimeout(0) chain");
  const snip = LIB.slice(LIB.indexOf('#[wasm_bindgen(inline_js = "export function js_location_search()'));
  const end = snip.indexOf('")]');
  const js = snip.slice(0, end);
  assert(/export function js_yield_turn\(\)/.test(js), "snippet exports js_yield_turn");
  assert(!/scheduler/.test(js), "no scheduler.yield() (its continuation jumps the task queue)");
  assert(/new g\.MessageChannel\(\)/.test(js), "MessageChannel fallback");
  assert(/export function js_document_hidden\(\)/.test(js) && /visibilityState === 'hidden'/.test(js), "hidden probe");
  assert(/export function js_perf_now\(\)/.test(js), "performance.now");
  assert(!/inline_js/.test(LIB.slice(LIB.indexOf("fn js_perf_now() -> f64;"))), "ONE inline_js snippet (pkg/snippets/…/inline0.js only)");
  const m = itemBody(LIB, "impl InteriorBuildYield {");
  assert(/if js_document_hidden\(\) \{\s*self\.last_ms = now;\s*return;/.test(m), "no yield while the document is hidden");
});

console.log("S6 — one log line per build");
check("[interiorStabBatch] 0x…: N stabs, K ms, rounds, fetched, failed, perStabFallback, loop cpu / wall, yields", () => {
  assert(
    FN.includes(
      '"[interiorStabBatch] 0x{landblock_high:08X}: {stabs} stabs, {stage_ms:.0} ms, rounds {}, fetched {}, failed {}, perStabFallback {per_stab_fallback}, loop cpu {loop_cpu_ms:.0} ms / wall {loop_wall_ms:.0} ms, {yields} yields"',
    ),
    "log line format",
  );
  assert(/walk\.rounds, walk\.fetched, walk\.failed/.test(FN), "batch stats in the line");
});

console.log("S7 — docs row");
check("url-flags.md: interiorStabBatch row, default on, off|0|false|no", () => {
  const docs = readFileSync(path.join(APP, "docs", "url-flags.md"), "utf8");
  const row = docs.split("\n").find((l) => l.startsWith("| `interiorStabBatch` |"));
  assert(row, "row `| \\`interiorStabBatch\\` |` missing");
  assert(row.includes("| `off`/`0`/`false`/`no` to disable |"), "accepted values column");
  assert(/\| \*\*on\*\* \(2026-10-09\) \|/.test(row), "default on");
  assert(row.includes("`!(off\\|0\\|false\\|no)`"), "reader grammar column");
  assert(row.includes("interior_stab_batch_flag"), "names the wasm reader");
  assert(row.includes("tests/interior_stab_batch.test.mjs"), "names this test");
});

console.log("S8 — batch-mode walk loop");
const BW = readFileSync(path.join(APP, "src", "batch_walk.rs"), "utf8");
const PF = readFileSync(path.join(APP, "src", "prefetch.rs"), "utf8");
check("batch_walk.rs: failed keys are excluded and discovery continues", () => {
  const wrapper = itemBody(BW, "pub(crate) async fn run_batch_walk<");
  assert(/run_batch_walk_paced\(initial, discover, prefetch, \|\| std::future::ready\(\(\)\), warn\)\.await/.test(wrapper), "unpaced = the paced loop with a no-op pace");
  const body = itemBody(BW, "pub(crate) async fn run_batch_walk_paced<");
  assert(/raw\.into_iter\(\)\.filter\(\|k\| !excluded\.contains\(k\)\)/.test(body), "excluded keys filtered from every later round");
  assert(/if excluded\.insert\(k\) \{\s*stats\.failed \+= 1;/.test(body), "failed keys excluded + counted");
  assert(!/\bbreak;\s*\}\s*\}\s*Ok\(\(\)\)/.test(body), "no break-and-Ok on a failed round");
  assert(/if misses == prev_misses \{\s*stats\.end = BatchWalkEnd::Stalled;/.test(body), "stall guard");
  assert(/discovery_rounds >= BATCH_WALK_MAX_ROUNDS/.test(body), "round cap");
  assert(/pub\(crate\) const BATCH_WALK_MAX_ROUNDS: u32 = 8;/.test(BW) && /pub\(crate\) const BATCH_WALK_ROUND_TRIES: u32 = 3;/.test(BW), "8 rounds / 3 tries, as run_walk_loop");
  assert(/-> BatchWalkStats\s*where/.test(body), "never fails: returns stats");
});
check("native unit tests pin the loop (self-contained, no dist)", () => {
  for (const name of [
    "failed_key_is_excluded_and_discovery_continues",
    "transient_whole_round_failure_is_retried_not_excluded",
    "persistent_whole_round_failure_excludes_the_round",
    "absent_key_ends_on_the_stall_guard",
    "deep_chain_stops_at_the_round_cap",
    "pace_runs_between_a_round_and_the_next_discovery",
    "pace_after_the_initial_round",
    "sub_walks_cover_the_single_walk_and_merge",
  ]) {
    assert(new RegExp(`async fn ${name}\\(\\)`).test(BW), `test ${name}`);
  }
  assert(/use holtburger_resource_http::RecordingSource;/.test(BW), "real RecordingSource discovery");
  assert(!/HOLTBURGER_DIST|ac_base_dats/.test(BW), "no dist dependency");
  assert(/#\[cfg\(any\(target_arch = "wasm32", test\)\)\]\s*mod batch_walk;/.test(LIB), "module gated wasm32 OR test");
});
check("prefetch.rs: batch-mode keyed walk binds PartialRound to per-key failures", () => {
  const plain = itemBody(PF, "pub(crate) async fn ensure_walk_prefetched_keyed_batch<F>(");
  assert(/ensure_walk_prefetched_keyed_batch_paced\(cache_key, source, walk, urgent, false\)\.await/.test(plain), "unpaced entry = paced(false)");
  const fn = itemBody(PF, "pub(crate) async fn ensure_walk_prefetched_keyed_batch_paced<F>(");
  assert(/BATCH_WALK_DEDUP\.with\(\|map\| \{\s*map\.get_or_install\(&cache_key/.test(fn), "own dedup map, keyed");
  const loop = itemBody(PF, "async fn run_batch_walk_loop<F>(");
  assert(/PrefetchError::PartialRound \{ failed, detail \} => RoundFailure \{\s*failed: Some\(failed\),/.test(loop), "PartialRound → exactly those keys");
  assert(/other => RoundFailure \{\s*failed: None,/.test(loop), "any other error fails the whole round");
  assert(/run_batch_walk\(Vec::new\(\), discover, prefetch,/.test(loop), "no initial keys");
  // The legacy loop is untouched for every other caller.
  const legacy = itemBody(PF, "async fn run_walk_loop<F>(");
  assert(/if !round_ok \{\s*break;\s*\}/.test(legacy), "run_walk_loop unchanged");
});

console.log("S9 — per-build stab memo");
check("armed only by a settled batch; keyed by stab id", () => {
  assert(/let stab_memo_on = matches!\(&stab_batch_stats, Some\(\(_, _, s\)\) if s\.settled\(\)\);/.test(FN), "settled() gate");
  assert(/let cached = stab_memo\.get\(&stab\.stab_id\)\.cloned\(\);/.test(FN), "lookup by stab id");
  assert(/if stab_memo_on \{\s*stab_memo\.insert\(stab\.stab_id, m\.clone\(\)\);/.test(FN), "insert only when armed");
  const settled = itemBody(BW, "    pub(crate) fn settled(&self) -> bool {".trimStart());
  assert(/self\.failed == 0 && matches!\(self\.end, BatchWalkEnd::Complete \| BatchWalkEnd::Stalled\)/.test(settled), "settled = nothing failed, complete or manifest-absent");
});
check("memo entry = the per-placement products, same order", () => {
  const entry = itemBody(LIB, "async fn interior_stab_memo_entry(");
  const a = idx(entry, "static_object_local_aabb(source.as_ref(), stab_id)", "aabb");
  const s = idx(entry, "static_object_default_script(source.as_ref(), stab_id)", "script");
  const n = idx(entry, "static_object_default_animation(source.as_ref(), stab_id)", "anim");
  const w = idx(entry, "ensure_walk_prefetched_keyed_batch(", "walk");
  const b = idx(entry, "walk_setup_parts_with_geom_and_bsp(source.as_ref(), stab_id)", "bsp");
  assert(a < s && s < n && n < w && w < b, "aabb < script < anim < walk < bsp (the per-placement order)");
  assert(/prefetch_urgent\(&\[ResourceKey::new\("eor\/portal", stab_id\)\]\)/.test(entry), "0x01: top-record prefetch as before");
  const stage = itemBody(LIB, "fn stage_interior_stab_bsps(");
  assert(/let pr = quat_rotate\(stab_world_orientation, b\.offset\);/.test(stage) && /stab_world_orientation\.multiply\(b\.rot\)/.test(stage), "0x02: the same part-frame composition");
  assert((stage.match(/CELL_STATIC_BSP_PENDING\.with/g) || []).length === 2, "stages into CELL_STATIC_BSP_PENDING (0x01 + 0x02)");
});

console.log("S10 — ?interiorStabChunk: concurrent paced sub-walks");
check("flag reader: default 40, off|0|false|no = one walk, parsed once over flag_search()", () => {
  const body = itemBody(LIB, "fn interior_stab_chunk_flag() -> Option<usize>");
  assert(/static FLAG: std::sync::OnceLock<Option<usize>>/.test(body), "OnceLock");
  assert(/batch_walk::parse_interior_stab_chunk_flag\(&flag_search\(\)\)/.test(body), "seeded flag_search()");
  const parse = itemBody(BW, "pub(crate) fn parse_interior_stab_chunk_flag(search: &str) -> Option<usize> {");
  assert(/"off" \| "0" \| "false" \| "no" => None/.test(parse), "the four off spellings → one walk");
  assert(/return Some\(INTERIOR_STAB_CHUNK_DEFAULT\);/.test(parse), "absent → default");
  assert(/pub\(crate\) const INTERIOR_STAB_CHUNK_DEFAULT: usize = 40;/.test(BW), "default 40");
  assert(/n\.clamp\(INTERIOR_STAB_CHUNK_MIN, INTERIOR_STAB_CHUNK_MAX\)/.test(parse), "explicit N clamped");
  for (const name of ["interior_stab_chunk_flag_grammar", "chunk_ids_balanced_in_order_and_bounded", "merge_all_is_settled_only_when_every_part_is"]) {
    assert(new RegExp(`fn ${name}\\(\\)`).test(BW), `native test ${name}`);
  }
});
check("ON: balanced chunks keyed LB + ids, paced, joined, merged; OFF: today's single walk + key", () => {
  const gate = idx(FN, "let stab_chunk = interior_stab_chunk_flag();", "chunk gate");
  const join = idx(FN, "futures::future::join(env_round, stab_walk).await", "join");
  assert(gate < join, "read before the joined stage");
  const stage = FN.slice(gate, join);
  const none = idx(stage, "None => {", "OFF arm");
  const some = idx(stage, "Some(chunk_max) => {", "ON arm");
  const off = stage.slice(none, some);
  assert(/prefetch::ensure_walk_prefetched_keyed_batch\(\s*prefetch::WalkCacheKey::new\("fetchEnvCellsInLandblock:stab-batch"\)\s*\.with_u32\(landblock_high\),\s*&source,/.test(off), "OFF: unpaced, today's key");
  const on = stage.slice(some);
  assert(/for chunk in batch_walk::chunk_ids\(&batch_ids, chunk_max\) \{/.test(on), "balanced chunks of the sorted ids");
  assert(/\.with_u32\(landblock_high\)\s*\.with_u32_slice\(&chunk\);/.test(on), "sub-walk key = LB + its ids");
  assert(/prefetch::ensure_walk_prefetched_keyed_batch_paced\(/.test(on), "paced sub-walks");
  assert(/futures::future::join_all\(sub_walks\)\.await/.test(on), "concurrent");
  assert(/batch_walk::BatchWalkStats::merge_all\(&parts\)/.test(on), "merged stats");
  const merge = itemBody(BW, "    pub(crate) fn merge_all(parts: &[BatchWalkStats]) -> BatchWalkStats {".trimStart());
  assert(/out\.rounds \+= p\.rounds;\s*out\.fetched \+= p\.fetched;\s*out\.failed \+= p\.failed;/.test(merge), "summed");
  assert(/if rank\(p\.end\) > rank\(out\.end\) \{/.test(merge), "worst end wins → settled iff every sub-walk settled");
});
check("chunk_ids: ceil(len / max) balanced chunks, in order", () => {
  const body = itemBody(BW, "pub(crate) fn chunk_ids(ids: &[u32], max: usize) -> Vec<Vec<u32>> {");
  assert(/let n = ids\.len\(\)\.div_ceil\(max\);/.test(body), "chunk count");
  assert(/let len = base \+ usize::from\(i < extra\);/.test(body), "sizes differ by at most one");
});

console.log("S11 — discovery pacing (?walkPace + the sub-walk pace hook)");
check("batch loop: pace before a discovery that follows a round, never before the first", () => {
  const body = itemBody(BW, "pub(crate) async fn run_batch_walk_paced<");
  assert(/if stats\.rounds > 0 \{\s*pace\(\)\.await;\s*\}\s*let raw = discover\(\);/.test(body), "pace → discover");
});
check("legacy loop: ?walkPace yield before discovery_round (after a prefetch round that suspended)", () => {
  const loop = itemBody(PF, "async fn run_walk_loop<F>(");
  assert(
    /for _round in 0\.\.8 \{[\s\S]*?if pace_next \{\s*maybe_pace_legacy_discovery\(\)\.await;\s*\}[\s\S]*?let misses = discovery_round\(inner_dyn, &walk\);/.test(loop),
    "paced before the discovery round",
  );
  // A warm (fully-resident) prefetch completes on its first poll: no turn.
  assert(/let mut pace_next = false;/.test(loop), "first discovery of a walk without initial keys: never paced");
  assert(/let \(initial, suspended\) = await_noting_suspend\(do_prefetch\(owned\)\)\.await;[\s\S]*?pace_next = suspended;/.test(loop), "initial-keys prefetch: paced only if it suspended");
  assert(/await_noting_suspend\(source\.prefetch_urgent\(&keys\)\)\.await[\s\S]*?await_noting_suspend\(source\.prefetch\(&keys\)\)\.await[\s\S]*?round_suspended \|= suspended;/.test(loop), "every round attempt notes suspension");
  assert(/if !round_ok \{\s*break;\s*\}\s*pace_next = round_suspended;/.test(loop), "next discovery paced iff the round suspended");
  const ans = itemBody(PF, "async fn await_noting_suspend<Fut>(fut: Fut) -> (Fut::Output, bool)");
  assert(/std::future::poll_fn\(/.test(ans) && /if polled\.is_pending\(\) \{\s*suspended = true;/.test(ans), "suspension = a Pending poll");
  const gate = itemBody(PF, "async fn maybe_pace_legacy_discovery() {");
  assert(/if walk_pace_flag\(\) && pace_context_is_main_thread\(\) \{\s*discovery_pace_turn\(false\)\.await;/.test(gate), "flag + main thread");
  const flag = itemBody(PF, "fn walk_pace_flag() -> bool {");
  assert(/crate::batch_walk::parse_walk_pace_flag\(&crate::flag_search\(\)\)/.test(flag), "seeded flag_search()");
  const parse = itemBody(BW, "pub(crate) fn parse_walk_pace_flag(search: &str) -> bool {");
  assert(/!trimmed\.split\('&'\)\.any\(/.test(parse), "absent reads ON");
  assert(/"walkPace=off" \| "walkPace=0" \| "walkPace=false" \| "walkPace=no"/.test(parse), "the four off spellings");
  assert(/fn walk_pace_flag_defaults_on_with_off_0_false_no_escape\(\)/.test(BW), "native grammar test");
});
check("pace turn: MessageChannel yield, skipped while hidden, main thread only; sub-walks gated the same", () => {
  const turn = itemBody(PF, "async fn discovery_pace_turn(sub_walk: bool) {");
  assert(/if crate::js_document_hidden\(\) \{\s*return;\s*\}/.test(turn), "no yield while hidden");
  assert(/crate::yield_to_event_loop\(\)\.await;/.test(turn), "the interior build's MessageChannel yield");
  assert(/"__hbWalkPace"/.test(turn), "diag global");
  const main = itemBody(PF, "fn pace_context_is_main_thread() -> bool {");
  assert(/JsValue::from_str\("document"\)/.test(main), "document present = main thread");
  const loop = itemBody(PF, "async fn run_batch_walk_loop<F>(");
  assert(/if pace \{[\s\S]*?run_batch_walk_paced\([\s\S]*?if pace_context_is_main_thread\(\) \{\s*discovery_pace_turn\(true\)\.await;[\s\S]*?\} else \{\s*run_batch_walk\(Vec::new\(\), discover, prefetch, warn\)\.await/.test(loop), "paced only when asked; unpaced = run_batch_walk");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
