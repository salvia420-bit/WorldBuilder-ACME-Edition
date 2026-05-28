# Team Agents Plan — 15-opportunity sweep (2026-05-27)

**Audience:** orchestrator (Claude) spawning Explore + implementation sub-agents against `external/holtburger/`.

**Goal:** land all 15 grounded opportunities surfaced by the 2026-05-27 four-agent audit. Bundled into 5 waves keyed by parallel-safety, not by ROI tier — every item ships.

**Why this structure:** ordering is by code-surface disjointness so each wave's agents can run in one parallel batch with minimal merge friction. Larger / lib.rs-heavy items are pushed to later waves so smaller ones don't fight them for that file.

---

## Required reading (in order) for every spawned agent

1. `external/holtburger/docs/handoff-for-next-agent-2026-05-26.md` — repo layout, reference repos (ACE/acclient.c/Chorizite/DRW), validation cheat sheet, three-source cross-reference principle, three-struct threading + per-entity HashMap + lazy JSON facade + plugin event bus patterns.
2. `external/holtburger/docs/chorizite-absorption-plan-2026-05-27.md` — what Waves A-J actually shipped (skip re-investigation traps).
3. `external/holtburger/docs/chorizite-reading-guide-summary-2026-05-27.md` — Wave A summary; load-bearing for any wire/DAT/protocol agent.
4. This doc — wave-specific brief for the agent's task.

The handoff doc carries the validation cheat sheet, cargo path, and disk-pressure notes. Don't repeat them in agent briefs — link.

---

## Cross-wave guidance — applies to every agent

### Visibility-blocker watch (user-requested)

Each opportunity is shipping into a real 3D game render. **Implementation correctness ≠ feature visibility.** While the agent is in their lane, they should keep an eye out for integration breaks that would prevent the feature from being visible in the running app:

- **Wire opcode handler exists but no dispatch in recv loop** — common failure mode.
- **Wasm export exists but never appears in `pkg/holtburger_web.d.ts`** — grep after wasm-pack build.
- **JS subscribes to an event the emit site never fires** — grep `events.emit("<name>")` and `events.on("<name>")` for paired sites.
- **Plugin built but not registered in the plugin-bar manifest** — see `ui/bar.js` and `keymap.js`.
- **Quality preset gate disables the feature unconditionally** — check `scene3d/quality.js` defaults.
- **Renderer feature compiles but is masked behind `?flag=on`** — check `scene3d/loop.js` query-param parsing.
- **CSS / layout collapse hides DOM** — visible in DOM inspector but z-index'd / display:none.

**Agent guidance:** if a visibility-blocker is in your code path or is a 5-line fix, fix it in-scope and call it out in the commit body. If it spans another agent's lane, **flag it in the commit body under a `## Visibility flags` section** with file:line + hypothesis — the next wave's orchestrator will route it.

### Opportunistic assist (user-requested)

If while working on your task you find a bug or improvement that visibly helps **a sibling agent's lane** in the same wave or a downstream wave, you may either:
- Patch it inline if ≤ 10 LOC and tests still pass — note it in the commit body.
- Otherwise log to `external/holtburger/docs/wave-cross-help-2026-05-27.md` (create on first write) with one line: `Wave X / Agent Y: <flag> @ file:line — <reason>`.

Do not chase rabbit holes. The user explicitly said "not outright bug-fixing." Stay in your task; help opportunistically.

### lib.rs etiquette (multiple agents may touch it per wave)

`apps/holtburger-web/src/lib.rs` is ~30k lines. To make parallel patches mergeable:

- New wasm exports go into a clearly-labeled section at the end of the file or the relevant `impl SessionHandle { ... }` block.
- Mark your additions with a leading comment: `// === Wave <ID> / Agent <X> — <feature> (2026-05-27) ===`.
- Use the **three-struct threading** pattern (handoff §"Critical patterns") for any per-entity property surfacing.
- Don't reformat existing code. Don't rename. Add-only.

If two agents in the same wave both need to touch `lib.rs`, the orchestrator commits sequentially: smaller-surface agent first, larger-surface agent rebases.

### Commit pattern

Per-agent commit at end of brief. Prefix: `feat(holtburger-web): wave <N>.<letter> — <short subject>`. Body: what shipped, what tests pass, any visibility flags raised. End with `Co-Authored-By:` block per CLAUDE.md convention.

### Validation gate per wave (orchestrator runs)

After all agents in a wave complete, before next wave fires:
```bash
cd /home/wbterminal/WorldBuilder-ACME-Edition
# Workspace check
cd external/holtburger && export PATH="$HOME/.cargo/bin:$PATH" && cargo check --workspace
# Wasm build
cd apps/holtburger-web && wasm-pack build --target web --out-dir pkg --dev
# Wire conformance
node external/holtburger/apps/holtburger-web/validate_wire_conformance.cjs
# Combat-rendering smoke
for t in test_ac_aim_level_for_velocity test_ac_attack_type_for_weapon test_ac_damage_rating test_ac_spell_shape test_ac_spell_cast_sequence test_play_effect_resolver; do
  node external/holtburger/apps/holtburger-web/$t.mjs 2>&1 | tail -2
done
# Visual smoke on 1070 (Firefox driver workflow — see memory)
```

If any agent's wave-mate breaks the gate, that agent's commit is reverted and the agent re-spawned with the failure log.

---

