# Handoff: LayoutDesc (DAT 0x21) consumer wiring

**For:** next agent considering retail-UI port from Layout records.
**Status: parser shipped (101/101 byte-exact); wasm export NOT shipped; consumer NOT shipped.** Recommended action: **DEFER** until a concrete UX win is identified.

## Why this is deferred, not in-progress

The vitaeum-parity Milestone D shipped the full LayoutDesc chain (LayoutDesc + ElementDesc + StateDesc + MediaDesc + MasterProperty + BasePropertyDesc + BaseProperty) — 101/101 retail records parse byte-exact. The parser is production-ready.

What's missing is a **JS consumer that produces meaningful retail-fidelity wins**. Each of the 101 retail Layouts corresponds to a UI panel (target-bar, inventory, spellbook, character-info, etc.). Holtburger-web ships hand-written HTML+CSS for every one of those panels today — 24+ plugins under `external/holtburger/apps/holtburger-web/plugins/`. Replacing them with Layout-driven rendering is a multi-week refactoring project across all 24, not a one-PR wiring task.

**Critical evidence point**: Chorizite (the C# AC plugin ecosystem this project draws from) does NOT consume Layout either. Their UI path is RmlUI (HTML/CSS/Lua via Rml.Net), entirely orthogonal to retail's C++ UIElement tree. There is no reference implementation to port. Building a JS Layout consumer is greenfield work.

## When to revisit

Wire Layout consumption when ONE of these is true:

- A private-server team wants to ship a patched UI panel (e.g. custom inventory grid). Layout-driven rendering would auto-update without code changes.
- The hand-written HTML+CSS diverges visibly from retail and users complain. Layout-driven rendering enforces pixel-perfect parity.
- A bot/automation use case needs to enumerate panel structure programmatically. Reading retail Layout is cleaner than scraping plugin HTML.

Until then, the hand-written plugins are simpler to maintain.

## Layout-ID → existing-plugin mapping (for reference)

Captured from the originating Explore agent run:

| Layout ID | UI Surface | Existing hand-written plugin |
|---|---|---|
| `0x2100001A` | Character Info (Attributes/Skills/Titles) | `plugins/character-info.js` |
| `0x21000016` | Target bar + buttons | `plugins/target-bar.js` |
| `0x21000023` | Inventory panel (300×362) | `plugins/inventory.js` |
| `0x21000024` | Equipment paper-doll (224×214) | `plugins/inventory.js` paperdoll |
| `0x2100002C / 2D / 5E` | Skill/Attribute tabs | `plugins/character-info.js` |
| `0x2100002F` | Allegiance panel (300×600) | `plugins/allegiance-panel.js` |
| `0x21000030` | Fellowship panel | `plugins/fellowship-panel.js` |
| `0x21000026` | Map view | `plugins/map-panel.js` |
| `0x21000066` | Journal panel (34 elements) | `plugins/journal-panel.js` |
| `0x21000069` | Contracts panel | `plugins/contracts-panel.js` |
| `0x21000071` | Status indicators (30 elements, 32 image DIDs) | `plugins/status-indicators.js` |
| `0x21000074` | Radar UI (120×140) | `plugins/radar.js` |
| (~89 more) | Vendor, buffs, spellbook, potions, pet, vitals, ... | Various plugins |

## Low-cost proof-of-concept spike (if curiosity wins)

1 day of work — produces a tiny demo that proves the walk is correct without building a real renderer.

1. Add `fetch_layout_desc(id)` wasm export to `apps/holtburger-web/src/lib.rs`. Pattern matches Wave 7.1 exports but uses `serde_json::to_string(&layout)` because the nesting is too deep for manual JSON construction. Add `LayoutDesc::unpack(&[u8])` to `crates/holtburger-dat/src/file_type/layout.rs`.
2. Add to `window.__hbWasm` (`index.html:1292` region).
3. Write `ui/ac_layout.js` with `loadLayoutDesc(id) → Promise<LayoutDescJSON>`.
4. Pick the smallest Layout (status-indicators, 30 elements, mostly static images). Build a one-off `plugins/_layout-poc.js` that walks `layout.elements`, emits a flat `<div>` per element with `width/height/x/y` from `element.state_desc.properties`, and renders the image DIDs as `<img src="...">` via the existing surface-pixels chain.
5. Compare to the hand-written `plugins/status-indicators.js`. If pixel-perfect AND maintainable, scale up; if brittle, mothball.

Estimate: 1 day for the spike. Decision: continue or shelve.

## How to pick up (if shipping Layout consumer)

1. Read this doc.
2. Read `crates/holtburger-dat/src/file_type/layout.rs` (LayoutDesc) + `element_desc.rs` + `state_desc.rs` + `master_property.rs` for the recursive shape.
3. Read `crates/holtburger-dat/tests/layout_parity.rs` for the parity test that confirms wire-format correctness.
4. Read `apps/holtburger-web/CHORIZITE_PORTING_PLAN.md` §13 for the strategic context.
5. Run the spike above to validate the walk.
6. Pick a panel + ship it as a single PR. Update `docs/ui-asset-completeness-method.md` §1 pipelines table (move LayoutDesc out of §6).

## Cross-references

- Parser: `external/holtburger/crates/holtburger-dat/src/file_type/layout.rs` (+ siblings `element_desc.rs`, `state_desc.rs`, `media_desc.rs`, `master_property.rs`, `base_property.rs`)
- Parity test: `external/holtburger/crates/holtburger-dat/tests/layout_parity.rs` (101/101 PASS)
- ACE reference: `external/ACE/Source/ACE.DatLoader/FileTypes/LayoutDesc.cs` + `ElementDesc.cs` + `StateDesc.cs`
- Acclient: `~/ac-headers/acclient.c` — `grep -n "LayoutDesc\|CUIPage\|CUILayout"`
- Chorizite vendored: `external/chorizite/ACBindings/Generated/Dats/DBObjs/LayoutDesc.cs` (reference only)
- Originating wave: `external/holtburger/docs/vitaeum-parity-plan-2026-05-23.md` Milestone D (full Layout parity write-up)
- Existing UI: `external/holtburger/apps/holtburger-web/plugins/` (24+ hand-written HTML+CSS plugins)
