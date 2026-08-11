# TASK a3 — PORTAL-GRAPH-SPLIT (+ PORTAL-SMALL riders)

Branch `fanout-D-a3`, worktree `/home/wbterminal/fanout-D/a3`. Queue items
`PORTAL-GRAPH-SPLIT` (C2, primary) and `PORTAL-SMALL` (C7+C8 riders) from
`queue-1070/batch-D-2026-08-10.json` → `postBakeCodeWork[0].items`.

Status: **DONE**. All acceptance bullets MET; no BLOCKED gate. Nothing pushed.

---

## What landed (commits)

Three bisectable commits, in the card's order (adjacency graph → consumer moves
→ riders), with leg 1 deliberately a provable no-op so the behaviour change is
isolated to leg 2.

| Commit | Title | Files |
|---|---|---|
| `ea290916` | PORTAL-GRAPH-SPLIT leg 1 — cell_adjacency beside cell_portal_graph | scene.rs |
| `dbc92844` | PORTAL-GRAPH-SPLIT leg 2 — route visible_cells[] to the render graph only | scene.rs, lib.rs, tests.rs, env840_seam_tests.rs, examples/route_validate.rs |
| `d9953810` | PORTAL-SMALL riders — closed EnvCell id range + a per-snapshot AABB index | scene.rs, lib.rs, tests.rs |

941 insertions / 78 deletions over 5 files.

### Leg 1 — the second graph (no behaviour change)

`SpatialScene.cell_adjacency: Arc<HashMap<u32, Vec<u32>>>` lands beside
`cell_portal_graph` with identical keying, directedness, COW shape and
landblock-unload lifetime (both the per-LB `clear_cells_for_landblock` retain
and the batched `clear_landblocks_collision` one; edge counts stay on the union
so the drain log does not drift).

* `insert_cell_portal` now asserts a REAL `CellPortal` record and writes BOTH
  graphs. `insert_cell_visible_edge` is the new PVS-only door into the union.
  Both go through one `push_cell_edge` free function so dedup and COW cannot
  drift between the two feeds.
* `cell_portal_neighbours` → adjacency. **Every existing caller is a transit
  consumer**, including `faithful_bridge::build_cell_inner`, which is modelling
  retail's `CCellPortal::GetOtherCell` list (acclient.c:362341) and therefore
  always meant `portals[]` — that file needed no edit, the accessor move fixed
  it. `cell_visibility_neighbours` is the new union accessor.
* Moved to adjacency: `exited_envcell_to_outdoor`'s BFS, `at_interior_doorway`,
  `cell_has_outdoor_exit`, and (via the accessor) `current_cell`'s re-seat +
  `clip_segment_to_cell_space`'s camera resolve.
* Left on the union, deliberately and asserted by test: `render_set`,
  `compute_visibility_with_frustum` **including its inline outdoor-exit test**,
  `compute_visibility_with_pview`.
* `EXIT_INDOOR_BFS_MAX_CELLS` overflows now bump `exit_bfs_overflows`
  (`exit_bfs_overflow_count()`), expected 0 forever.

Because nothing called `insert_cell_visible_edge` yet, the two graphs are
edge-for-edge equal at every point in this commit — 674/674 unchanged, as
required.

### Leg 2 — the feed split (the behaviour change)

`fetchEnvCellsInLandblock` queues `portals[]` and `visible_cells[]` into
separate pending vecs (`CellGraphPending.portals` / `.visible_edges`) and the
TickMovement drain routes them through the two different inserters. The
`[phase6.D]` console line now counts the classes apart and reports both graph
sizes. The two real-DAT fixtures that MIRROR that ingest —
`env840_seam_tests::build_scene` and `examples/route_validate` — are routed the
same way, which is what makes those suites pin the split on shipped Holtburg
data rather than on a synthetic fixture.

Kill path: `USE_PORTAL_GRAPH_SPLIT` (scene.rs:52), the same compile-time A/B
shape as the file's existing `USE_LOCAL_FORCE_POSITION_CONSTRAINT`. `false`
makes the PVS feed write adjacency too, the two graphs go identical, and every
consumer walks the union again — the whole revert is one const, gated at ONE
site, with no consumer edits and no wasm re-plumbing. See DEVIATION 1.

### Leg 3 — PORTAL-SMALL

* **C7** `is_envcell_id` → `(0x100..=0xFFFD)`, closed at both ends. Applied at
  five sites; three of them were not in the card (see "Read-verified anchors").