## Wave 1 — Isolated quick wins (CLOSED 2026-05-28; 6 parallel agents)

All six touched disjoint files. Closed in one batch as planned.

### Wave 1 closing summary

| Agent | Status | Commit | Notes |
|---|---|---|---|
| 1.A | shipped | `ee254118` | J3.A-E codegen already emits all 46 Qualities opcodes (0 skipped); agent added 10 parity tests + 4 wire fixtures (36→40 conformance). 4 visibility flags → Wave 6.A. |
| 1.B | no-op | — | Migration already complete in J2 commit `563afacc` (5 prompted + 5 bonus discoveries); audit was stale by ~1 day. |
| 1.C | shipped | `52292249` | Gap already closed by PR 3 (3 layers cover it); agent added 7 end-to-end dispatch lockdown assertions. Visibility flag → Wave 6.B. |
| 1.D | shipped | `dc75471d` | `set_wielded` wasm alias + paperdoll drop wiring; `wieldFromPack` kept as deprecated alias for stale-pkg back-compat. |
| 1.E | shipped | `7d50d8e2` | Player-tracked shadow gate at 5 Hz / 4m delta; 60→80m radius; cascade-mismatch warn-once. Visual smoke on 1070 deferred to next session. |
| 1.F | shipped | `b4aa4fe7` | 5 indicators wired to live events; +37 unit tests. Portal Storm + Mini-Game pre-subscribed but lack emit sites → Wave 6.C (Portal Storm) + parked (Mini-Game). |

**Validation gate:** cargo check workspace PASS, wire conformance 40/40, 6 combat-rendering smoke tests PASS, node --check on all touched JS files PASS, both new test files PASS (37/37 + 93/93 with new assertions).

**Surprise findings:** 2 of 6 agents (1.B + 1.C) found their tasks already addressed by prior commits. Post-J4 audit doc had stale assumptions. **Future agent should refresh the audit against current `master` before drafting new wave plans.**

---

### Agent 1.A — Qualities_Update/Remove codegen sweep

**Goal:** push protocol crate generated coverage from 97.4% toward ≥99% by feeding the J3.A-E codegen the 16 `Qualities_Update*` + 8 `Qualities_Remove*` opcodes already defined in `external/chorizite/Chorizite.ACProtocol/protocol.xml` lines ~90-130.

**Surface:**
- `crates/holtburger-protocol/build.rs` — codegen entry point (verify; spawned by J3.A `cdcf92d4`).
- `crates/holtburger-protocol/src/messages/qualities/` — output dir.
- `apps/holtburger-web/validate_wire_conformance.cjs` — add fixtures.

**Refs:** Chorizite XML at `external/chorizite/Chorizite.ACProtocol/protocol.xml` (search for `0x02CD` through `0x02EA` and `0x01D1` through `0x01DE`). ACE source: `~/ace-server/Source/ACE.Server/Network/GameMessages/Messages/GameMessageQualities*.cs`.

**Validation:**
- `cargo test -p holtburger-protocol --lib` PASS with new generated parity tests.
- Wire conformance count rises (currently 36 PASS / 0 FAIL / 0 SKIP per J5).

**Visibility check:** new opcodes must also be routed in `apps/holtburger-web/src/lib.rs` recv loop. If routing is missing, the parser exists but never fires — flag it in the commit. Likely a `match opcode { ... }` block that needs new arms.

**Effort:** S (codegen does the heavy lifting).

---

### Agent 1.B — read_pstring migration cleanup

**Goal:** finish the J2 read_pstring_char correctness-by-construction migration. Five parsers still use the old pattern with manual `align_boundary` calls: `game_time.rs`, `region.rs`, `chat_pose_table.rs`, `skill_table.rs`, `weenie.rs`.

**Surface:**
- `crates/holtburger-dat/src/file_type/game_time.rs`
- `crates/holtburger-dat/src/file_type/region.rs`
- `crates/holtburger-dat/src/file_type/chat_pose_table.rs`
- `crates/holtburger-dat/src/file_type/skill_table.rs`
- `crates/holtburger-dat/src/file_type/weenie.rs`

**Refs:** the migration pattern from J2 (`563afacc feat(holtburger): post-absorption Wave J1 + J2 — dead-code purge + correctness-by-construction`); search for an existing migrated file as template.

**Validation:**
- `HOLTBURGER_PORTAL_DAT=$HOME/ac_base_dats/client_portal.dat cargo test -p holtburger-dat` PASS.
- Spot-check a known string field in each (e.g., region name, chat-pose name) round-trips through dump + reparse.

**Visibility check:** N/A — pure correctness; no user-visible surface unless a region/weenie name was previously truncated/garbled. If you observe pre-fix garbling, log it.

**Effort:** S (2-3 hrs).

---

### Agent 1.C — Lifestone dispatch case

**Goal:** patch the upstream Chorizite gap flagged in the absorption-plan handoff §7: `World.CreateWorldObject` switch is missing the explicit `ObjectClass.Lifestone` case, so lifestones fall to the default branch and never get the typed `LifestoneWorldObject` subclass.

**Surface:** find where `CreateWorldObject` (or our port equivalent) lives. Likely `crates/holtburger-world/src/world_object_dispatch.rs` or `apps/holtburger-web/src/lib.rs` / `ui/world_object.js`. Grep `ObjectClass::` and `Lifestone`.

