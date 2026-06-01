# Full-World Bake + Per-Landblock Client-Side Verify — Plan (2026-05-30)

Take the renderer from a 169-LB Holtburg ring to **all of Dereth**, and prove each
landblock client-side against a live ACE server with no GPU, one landblock at a time.

This plan is grounded in (read first if unfamiliar):
[`world-completeness-method.md`](world-completeness-method.md) (the placement contract),
[`ring-expansion-method.md`](ring-expansion-method.md) (the one-shot expansion shape +
the §6 infra gaps), [`ring-diagnose-repair-playbook.md`](ring-diagnose-repair-playbook.md)
(the per-LB diagnose loop), [`diagnostic-toolset-method.md`](diagnostic-toolset-method.md)
(the surface inventory), [`entity-completeness-method.md`](entity-completeness-method.md),
[`event-completeness-method.md`](event-completeness-method.md),
[`ace-local-setup.md`](ace-local-setup.md) (live ACE bring-up).

Status: **PLAN, 2026-05-30.** Nothing in here is shipped yet. Sections marked
**[VERIFY]** are assumptions to confirm before the dependent phase, not facts.

---

## 0. The decisions that shape this (binding)

From the operator, 2026-05-30:

- **Verify against LIVE ACE.** Spawns/entities come from the real server wire
  (`wsbridge → ACE` UDP 9000/9001), never the offline JSONL replay. The entity
  oracle is `dump-lb-expectations` reading `ace_world.landblock_instance`.
- **No spawns JSONL bake.** Entities come off the wire.
- **No events bake either.** Events fire at runtime (ambient/sky = DAT-computed
  client-side; entity anim/physics hooks = live entity rigs; `GameMessageSound`
  0xF750 = server wire). The events *oracle* is `dump-lb-expectations.events`,
  generated on demand — not a staged `dist/events` layer.
- **100% ACE parity, byte-level.** Not just placement-equal-within-tolerance.

**Consequence — the whole-world bake collapses to ONE produced layer: `dist/scenery`.**
Everything else is already done or comes live:

| Layer | Source | Whole-world status |
|---|---|---|
| Terrain (`CellLandblock` 0xLLLLFFFF) | DAT → `manifest/shards` | **DONE** — shards are whole-DAT (885,155 files; eor/cell = 805,348 records = entire client_cell_1.dat) |
| EnvCells (0xLLLL01xx) | DAT → `manifest/shards` | **DONE** — same shard bake (whole-DAT) |
| Meshes / textures / scenes | DAT → `manifest/shards` | **DONE** — same shard bake |
| **Scenery (trees/rocks)** | Rust `scenery-bake` → `dist/scenery/*.jsonl` | **TO BAKE** — ring-only (169) → ~40,197 content LBs. The renderer *fetches* this. |
| Spawns / NPCs / monsters | **live ACE wire** | n/a — not baked |
| Events (sound/particle) | **runtime + wire**; oracle = `dump-lb-expectations` | n/a — not baked |

So "bake the entire world" = **bake `dist/scenery` for every content-bearing
landblock**, harden it to 100% byte-parity, then **verify every content LB live**.

---

## 1. Scope census — the denominator (Phase 0)

Everything downstream is sized by *which landblocks are real*. Measured against
the actual `~/ac_base_dats/client_cell_1.dat` (probe run during planning):

| Class | Count | Notes |
|---|---:|---|
| Grid landblocks (0x00–0xFE on each axis) | 65,025 | `get-world-info.totalLandblocks` |
| All-water (ocean) | 26,336 | all 81 vertices terrain_type ∈ 0x10..=0x14 |
| Has-land (≥1 non-water vertex) | 38,689 | |
| Has `LandblockInfo` / `has_objects` flag | 5,346 | flag == LBI presence, exactly |
| All-water **but** has structures (piers/bridges) | 1,508 | must NOT be dropped |
| Has indoor EnvCells (dungeons) | 3,409 | strict subset of the 5,346 |
| In `ace_world.landblock_instance` | ~4,520 | spawn-only subset — do NOT use as the bake set |

**Content-bearing set (the bake + verify target) = `has-land terrain` OR
`has_objects` ≈ 40,197 LBs.** The union is load-bearing: dropping all-water LBs
would wrongly discard 1,508 water-anchored structures; dungeons are all captured
because EnvCell LBs ⊆ the `has_objects` set.