* **C8** `CellSceneSnapshot.cell_aabb_index` — a `cell_id → [f32; 6]` map built
  once per snapshot and consumed by both aperture exports plus
  `getRenderSetWithFrustum`. No wire-format change; selection logic untouched.

---

## Tests run + results

All Rust via `env PATH="/opt/rust/toolchains/1.95.0-x86_64-unknown-linux-gnu/bin:$PATH" cargo …`
from `external/holtburger/` (bare `cargo` has no rustup default on this box).

| Command | Result |
|---|---|
| `cargo test -p holtburger-world` @ HEAD `2946486d` (baseline) | **674 passed / 0 failed / 0 ignored** |
| `cargo test -p holtburger-world` @ `ea290916` (leg 1) | **674 passed / 0 failed** — unchanged, as a no-op leg must be |
| `cargo test -p holtburger-world` @ `dbc92844` (leg 2) | **684 passed / 0 failed** (+9 synthetic, +1 real-DAT) |
| `cargo test -p holtburger-world` @ `d9953810` (leg 3, final) | **687 passed / 0 failed / 0 ignored** |
| `cargo test -p holtburger-core` (downstream consumer of the moved predicates) | **623 passed / 0 failed / 1 ignored** |
| `cargo check -p holtburger-web --target wasm32-unknown-unknown` | **clean** — 15 warnings, every one a pre-existing dead-code/unused-import, none in the new code (verified by listing them) |
| `cargo check -p holtburger-world --all-targets` | clean (1 pre-existing `check_walkable_probe_depth` dead-code warning); confirms `examples/route_validate` + `examples/leak_test` still build |

**The `#[ignore]` question:** holtburger-world has ZERO `#[ignore]` tests, so
`-- --ignored` has nothing to run. The real-DAT suites are DAT-**gated**, not
ignored: they print a `SKIP …` line and return if the dats are missing. They did
NOT skip — `~/ac_base_dats/client_portal.dat` and `client_cell_1.dat` are
present at the paths `env840_seam_tests` defaults to, and the suite emits its
full cell inventory / membership / CTransition dumps. All 7 env840 tests + the
academy/wedge suites really executed against retail data.

### The strongest single result: a byte-identical real-DAT transcript

`cargo test -p holtburger-world -- --nocapture --test-threads=1` was captured
before and after the feed split: **2,921 lines, byte-identical**. That is every
seam diagnosis, wedge slice loop, arrival probe and raw `CTransition` internals
dump on real Environment-840 geometry, unchanged by the split. Reported plainly
rather than dressed up: the five-cell vestibule is small enough that no PVS-only
edge was load-bearing for any of its queries. **The env840 suites pin that the
split broke nothing; they do not by themselves prove it fixed anything.** The
nine synthetic tests do that, each with a pre-split control arm.

### `[M]` MEASURED — the union/adjacency gap on the shipped DATs

New `env840_pvs_edges_exceed_walkable_edges` (real `client_cell_1.dat`, the five
Environment-840 cells, through the production ingest shape):

```
  cell 0xA9B4016A: walkable=4 visible=4  pvs_only=[]
  cell 0xA9B4016B: walkable=1 visible=4  pvs_only=[0xA9B4016C, 0xA9B4016D, 0xA9B4016E]
  cell 0xA9B4016C: walkable=2 visible=5  pvs_only=[0xA9B4016B, 0xA9B4016D, 0xA9B4016E]
  cell 0xA9B4016D: walkable=2 visible=5  pvs_only=[0xA9B4016B, 0xA9B4016C, 0xA9B4016E]
  cell 0xA9B4016E: walkable=2 visible=5  pvs_only=[0xA9B4016B, 0xA9B4016C, 0xA9B4016D]
  TOTAL over env840: walkable=11 visible=23  (adjacency 5 of 5 union source cells)
```

The union carries **2.1×** the edges physics should see on the *smallest
interior in the game*, and 0xA9B4016B — one doorway — was offering four
neighbours to `current_cell`, `at_interior_doorway` and the exit BFS. The test
asserts only the structural invariants (adjacency ⊆ union, every adjacency edge
present in the union, the vestibule keeps real portals) and PRINTS the counts:
pinning them would make the suite a canary for Turbine's level data instead of
ours.

### New tests proving the acceptance bullets

`spatial::tests::portal_graph_split` (9) — every one carries a pre-split CONTROL
arm feeding the same edge through `insert_cell_portal` and asserting the OLD
behaviour, so each test documents the bug as well as the fix:

