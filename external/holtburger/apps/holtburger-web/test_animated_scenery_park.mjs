// Animated scenery vs THE PARK TRAP (2026-08-01).
//
// THE BUG. `landblock_lru.js park()` (DEFAULT-ON since 2026-07-10) detaches an
// LB's `staticsGroup` children into the warm-park pool, disposes NOTHING, and
// KEEPS the statics baked mark so re-entry is a pure re-attach. Animated
// scenery nodes carry `userData.landblockId`, so park sweeps them up with the
// rest of the LB's statics — and `animated_scenery.js::_isOrphaned` (which
// only asks "is my topmost ancestor still the Scene?") cannot tell that apart
// from a real eviction. The rAF reclaim loop therefore ran the full teardown
// on a PARKED node: `_reclaimInstancedSlots` (frees its InstancedMesh slots),
// `geometry.dispose()` on the legacy per-mesh path, `_builtKeys.delete`,
// `_instances.splice`. Unpark then re-attached a DEAD anchor — no instance
// record, no bucket slots — and because park kept `staticsBakedLbs` marked,
// `loadStaticsForLandblock` short-circuits and NOTHING ever re-bakes it. The
// tree is gone for the rest of the session, and every park/unpark round trip
// takes more of them.
//
// THE FIX. `_isParkedLb(node)` asks the LRU whether the node's landblock is
// merely parked. A parked node is detached (invisible, un-posed), so the loop
// just skips it. Once the pool TRUE-disposes the LB (`disposeParked` →
// `evict`) the key leaves `parkPool`, the predicate goes false, the next frame
// reclaims exactly as before — and `evict` has by then cleared
// `staticsBakedLbs`, so re-entry legitimately re-bakes.
//
// This suite locks the PREDICATE. The rAF loop that consumes it is
// module-private and needs a live wasm bake to drive, so its wiring is
// verified live (see the commit message for the console one-liner).
//
// Run from apps/holtburger-web/:  node test_animated_scenery_park.mjs

let failed = 0, passed = 0;
function check(name, ok, detail) {
  console.log(`  [${ok ? "OK" : "FAIL"}] ${name}${detail ? " — " + detail : ""}`);
  ok ? (passed += 1) : (failed += 1);
}

// animated_scenery.js imports three at module scope; the worktree symlinks
// node_modules, so this is a plain import.
globalThis.window = { location: { search: "" } };
const { _isParkedLb } = await import("./scene3d/animated_scenery.js");

const LB = 0xbb9f0000;            // packed lb-key
const CELL = 0xbb9f0040;          // same LB, outdoor cell low word
const OTHER = 0xbc9f0000;

function nodeFor(landblockId) {
  return landblockId === undefined ? {} : { userData: { landblockId } };
}
function lruStub(parkedKeys) {
  const pool = new Set(parkedKeys);
  return { isParked: (id) => pool.has(((id >>> 0) & 0xffff0000) >>> 0) };
}

console.log("animated scenery — the park trap");

// ── No LRU reachable ⇒ fail-soft false (today's behaviour everywhere the
//    LRU is absent: headless suites, capture paths, ?warmPark=off). ────────
{
  window.liveScene3d = null;
  window.__landblockLru = null;
  check("no LRU ⇒ false", _isParkedLb(nodeFor(LB)) === false);
  check("null node ⇒ false", _isParkedLb(null) === false);
  check("node without a landblockId ⇒ false", _isParkedLb(nodeFor(undefined)) === false);
}

// ── liveScene3d facade ────────────────────────────────────────────────────
{
  window.liveScene3d = { landblockLru: lruStub([LB]) };
  window.__landblockLru = null;
  check("parked LB via liveScene3d ⇒ true", _isParkedLb(nodeFor(LB)) === true);
  check("un-parked LB ⇒ false", _isParkedLb(nodeFor(OTHER)) === false);
  check("a full cell id masks to the lb-key", _isParkedLb(nodeFor(CELL)) === true);
}

// ── window.__landblockLru fallback (liveScene3d not stamped yet — the
//    documented one-time-snapshot trap). ───────────────────────────────────
{
  window.liveScene3d = null;
  window.__landblockLru = lruStub([LB]);
  check("parked LB via window.__landblockLru ⇒ true", _isParkedLb(nodeFor(LB)) === true);
  check("un-parked LB via fallback ⇒ false", _isParkedLb(nodeFor(OTHER)) === false);
}

// ── A throwing / half-built LRU must never break the reclaim loop. ────────
{
  window.liveScene3d = { landblockLru: { isParked() { throw new Error("boom"); } } };
  window.__landblockLru = null;
  check("throwing isParked ⇒ false (fail-soft)", _isParkedLb(nodeFor(LB)) === false);
  window.liveScene3d = { landblockLru: {} };   // no isParked (stale bundle)
  check("LRU without isParked ⇒ false", _isParkedLb(nodeFor(LB)) === false);
  window.liveScene3d = { landblockLru: lruStub([]) };
  check("empty pool ⇒ false", _isParkedLb(nodeFor(LB)) === false);
}

// ── Truthiness discipline: only a strict `true` counts, so a stale bundle
//    returning a truthy non-boolean can't wedge an instance resident. ─────
{
  window.liveScene3d = { landblockLru: { isParked: () => 1 } };
  check("truthy non-boolean ⇒ false (=== true only)", _isParkedLb(nodeFor(LB)) === false);
}

console.log(`\nanimated scenery park trap: ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