**Tool to build:** `landblock-census` — ~80 LOC, a new `src/bin/landblock-census.rs`
(or a `dat-tool census` subcommand; `dat-tool` already parses one LB at
`bin/dat-tool.rs:662`). Algorithm: open `client_cell_1.dat` once via
`holtburger_dat::DatDatabase`, iterate ids where `id & 0xFFFF == 0xFFFF`,
`CellLandblock::unpack`, mark content-bearing if `has_objects != 0` **OR** any of
the 81 `terrain_type(x,y)` ∉ `0x10..=0x14` (water codes from
`~/ac-headers/acclient.h:4112-4134`). Emit `0x{lb:04X}` per line →
`content-landblocks.txt`. Also emit a `dungeon-landblocks.txt` (EnvCell-bearing,
the 3,409) for the PVS pass. Runs in seconds.

This file is the `--landblocks @content-landblocks.txt` input to the bake **and**
the work-queue for the verify sweep. There is no existing world-census/ocean
command — this is genuinely new (but tiny).

---

## 2. 100% ACE parity hardening (Phase 1) — gates everything

The scenery bake is a verbatim Rust port of ACE `Scenery.Load`, already at
**16,700/16,700 placements, 0 missing / 0 extra** vs the C# oracle (B.5 report).
The only gap to "100% byte parity" is float serialization:

- Today: `format_f32_six_sig` / `format!("{:.6}", v)` (`scenery-bake.rs:622-629`)
  vs C# `F6`. ~56% of ring LBs differ in the 6th decimal only (`0.664591` vs
  `0.664592`). Placements are identical within `1e-4`; the strings aren't.

**Two-step fix (do NOT skip step A — it determines whether this is cosmetic or real):**

- **A. [VERIFY] Are the f32 *values* bit-identical between the Rust port and C#
  `Scenery.Load`?** Extend `scenery-cross-check` (`tools/scenery-cross-check/`) to
  compare raw `f32::to_bits()` per field, not formatted strings. If bit-identical
  → the divergence is pure formatting (step B closes it). If not → there's a
  residual arithmetic divergence (f32-vs-f64 intermediates / op order); fix the
  Rust port to ACE's exact float ops first (the determinism contract already
  pins the *integer* overflow semantics — floats need the same care).
- **B. Unify the emitter** so Rust and the C# oracle produce byte-identical
  strings — either replicate .NET's `F6` rounding in `format_f32_six_sig`, or
  switch both sides to a single canonical shortest-round-trip representation
  (ryu-style). Re-run B.5 cross-check at **byte** tolerance.