* **"an adjacency-only consumer no longer traverses a PVS-only edge"** —
  `current_cell_seam_rescue_will_not_reach_through_a_pvs_edge` (a pose in a 1 m
  stitch gap, inside no hull, where only the neighbour walk can name a cell:
  pre-split it was relabelled into a PVS-only room = a cur_cell teleport of the
  0x16E↔0x16A grocer class); `interior_doorway_relaxation_ignores_pvs_neighbours`;
  `camera_clip_will_not_follow_a_pvs_edge_out_of_cell_space`;
  `outdoor_exit_sentinel_must_arrive_by_portal_not_pvs`.
* **"render_set unchanged on the same fixture"** —
  `render_set_is_unchanged_by_the_split`: `render_set` AND
  `compute_visibility_with_frustum` equality across both feeds for every source
  cell at depths 0..3, plus an explicit assert that BFS-1 from A still reaches
  the PVS-visible room (if that ever fails, the 2026-05-25 `visible_cells` fix
  has been undone).
* **the `EXIT_INDOOR_BFS_MAX_CELLS=64` overflow** —
  `exit_bfs_cap_no_longer_trips_on_the_pvs_closure`: one real room + a 200-cell
  PVS fan-out. Pre-split arm asserts `None` (STAY INDOORS) **and**
  `exit_bfs_overflow_count() == 1`, so the refusal is proven to be an overflow
  rather than a geometric verdict; post-split arm exits correctly with overflow
  count 0.
* plus `accessors_separate_walkable_from_visible`,
  `a_cell_in_both_feeds_keeps_its_adjacency_either_order` (order-independence of
  the two inserters — the common case is a doorway that is also PVS-listed), and
  `landblock_unload_prunes_both_graphs` (both retains, per-LB and batched).

`spatial::tests::envcell_id_range` (3) — the closed range at both ends; the
camera-clip refusal for a sentinel start cell; the label refusal in
`current_cell`. The last two register a **huge AABB against the sentinel key**,
so they fail loudly if the filter is ever dropped rather than passing by luck.

### Not run, and why

`harness/test_cell_fusion.mjs` (and the rest of the node battery) cannot run in
this worktree: `node_modules` is gitignored and was never installed here, so
`import 'three'` fails. Pre-existing environment gap, not a regression — and
that suite tests `buildFusedMesh`, which touches neither the cell graph nor the
aperture exports. No JS unit test covers `getVisiblePortalApertures*` at all
(only the browser probes `scripts/multi-agent/aperture_export_probe.mjs` and
`smoke_portal_stencil.mjs`, which need a dist + a browser — none on this box).
The C8 rider changes no wire format, so those consumers are unaffected by
construction.

---

## Read-verified anchors

Every line number below was opened this session. Post-change numbers are current
HEAD (`d9953810`); pre-change numbers are `2946486d`.

**Card citations — CONFIRMED as written:**

| Card citation | Verdict |
|---|---|
| `scene.rs:41` `is_envcell_id` | ✅ exact (pre-change) — now scene.rs:72 |
| `scene.rs:2549 / :2559` inline copies | ✅ exact — both were `(nb & 0xFFFF) >= 0x100` in `current_cell` |
| `lib.rs:21456-21490` portals vs visible_cells routing | ✅ exact — `portals[]` push at 21456-21461, `visible_cells[]` push at 21484-21490 |
| `lib.rs:35437 / :35516` per-portal linear scan | ✅ exact — both `aabb_for` closures over `snap.cell_aabbs` |
| `EXIT_INDOOR_BFS_MAX_CELLS = 64` | ✅ scene.rs:362 (pre) → :421 (post) |
| consumers `current_cell` / `clip_segment_to_cell_space` / `exited_envcell_to_outdoor` / `at_interior_doorway` / `cell_has_outdoor_exit` | ✅ all five walked the union |

**Anchors the card did not have (found by reading — I4):**

* `faithful_bridge.rs:643` — `build_cell_inner` calls `cell_portal_neighbours`
  to model `CCellPortal::GetOtherCell`. A **sixth** union consumer, and the one
  most obviously wrong (it drives the retail `find_transit_cells` flood). Fixed
  for free by the accessor move; that file is untouched.
* `current_cell`'s landblock-wide fallback scan (pre `:2570`, post `:2758`) had
  **no EnvCell predicate at all** — the one C7 site where the sentinel would
  have been *returned* as the player's cell label rather than merely queried.
  Found by writing the test for the cited pair and watching it fail against the
  fallback instead.
