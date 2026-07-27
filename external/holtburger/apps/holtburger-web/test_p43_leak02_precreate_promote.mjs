// P4.3 / LEAK-02 (2026-07-27) — `EntityManager.remove()` purge ordering +
// the `?preCreateBuffer` default-ON promotion.
//
// Retail shape being closed: `CObjectMaint::DeleteObject(unsigned int)`
// (acclient.c:309939) misses the `weenie_object_table` bucket at
// :309986-309988 and jumps past the `null_weenie_object_table` removal at
// :309999, which sits inside the hit branch opened at :309995 — a guid
// present ONLY in the placeholder table is unreachable from the delete path.
// Ours was the same shape: `remove()` bailed on `if (!inst) return;` before
// the `_pendingAttach` / `_pendingVisibility` / `_preCreate` purges, and a
// park exists only for guids with no committed `entityMap` entry.
//
// Standalone node ESM test (no live ACE session, no browser). Three parts:
//   PART 1 — the SHIPPED flag reader, extracted from scene3d/entities.js and
//            executed in a vm context with a synthetic `window`. Asserts the
//            promoted semantics on real code, not on a doc claim.
//   PART 2 — purge ORDERING inside the shipped `remove()` body: statement
//            positions in the real source, not a re-implementation.
//   PART 3 — behavioral: the pure buffer module drains to zero under the
//            despawn-before-spawn sequence and across a session reset.
//
// Run:
//   cd apps/holtburger-web/
//   node test_p43_leak02_precreate_promote.mjs

import { fileURLToPath } from "node:url";
import { dirname, join as joinPath } from "node:path";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const __dirname = dirname(fileURLToPath(import.meta.url));

let failed = 0;
let passed = 0;
function check(name, ok, detail) {
  const status = ok ? "OK" : "FAIL";
  console.log(`  [${status}] ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failed += 1;
  else passed += 1;
}

const entitiesSrc = readFileSync(joinPath(__dirname, "scene3d", "entities.js"), "utf8");

// =====================================================================
// PART 1 — the shipped flag reader, executed.
// =====================================================================
console.log("PART 1 — shipped readPreCreateBufferFlag() semantics");

// Slice the real function out of entities.js by symbol, brace-matched, so
// this cannot drift into testing a copy.
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}() {`);
  if (start < 0) return null;
  let depth = 0;
  for (let i = src.indexOf("{", start); i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) return src.slice(start, i + 1);
    }
  }
  return null;
}

const readerSrc = extractFn(entitiesSrc, "readPreCreateBufferFlag");
check("readPreCreateBufferFlag() found in scene3d/entities.js", readerSrc !== null);

// Run the extracted reader against a synthetic `window`. `warns` collects
// the unrecognised-token warning so PART 1 can assert it is not silent.
let warns = [];
function readFlagWith(search) {
  warns = [];
  const sandbox = {
    URLSearchParams,
    console: { warn: (m) => warns.push(String(m)) },
    // `undefined` here reproduces the no-browser branch: `typeof window`
    // on a declared-but-undefined binding is still "undefined".
    window: search === null ? undefined : { location: { search } },
  };
  vm.createContext(sandbox);
  return vm.runInContext(`${readerSrc}; readPreCreateBufferFlag();`, sandbox);
}

check("param ABSENT → ON (the promotion)", readFlagWith("") === true);
check("?preCreateBuffer=off → OFF (the escape)", readFlagWith("?preCreateBuffer=off") === false);
check("?preCreateBuffer=OFF → OFF (case-insensitive)", readFlagWith("?preCreateBuffer=OFF") === false);
check("?preCreateBuffer=on → ON", readFlagWith("?preCreateBuffer=on") === true);
check("?preCreateBuffer= (empty) → ON", readFlagWith("?preCreateBuffer=") === true);
check("bare ?preCreateBuffer → ON", readFlagWith("?preCreateBuffer") === true);
check("no window at all (node/worker) → ON, matching the page default", readFlagWith(null) === true);

