# Armor-on-character + skill/attribute HUD — laptop investigation brief (2026-06-18)

**Audience:** the laptop (fresh wasm, real GPU, populated world).
**Why this exists:** the buildbox investigated "equipped armor not appearing on the character" and "skill/attribute menus broken." It refuted the original premise, ran a 16-agent static sweep, and *attempted* a headless runtime repro — but the buildbox harness is a degraded venue (ACE Network Timeout under the nullRender recipe + the `spawns` baked layer is missing here), so it could **not** produce a runtime verdict. The laptop is the right place to confirm. This is the "stuff to look out for" list.

---

## TL;DR
1. **It is NOT a data problem and NOT a WB.Terminal/ACEForge SQL thing.** holtburger reads DAT + LSD-Partial JSON, never ACE-World SQL. The data you need is already present (proven below). Don't chase emission.
2. **Check your HEAD first.** Current origin HEAD already contains commits that likely fix much of this (`default-on 41 feature-gates + spawn-pipeline fix`, HUD skills-pane consolidation, examine parity-wiring). If your laptop build predates them, pull + rebuild before retesting — half the symptoms may vanish.
3. The remaining real questions are **render/HUD wiring**, narrow and listed below with file:line and how to verify at runtime.

---

## 0. Premise correction (do not re-investigate)
- holtburger has **no ACE-World SQL ingestion** (only an unrelated dye-recipe builder). Ingest path = DAT + `external/LSD-Partial-2025-02-23_16-15/` weenie JSON + chorizite-parity JSON.
- LSD weenie JSON already carries everything: `attributes`, `skills`, `body` (body parts), `createList`, `emoteTable`, `spellbook`, plus `boolStats/intStats/didStats/iidStats/floatStats/int64Stats/stringStats`.
  - Proof: `22913 - The Auditor.json` (full attributes Str 325… + 10 skills); `51 - Platemail Cuirass.json` (ClothingBase DID `0x020001A6`, PaletteBase `0x0400007E`).
- So "make WB.Terminal emit bool/attribute/skill/body_part tables" delivers nothing to holtburger. It's the wrong layer.

---

## 1. CHECK THIS FIRST — are you behind HEAD?
Buildbox saw these on origin (HEAD `70ca0325`) that bear directly on the symptoms:
- `9d06254a holtburger-web: default-on 41 validated feature-gates + spawn-pipeline fix`
- `3d8a4a6d HUD BAND-B: skills-pane consolidation (S2/S4/S3)`
- `b87a2771 HUD BAND-A: skills 6-tuple — MARGINAL next-rank cost (R1/S1)`
- `8a897e74 HUD BAND-D+E: parity-wiring + examine/window (R6-R9, R11)`
- `f4f04d24 HUD BAND-C1: registry-dispatch R2-R5 + R10`
- `534130da … feafc0a1` anim Steps 1–5 (MotionSequence authority JS→Rust)

**Action:** if behind, `git pull` then
`cd apps/holtburger-web && wasm-pack build --target web --out-dir pkg --release`
(stale `pkg/` against newer `lib.rs`/`index.html` = silent total boot failure). Retest, then read the rest of this only for what's still broken.

---

## 2. Armor not appearing — candidate breaks (3D path; 2D PIXI is retiring, ignore it)
Static analysis says the web client's clothing pipeline is **mostly wired**; the live failure is one of these. Verify each at runtime.

