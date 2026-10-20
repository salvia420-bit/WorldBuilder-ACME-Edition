// scene3d/bulk_child_remove.js — remove many children from one three.js
// parent in ONE order-preserving pass.
//
// 2026-10-20 (improvement hunt A3 / open-frontier-perf-2, step 1): the LRU's
// park/evict loops detached an LB's statics / buildings / terrain children one
// `parent.remove(c)` at a time. three r184 Object3D.remove is
// `children.indexOf(c)` + `children.splice(i, 1)` per call, so k removals from
// an n-child group cost O(k·n). Since staticAnchorFreeze / staticScriptRadius
// (10-17) the frozen static-script anchors stay direct staticsGroup children
// for every resident LB — ~14k children at Linvak's 9×9 ring — and removing
// one ~290-child LB (oldest first, i.e. from the front of `children`) measured
// ~10 ms on the laptop at 14k children, ~14 ms at 23k. V8's splice is bimodal
// there: a backing store that ever held more than ~16k slots sits in
// large-object space, cannot be left-trimmed, and every remove() memmoves the
// whole array (~30 µs); a never-grown array can show ~1 ms for the same LB.
// A session's staticsGroup grows and shrinks with LB churn, so the slow mode
// is the realistic one. One compaction pass is O(n + k): ~0.25-0.5 ms at 14k
// children, ~0.5 ms at 23k, either mode.
//
// What is IDENTICAL to calling `group.remove(c)` for each `c` of `kill`, in
// order (pinned by tests/bulk_child_remove.test.mjs):
//   - the surviving children and their order (in-place compaction, so the
//     `children` ARRAY IDENTITY is kept too — nothing holding the array sees
//     a new one);
//   - `parent === null` on every removed child; survivors untouched;
//   - a kill entry that is not a child (null, already detached, parented
//     elsewhere) is a no-op; a duplicate entry removes the child once;
//   - the events: per removed child, in KILL order (not children order),
//     'removed' dispatched on the child, then 'childremoved' { child } on the
//     parent — same types, same targets, same `child` field, same sequence.
// The one deliberate difference: listeners run after the compaction, so a
// listener reading `group.children` sees the whole batch already gone (three
// shows it the batch half-removed). The graph is consistent either way — every
// child in `children` has `parent === group`, every removed one `null`. No
// app code listens for 'removed' / 'childremoved' (rg 2026-10-20) and neither
// does three r184 itself.
//
// HOW (no per-child hashing): a Set lookup per child of the WHOLE group
// measured ~2x the cost of one `parent` pointer compare at 14k children
// (cache-missing identity hashes). So the kill entries are MARKED by nulling their
// `parent` first (only entries whose parent IS this group — three's own
// invariant `child.parent === group` ⇔ `child ∈ group.children`, which add()
// and remove() maintain), and the pass keeps every child whose parent is
// still `group`; only the k null-parent children consult a Set. A marked
// entry the pass never meets (parent said group but it was not in
// `children` — impossible through three's API) gets its parent back and no
// event, as three's indexOf -1 no-op would leave it. The mirror case — a
// kill entry sitting in `children` with some OTHER parent — is the one input
// where the pass differs (it keeps the entry; three would splice it out);
// that graph can only come from writing `children` / `parent` by hand, which
// nothing does to terrainGroup / buildingsGroup / staticsGroup.
//
// Pure leaf: no URL reads, no three import. The flag (`?bulkChildRemove=off`)
// lives with the caller (landblock_lru.js).

// Same shapes as three's module-private `_removedEvent` / `_childremovedEvent`
// singletons (EventDispatcher stamps `target` and clears it after).
const _removedEvent = { type: "removed" };
const _childremovedEvent = { type: "childremoved", child: null };