* `current_cell_for_arrival`'s two landblock scans (pre `:2674` / `:2684`, post
  `:2867` / `:2876`) filtered with an inline `(cell_id & 0xFFFF) < 0x100` — the
  open-ended half of the predicate again, so `0xFFFF` passed.
* `getRenderSetWithFrustum` (post `lib.rs:35630`) holds a **third** byte-identical
  `aabb_for` linear-scan closure, called once per render-set member.

**One STALE citation corrected:** the `visible_cells` comment in
`fetch_env_cells_in_landblock` read *"`insert_cell_portal` dedupes
(scene.rs:513)"*. `insert_cell_portal` was at **scene.rs:1747**, not 513 — the
reference was off by ~1,234 lines. Rewritten to name the behaviour without a
line number.

**Retail/decomp cross-checks:** `CCellPortal::GetOtherCell` acclient.c:362341
(the walkable neighbour list the faithful bridge models);
`CellManager::UpdateLoadPoint`'s `(u16)objcell_id < 0x100` split (the C7 lower
bound); `CCellStruct::point_in_cell` :355496 / `sphere_intersects_cell` :355503
(the containment pair `current_cell` layers). `EnvCell.visible_cells: Vec<u16>`
confirmed at `crates/holtburger-dat/src/file_type/env_cell.rs:88` (READ ONLY —
that file is a4's ACTIVE scope, not touched).

---

## DEVIATIONS (I3)

**DEVIATION 1 — I7 flag lifecycle: no URL flag; a compile-time const kill path
instead, DEFAULT-ON.**
I7 wants new behaviour behind a SPEC-named flag, DEFAULT-OFF. Evidence for
departing: (a) the queue card names no flag, and **none of batch-D's Rust-side
items do** — MOVE-F2-HOLDKEY, MOVE-F3-ENABLE, MOVE-F6-SPEEDCAP,
PORTAL-FLAGS-DECODE and BLDPORTAL-CONSUME are all flagless correctness fixes to
crate internals (read from the queue JSON this session); the URL-flag machinery
in this repo is JS/wasm-boundary, and `cell_adjacency` is three layers below it.
(b) A DEFAULT-OFF arm here would mean shipping the merged feed and dual-feeding
both graphs, which makes the task inert and *adds* the risk it is removing.
What I did instead: `USE_PORTAL_GRAPH_SPLIT` (scene.rs:52), default `true`,
matching the file's own existing A/B idiom (`USE_LOCAL_FORCE_POSITION_CONSTRAINT`,
scene.rs:34, also default-`true`-with-a-legacy-arm). It gates exactly ONE site —
`insert_cell_visible_edge` — so the OFF arm is byte-identical legacy behaviour
**by construction, not by assertion**: with it false the PVS feed writes
adjacency too and the graphs are the same object graph the pre-split code built.
No `url-flags.md` row is added, because no URL flag exists to document. The
orchestrator owns whether this needs promoting to a real flag before the 1070
pass.
*Honesty note:* a compile-time const cannot be exercised at runtime, so there is
no test of the OFF arm. Commit `ea290916` is the empirical stand-in — it is the
same graph state, and it measured 674/674 identical.

**DEVIATION 2 — lib.rs edits outside the two cited regions.**
Scope granted me `lib.rs` ~:21456-21490 and ~:35437/35516. Routing
`visible_cells[]` to a different inserter mechanically requires the queue that
carries it, so I also touched: `CELL_GRAPH_PENDING` initialiser (`:16781`),
`CellGraphPending` struct (`:17021`), `drain_pending_cell_graph_into` (`:17391`,
return arity `(usize, usize)` → `(usize, usize, usize)`; the sole caller is the
`[phase6.D]` log at `:53066`). The C8 index likewise requires
`CellSceneSnapshot` (`:33084`) and `publish_cell_scene_snapshot` (`:41798`).
**None of these are in a4's ACTIVE regions** — verified by hunk header:
my lib.rs hunks are at old-file 16780, 17013, 17368-17394, 21476-21489, 33035,
35435-35438, 35515-35517, 35601-35603, 41752, 53020-53027; a4 holds
21401-21409 and 21675-21723, and my nearest hunk (21476) sits *between* them.
No collision, no minimal-edit compromise needed.