**Acceptance:** `scenery-cross-check --with-collision` reports byte-identical
across a large content-LB sample (and bit-identical f32s). This is the gate the
world-completeness contract actually asks for ("byte-equivalent to what any AC
server believes") and it makes the integrity sidecars unambiguous.

Bake determinism is already strong (locale-free formatting, `-0.0` normalized,
per-run `bake-source.sha256` pinning the 3 input DATs, 2×/100× determinism
harnesses) — re-runs are byte-identical. This phase is purely about Rust↔C# parity.

---

## 3. The verify loop — what exists vs what to build

**Good news: the two hard pieces already work.** (Agent-confirmed against real code.)

- **Per-LB teleport is proven.** No wasm/URL teleport exists; the mechanism is the
  ACE Developer command `@teleloc <cellId> x y z` sent via
  `handle.sendChat(...)`, demonstrated end-to-end in
  `scripts/perf-worker/tour-lbs.mjs:79-91` (builds `cellId = 0x<LBhex>0001`,
  teleports, 5.5 s settle, ~13 LBs/min/agent). **Needs a Developer (accessLevel 4)
  account.**
- **`__diag.runAll(lbId)`** (`scene3d/diag.js:480-488`) is always installed,
  headless, observation-only, sub-millisecond. It aggregates **4 surfaces**:
  `spawns`, `placements`, `entityTypes`, `events` → `{summary, surfaces}` with
  `PASS | DRIFT | INFRA`. **`integrity` and `pvs` exist but are NOT in `runAll`**
  — call them separately for the dungeon/byte passes.
- **AutoLogin** (`index.html:10244-10552`): `?autoLogin=1&account&password&autoSpawn=first&kickDance=1&renderer=3d&diag=1&wireframe=1&hud=none&plugins=none&agentic=low`.
  Wait for `window.__bootState === "ready"` (not `"in-world"`).

**What to build (5 small pieces — see `ring-expansion-method.md §6`):**

1. **Wire `runAll` into the teleport loop.** `tour-lbs.mjs` is the template but it
   screenshots; replace with `loadExpected` → `runAll` → record. (~20 LOC)
2. **Feed the whole-world LB list** (Phase 0's `content-landblocks.txt`) — today
   only a hardcoded 13-LB array exists (`tour-lbs.mjs:18-34`).
3. **Per-LB oracle generation + loading.** `runAll` returns `INFRA` unless
   `diag.expected` is set, and **nothing calls `setExpected`/`loadExpected` today**;
   only Holtburg's `oracles/0xA9B40000.json` exists. Generate one oracle per
   content LB via `dump-lb-expectations` (buildings + bakedScenery + npcs + events),
   and `await __diag.loadExpected("/oracles/<lb>.json")` **before** each teleport so
   the spawn buckets fill against the right oracle.
4. **`fleet.mjs --lb-ring`** — `fleet.mjs` is N-agents-one-default-LB today (no LB
   arg; its regex even rejects digits). Add a shared LB work-queue: each agent
   pulls the next LB, teleports, settles, `runAll` + `pvs` + `integrity`, records,
   repeats. This is the unbuilt round-robin.
5. **Per-LB matrix report writer** — reuse the `matrix.json` shape from the
   build-side `scripts/diag/diag-run-all.cjs:194-221`.

**Oracle commands** (WB.Terminal, decimal lbX/lbY; load `RetailSmoke.wbproj`):
- `{"command":"dump-lb-expectations","lbX":..,"lbY":..,"out":"oracles/<lb>.json"}` → placements/scenery/npcs/events oracle.
- `{"command":"pvs-visibility-snapshot","cellId":"0xLLLL01xx","bfsDepth":1}` → EnvCell PVS oracle (contract: `BFS_N ⊆ DatVisibleCells`).
- `{"command":"diag-run-all"}` → the build-side global gate (parity surfaces).

**The 5 parity surfaces (wire / dat / enum / physics / motion) are global/fixture,
NOT per-LB.** They run ONCE via `diag-run-all`; a whole-world sweep doesn't touch
them. The per-LB sweep is only the content axes.

### 3.1 Open item — dungeon EnvCell reachability **[VERIFY]**

`@teleloc` is proven to land on the **outdoor cell** (`0x0001`). Whether passing a
**interior** cellId (`0xLLLL01xx`) drops the player *inside* a dungeon is untested.
Resolve early (it gates verifying the 3,409 dungeon LBs' EnvCells):
- **First try:** `@teleloc 0x<LB>0100 <x> <y> <z>` with interior-cell-local coords.
  If ACE places the player inside, dungeons are reachable with zero extra work.
- **Fallback:** teleport to the dungeon's surface portal drop-in coords (from
  `LandblockInfo`/portal data), or use `@tele`/recall-to-portal admin commands.
Either way, the outdoor `runAll` already exercises a dungeon LB's *terrain +
scenery + surface entities*; this item is specifically about being *inside* to
verify interior EnvCell PVS via `pvs-visibility-snapshot` / `__diag.pvs`.

---

## 4. Phase plan (ordered; each phase has an acceptance gate)

| Phase | Deliverable | Acceptance |
|---|---|---|
| **0. Census** | `landblock-census` bin → `content-landblocks.txt` (~40,197) + `dungeon-landblocks.txt` (3,409) | counts match the table in §1; 0 parse failures |
| **1. Parity hardening** | f32 bit-identity check + byte-identical emitter (§2) | `scenery-cross-check` byte-identical on a large sample |
| **2. Prereqs** | (a) land the scenery plumb-fix (`index.html:6627` — add `fetch_landblock_scenery` + `init_scenery_base_url`); (b) resolve dungeon-interior teleport (§3.1) | scenery renders in-world; `@teleloc` reaches an interior cell (or fallback chosen) |
| **3. Verify-loop infra** | the 5 pieces in §3: `runAll`-in-loop, LB list, per-LB oracle gen+load, `fleet.mjs --lb-ring`, matrix writer | a 169-LB ring sweep reproduces the known Holtburg result end-to-end |
| **4. Parallel-bake wrapper** | shard `content-landblocks.txt` into N chunks, run N `scenery-bake` processes (no `--parallel` flag exists; each opens its own read-only `DatDatabase`) + atomic publish to `$HOLTBURGER_DIST/scenery` | byte-deterministic re-run; sha sidecars present for all ~40,197 |
| **5. Full-world scenery bake** | `dist/scenery` for all content LBs, staged to the single root | `_health.json` green; spot-render 5 distant LBs show scenery |
| **6. World oracle generation** | `dump-lb-expectations` per content LB + `pvs-visibility-snapshot` per dungeon cell → `oracles/` tree | one oracle per content LB; dungeon PVS oracles present |
| **7. Verify sweep** | fleet of headless wire-agents on live ACE, teleport per LB, `runAll`+`pvs`+`integrity`, → world coverage matrix | every content LB reports PASS or a triaged DRIFT; INFRA count = 0 |
| **8. Repair loop** | route every DRIFT through `ring-diagnose-repair-playbook.md §5` until green | 0 un-triaged DRIFT; `diag-run-all` exit 0 |

Phases 0–3 are independent of the bake and can proceed first (they're cheap and
de-risk the loop). Phase 1 gates 4–5 (don't bake 40k LBs until parity is byte-true).

---

## 5. Budget — disk, compute, wall-clock

- **Disk (scenery JSONL only):** ring = 169 LBs / 4.2 MB → ~40,197 LBs ≈ **~1 GB**
  + ~12 MB sha sidecars. Trivial next to the existing 4.5 GB shards on
  `/mnt/wbterminal2`. (Oracles add a similar ~1 GB of small JSON; keep on
  `/mnt/wbterminal1` scratch or alongside.)
- **Bake compute:** `scenery-bake` is serial (no `--parallel`); per-LB cost is DAT
  decode + noise + AABB. Whole-world serial ≈ hours; shard the `@file` list into N
  processes (each its own `DatDatabase`) → **minutes-to-~1 h** on this box.
- **Verify wall-clock:** dominated by per-LB teleport+settle (~6 s including the
  5.5 s envcell/PVS settle) + sub-ms `runAll`. 40,197 LBs ÷ N agents:
  - 8 agents ≈ **~8 h**; 16 agents ≈ **~4 h**; 32 agents (≈130 MB RSS each → ~4 GB)
    ≈ **~2 h**. Resumable per-LB (matrix records completion) so it can run in
    chunks and survive interruption.

---

## 6. World-wide acceptance gate

An LB is "verified" when, against live ACE:
1. `__diag.runAll(lb)` → all 4 content surfaces `PASS` (no `DRIFT`/`INFRA`).
2. For dungeon LBs: `__diag.pvs` vs `pvs-visibility-snapshot` oracle (`BFS_N ⊆ Dat`).
3. `__diag.integrity.verifyManifests` byte-matches the scenery sidecar (clean
   once Phase 1 byte-parity lands).
4. No `__diag.assets.{material,animation,mesh}Errors` during the visit.

The world is "shipped" when every content LB passes (1)–(4) and the global
`diag-run-all` (parity surfaces) exits 0. The matrix report is the coverage proof.

---

## 7. Open questions / assumptions to verify (don't let these go silent)

- **[VERIFY] §3.1 dungeon-interior `@teleloc`** — gates verifying 3,409 dungeons' EnvCells.
- **[VERIFY] §2.A f32 bit-identity** — determines whether 100% parity is a formatter fix or a port fix.
- **[VERIFY] ACE world coverage at radius** — live ACE pushes `landblock_instance`
  for the player's LB + adjacents; confirm a single `@teleloc` loads enough for the
  entity oracle to match (the spawn diff's 5-mode classifier handles
  `wire-arrived-other-lb`, but settle time may need tuning per LB).
- **[VERIFY] Developer-account supply** — the sweep needs accessLevel-4 accounts;
  ACE auto-promotes the first account to admin (`ace-local-setup.md §7`). Rotate a
  small pool to avoid ghost-session locks (cf. wave-3 prereq).
- **Scenery render radius** — the renderer's default `bakeStaticsRing(...,1,...)`
  fetches a 3×3 ring; the sweep teleports *onto* each LB so its own scenery is in
  range, but confirm no LB is only ever a neighbor (the per-LB teleport guarantees
  center coverage).

---

## 8. What this plan does NOT cover

- **Multi-region** (Dereth 0x13 only; Coldeve-style extra regions are a separate
  per-region dist tree — `ring-expansion-method.md §7.2`).
- **Custom/modder worlds** — base DATs only; the bake preflight rejects `0x__FFxxxx`.
- **Live spawn mutation** — ACE can change spawns at runtime; the sweep is a
  point-in-time check, not a live watcher.
- **The parity surfaces' per-LB expansion** — they stay global; only physics-replay
  is even LB-pinned (to Holtburg) and that's out of scope here.
- **Performance regressions** — observation-only; see `scripts/perf-worker/`.

---

*Build on the contracts; this doc only sequences the work. When a per-LB check and
the build-side validator disagree, the build-side (canonical-oracle) side wins.*
