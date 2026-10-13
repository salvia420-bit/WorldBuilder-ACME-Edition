// tests/ace_obj_maint.test.mjs — streaming-residency-1 (WebAC comparison,
// 2026-10-13): `?aceObjMaint=on`, the ACE-parity visibility prune.
//
// The wasm world's 25 s out-of-visibility prune (liveness.rs, forwarded to
// the rigs by `?maintPrune`) only armed for entities outside a conservative
// set: the player's 3x3 landblocks OR anything within 384 m. ACE's set is
// narrower (`ObjectMaint.GetVisibleObjects`: outdoors the landblock +
// adjacents minus objects in non-SeenOutside EnvCells; in an EnvCell its own
// cell + VisibleCells) and ACE sends nothing about an object after it leaves
// that set, so the client kept frozen ghosts. Retail drops them too
// (`CObjectMaint::AddObjectToBeDestroyed` +25 s, acclient.c:310651).
//
// The predicate itself is covered by Rust unit tests
// (crates/holtburger-world/src/state/tests.rs `test_ace_object_maint_*`) and
// the parse shape by the wasm crate's `ace_obj_maint_flag_is_strict_opt_in`.
// This file pins the wiring around them (source assertions; wasm cannot load
// under node): strict opt-in, default path untouched.
//
// Run: node tests/ace_obj_maint.test.mjs   (from apps/holtburger-web/)

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const here = new URL(".", import.meta.url);
const src = (rel) => readFileSync(new URL(rel, here), "utf8");
const WORLD = "../../../crates/holtburger-world/src/";

test("?aceObjMaint is a strict =on opt-in wasm flag, installed on the world", () => {
  const lib = src("../src/lib.rs");
  const at = lib.indexOf("fn parse_ace_obj_maint_flag(search: &str) -> bool {");
  assert.ok(at > 0, "parser exists");
  const body = lib.slice(at, at + 300);
  assert.match(body, /trimmed\.split\('&'\)\.any\(\|kv\| kv == "aceObjMaint=on"\)/, "exact =on");
  assert.doesNotMatch(body, /!trimmed/, "absent = OFF (not an =off escape)");
  assert.match(lib, /let ace_obj_maint_on: bool = parse_ace_obj_maint_flag\(&flag_search\(\)\);/);
  const flags = lib.slice(lib.indexOf("flags: session::LoopFlags {"));
  assert.match(flags.slice(0, 3000), /\bace_obj_maint_on,/, "rides LoopFlags");
  assert.match(src("../src/session/mod.rs"), /pub\(crate\) ace_obj_maint_on: bool,/);
  for (const f of ["../src/session/messages/login.rs", "../src/session/commands/lifecycle.rs"]) {
    const s = src(f);
    assert.match(s, /\bace_obj_maint_on,/, `${f} destructures the flag`);
    assert.match(s, /new_world\.set_ace_object_maint_enabled\(ace_obj_maint_on\);/, f);
  }
});

test("liveness keeps the conservative predicate and 25 s as the default", () => {
  const live = src(WORLD + "state/liveness.rs");
  assert.match(live, /const ACE_DESTRUCTION_TIMEOUT_SECS: f64 = 25\.0;/);
  assert.match(live, /const CONSERVATIVE_VISIBILITY_DISTANCE_M: f32 = 384\.0;/);
  assert.match(live, /const ACE_OBJECT_MAINT_DESTRUCTION_TIMEOUT_SECS: f64 = 30\.0;/);
  // The carrier is a plain bool on the Default-derived lifecycle store → OFF.
  const store = live.slice(live.indexOf("pub(crate) struct EntityLifecycleStore {"));
  assert.match(live, /#\[derive\(Debug, Default\)\]\s*pub\(crate\) struct EntityLifecycleStore \{/);
  assert.match(store.slice(0, 1200), /\n\s*ace_object_maint: bool,/);
  // The ACE view bails out first when the flag is off, so the default path
  // falls through to the untouched 3x3-or-384 m predicate.
  const view = live.slice(live.indexOf("fn ace_object_maint_view(&self)"));
  assert.match(view.slice(0, 300), /if !self\.entity_lifecycle\.ace_object_maint \{\s*return None;\s*\}/);
  const visible = live.slice(live.indexOf("fn current_visible_world_guids(&self)"));
  assert.match(
    visible.slice(0, 2500),
    /self\.is_conservatively_visible_world_entity\(entity, &nearby_guids\)/,
    "conservative predicate still the fallback",
  );
  // The deadline only lengthens under the flag.
  assert.match(
    live,
    /let destruction_timeout = if self\.entity_lifecycle\.ace_object_maint \{\s*ACE_OBJECT_MAINT_DESTRUCTION_TIMEOUT_SECS\s*\} else \{\s*ACE_DESTRUCTION_TIMEOUT_SECS\s*\};/,
  );
  assert.match(live, /self\.set_entity_prune_deadline\(guid, now \+ destruction_timeout\);/);
});

test("an unloaded SeenOutside bit is visible (Option accessor, not the false fold)", () => {
  const scene = src(WORLD + "spatial/scene.rs");
  assert.match(
    scene,
    /pub fn cell_seen_outside_opt\(&self, cell_id: u32\) -> Option<bool> \{\s*self\.cell_seen_outside\.get\(&cell_id\)\.copied\(\)\s*\}/,
  );
  // The old accessor (ambient gate) keeps its false fold.
  assert.match(scene, /self\.cell_seen_outside\.get\(&cell_id\)\.copied\(\)\.unwrap_or\(false\)/);
  const live = src(WORLD + "state/liveness.rs");
  assert.match(live, /self\.scene\.cell_seen_outside_opt\(cell\) != Some\(false\)/, "unknown = visible");
  assert.match(live, /let seen_outside = self\.scene\.cell_seen_outside_opt\(cell\)\?;/, "no player cell data → fallback");
  assert.doesNotMatch(live, /self\.scene\.cell_seen_outside\(/, "liveness never reads the false-folding accessor");
});