// Below this many kills the plain per-child `remove()` is kept: each remove
// is an indexOf + memmove (a few µs in splice's fast mode, ~30 µs at 14k in
// its slow mode), while the pass reads every child of the group (~18-34 ns
// each at 14k, polymorphic children). The cost ratio does not depend on n:
// crossover k≈90-170 against the fast mode, k≈8-15 against the slow one
// (laptop, three r184, 2026-10-20). 16 never loses more than ~0.4 ms to the
// fast mode and wins from k≈16 in the slow one. Results are identical either
// side (tests/bulk_child_remove.test.mjs covers both).
export const BULK_CHILD_REMOVE_MIN_KILL = 16;

const _hasOwn = Object.prototype.hasOwnProperty;

function _dispatchRemoved(group, c) {
  c.dispatchEvent(_removedEvent);
  _childremovedEvent.child = c;
  try {
    group.dispatchEvent(_childremovedEvent);
  } finally {
    _childremovedEvent.child = null;
  }
}

/**
 * Remove every child of `group` listed in `kill` (Array or Set), preserving
 * the order of the survivors. Equivalent to `for (c of kill) group.remove(c)`
 * (see the header for the exact contract).
 *
 * Falls back to exactly that per-child loop when `group` is not a three
 * Object3D (test stubs with a recording `remove()`), when `remove` is
 * patched on the instance (an instrumented group must keep seeing its
 * calls), or when `kill` has fewer than BULK_CHILD_REMOVE_MIN_KILL entries.
 *
 * @param {object} group     the parent (three Object3D for the bulk path)
 * @param {Iterable<object>} kill  children to remove (Array or Set)
 * @param {boolean} [failSoft=false]  isolate each child's remove (fallback
 *   loop) or event pair (bulk path) in try/catch — mirrors callers that wrap
 *   every `remove()` in try/catch.
 * @returns {number} how many children left `group.children` (stub groups
 *   without a children array report the number of `remove()` calls made)
 */
export function removeChildrenBulk(group, kill, failSoft = false) {
  if (!group || !kill) return 0;
  const killCount = Array.isArray(kill) ? kill.length : (kill instanceof Set ? kill.size : -1);
  if (killCount === 0) return 0;
  const children = group.children;
  const bulk =
    killCount >= BULK_CHILD_REMOVE_MIN_KILL &&
    group.isObject3D === true &&
    Array.isArray(children) &&
    typeof group.dispatchEvent === "function" &&
    !_hasOwn.call(group, "remove");
  if (!bulk) {
    if (typeof group.remove !== "function") return 0;
    const before = Array.isArray(children) ? children.length : -1;
    let calls = 0;
    for (const c of kill) {
      calls++;
      if (failSoft) {
        try { group.remove(c); } catch (_) { /* fail-soft per child */ }
      } else {
        group.remove(c);
      }
    }
    return before >= 0 && Array.isArray(group.children) ? before - group.children.length : calls;
  }

  // 1. Mark: null the parent of every entry that is a child of `group`, in
  //    kill order. A duplicate entry finds `parent === null` and is skipped.
  const order = [];
  const marked = new Set();
  for (const c of kill) {
    if (c != null && c.parent === group) {
      c.parent = null;
      order.push(c);
      marked.add(c);
    }
  }
  if (order.length === 0) return 0;

  // 2. Compact in place. `marked.delete` is true only for the first slot of
  //    a marked child, so the pass removes exactly one occurrence of each.
  const len = children.length;
  let w = 0;
  for (let i = 0; i < len; i++) {
    const c = children[i];
    if (c != null && c.parent === null && marked.delete(c)) continue;
    if (w !== i) children[w] = c;
    w++;
  }
  children.length = w;

  // 3. Anything still marked was never in `children`: undo the mark (three's
  //    remove would not have touched it) and give it no event.
  if (marked.size > 0) {
    for (const c of marked) c.parent = group;
  }

  // 4. Events in KILL order, once per removed child.
  let count = 0;
  for (let i = 0; i < order.length; i++) {
    const c = order[i];
    if (marked.size > 0 && marked.has(c)) continue;
    count++;
    if (failSoft) {
      try { _dispatchRemoved(group, c); } catch (_) { /* fail-soft per child */ }
    } else {
      _dispatchRemoved(group, c);
    }
  }
  return count;
}