**A. `?surfaceUnified` default-OFF → dyed/luminous gear renders flat-opaque (HIGH confidence, confirmed in code).**
- `scene3d/materials.js:1227-1236` (`readSurfaceUnifiedFlag`, URL opt-in, **default false**), and the entity-owned material build at `:2917` skips emissive/blending unless on.
- Symptom this explains: armor/NPCs look **flat/wrong-coloured**, dyed luminous gear washes out — *not* fully-invisible armor.
- Verify: boot with `?surfaceUnified=on` vs without; eyeball a dyed NPC / luminous gear. If it fixes the look, the action is "make this correct/default-on" (it's already a Wave-2 candidate, low risk).

**B. spawn-path appearance consumption (verify; static was contradictory).**
- Confirmed wired: `model_changes/texture_changes/sub_palettes` ARE consumed — `scene3d/loop.js:1943/2257/2616` slice `upd.modelChanges`; `scene3d/entities.js:2855` applies `meta.modelChanges`; `src/lib.rs:18883` handles `UpdateObject 0xF7DB → KIND_APPEARANCE`.
- The open question: do entities that **spawn already wearing** armor get their mesh assembled, vs only the equip-while-watching (`ObjDescEvent`) path? Probe: count entities with `meta.modelChanges>0` AND `meshParts>0`. Any "clothed-but-zero-mesh" = the bug.

**C. Is the appearance data even arriving from ACE?**
- If `model_changes.len()==0` on every spawn, the server (ACE `Creature.CalculateObjDesc()`) isn't populating ObjDesc — a server-side issue, not the client. Add a one-line trace at `src/lib.rs:34957` (ObjectCreate pack) / `scene3d/loop.js:2257`.

**D. Tree note.** The standalone Rust workspace (`/holtburger/crates`, the TUI client) genuinely lacks `clothing.rs` and drops `ObjDescEvent`/`UpdateObject` in `holtburger-world/routing.rs`. The **web tree** (`external/holtburger/crates` + `apps/holtburger-web`) has clothing.rs and handles those. Only relevant if you also run `holtburger-cli`.

---

## 3. Skill / attribute menus — candidate breaks
**Player's own panels look ALREADY WIRED** (confirm they actually populate at runtime):
- `plugins/character-info.js` Skills tab (`renderSkills`) + Attributes tab (`renderAttributes`) + `plugins/vitals-hud.js`, fed by `playerStats()` snapshot.
- Protocol path is complete: `PrivateUpdateAttribute/Skill/Vital` parsed → `holtburger-world/handlers/player.rs` → `DerivedStatsUpdated` → `playerStatsUpdated` bus → panels.
- The `hud-research-2026-06-16` backlog already **specced 6 ready-to-implement QoL fixes** (XP-table prefetch race, `raiseAttributeFailed`/`raiseVitalFailed` feedback, `playerXpSpent`, `vitalBaseChanged`, `maxRankAchieved`). If "menus broken" = these gaps, they're already designed; see `~/out/hud-research-2026-06-16/ROADMAP.md`.

**PROBE GOTCHA (cost us a cycle): `playerStats()` returns a wasm-bindgen struct** (`keys: ['__wbg_ptr']`), not a plain object. Read its fields via a **prototype-accessor walk** (copy the `clone()` in `harness/lib/boot.mjs` `readGetter`), NOT `Object.keys`. A naive read shows empty and looks like a broken panel — it isn't.

**The genuinely uncertain one — examine/appraisal of OTHER objects** (armor levels, creature attributes/skills on examine):
- wasm exports DO exist: `getObjectAppraisal` (`src/lib.rs:29268`), `requestAppraisal` (`:29243`); UI in `plugins/examine-target.js`.
- Verify: examine an NPC → does the appraisal panel show its attributes/skills/armor? If empty, check whether the `IdentifyResponse` `CREATURE_PROFILE` flag (0x0100) is set on the wire (ACE-side — ACE is the server) and whether `examine-target.js` renders `creatureProfile`.

---

## 4. Runtime checks to run on the laptop
You have the populated world + GPU we lacked. Suggested session:
1. Boot `?renderer=3d`, get in-world in Holtburg (NPCs present).
2. **Armor:** for each live entity, capture `meta.modelChanges/textureChanges/subPalettes` counts + traverse its `Object3D` for `isMesh` count; screenshot a clothed NPC. Run once `?surfaceUnified=off`, once `=on`, diff.
3. **Player armor:** does YOUR character show equipped gear? Equip/remove an item — does the model rebuild?
4. **Stat panels:** open Skills/Attributes (F1 → character), confirm rows populate; read `playerStats()` via the accessor clone.
5. **Examine:** examine an NPC; confirm appraisal attributes/skills/armor render.

A ready probe scaffold exists on the buildbox at `~/out/aceforge-followup-repro/repro.mjs` (covers all four). **Before reusing it, fix two things:** (a) read `playerStats()` via the prototype-accessor clone, not `Object.keys`; (b) use your laptop's stable-session recipe (the buildbox needed `renderOnDemand=1` + periodic `__renderOnce()` to avoid ACE Network Timeout — your GPU session may not).

---

## 5. Do NOT
- Build SQL emission in WB.Terminal for this (wrong layer; data already present).
- Audit/maintain the 2D PIXI path (retiring).
- Trust ACEForge's `SKILL.md` enum comments (its ItemType doc line is wrong, e.g. "6=MeleeWeapon").

---

## Provenance / confidence
- **Refuted with proof:** SQL-emission premise; data-availability as the cause.
- **Confirmed in code (HIGH):** `?surfaceUnified` default-OFF → flat-opaque dyed gear; appearance consumption + `UpdateObject` handling ARE present in the web tree; appraisal wasm exports exist; player stat protocol path complete.
- **Needs the laptop runtime to settle (MEDIUM):** does equipped armor mesh actually appear on screen; do the panels populate live; does examine render other-object stats; is ACE populating ObjDesc/CREATURE_PROFILE.
- **Buildbox repro = inconclusive** (ACE Network Timeout ~91s under the nullRender recipe + `spawns` baked layer missing here → empty world). That's a buildbox limitation, not a client signal. The 16 static agents also conflated the two source trees in places — corrected above via direct greps on the web tree.