**Refs:**
- `external/chorizite/ACPlugin/API/World.cs` — `CreateWorldObject` method.
- `external/chorizite/ACPlugin/READING_GUIDE.md` — Wave A summary flagged this as "based on grepping, not run-validated."
- Pre-flight: verify the gap still exists in our port before patching. If we already fixed it, log it.

**Validation:** dispatch test that creates an entity with `ObjectClass::Lifestone` and asserts the subclass is `Lifestone`, not the generic fallback.

**Visibility check:** in-game, lifestone interact UI may currently show a generic object panel instead of the lifestone bind/recall UI. Verify what's visible on a lifestone entity today.

**Effort:** S (30 min if gap confirmed).

---

### Agent 1.D — SetWielded JS port

**Goal:** port `Character.cs:757-762` SetWielded logic so equip-from-paperdoll works. PR 3 shipped the WorldObject hierarchy but never circled back.

**Surface:**
- `apps/holtburger-web/src/lib.rs` — new narrow wasm export `set_wielded(item_guid, slot)`.
- `apps/holtburger-web/ui/equippable.js` (or wherever paperdoll equip flow lives) — wire the click handler.
- May need a new C2S `EquipObject` opcode wrapper if not already in `game_action.rs`.

**Refs:**
- `external/chorizite/ACPlugin/API/Character.cs:757-762` — source of port.
- `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionEquipObject.cs` — server contract.
- Memory: `project_holtburger_combat_phase_d_done_2026-05-17.md` (combat selection ring; the `findGuidByName` style).

**Validation:**
- Wasm builds; `set_wielded` appears in `pkg/holtburger_web.d.ts`.
- Smoke: log in, drag an item from inventory to a paperdoll slot, observe wire packet to ACE + server response.

**Visibility check:** the inventory + paperdoll UI from wave 14 already exists; this purely wires the click. If the paperdoll DOM doesn't have drop targets, that's the blocker — flag it (likely fix is also small, may pull into scope).

**Effort:** S (1-2 hrs).

---

### Agent 1.E — Player-tracked dynamic shadow gate

**Goal:** convert `SHADOW_RECEIVE_RANGE_M` from spawn-relative to per-frame player-tracking gate so shadows stop popping at landblock boundaries during traversal.

**Surface:**
- `apps/holtburger-web/scene3d/buildings.js:76-78` (TODO FU2-future).
- `apps/holtburger-web/scene3d/statics.js:594` (matching pattern).
- Tie-in to `scene3d/loop.js` for the per-frame check.

**Refs:** original FU2 wave notes (search commit log for `FU2`). Memory: `project_holtburger_stutter_fixes_2026-05-21.md` for the renderer.compile pre-warm precedent.

**Validation:**
- Smoke on 1070: walk across a landblock boundary in Holtburg; observe shadow continuity.
- Capture before/after screenshots to `/mnt/wbterminal1/tmp/claude-scratch/wave1e-shadow-gate/`.

**Visibility check:** CSM cascade ranges in `scene3d/lighting.js` must include the player-relative radius; if cascades top out below the gate radius, the gate is moot — verify cascade configuration.

**Effort:** S.

---

### Agent 1.F — Status-indicators state wiring

**Goal:** `plugins/status-indicators.js:9` notes "First pass: 6 indicators rendered with their canonical sprite, no state wiring." Subscribe to existing events to drive state transitions.

**Surface:** `plugins/status-indicators.js` only.

**Refs:**
- Events fired today (grep `events.emit`): `vitaeChanged`, `vitalChanged`, `containerUpdated`, latency tracking.
- Chorizite `gmFloatyIndicatorsUI` for the canonical state machine per indicator.

**Validation:**
- Manual: log in, take damage → vital indicator updates; pick up burden → carry-capacity indicator updates.
- Add a `test_status_indicators.mjs` smoke that fires synthetic events and asserts setState calls.

**Visibility check:** confirm the emit sites for each event actually fire under normal gameplay (some may be stubs). If a subscribed event never fires, the indicator stays at default — flag the missing emit.

**Effort:** S.

---

## Wave 2 — Scene/shader parallel (CLOSED 2026-05-28; 3 parallel agents)

All three lived in `scene3d/` but touched distinct files. Closed in one batch.

### Wave 2 closing summary

| Agent | Status | Commit | Notes |
|---|---|---|---|
| 2.A | shipped | `686801e8` | 32-color palette LUT in terrain fragment shader, retail-grounded RGBs from `client_portal.dat` 0x13000000. Dump tool + regenerator script + 22-test suite. Tint at default 0.25; surfaced as configurable. |
| 2.B | pivot-shipped | `87b2828d` | Pre-flight: Phase 1.1 Sobel-X already shipped in commit `fd475f2`; deferred-state comment was stale. Pivoted to the *actual* missing visibility — wired the `normalMaps` quality flag end-to-end (UI toggle was no-op) + per-category `normalScale` defaults table. +18 unit tests. |
| 2.C | pivot-shipped | `a8bcea72` | Pre-flight: audit's "124 placeholder IDs" was off by 120 — only 4 sentinels remain. Pivoted to building scaffolding for the actual remaining work: dumped 4.2 MB retail PhysicsScript catalog, derived 147-entry canonical PScript→DID map (`data/playscript-canonical-physics-scripts.json`), +13 lockdown assertions. Unblocks Wave 7. |

