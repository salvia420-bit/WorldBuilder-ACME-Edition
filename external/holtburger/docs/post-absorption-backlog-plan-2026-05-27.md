# Post-absorption backlog plan — 2026-05-27

**Audience:** team agents picking up known follow-on items after the chorizite absorption plan landed end-to-end (2026-05-27, commits `bf9b5ea9..a9ea2695`).

**Source of truth for shipped state:** [`chorizite-reading-guide-summary-2026-05-27.md`](chorizite-reading-guide-summary-2026-05-27.md) §1 "Shipped status" + §2 upstream-bug catalogue + §7 open questions.

**Code-quality framing:** items are ordered by their *contribution to codebase legibility, correctness-by-construction, and future-proofing* — not by user-visible feature value. Feature polish is intentionally last.

---

## TL;DR

5 waves, ranked by code-quality contribution:

| Wave | Theme | Risk | Effort | Parallel? |
|---|---|---|---|---|
| **J1** | Kill dead code & two-source-of-truth ambiguities | Low | 1-2 hours | Yes (3 agents) |
| **J2** | Correctness-by-construction (close incomplete primitives) | Low | ~½ day | Yes (1 agent for 5 sub-migrations) |
| **J3** | Codegen coverage growth (PR 7.2) | Med | ~1 week | Partially (after J3.A foundation) |
| **J4** | Feature polish | Low | 1-2 days | Yes (3 agents) |
| **J5** | Pre-existing test failures | Low | 1-2 hours | Yes (2 agents) |

**Why this order?** Removing ambiguity (J1) reduces the cognitive load for everyone touching the code after; closing correctness gaps (J2) eliminates "works today only because conditions don't trigger the bug" tech debt; codegen coverage (J3) is foundation-tier work that pays off long-term; feature polish (J4) is incremental user value with low code-quality impact; pre-existing test failures (J5) get cleaned up last because they're orthogonal to the absorption work but should be addressed before they normalize.

---

## Inventory (what's actually in the backlog)

### A. Code-health drift (eliminate ambiguity)

1. **3 orphan hotkey declarations** (handoff §1 PR 8 + Polish B reports):
   - `emote-panel.js` sets `window.__toggleEmotePanel` for "Shift+F2", but `FKEY_SHIFT_TOGGLES` doesn't include F2.
   - `combat-bar.manifest.json` declares F4, but `index.html`'s F4 dispatch is `toggleView("inventory")` (combat-bar.js has no F4 listener).
   - `inventory.manifest.json` declares `"I"` as a hotkey, but no JS handler exists anywhere.

2. **`combat-bar.mount()` unwired** (Polish A report): The pre-existing barSlots literal only attached `activate`, not `mount`. mount() registers armed-spell cleanup that currently never fires. Either wire it or delete the unused code.

3. **Hybrid loader/static-import duality** (Polish A report): 31 static `import * as <id>Plugin` lines retained in `index.html` for non-bar uses (`mainPanelPlugin.registerView`, `inventoryPlugin.view`, `compass-hud` side-effect import, etc.) alongside the loader-driven barSlots. Two source-of-truth situation. Long-term: every plugin should self-register its non-bar functionality.

