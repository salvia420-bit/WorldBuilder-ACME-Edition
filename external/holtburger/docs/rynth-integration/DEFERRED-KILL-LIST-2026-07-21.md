<!-- Provenance: extracted verbatim from /mnt/wbterminal1/omnibus/p1/synth_01 (PHASE-2 PLAN, 2026-07-21), the 'DEFERRED' + 'C5 KILL-LIST' tail section. -->
<!-- Rescued 2026-07-23 (rynth-review 16 finding #6 / 17-SYNTHESIS coverage-gaps) because it existed only on ephemeral buildbox/mnt storage and was at risk of disk reclaim; content below is unedited. -->

## DEFERRED (per C5's scope cut — explicitly NOT in this fan-out)

**Deferred wiring/flips of the dark cores built above (build now, wire after survival proves out):**
- `loot_policy` **wiring into loot_loop** + `set_loot_mode`/`set_loot_tier` director verbs (A4-4/5). Keep
  `greedy` default when it does land.
- `combat_memory` **observe-block** (the COMBAT digest line) + danger-driven director directive / `flee` verb
  (A3-3/4, A5-1).
- `suit_solver` **Tier-1** `upgrades`/`bestSuit` full DFS (spell-bitmap + bucket DFS + branch-and-bound +
  ReductionOptions), the background **appraisal sweep**, the SUIT observe block, and `tools/suit.js`
  (`build_suit`/`equip_suit`) (A2-3/4/6, A7 M1/M2/M3). Guard `CalcedStartingArmorLevel` behind a capability
  check (R3).
- `heal_reflex`/`confirm_reflex` **kernel registration** + the reflex-bus/scheduler (A1-7/8).
- Fellowship/allegiance/appraisal/vendor-rate **observation lines** (A5-2/3/4) — pure dead-getter wiring,
  cheap, but a new director surface → defer behind the budget governor (WP-15/16) proving out.

**Deferred host/wasm surface changes:**
- Host getter for vendor `MerchandiseItemTypes` + `MaxValue` (+`IsSellable`) (A4-1) and the deterministic
  `sell_trash` auto-sell that depends on it (A4-5).
- Widening the decoded combat event with damage fields (A6-P5) — **not needed** (damage is on kind=19, §D4);
  only revisit for verbatim EORT logger parity, itself deferred.
- Per-item `containerId` in the inventory snapshot (unblocks auto-pack *routing*, A1 gap).
- `DecalEventShim` + property-key (Decal→ACE `PropertyInt`) translation table (A6-P1/P2), trade seam-wrappers
  (A6-P3), raw-packet plane / `poll_raw_messages` (A6-P5), logout export (A6-P7).
- The full unified **ArrivalState** enum / `reconcile_arrival_body` refactor (B4 items 2-6) and the
  `arrival: loading` observation line (B4-7) — the surgical WP-1/WP-2 fixes cure the live wedge; the full SM
  unification is a larger follow-on.

**Deferred nav/arbitration heavy items:**
- The full `RynthPilot` — `nav_cost.js`, `nav_plan.js` 3-tier planner, `nav_pilot.js` recovery table + z-embed
  detector, and the `bot.goto`/`ExplorePressure` flip (C3 Stages 2-7). WP-8 (nav_frame) + WP-9 (guards) + WP-10
  (pressure-ladder recovery) are the safe increments this phase; the flip is deferred.
- `GoalStack` (C4 Layer-2) and sophisticated-behavior-as-goal (`improve-equipment`, `loot-profile`, C4
  Layer-3) — land only **after** the `obsQuota` governor (WP-15/16) is proven, so they can't become the next
  unconditional dump.
- Cross-track wasm z-embed "root fix" framed as C3-Stage-8 — subsumed by WP-1/WP-2.

**C5 KILL-LIST (tempting, deferrable, or actively harmful now — do NOT build):**
- **Port Mag-SuitBuilder's GUI/WorldFilter layer** (18/24 files Decal/WinForms-coupled, 5.8k LOC). Only the
  pure property-model + permutation math is portable (WP-13 Tier-0 now + the deferred Tier-1) — never the
  GUI/WorldFilter.
- **Any End-Of-Retail-Tools logger/parser port** (Combat/Creature/Loot/Vendor/Packet/WorldObject) — Decal
  raw-packet telemetry; zero soak value; holtburger has its own event plane.
- **Mag-Filter login automation** — redundant with `supervisor.cjs`/`rynth_boot_helper.cjs`.
- **Step-5 town-directed blind long on-foot walk** (bot.js:1405-1428) — a wedge/aggro/stream-optics risk; keep
  `townFrontier` for *direction only*, don't ship the blind hop.
- **Embeddings / paraphrase-loop detection** (gte-base) — already deferred by the operator; trigram/Jaccard
  first.
- **Multi-town / cross-town frontier** — one-town interior coverage isn't proven yet.
- **z-band verticality tuning / new coverage dimensions** — grows observation + prompt tax before movement is
  reliable.
- **A second parallel soak rig** — forbidden; the live stream bot IS the soak. Fix ops fragility by moving the
  **wasm build off the laptop onto the buildbox** (C5-8) and rsync `pkg/` to the laptop — not by adding
  runtime load.