**Validation gate:** cargo check workspace PASS, wire conformance 40/40, all touched JS parses, 4 wave-2 tests PASS (terrain palette 22/22, normal gate skipped on missing three module but covered by quality-preset 32/32, resolver 67/67, quality 32/32).

**Audit-staleness pattern alert:** 4 of 9 agents across Waves 1+2 found their tasks already partially or wholly addressed by post-audit commits. **The post-J4 audit doc is now demonstrably ≥1-week stale across the board.** See "Wave 8 — audit refresh (recommended before Wave 4+)" below. Pre-flight verification stays mandatory in every agent brief until refresh lands.

---

### Agent 2.A — Terrain palette swap

**Goal:** the terrain vertex color R channel already holds palette index 0-31 (`scene3d/adapter.js:449`) but the PBR shader never samples it. Add a 32×1 LUT and one shader lookup so biome colors render correctly.

**Surface:**
- `apps/holtburger-web/scene3d/adapter.js` — verify the palette index is set per-vertex.
- `apps/holtburger-web/scene3d/terrain.js` (or wherever terrain material lives) — add LUT texture + shader sample.
- `apps/holtburger-web/data/` — add committed 32-color palette JSON if not present.

**Refs:**
- Memory: `reference_ac_terrain_textures.md` (33 tiles, 512×512 RGBA, SurfaceTexture chain).
- ACE.DatLoader for the canonical palette mapping.
- DRW for the palette index → color mapping (cross-check before trusting).

**Validation:**
- Smoke on 1070 across multiple biomes (Holtburg grass, sand, snow, dirt zones). Capture before/after screenshots.
- Add `test_terrain_palette.mjs` asserting LUT sampling gives expected RGB for known indices.

**Visibility check:** quality-preset gate may disable terrain palette per tier — verify it's on for at least `high` preset. If shadow + palette together hit a uniform-count limit on low-tier GPUs, gate appropriately.

**Effort:** S-M.

---

### Agent 2.B — Procedural normals (Phase 1.1)

**Goal:** ship the deferred Sobel-X height-to-normal pipeline documented at `scene3d/materials.js:108-109` and sketched at lines 497-509. Surface classification + tangent-space math already in place (lines 607-648).

**Surface:**
- `apps/holtburger-web/scene3d/materials.js` PBR section only.
- A new uniform / texture binding may be needed in the shader pipeline.

**Refs:**
- Memory: `project_visual_fidelity_wave2_done_2026-05-13.md` for the Phase 1.1 deferral context.
- ACE / acclient.c — no direct equivalent; this is a fidelity extension above retail.

**Validation:**
- Smoke on 1070: focus camera on stone/brick/wood walls; verify added micro-relief.
- Capture before/after to `/mnt/wbterminal1/tmp/claude-scratch/wave2b-normals/`.

**Visibility check:** surface classifier from Phase 1.4 (82% acc per memory) must include the categories you generate normals for. If classification fails, no normal is generated — the visible regression is just flat lighting. Log classifier misses you encounter.

**Effort:** M.

---

### Agent 2.C — PhysicsScript real-VFX completion

**Goal:** Wave 17 resolver works end-to-end for the live script families; 124 remaining PlayScript IDs still hit the placeholder branch. Port each to a `ParticleManager` emitter template using the already-built picker.

**Surface:**
- `apps/holtburger-web/scene3d/play_effect_vfx.js` (resolver at line 27; status summary at line 1945).
- `apps/holtburger-web/scene3d/particles/` (ParticleManager templates).
- May add to `apps/holtburger-web/data/` if a script-id → template map is committed JSON.

**Refs:**
- `external/holtburger/crates/holtburger-dat/examples/dump_cmt_ranged_rows.rs` — DAT dump template.
- `~/ac-headers/acclient.c:336552` — retail weighted-pick logic.
- ACE.DatLoader PhysicsScriptTable for the canonical entry shape.

**Validation:**
- `cargo run -p holtburger-dat --example dump_physics_scripts` (write if missing) covers all 124 IDs end-to-end.
- Add to `test_play_effect_resolver.mjs`: assert each previously-placeholder ID now returns a real template.
- Smoke on 1070: trigger a known spell whose script ID was in the 124; verify the real particles render instead of the placeholder sphere/cube/torus.

**Visibility check:** if `fetchPhysicsScriptTable(did)` returns null for an entity, your real template never even attempts — the placeholder fires. Check the `physicsScriptTableDid` per entity in the live entity manager. Flag entities whose DID is missing.

**Effort:** M (incremental — can ship in sub-batches of 30-40 IDs).

---

## Wave 3 — HUD / plugin / vitals (3 agents)

### Agent 3.A — Hotbar fire wiring

**Goal:** `plugins/hotbar.js:14-21` — "Real fire wiring (cast spell / use item) is a follow-on." Combat-bar already fires; mirror the call from hotbar slot click + numkey 1-9.

**Surface:**
- `apps/holtburger-web/plugins/hotbar.js`.
- `apps/holtburger-web/ui/keymap.js` for the numkey bindings.
- Reuse `sessionHandle.castSpell()` / `sessionHandle.useItem()` from the combat-bar code path.

**Refs:**
- `apps/holtburger-web/plugins/combat-bar.js` — the working precedent.
- `~/ac-headers/acclient.c` `gmToolbarUI::OnShortcut` for the canonical click → fire chain.

**Validation:**
- Smoke on 1070: drag a spell to hotbar slot 1; press `1`; verify spell fires and target is consumed.
- Smoke: drag a usable item (potion); press `2`; verify use packet sent.