4. **Legacy FKEY_VIEWS / FKEY_SHIFT_TOGGLES retained** (Polish bridge): the manifest-hotkey path is live, but the legacy tables still serve as fallback for the 3 unmanifested plugins (character-info F1, options F10, spell-research Shift+F4). Worth either declaring those 3 hotkeys in manifests (even if they don't have manifests today) or deleting the fallback path.

5. **`PROP_INT_PHYSICS_STATE = 107` correction** (suspected drift): handoff §3 hierarchy work moved PhysicsState from PROP_INT_PHYSICS_STATE=93 to 107 in `world-state.js`. The original 93 was the position in `gmInventoryUI`'s field set, not the PropertyInt; the corrected 107 matches `holtburger-common::PropertyInt::PhysicsState`. Verify no other site still references 93 for this purpose.

### B. Correctness-by-construction (close incomplete primitives)

6. **5 pre-existing parsers should migrate to `read_pstring_char`** (handoff §2 row 13): `game_time.rs`, `region.rs`, `chat_pose_table.rs`, `skill_table.rs`, `weenie.rs` — all read `PStringBase<char>`-annotated fields with the older `read_pstring + align_boundary` pattern that's silently incomplete on the 0xFFFF length escape. Safe today because retail strings are <65,534 bytes, but correctness-by-construction means these should use the corrected primitive.

### C. Codegen coverage growth (PR 7.2)

7. **PR 7.2 — the conditional-encoding cases** PR 7 deferred. Priority order from PR 7's report:

   | Sub-PR | Feature | Sites | Code-quality value |
   |---|---|---|---|
   | 7.2.A | `<align>` padding directives | several | Foundation — establishes cursor-tracking discipline |
   | 7.2.A | `<subfield>` packed bit-fields | 6 | Foundation — small, no cross-refs |
   | 7.2.B | `<vector length="FieldName">` | 12 | **Biggest payload-shape win** — unblocks PackableList/HashTable + ACBaseQualities/ACQualities family (needed for renderer's nameplate/material-specific shading from real wire data) |
   | 7.2.C | `<maskmap>` bitfield-driven optional fields | 22 | **Most sites** — unblocks WeenieHeaderFlag object descriptors (used by every entity create/update) |
   | 7.2.D | `<switch>` discriminated unions | 18 | TurbineChat nested BlobDispatchType + WeenieDesc switch arms |
   | 7.2.E | `<table>` Dictionary<K,V> + templated types | 4 + N | Interacts with 7.2.B + 7.2.D; do last |
   | 7.2.F | `<if condition>` conditional encoding | rare | Trivial after 7.2.B-D |

### D. Feature polish (deferred char-creation + spell-level cache)

8. **SpellLevelCache for `roughLevel` accuracy** (Wave F.1 deferred): retail `acclient::InqSpellLevelByRoughHeuristic` uses undocumented power-component inspection; ACE bypasses with a hand-curated `SpellLevelCache`. Wave F.1's hybrid Proxy currently uses JSON name-suffix level for accuracy. Port the cache from ACE.

9. **Char-creation hair/skin swatch pickers** (Wave D.2 deferred): v1 ships a Randomize Appearance button only. Add per-feature swatch pickers (hair color strip, hair-style icon strip from CharGen icon images).

10. **Char-creation manual attribute spending** (Wave D.2 deferred): v1 routes through pre-spread templates. Add the slider UI for `gmCGProfessionPage`.

11. **Char-creation multi-area picker** (Wave D.2 deferred): auto-picks heritage's first primary area. Add the dropdown for `gmCGTownPage`.

### E. Pre-existing failures (orthogonal to absorption)

12. **`tell_command_dispatches_tell_client_command`** in `holtburger-cli` — flagged failing since Wave C. Unrelated to absorption work; should be triaged.

13. **`soa_aos_parity` env-file failure** — needs `/mnt/wbterminal1/holtburger-dist-v2/manifest.json` which isn't present in the standard dev env. Either commit a synthetic test fixture or guard the test on env-file existence.

14. **Wave F.4 wire-conformance SKIPped fixture** (handoff §2 row 10): exposes upstream Chorizite Write/Read bool asymmetry. Either widen the WB.Terminal validator's synth-pack pipeline to pre-widen bool fields, or accept the SKIP indefinitely.

---

## Wave-by-wave execution plan

### Wave J1 — Kill dead code & two-source-of-truth ambiguities

**Theme:** "anyone reading the code should be able to trust that declared = active."

**Parallel-safe:** 3 agents on entirely different surfaces.

| Agent | Scope | Files |
|---|---|---|
| J1.A | Orphan hotkey cleanup + decide combat-bar.mount() | `apps/holtburger-web/plugins/{combat-bar,emote-panel,inventory}.js` + `.manifest.json` + `index.html` |
| J1.B | Legacy FKEY consolidation: declare F1/F10/Shift+F4 in manifests; delete `FKEY_VIEWS` fallback path | `apps/holtburger-web/index.html` + 3 new tiny manifests if needed |
| J1.C | Audit + delete unused static plugin imports where loader-driven path covers them; document the ones that legitimately can't be removed | `apps/holtburger-web/index.html` |

**Validation:** all JS test suites green; manual key-press exercise (or extend `keymap_manifest.test.cjs` to assert no orphans).

**Risk:** low. J1.A and J1.B are surgical. J1.C requires careful audit but is purely deletions.

**Exit gate:** zero orphan hotkey declarations; combat-bar.mount() either wired or removed; legacy FKEY tables retired; static imports retained only for documented non-bar uses.

---

### Wave J2 — Correctness-by-construction

**Theme:** "code that's correct only because conditions don't trigger the bug isn't correct."

**Parallel-safe:** single agent does all 5 parser migrations + tests.

**Scope:** migrate `game_time.rs`, `region.rs`, `chat_pose_table.rs`, `skill_table.rs`, `weenie.rs` from `read_pstring + align_boundary` to `read_pstring_char`. Validate each against retail portal.dat via existing parser-parity tests.

**Validation:**
- `cargo test -p holtburger-dat --lib` PASS (currently 223; should stay green).
- `cargo test -p holtburger-dat --lib --features retail-parity` PASS against `HOLTBURGER_PORTAL_DAT=~/ac_base_dats/client_portal.dat`.
- Bonus: add a 0xFFFF-length-escape stress test for at least one of the 5 (synth-construct a string >65,534 bytes, verify the migrated parser handles it correctly).

**Risk:** low. Each migration is a 1-line `use` change + replacement of `read_pstring(_, 2)? + align_boundary(reader, 4)?` with `read_pstring_char(_)?`. The shapes are identical for the safe-path (<65,534 bytes). The stress test guards against regression on the escape path.

**Exit gate:** 5 parsers migrated; one stress test for the 0xFFFF escape path; `read_pstring`'s doc-comment can drop the "verified-safe callers" list (everyone uses `read_pstring_char` now).

---

### Wave J3 — Codegen coverage growth (PR 7.2)

**Theme:** "the generated layer should approach 100% of protocol.xml; hand-written parsers should be the exception, not the rule."

**Parallel-safe:** NO for J3.A (foundation); YES for J3.B+ once foundation lands.

Sequencing:

1. **J3.A — Foundation: `<align>` + `<subfield>`** (~1 day, single agent). Smallest features, no field-cross-references. Establishes cursor-tracking + bit-extraction patterns the bigger features rely on. Tests + at least 6 newly-emitted simple-type cases that previously hit the SKIPPED path.

2. **J3.B — `<vector length="FieldName">`** (~2 days, single agent). The biggest single payload-shape win. 12 sites including PackableList/HashTable (which unblocks ACBaseQualities/ACQualities — the renderer's nameplate/material-specific shading source). Tests against real wire captures from PCap fixtures (handoff §7 mentions WorldBuilder Terminal fixture capture path).

3. **J3.C — `<maskmap>`** (~2 days, single agent). 22 sites. Unblocks WeenieHeaderFlag (used by every entity create/update). Tests against the existing hand-written `WeenieHeader` unpacker — must produce byte-identical bytes for ≥10 fixture object descriptors.

4. **J3.D — `<switch>` + `<table>` Dictionary<K,V>** (~2 days, single agent). 18 + 4 sites. Tests against TurbineChat captures.

5. **J3.E — Templated types + `<if condition>` mop-up** (~1 day, single agent). The remaining long tail.

**Validation per sub-PR:**
- `cargo test -p holtburger-protocol --test generated_parity` PASS (existing 6 tests + N new for newly-covered shapes).
- Generated artifact line count grows; SKIPPED-note count shrinks. Track both in the parity test.
- `cargo check --target wasm32-unknown-unknown -p holtburger-web` PASS at every step.
- Spot-check: pick 3 newly-covered message types, parse a real wire capture with both the generated reader AND the hand-written reader where applicable, assert byte-identical output. (Hand-written stays source of truth; generated must agree.)

**Risk:** medium. The codegen output is mechanically generated, so the failure mode is "doesn't compile" — recoverable. The harder risk is subtle wire-format divergence between Chorizite's protocol.xml and acclient.c. Per handoff §2 rows 7-8, ACBindings doc-comments + struct layouts aren't always bit-for-bit accurate; cross-ref `acclient.c::<Type>::UnPack` for any non-trivial generated reader before trusting it.

**Exit gate:** generated coverage ≥98% (target: <5 SKIPPED notes in the output). PR 7.2.E mop-up brings the codegen to "complete" status; future protocol.xml drift gets auto-absorbed via `cargo:rerun-if-changed`.

---

### Wave J4 — Feature polish

**Theme:** "incremental user-visible improvements with low code-quality impact."

**Parallel-safe:** 3 agents on independent surfaces.

| Agent | Scope | Files | Effort |
|---|---|---|---|
| J4.A | SpellLevelCache port from `ACE.Server/WorldObjects/WorldObject_Magic.cs:1948-1958` → replace Wave F.1's heuristic | `crates/holtburger-protocol/src/messages/magic/` + `apps/holtburger-web/src/lib.rs` wasm + JS spellbook hybrid Proxy update | ~1 day |
| J4.B | Char-creation hair/skin/eyes swatch pickers (per-feature icon strips from CharGen DAT) | `apps/holtburger-web/plugins/character-creation.js` + new wasm icon-strip exposers | ~1 day |
| J4.C | Char-creation manual attribute spending UI + multi-area picker | `apps/holtburger-web/plugins/character-creation.js` + tests | ~½ day |

**Validation per agent:** existing tests + new tests for the added UI surfaces. No regression.

**Risk:** low. Pure feature additions on top of stable foundations.

**Exit gate:** all three deferred Wave D.2 + F.1 polish items shipped; matrix doc updated.

---

### Wave J5 — Pre-existing test failures

**Theme:** "tests should always pass, or be explicitly disabled with a reason."

**Parallel-safe:** 2 agents on different test failures.

| Agent | Scope |
|---|---|
| J5.A | Investigate + fix `tell_command_dispatches_tell_client_command` in `holtburger-cli`. If unfixable, mark `#[ignore]` with a reason. |
| J5.B | Either commit a synthetic fixture for `soa_aos_parity` OR guard the test on env-file existence. Wave F.4 wire-conformance SKIP either resolves the WB.Terminal pipeline gap OR documents permanent SKIP. |

**Risk:** low. Either the test passes or it's properly disabled with a documented reason; the codebase stops shipping with known-failing tests.

**Exit gate:** `cargo test --workspace --lib` runs 0 failures (no `--exclude` needed); JS regression suite likewise.

---

## Parallelism map (entirely non-overlapping surfaces)

| Wave | Surface |
|---|---|
| J1.A | `plugins/{combat-bar,emote-panel,inventory}.{js,manifest.json}` + index.html (hotkey region) |
| J1.B | index.html (FKEY region) + possibly 3 new `<id>.manifest.json` |
| J1.C | index.html (import region) |
| J2 | `crates/holtburger-dat/src/file_type/{game_time,region,chat_pose_table,skill_table,weenie}.rs` + utils.rs doc-comment |
| J3.A-E | `crates/holtburger-protocol/build.rs` (sequential within J3) |
| J4.A | `crates/holtburger-protocol/src/messages/magic/` + JS spellbook |
| J4.B | `plugins/character-creation.js` + wasm icon exporters |
| J4.C | `plugins/character-creation.js` (different region than J4.B — but coordinate at commit time) |
| J5.A | `apps/holtburger-cli/src/pages/game/input/commands.rs` |
| J5.B | `tests/soa_aos_parity.test.cjs` + `validate_wire_conformance.cjs` |

**Top-of-J1 parallel batch:** J1.A + J1.B + J1.C (3 agents) + J2 (4th agent on different crate) is the cleanest first push — 4 agents, completely non-overlapping, all eliminating ambiguity / closing correctness gaps.

---

## Estimation summary

| Wave | Effort | Risk |
|---|---|---|
| J1 (3 agents parallel) | 1-2 hours wall-clock | Low |
| J2 (1 agent) | ~½ day | Low |
| J3 (sequential J3.A → parallel J3.B-E) | ~1 week | Medium |
| J4 (3 agents parallel) | 1-2 days wall-clock | Low |
| J5 (2 agents parallel) | 1-2 hours wall-clock | Low |
| **Total** | ~1-2 weeks if J3 is fully done; ~3 days if J3 is deferred | Low-medium overall |

J3 is the bulk; deferring 7.2.D + 7.2.E (the long tail) yields most of the value in ~½ the time.

---

## Recommended start

**J1 + J2 in parallel (4 agents, ~½ day wall-clock).** Highest code-quality return per hour; all low risk; all eliminate technical debt that compounds over time.

**Then J5 (~1 hour) for clean test runs.**

**Then J3.A + J3.B + J3.C** (the high-value codegen growth) — sequenced because they share `build.rs`. J3.D + J3.E can be deferred as "future cleanup" if priorities change.

**J4 last** — incremental feature value once the foundation is clean.

---

## Cross-cutting conventions (all waves)

- Cite source file:line in doc-comments per the absorption-plan convention.
- Update handoff doc §2 if new upstream bugs are surfaced.
- Update matrix doc (`docs/acplugin-event-coverage-2026-05-27.md`) if Y/N counts change.
- Test additions follow the existing pattern (cargo `#[cfg(test)]` mod for Rust; `tests/<name>.test.cjs` for JS).
- Parallel agents: don't touch the handoff doc — batch the updates at commit time.
- One commit per wave (or one per agent if multiple ship same day).

---

## Open questions for the next planning round

1. Is the WB.Terminal validator pipeline worth extending to handle the upstream Chorizite Write/Read bool asymmetry, or accept the 4 SKIP fixtures indefinitely?
2. Should `read_pstring_char` ever supplant `read_pstring`, or remain two separate primitives forever?
3. PR 7.2.E (templated types + `<if condition>` mop-up) — is the ~1 day worth shipping, or is "98% codegen coverage" the right stopping point?
4. The handoff doc's TL;DR §3 "5 missing enums" claim is now stale (Wave B + Wave G shipped them all); should the TL;DR be updated, or kept as a session-start snapshot?