// The footgun class this reader is written against: a bare `!== "off"`
// reader answers ON for all of these, silently.
check("?preCreateBuffer=false → OFF (not the `!== \"off\"` footgun)", readFlagWith("?preCreateBuffer=false") === false);
check("?preCreateBuffer=0 → OFF", readFlagWith("?preCreateBuffer=0") === false);
check("?preCreateBuffer=no → OFF", readFlagWith("?preCreateBuffer=no") === false);
check("?preCreateBuffer=1 → ON", readFlagWith("?preCreateBuffer=1") === true);
check("?preCreateBuffer=true → ON", readFlagWith("?preCreateBuffer=true") === true);

// Other flags' params must not bleed into this one.
check("an unrelated param does not disable", readFlagWith("?deadReckon=off&spawnHiddenState=off") === true);

{
  const v = readFlagWith("?preCreateBuffer=yes-please");
  check("unrecognised token → default ON *and* warns (no silent fallback)", v === true && warns.length === 1, warns[0] || "no warn");
}
{
  readFlagWith("?preCreateBuffer=off");
  check("the documented escape does NOT warn", warns.length === 0);
}
{
  readFlagWith("");
  check("the bare default does NOT warn (clean console on a default boot)", warns.length === 0);
}

// =====================================================================
// PART 2 — purge ordering inside the shipped remove().
// =====================================================================
console.log("PART 2 — remove() purge ordering (LEAK-02)");

const removeStart = entitiesSrc.indexOf("\n  remove(guid) {");
check("remove(guid) found in scene3d/entities.js", removeStart > 0);

// Brace-match the method body so the offsets below cannot pick up a
// same-named statement from a neighbouring method.
const removeBody = (() => {
  let depth = 0;
  for (let i = entitiesSrc.indexOf("{", removeStart); i < entitiesSrc.length; i += 1) {
    if (entitiesSrc[i] === "{") depth += 1;
    else if (entitiesSrc[i] === "}") {
      depth -= 1;
      if (depth === 0) return entitiesSrc.slice(removeStart, i + 1);
    }
  }
  return "";
})();

const iBail = removeBody.indexOf("if (!inst) return;");
const iPreCreate = removeBody.indexOf("this._preCreate.purgeGuid(g);");
const iAttach = removeBody.indexOf("this._pendingAttach.delete(g);");
const iVis = removeBody.indexOf("this._pendingVisibility.delete(g);");

check("remove() still has the `!inst` early-return", iBail > 0);
check(
  "_preCreate.purgeGuid(g) runs BEFORE the `!inst` early-return",
  iPreCreate > 0 && iPreCreate < iBail,
  `purge@${iPreCreate} bail@${iBail}`,
);
check(
  "_pendingAttach.delete(g) runs BEFORE the `!inst` early-return",
  iAttach > 0 && iAttach < iBail,
  `purge@${iAttach} bail@${iBail}`,
);
check(
  "_pendingVisibility.delete(g) runs BEFORE the `!inst` early-return",
  iVis > 0 && iVis < iBail,
  `purge@${iVis} bail@${iBail}`,
);
// Each purge must appear exactly once — a duplicate after the bail would
// make the ordering assertions above pass while leaving dead code behind.
for (const [label, stmt] of [
  ["_pendingAttach.delete", "this._pendingAttach.delete(g);"],
  ["_pendingVisibility.delete", "this._pendingVisibility.delete(g);"],
  ["_preCreate.purgeGuid", "this._preCreate.purgeGuid(g);"],
]) {
  const n = removeBody.split(stmt).length - 1;
  check(`${label}(g) appears exactly once in remove()`, n === 1, `${n}×`);
}
// The spawn-generation bump must stay ahead of everything (Batch 9 #2).
check(
  "the _spawnGen bump still precedes the purges",
  removeBody.indexOf("this._spawnGen.set(g,") > 0 &&
    removeBody.indexOf("this._spawnGen.set(g,") < iAttach,
);