**Visibility check:** if hotbar items don't persist across login, the user's hotbar will look empty every session. Check `localStorage` persistence — if absent, file a visibility flag (this is in scope to add if 5 LOC).

**Effort:** S.

---

### Agent 3.B — Examine-target dye preview

**Goal:** `dye-preview.js` (21KB) already renders paperdoll with dye applied; embed it in the existing `examine-target.js` detail-pane so examining another player or NPC shows them in their actual armor + dye colors.

**Surface:**
- `apps/holtburger-web/plugins/examine-target.js`.
- `apps/holtburger-web/plugins/dye-preview.js` (already built; embed as a sub-component).

**Refs:**
- Wave 14 paperdoll viewport (`project_holtburger_paperdoll_done_2026-05-25` or commit `765d0b72`).
- Chorizite `gmFloatyExaminationUI` for the canonical layout.

**Validation:**
- Smoke on 1070: examine a guard NPC; verify their equipped gear renders with dye in the detail panel.
- Add a test asserting `examine-target.js` instantiates the dye-preview when a target has inventory data.

**Visibility check:** if the target's inventory data isn't synced to the client (server only sends visible-slot data), the preview will show partial gear. Verify what gets transmitted on examine. Flag missing slots.

**Effort:** S.

---

### Agent 3.C — Per-vital granular events

**Goal:** today JS subscribes to a coalesced `kind=8 playerStatsUpdated` for vital bar updates, causing bursty animation. Split into per-vital `CLIENT_EVENT_KIND` arms so vital bars animate smoothly.

**Surface:**
- `apps/holtburger-web/src/lib.rs` — new event kind constants + per-vital emit sites in the Qualities update handlers.
- `apps/holtburger-web/plugins/vitals-hud.js` — subscribe to per-vital events instead of polling on coalesced.
- `apps/holtburger-web/ui/keymap.js` if event kinds are catalogued there.

**Refs:**
- `external/chorizite/ACPlugin/API/Character.cs:721` even/odd parity (ported in PR-4 per the post-J4 audit).
- Wave C derived-vital math (already in `crates/holtburger-core/src/client/vital_info.rs`).

**Validation:**
- Add `test_per_vital_events.mjs`: fire synthetic `Qualities_UpdateInt2nd` for Health, assert per-vital event fires once.
- Smoke on 1070: take damage; visually confirm health bar animates smoothly instead of stepping.

**Visibility check:** new event kinds must be added to the `drainEvents` switch in `index.html`. If routing is missing, the events are emitted but never delivered to plugins — silent failure. Verify drainEvents has arms for each new kind.

**Effort:** S.

---

## Wave 4 — Mid features parallel (2 agents)

Both touch `src/lib.rs` and `crates/holtburger-protocol/`. Smaller-surface agent (4.B) commits first; 4.A rebases.

### Agent 4.A — Train Skills UI

**Goal:** ship the skill-training panel. Wave C ported `SkillInfo` math (trained/specialized/credit-pool tiebreak); `PrivateUpdateSkill` is wired; only the panel + C2S opcode are missing. This is the **progression loop**.

**Surface:**
- `apps/holtburger-web/plugins/train-skills.js` (NEW).
- `apps/holtburger-web/src/lib.rs` — `train_skill(skill_id, points)` wasm export + protocol wrapper.
- `crates/holtburger-protocol/src/messages/` — new C2S opcode if missing.
- Register in `ui/bar.js` or as an NPC-interact-triggered panel.

**Refs:**
- `external/chorizite/ACBindings/Generated/UI/Elements/gmTrainSkillsUI.cs` — canonical layout.
- `external/chorizite/ACBindings/Generated/UI/Elements/gmStatManagementUI.cs` — attribute side (out of scope here but useful sibling).
- `external/chorizite/ACPlugin/API/SkillInfo.cs` — `canRaiseSkill` predicate.
- `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionRaiseSkill.cs` — server handler contract.
- `docs/acplugin-event-coverage-2026-05-27.md` §B rows 21-28 (PrivateUpdateSkill wiring).

**Validation:**
- Add `test_train_skill_packet.mjs`: pack/unpack the C2S opcode against a fixture.
- Wire conformance fixture added.
- Smoke on 1070: log in with a character that has available skill credits; open train-skills panel; raise a skill; observe server response + UI update.

**Visibility check:** the train-skills panel may need NPC-interact context to open (vs. always-available). Check ACE: is `raise_skill` always-available or NPC-gated? If gated, the panel needs an NPC-interact trigger to be reachable — flag if missing.

**Effort:** M.

---

### Agent 4.B — Remote-entity buff/debuff

**Goal:** Wave F.2 `CEnchantmentRegistry` is in; `plugins/buffs-hud.js` only renders self-buffs. Add target_guid dispatch and a per-nameplate bar so we can see debuff stacks on raid targets and ally buffs.

**Surface:**
- `apps/holtburger-web/plugins/buffs-hud.js` (refactor for per-entity).
- `apps/holtburger-web/src/lib.rs` — dispatch event with `target_guid` payload.
- `crates/holtburger-protocol/src/messages/` — wire new opcodes if missing (`OnMagic_DispelEnchantment` 0x02C4 + purge variants).
- `scene3d/nameplate.js` (or equivalent) — render per-entity bar.

