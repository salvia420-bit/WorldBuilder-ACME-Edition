# Upstream candidate — DatReaderWriter `Tree.TryDelete` corrupts the b-tree

Companion to `upstream-drw-decompress-fix.md`. Repro tool, patch and evidence are
all in-tree; nothing here is speculative.

- Repro: `tools/dat-patch/DatDeleteRepro/` (synthetic, no retail dats needed).
- Patch: `docs/dat-patch/patches/drw-btree-delete-fix.patch`
  (= commit `694c4ac` on branch `acme/fix-btree-delete` in the vendored
  `external/DatReaderWriter` checkout; that checkout is left on `master`, so
  `git checkout acme/fix-btree-delete` to build the fixed side).
- Field discovery: the r8 HIFI split, 2026-08-19 — 2,412 requested deletes on the
  1.43 GiB r7.2 portal produced 169 landed deletes, **3 innocent records lost**,
  1 phantom id, and broken lookups after ~213
  (`/mnt/wbterminal2/dat-patch-r8/split/split-run-DELETE-CORRUPTION.log`).
  The split was rebuilt as pure reconstruction; **no tool in our lane calls
  TryDelete.**

## Symptom
Once deletes touch internal nodes, `TryDelete` starts returning false for keys
that are present, silently drops keys nobody asked to delete, admits ids that were
never inserted, and leaves records that an in-order walk still yields but
`TryGetFile` can no longer find.

## The four defects (all in `DatBTreeReaderWriter`'s rebalance path)
1. **`DeleteKeyFromSubtree`, borrow-from-left**: the separator between
   `leftSibling` and `childNode` is `parentNode.Files[subtreeIndexInNode - 1]`.
   The code used `Files[subtreeIndexInNode]` — the separator to the child's
   RIGHT. Both the key rotated down and the key rotated up are then wrong.
2. **`DeleteKeyFromSubtree`, merge-with-left**: same off-by-one, in the key that
   sinks into the merged node *and* in `parentNode.RemoveFileAt(...)`, so the
   parent loses the wrong separator.
   (The right-sibling borrow and merge paths are correct — the bug is one-sided.)
3. **`DeleteKeyFromNode`**: `DeleteSuccessor(predecessorChild)` — the successor
   of the deleted key lives in `successorChild`. As written it removes the
   smallest key of the LEFT subtree and installs it as the separator.
4. **`DeleteSuccessor`**: the non-leaf path recurses into `DeletePredecessor`,
   returning the rightmost key of the leftmost subtree instead of the leftmost.

## Why it survived the test suite
`CanDeleteFileEntries` deletes **every** key, **in ascending order**, for
N ≤ 1000. That is the one pattern that does not corrupt:

| N=5000, seed 1 | ascending | shuffled |
|---|---|---|
| delete every key (stride 1) | CLEAN | CORRUPT |
| every 2nd / 3rd / 5th / 7th / 13th | CORRUPT | CORRUPT |

Deleting every key in order collapses nodes uniformly from the left, so the
mis-indexed separator is always the key that was about to be removed anyway.

## Repro and result
```
dotnet tools/dat-patch/DatDeleteRepro/bin/Release/net8.0/DatDeleteRepro.dll --bisect
```
Inserts N sparse ids (shuffled insert order), deletes every 8th ascending, then
asserts: requested keys gone; every other key present *and* findable by
`TryGetFile`; in-order walk sorted with no ids that were never inserted.

| entries | before the patch | after |
|---|---|---|
| 62 – 400 | clean (tree still shallow) | clean |
| 800 | 5 out-of-order, 89 lookup misses | clean |
| 2,000 | 8 refused, 1 lost, 1 phantom, 21 unordered, 303 lookup misses | clean |
| 20,000 | 436 refused, 1 lost, 1 phantom, 166 unordered, 6,273 lookup misses | clean |

Post-patch sweep: N=5,000 × strides {1,2,3,5,7,13} × seeds {1,2,3} × {ascending,
shuffled} = 36/36 CLEAN. The library's own synthetic b-tree tests are unchanged
(36 pass / 23 fail both before and after — the 23 are EOR fixture tests whose
retail dats are absent from this checkout).

## Suggested upstream test
Add a delete case that (a) deletes a *subset*, (b) at N large enough for a
multi-level tree (≥ 1,000), (c) then asserts the survivors are all still
retrievable and the walk is sorted. Any of those three alone would have caught
this; the current test has none of them.