console.log("PART 2b — session-reset clear (LEAK-02 relog arm)");
const cwStart = entitiesSrc.indexOf("  clearWorldEntities() {");
const cwBody = entitiesSrc.slice(cwStart, entitiesSrc.indexOf("\n  }", cwStart));
check("clearWorldEntities() clears the generic buffer", cwBody.includes("this._preCreate.clear();"));
check("clearWorldEntities() clears _pendingAttach", cwBody.includes("this._pendingAttach.clear();"));
check("clearWorldEntities() clears _pendingVisibility", cwBody.includes("this._pendingVisibility.clear();"));

// =====================================================================
// PART 3 — behavioral: the pure buffer under the LEAK-02 sequences.
// =====================================================================
console.log("PART 3 — behavioral (pure buffer module)");

const { createPreCreateBuffer } = await import("./scene3d/pre_create_buffer.js");

// (a) The LEAK-02 sequence itself: events park for a guid that never
//     spawns, then ObjectDelete arrives. With the purge hoisted above the
//     `!inst` bail, remove()'s purgeGuid is now reached for exactly this
//     guid, so the bucket must be gone immediately — not 25 s later.
{
  const b = createPreCreateBuffer({ now: () => 0 });
  const GHOST = 0xdeadbeef;
  b.enqueue(GHOST, "visibility", { visible: false });
  b.enqueue(GHOST, "attach", { parentGuid: 1 }, { dedupeKind: true });
  check("park for a never-spawned guid is non-empty before the delete", b.size() === 2 && b.guidCount() === 1);
  b.purgeGuid(GHOST); // what remove() now reaches on the `!inst` path
  check(
    "despawn-before-spawn purges the bucket immediately (not at the 25 s sweep)",
    b.size() === 0 && b.guidCount() === 0,
  );
}

// (b) purgeGuid stays surgical — a sibling guid's park is untouched.
{
  const b = createPreCreateBuffer({ now: () => 0 });
  b.enqueue(1, "visibility", { visible: true });
  b.enqueue(2, "visibility", { visible: true });
  b.purgeGuid(1);
  check("purgeGuid leaves other guids' parks alone", b.guidCount() === 1 && b.hasFor(2) && !b.hasFor(1));
}

// (c) clear(): a session reset drops every bucket. Without it a park from
//     the dead session survives into a fresh guid space where no spawn can
//     ever drain it (the flag-off legacy maps have no sweeper at all).
{
  const b = createPreCreateBuffer({ now: () => 0 });
  b.enqueue(1, "visibility", { visible: true });
  b.enqueue(2, "attach", { parentGuid: 3 });
  b.enqueue(2, "visibility", { visible: false });
  const dropped = b.clear();
  check("clear() drops every bucket and returns the guid count", dropped === 2 && b.size() === 0 && b.guidCount() === 0);
  check("clear() leaves the buffer usable", (b.enqueue(9, "visibility", { visible: true }), b.size() === 1));
}

// (d) clear() on an empty buffer is a no-op (clearWorldEntities runs on
//     every disconnect, including ones with nothing parked).
{
  const b = createPreCreateBuffer({ now: () => 0 });
  check("clear() on an empty buffer is a no-op returning 0", b.clear() === 0 && b.size() === 0);
}

// (e) The 25 s expiry is still the backstop for parks remove() never sees
//     (a guid the server never mentions again). Retail 25.0 s at
//     acclient.c:310666.
{
  let t = 0;
  const b = createPreCreateBuffer({ now: () => t });
  b.enqueue(5, "visibility", { visible: true });
  t = 25000;
  check("backstop: bucket alive at exactly 25 000 ms (> not >=)", b.expire(t) === 0 && b.size() === 1);
  t = 25001;
  check("backstop: bucket expires at 25 001 ms", b.expire(t) === 1 && b.size() === 0);
}

// =====================================================================
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