**DEVIATION 3 — C7 applied at 5 sites, not the 2 cited; C8 at 3 closures, not
the 2 cited.** Both are the same defect at more sites than the card knew about
(itemised under "Read-verified anchors"). The C7 extras are load-bearing — the
`current_cell` fallback scan is the only place the sentinel could actually be
*returned*. The C8 extra is one closure body; leaving an identical scan two
functions away, with the index already in the snapshot, would have been the odd
choice. Both stay inside my declared files.

**DEVIATION 4 — environment, not code.** The worktree was missing
`external/chorizite/Chorizite.ACProtocol/`, which `holtburger-protocol/build.rs`
canonicalizes; every Rust build failed at the build script. That path is
gitignored (`.gitignore:630 external/*`) and absent from the worktree but
present in the main checkout, so I symlinked it:
`external/chorizite/Chorizite.ACProtocol -> /home/wbterminal/WorldBuilder-ACME-Edition/external/chorizite/Chorizite.ACProtocol`.
Read-only build input, gitignored, not committed (`git status` stays clean of
it). **Sibling fan-out agents on other worktrees will hit this too.**

---

## Remainder / follow-ups

1. **The 1070 interior eye pass is the real gate and has NOT run.** This change
   moves where a body may travel. The suites prove no regression on the
   env840 five-cell fixture and the synthetic topologies; they cannot prove a
   dungeon feels right. Recommended vantages: a multi-room interior with a
   dense PVS (the holtburg redoubt vantage ENVCELL-POOL already queued), a
   cottage doorway in/out (B11 symmetry), and a stair chain.
2. **`exit_bfs_overflow_count()` and `cell_adjacency_len()` have no `__diag`
   surface — DELIBERATELY LEFT UNWIRED, and this is the one thing I would take
   next.** `collisionResidencyDiag` (lib.rs:36673) is the natural home and its
   doc states the rule: APPEND to the end, never insert, because
   `scene3d/diag/collision.js` parses positionally against `RESIDENCY_FIELDS`.
   The Rust half is two lines; the useful half needs that JS file (outside my
   file scope) plus the T01 diag-schema registration, and `test_diag_schema.mjs`
   cannot run on this box (no `node_modules` — see "Not run"). Appending
   Rust-side alone would have been motion without effect: unregistered trailing
   fields are silently ignored by the JS parser. Until that lands the overflow
   counter is debugger-only, which means **the 1070 pass cannot currently assert
   `exitBfsOverflows == 0`** — that is the honest state of the gate.
3. **`compute_visibility_with_frustum`'s outdoor branch still reads the union**
   for its inline outdoor-exit test (scene.rs:3305), by design and by test. That
   branch is the natural home for BLDPORTAL-CONSUME's retail walk; **that card
   cites `~:3086-3100`, which is now `~:3277-3315`** after my insertions.
   Whoever takes it should also know `cell_has_outdoor_exit` next door
   (scene.rs:2985) now answers from adjacency, so the two are deliberately no
   longer the same predicate.
4. **Merge note for the orchestrator.** a4 (PORTAL-FLAGS-DECODE) will touch
   scene.rs's `>= 0xFFFE` sentinel VALUE tests. I did not change any of those
   comparisons — I only changed which *map* they read (`cell_adjacency` in
   `cell_has_outdoor_exit` / `at_interior_doorway` / the exit BFS; the union in
   `compute_visibility_with_frustum`). Expect a textual merge at
   `cell_has_outdoor_exit` (scene.rs:2985) and `at_interior_doorway` (:3020),
   and note that once a4 decodes `CellPortal.flags` bit 2 (leads-outdoors), the
   *right* source for `cell_has_outdoor_exit` becomes that bit read off an
   adjacency edge — the split is a prerequisite for that, not a conflict with it.
5. **`EXIT_INDOOR_BFS_MAX_CELLS = 64` left at 64.** On adjacency the number
   means what its doc always claimed ("the largest mansions are ~15 cells"), so
   raising it would be unjustified guesswork; the new counter is how we will
   learn if a real structure ever exceeds it.
6. **Draw-pool interaction: none.** `pool_producer.js` and `pool_envcells.js`
   contain no cell-graph reference at all (grepped); the pooled interior
   visibility delta rides `tickCellVisibility3D`'s container set, which is fed
   by `render_set` — and `render_set` is asserted unchanged across the split.
7. **Not done, not needed:** no `pkg/` build (no JS consumer of the changed
   Rust surfaces; wire formats unchanged), no `url-flags.md` row (see
   DEVIATION 1), no `IMPLEMENTATION.md` status-table edit (the fan-out preamble
   forbids editing that file).