**Refs:**
- `docs/acplugin-event-coverage-2026-05-27.md` §F #1 — ranked top renderer-impact gap.
- `external/chorizite/ACPlugin/API/Character.cs:620+` — dispel/purge handler precedent.
- ACE: `~/ace-server/Source/ACE.Server/Network/GameMessages/Messages/GameMessageEnchantmentUpdated.cs`.

**Validation:**
- Add `test_remote_buffs.mjs`: synthetic enchantment-update on a non-self GUID renders correctly.
- Smoke on 1070: spawn a creature via `@create`; cast Strength I on it; verify the buff bar shows above its nameplate.

**Visibility check:** if the nameplate system culls UI elements when the entity is off-screen, buff bars vanish — fine for performance. But if they vanish at near range (>~30m), it's a culling-distance regression. Verify nameplate cull distance.

**Effort:** M.

---

## Wave 5 — Tradeskill end-to-end (1 large agent, optionally 3 sub-agents in parallel)

The biggest opportunity. The `UseWithTarget` wire is live but our app has zero handler logic. ACE's `GameActionDoTradeSkillAttempt.cs` + skill-check + material consumption + result-notification chain is the entire missing layer. Unlocks tinkering / dyeing / salvage / imbues — a whole gameplay axis.

### Sub-agent layout (parallelize internally)

**5.A — Wire + protocol layer**
- Surface: `crates/holtburger-protocol/src/messages/` for the tradeskill request/response opcode pair; `apps/holtburger-web/src/lib.rs` for the C2S send + S2C recv route.
- Refs: `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameActionDoTradeSkillAttempt.cs`; `external/chorizite/Chorizite.ACProtocol/protocol.xml` (search `TradeSkill`); the existing `UseWithTarget` site is the entry hook.
- Validation: wire conformance fixture.

**5.B — Recipe / outcome data layer**
- Surface: `crates/holtburger-dat/src/file_type/craft_table.rs` (NEW if missing) — port the `CCraftTable` DAT type if not already there.
- Refs: ACE.DatLoader `CraftTable.cs`; cross-check DRW dats.xml against retail bytes (per the established pattern, DRW is often wrong).
- Validation: parser parity test against `HOLTBURGER_PORTAL_DAT`.

**5.C — UI layer**
- Surface: `apps/holtburger-web/plugins/tradeskill.js` (NEW) — invocation surface (use-item-on-item drag-drop in inventory; or a NPC-triggered tradeskill panel).
- Refs: `external/chorizite/ACBindings/Generated/UI/Elements/gmCraftRecipeUI.cs` for any retail tradeskill UI pattern; existing `plugins/inventory.js` for the drag-drop precedent.
- Validation: smoke on 1070: drag a dye onto a piece of armor; observe success / failure result; observe material consumption.

### Cross-cutting

- Visibility check: tradeskill outcomes are normally communicated via chat messages (success/failure) + inventory delta (consumed material + modified target). Both surfaces are already live. If outcomes arrive but neither surface updates, the player can't tell anything happened — flag.
- Three-source cross-reference applies here strongly: ACE (server) + acclient.c (client tradeskill UI logic) + Chorizite (typed wire shapes). Cite at least two in any non-trivial decision.
- Estimated total effort: M-L (~1 week if serial; ~3-4 days if 5.A/B/C run in parallel).

---

## Wave 6 — Wave 1 follow-ons (3 parallel agents)

Surfaced by Wave 1's visibility flags. All three are isolated surfaces; safe to run as one parallel batch.

### Agent 6.A — Qualities codegen recv-loop wiring

**Goal:** wire the generated `S2C_Qualities_*` parsers into the actual recv loop so the codegen layer isn't a parallel-unused implementation. Also patch the Chorizite XML f32→f64 mismatch for `UpdateFloat`, add 16 missing `Remove*` `GameOpcode` enum entries, and add 4 missing Attribute/Skill dispatch arms.

**Surface:**
- `crates/holtburger-protocol/src/opcodes.rs` — add 16 `Remove*` enum entries (0x01D1-0x01DE + 0x02B8/B9).
- `crates/holtburger-protocol/src/messages/game_message/unpack.rs:189` — add 4 missing dispatch arms (`UpdateAttributeLevel`, `Attribute2nd`, `Attribute2ndLevel`, `SkillAC`).
- `apps/holtburger-web/src/lib.rs:17321-17326` — re-route recv loop from hand-written variants to generated `S2C_Qualities_*`.
- `crates/holtburger-protocol/codegen/` or `build.rs` — override `UpdateFloat::Value` type (f32→f64) until upstream Chorizite XML fix at `protocol.xml:8082+8088`. Cite ACE `GameMessagePrivateUpdatePropertyFloat.cs:13` as the truth source.

**Refs:** see Wave 1.A commit `ee254118` body for the 4 specific visibility flags with file:line.

**Visibility check:** with all dispatch wired, per-property changes broadcast by ACE should now drive UI updates that previously coalesced into `kind=8` only. **Coordinate with Wave 3.C** (per-vital granular events) — these waves are independent but cover overlapping surface; the per-vital arms must not be duplicated. Recommend 6.A runs first; 3.C consumes the generated path.

**Validation:**
- `cargo test -p holtburger-protocol` PASS.
- Wire conformance: re-pack ACE-captured byte streams through generated path and assert byte-equality with hand-written path.
- Smoke on 1070: cast Strength I on self; observe the specific attribute opcode arrives at JS via the new path.

**Effort:** M.

---

### Agent 6.B — Lifestone bind/recall UI

**Goal:** typed `Lifestone` subclass exists (per Wave 1.C verification) but no UI consumer branches on it — lifestone interact flows through generic `examine()` → `client.player.useObject(guid)` instead of a bind/recall popup. Add a Lifestone-specific UI.

**Surface:**
- `apps/holtburger-web/plugins/lifestone-popup.js` (NEW).
- Hook: `worldObjectManager.addEventListener('created', e => { if (e.detail.object instanceof Lifestone) ... })` per Wave 1.C report.
- May need new wasm export for bind/recall opcodes if not already in `game_action.rs`.

**Refs:**
- `apps/holtburger-web/plugins/world-objects/lifestone.js` — typed subclass with `tie()` method already exists.
- `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/GameAction*Lifestone*.cs` — server contract for bind + recall.
- Wave 1.C commit `52292249` for the dispatch hook details.

**Visibility check:** lifestones in Holtburg are at known positions (memory: `project_holtburg_h2_h3_done_2026-05-12.md`); smoke-test by walking to one and observing the new UI vs. the generic examine flow.

**Effort:** S-M.

---

### Agent 6.C — Portal Storm S2C dispatch + bus emit

**Goal:** Wave 1.F pre-wired the Portal Storm indicator to subscribe to `portalStormChanged` events, but no emit site exists. The `Misc_PortalStorm*` opcodes (0x02C9-0x02CC) are catalogued and parsed by the protocol crate but never surfaced as a `ClientEvent` kind.

**Surface:**
- `apps/holtburger-web/src/lib.rs` — add a new `CLIENT_EVENT_KIND_PORTAL_STORM` + recv-loop dispatch arms for the 4 opcodes.
- `apps/holtburger-web/index.html` `drainEvents` switch — route new kind to `__pluginClient.events.emit("portalStormChanged", payload)`.
- Cross-check ACE's portal-storm broadcast logic to verify all 4 states fire under expected conditions.

**Refs:**
- Wave 1.F commit `b4aa4fe7` for the subscribe side (`status-indicators.js:209-216`).
- `data/chorizite/chorizite-acprotocol-opcodes.json:368-371` — opcode catalog.
- `~/ace-server/Source/ACE.Server/.../GameMessagePortalStorm*.cs` for broadcast triggers.

**Validation:**
- Add wire fixture for at least one `Misc_PortalStorm*` opcode (target 41/41 conformance).
- Smoke on 1070: trigger a portal storm scenario (admin command or natural recall flood) and observe the indicator activates.

**Effort:** S.

---

### Deferred from Wave 1 (parked — not in Wave 6)

- **InstancedMesh per-instance `receiveShadow`** (Wave 1.E): Three.js `InstancedMesh` can't toggle `receiveShadow` per-instance; would need shader-level support. Park until visual smoke shows distant InstancedMesh statics are visibly hurt by the bake-time-only decision.
- **`SetWielded` optimistic local update layer** (Wave 1.D): PR 4+ territory; pair with Wave 5 inventory work.
- **Mini-Game indicator (chess) wiring** (Wave 1.F): not wired server-side per ACE either; larger scope than Portal Storm. Defer until chess support is on roadmap.

---

## Wave 7 — Real-particle templates for placeholder-fallback path (3 parallel agents)

Generated from Wave 2.C's canonical map (`data/playscript-canonical-physics-scripts.json`, 147 entries). The Wave 17 PhysicsScript resolver already plays real visuals when an entity has `physicsScriptTableDid` populated — but most entities don't, so they hit `_runPlaceholderDispatch` and get sphere/cube/torus bursts regardless. This wave fills that fallback with real `ParticleEmitterInfo` POJOs driven by the canonical map.

Recommend splitting across 3 parallel agents by PScript family — disjoint output keys, easy parallel commit.

### Agent 7.A — Launch + Splatter + Spark families (~50 IDs)

**Goal:** highest-traffic combat IDs. Launch (0x04, 103 unique retail scripts) + Splatter family + Spark family.

**Surface:**
- New: `apps/holtburger-web/scene3d/playscript_real_templates.js` — lazy ParticleManager template factory; loads canonical map at init, fetches the per-ID `PhysicsScript` at first use, builds synthetic `ParticleEmitterInfo` POJOs from `CreateParticle` hooks.
- `scene3d/play_effect_vfx.js#_runPlaceholderDispatch` — call the new module for resolvable IDs; keep sphere/cube/torus fallback as last resort.
- `apps/holtburger-web/particles/particle_emitter_info.js` — reuse existing POJO schema.

**Refs:** Wave 2.C commit `a8bcea72`. Canonical map at `data/playscript-canonical-physics-scripts.json`. Picker logic at `~/ac-headers/acclient.c:336552` (weighted pick by `speed`).

**Visibility check:** `_runPlaceholderDispatch` may have stage-specific branches (windup vs hit vs end). Verify your template fires at the right stage; if a Launch script renders mid-projectile instead of at the muzzle, log it.

**Effort:** M.

### Agent 7.B — Explode + Health/Shield/Enchant families (~50 IDs)

**Goal:** explosion + buff-overlay IDs. Explode (0x05, 70 unique scripts) + Health/Shield/Enchant.

**Surface:** same module as 7.A; disjoint case arms in `_runPlaceholderDispatch`.

**Coordination:** 7.A and 7.B both edit `playscript_real_templates.js` + `_runPlaceholderDispatch`. Use clearly-labeled `// === Wave 7.A — ... ===` / `// === Wave 7.B — ... ===` comment blocks per lib.rs etiquette. Map of which IDs each agent owns documented in their commits.

**Effort:** M.

### Agent 7.C — physicsScriptTableDid per-entity population (visibility unblocker)

**Goal:** the visibility flag from 2.C — most entities lack `physicsScriptTableDid` so the real-VFX resolver never even attempts. Audit `scene3d/entities.js` to find where the field is populated and extend coverage to all entity classes that should have a table.

**Surface:**
- `scene3d/entities.js` — extend `_extractPhysicsScriptTableDid` (or equivalent) per the Wave 16 patterns.
- `apps/holtburger-web/src/lib.rs` may need a new wasm export if the data isn't surfaced. Check `crates/holtburger-dat/src/file_type/setup.rs` (or where SetupModel.default_phstable_id lives).
- Memory: `project_holtburger_combat_phase_h_done_2026-05-17.md` for Wave 16 entity collision context.

**Validation:** smoke on 1070: cast a spell on an NPC; verify real particles render (not placeholder) on a class that previously had no DID populated. Add lockdown test to test_play_effect_resolver.mjs.

**Effort:** S-M.

---

## Wave 8 — Audit refresh (recommended before Wave 4+)

**Status:** 4 of 9 agents across Waves 1+2 found their tasks already partially or wholly addressed by post-audit commits. **The post-J4 audit doc is now demonstrably ≥1-week stale across the board.** Continuing to spawn agents from the stale audit wastes compute on no-ops + pivots.

**Recommendation:** before drafting Wave 4+ briefs from the original 15-opportunity menu, run a 1-agent audit refresh pass against current `master HEAD`. The refresh checks each remaining opportunity (Wave 3, 4, 5) against:
- Recent commit log (`git log --since` the audit date)
- Existence of expected files / line numbers cited in the audit
- TODO/FIXME comments at the cited locations

**Output:** updated team-agents doc with corrected scope (or strike-throughs for closed items).

**Effort:** S (~2-3 hrs single-agent).

**When to run:** before Wave 4 dispatch. Wave 3 is small enough that pre-flight per agent is acceptable; Waves 4+ are bigger and a wasted scope re-pivot is more expensive.

---

## Cross-wave bookkeeping (orchestrator-owned)

### Per-wave verification checklist

- [ ] All agents in wave reported success.
- [ ] `cargo check --workspace` PASS.
- [ ] `wasm-pack build` PASS.
- [ ] Wire conformance PASS (count ≥ 36).
- [ ] Combat-rendering 6 smoke tests PASS.
- [ ] 1070 visual smoke run — at least login + spawn entity + cast spell + walk into landblock boundary.
- [ ] Any visibility flags raised → triaged into a follow-on doc.

### Wave cadence guideline

Recommend ~24h between waves to allow visual verification on the 1070 (via Firefox driver workflow per memory `reference_firefox_driver_workflow.md`). If a wave's visual smoke catches a regression, fix in scope before next wave fires.

### Memory updates after each wave

After Wave N closes, write one `project_wave_<N>_done_2026-05-NN.md` memory under `/home/wbterminal/.claude/projects/-home-wbterminal/memory/` summarizing what shipped and any leftover follow-ons. Pattern matches the existing `project_wave3a_done_2026-05-19.md` etc.

### Roll-up handoff

After Wave 5 closes, write `docs/handoff-2026-06-XX.md` summarizing all 15 opportunities' end state, any new visibility flags, and the next agent's recommended starting point. Pattern matches `docs/handoff-for-next-agent-2026-05-26.md`.

---

## Agent-count summary

| Wave | Agents | Surface | Status |
|---|---:|---|---|
| 1 | 6 | Codegen + 5 isolated parsers/plugins/scene tweaks | ✅ closed 2026-05-28 |
| 2 | 3 | scene3d/ shader + VFX | ✅ closed 2026-05-28 |
| 3 | 3 | HUD plugins + per-vital wasm split | pending |
| 4 | 2 | Train Skills + Remote Buffs (both touch lib.rs + protocol) | pending (audit-refresh recommended first) |
| 5 | 1 (or 3 sub) | Tradeskill end-to-end | pending |
| 6 | 3 | Wave 1 follow-ons: codegen wiring, Lifestone UI, Portal Storm dispatch | pending |
| 7 | 3 | Wave 2.C follow-on: real-particle templates + per-entity DID population | pending |
| 8 | 1 | Audit refresh against current `master HEAD` | recommended before Wave 4+ |
| **Total** | **22** | **15 original + 7 surfaced follow-ons** | |

Eight waves; ~22 agent slots. With ~24h cadence per wave, full sweep ships in ~7-9 days of orchestrator time (agent compute is parallel within each wave).

**Recommended ordering:**
- Wave 3 next (small, pre-flight per agent handles staleness)
- Wave 6 in parallel with or after Wave 3 (lib.rs surface overlaps with 3.C but coordinated)
- Wave 7 in parallel with Wave 6 (entirely disjoint — particle-templates vs protocol)
- Wave 8 between Wave 3 and Wave 4 (refresh before the bigger waves)
- Wave 4 and 5 last (informed by refreshed audit)
