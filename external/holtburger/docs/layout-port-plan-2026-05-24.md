# Layout-port plan — wire remaining plugins to retail LayoutDescs

**Started:** 2026-05-24, after the radar/compass port (commit `5a1b957e`).
**Status doc parent:** `vitaeum-parity-plan-2026-05-23.md` "Inventory window port" + "Radar / compass" sections.
**Pattern:** Each plugin reads ElementDesc positions/sizes from `client_local_English.dat`'s LayoutDesc records (0x21NNNNNN range) at runtime via `ui/ac_layout.js`'s `loadLayout(id)` + `findElementById(layout, elemId)`. Hand-tuned CSS stays as fallback.

## Plugin × layout inventory

24 plugins total. 21 reference a retail LayoutDesc in their head-comment; 3 don't (Holtburger additions or composite components).

### Wired (3 layouts across 2 plugins)

| Plugin | Layout | Retail name | Commit | What's wired |
|---|---|---|---|---|
| `inventory.js` | `0x21000023` | gmInventoryUI | `998bbc8a` | paperdoll area + bag column + items grid + burden bar |
| `inventory.js` | `0x21000024` | gmPaperDollUI | `e606604a` / `998bbc8a` | 21/22 body slots + burden bar position |
| `radar.js` | `0x21000074` | gmRadarUI | `5a1b957e` | disk + lock + move + 4 cardinals + coords strip (8/8 elements) |

### Candidates — open layout-port work (16 layouts)

Ordered by likely-visual-impact descending; effort is rough.

#### Tier 1 — high impact, small/medium effort

| Plugin | Layout | Retail name | Dims | Notes |
|---|---|---|---|---|
| `chat-panel.js` | `0x2100006F` | gmFloatyMainChatUI | 410×100 | Sizing-correct already; retail puts 4 left-edge buttons + scrollbar + input-row + send button at specific offsets. Our hand-tuned layout has tabs on TOP (Holtburger UX choice) — see "Chat specifics" below for the divergence the user should weigh. |
| `hotbar.js` | `0x21000070` | gmFloatyToolbarUI | 310×100 | 18 elements; 9 hotbar slots + 2 nav arrows + ammo/lock controls. Our impl has 9 slots in a row, no nav arrows. |
| `vitals-hud.js` | `0x2100006C` | gmFloatyVitalsUI | small | Three horizontal bars (HP/ST/MN) with labels. Currently top-center; layout would give exact bar positions/sizes. |
| `target-bar.js` | `0x21000016` | gmToolbarUI | TBD | Layout decoded already (see plugin comments). 5 panel shortcuts + Use/Target/Examine + Pack rows. |
| `status-indicators.js` | `0x21000071` | gmFloatyIndicatorsUI | 150×30 | 30 elements / 32 image DIDs. Position of each status icon. |
| `combat-hud.js` | `0x21000007` | gmCombatUI | TBD | Stance + power-bar + attack-height triangle. |
| `combat-bar.js` | — | (Holtburger-only) | — | No retail layout — combat-bar is a holtburger plugin abstraction. Skip. |

#### Tier 2 — high impact, larger effort

| Plugin | Layout | Retail name | Notes |
|---|---|---|---|
| `options-panel.js` | `0x21000029` + `0x21000293` | gmConfigUI | 8-tab options panel; outer layout positions tab strip + content area; each tab's content is a sub-layout `0x21000293` (the comment notes this is unwired). Heavy: tab strip with 8 buttons + dynamic per-tab content. |
| `character-info.js` | `0x2100001A` + `0x2100002C` + `0x2100002D` + `0x2100005E` | gmCharacterInfoUI / gmAttributeUI / gmSkillUI / gmCharacterTitleUI | Parent layout + 3 child layouts (Attributes / Skills / Title). Position of stat columns, attribute rows, skill list, etc. |
| `vendor-ui.js` | `0x21000012` | gmVendorUI | Vendor buy/sell panel — wares grid + buy/sell buttons + slider. Comment says "Layout decoded from chorizite-dump-layout-tree on 0x21000012" so element-id mapping is already known. |
| `spellbook.js` | `0x21000032` | gmSpellbookUI | School tabs + spell grid + detail pane. Comment notes "Real DAT sprites extracted from gmSpellbookUI". |
| `map-panel.js` | `0x21000026` | gmMapUI | 11 elements; world bitmap + zoom controls + coords readout. |

#### Tier 3 — single-purpose panels (independent ports)

| Plugin | Layout | Retail name | Notes |
|---|---|---|---|
| `journal-panel.js` | `0x21000066` | gmJournalUI | 34 elements / 7 image DIDs. Quest journal — parchment 9-slice + entry list. |
| `contracts-panel.js` | `0x21000069` | gmContractsUI | 20 elements / 3 image DIDs. |
| `allegiance-panel.js` | `0x2100002F` | gmAllegianceUI | 34 elements / 5 image DIDs. Layout already decoded in plugin comments. |
| `fellowship-panel.js` | `0x21000030` | gmFellowshipUI | 36 elements / 11 image DIDs. |
| `examine-target.js` | `0x2100006B` | gmFloatyExaminationUI | Floating popup — rows of property labels + values. |
| `main-panel.js` | `0x2100006E` | gmFloatyPanelUI | Container chrome (frame + title bar + close button). Reusable wrapper — wiring this drives consistent panel chrome across all child views. |

### Not-applicable (3 plugins)

| Plugin | Reason |
|---|---|
| `combat-bar.js` | Holtburger abstraction over melee/missile/magic; no single retail panel maps |
| `stance-toggle.js` | Folded into combat plugin per `project_holtburger_motion_table_combat_path` memory |
| `dye-preview.js` | Holtburger-only UX addition (dye preview tooltip) |
| `buffs-hud.js` | No retail layout reference in code; check `acclient.h` for gmFloatyBuffsUI before assuming |

## Chat specifics — gmFloatyMainChatUI (0x2100006F)

The user asked specifically about the chat window. Layout dump:

```
root 0x10000600 (410×100, 23 children)
├── 16 frame corners + decorative edges (4 per side × 4 visual states)
├── 0x10000010 chat-log container (5, 5) 400×73
│   ├── 0x10000011 text area (16, 0) 368×73   ← 16-px gutter for left buttons
│   │   └── 0x1000048C badge/icon (0, 57) 16×16
│   └── 0x10000012 scrollbar track (384, 0) 16×73   ← right-side scrollbar
├── 0x1000046F top-right button (368, 5) 16×16, 2 states
├── 0x10000522 left button A (5, 5) 16×16   ┐
├── 0x10000523 left button B (5, 22) 16×16  │ 4 stacked left-edge
├── 0x10000524 left button C (5, 39) 16×16  │ buttons (likely
├── 0x10000525 left button D (5, 56) 16×16  ┘ filter/option toggles)
└── 0x10000013 input row (5, 78) 400×17
    ├── 0x10000014 channel selector (0, 0) 46×17, 2 states
    │   └── 0x10000015 selector inner (0, 0) 46×17
    ├── 0x10000016 text input field (46, 0) 306×17
    │   ├── 0x10000017 left decoration (0, 0) 1×17
    │   └── 0x10000018 right decoration (397, 0) 1×17
    └── 0x10000019 send button (354, 0) 46×17, 3 states
```

### Side-by-side with current `chat-panel.js`

| Feature | Retail layout | Current Holtburger | Action |
|---|---|---|---|
| Outer dims | 410×100 | 410×100 | ✅ matches |
| Tab/filter UI placement | 4 buttons left-edge (vertical strip 16×72) | 7 horizontal buttons across top | **Divergence** — retail's 4-button column is more compact but holds fewer filters. Need user judgment. |
| Chat-log area | (5, 5) 400×73, text inset (21, 5) 368×73 | top:24, left:4, right:4, bottom:22 (≈400×54) | Layout-driven would gain ~19px height by reusing the top tab strip |
| Right-side scrollbar | 16×73 explicit element | CSS `scrollbar-width: thin` | Visual difference (retail had a dedicated scrollbar element with brass styling) |
| Top-right button | (368, 5) 16×16 with 2 states | Not present | Add for retail parity (options / pin / collapse?) |
| Input row | (5, 78) 400×17 | bottom row | Sizing approximate |
| Channel selector | 46×17 | Has dropdown button | Width-correct |
| Text input | 306×17 | flex:1 fills | Layout-driven gives explicit width |
| Send button | 46×17 with 3 states | Has Send button | Sizing-correct |

### Recommended chat scope (3 options)

**Option A — surgical, matches retail anatomy:**
Apply layout-driven positions to chat-log area, scrollbar element, input row, channel selector, text input, send button. KEEP the 7-button horizontal top tab strip as a Holtburger usability win (more filter granularity than retail's 4-button strip). Add the top-right button per retail layout. Effort: ~1.5 hours.

**Option B — full retail port:**
Replace the 7-button top tab strip with retail's 4-button left-edge strip. Reduces filter granularity (need to decide which 4 of All/Local/Tells/Channels/Combat/Magic/System to keep). Layout has 4 button slots so this is one-to-one with retail. Effort: ~3 hours + filter UX decision.

**Option C — pure data layer, no visual change:**
Wire `loadLayout(0x2100006F)` and `findElementById` calls but apply only invisible sizing — frame corners, decorative edges, scroll behavior. Hand-tuned positions for everything user-visible stay in place. Useful as scaffolding for the future. Effort: ~30 min.

## Cross-cutting groundwork

Before tackling individual ports, two infrastructure pieces would compound:

### G1 — Lazy layout pre-bake in `boot.hba`

Add the most-frequently-loaded layouts to `BOOT_ESSENTIAL_PORTAL_IDS` so they bundle into boot.hba and skip the per-shard HTTP fetch. Candidates: `0x21000023` (inventory), `0x21000024` (paperdoll), `0x21000074` (radar), `0x21000070` (hotbar), `0x2100006F` (chat), `0x2100006C` (vitals), `0x2100006E` (main-panel container). Plus the master record `0x39000001` (already chained per call). Effort: 15 min + re-bake.

### G2 — Plugin-side `applyLayoutRegions(layoutId, refs)` helper

Each plugin port replicates a similar `applyXxxLayout` helper. Extract a common helper into `ui/ac_layout.js` that takes a layoutId + `{ elemId → DOM ref }` map and applies x/y/w/h. Plus a `withParentOrigin(parentLayoutId, parentElemId)` mode for the burden-bar pattern (anchor inside a parent panel). Effort: ~1 hour, reduces every subsequent port by ~30 LOC.

### G3 — Richer `fetch_layout` payload (StateDesc / BaseProperty / MediaDesc)

Current wasm `fetch_layout` v1 emits geometry only. The StateDesc tree carries background image DataIDs, hover/active state colors, text content references, behavior flags. Adding these would unlock layouts that depend on multi-state rendering (lock-button's locked/unlocked sprites; channel-selector's dropdown-open state). Effort: 2–3 hours of wasm + serializer + JS unpack.

## Suggested order

1. **G1** re-bake — closes a stale follow-on, ~15 min ops work, makes Tier 1 ports faster.
2. **G2** helper extraction — refactor while the pattern is fresh (one inventory + one radar to consolidate from).
3. **Chat (Option A)** — answers the user's direct question, ~1.5 hours, visible-but-conservative.
4. **Hotbar** — same size class as chat; quick win.
5. **Vitals HUD + status-indicators + target-bar** — small focused HUD strip ports.
6. **G3** richer payload — needed before character-info / spellbook / options-panel (state-driven UIs).
7. **Vendor + spellbook + map + journal + contracts + allegiance + fellowship + character-info + options-panel** — sequential, each ~2 hours.
8. **Main-panel container** — last; once individual panels are consistent, port the wrapping `gmFloatyPanelUI` to drive chrome.

Total: ~25–30 hours of layout-port work to consume the full inventory. Spread across sessions.

## How to add a new layout port (recipe)

Mechanical pattern after the inventory + radar precedent:

1. **Dump the layout** offline:
   - copy `apps/holtburger-tools/examples/radar_layout_dump.rs` to `<plugin>_layout_dump.rs`, change the const at top
   - `cargo run --release --example <plugin>_layout_dump`
   - identify element_id → semantic-purpose map by cross-referencing with the plugin's hand-tuned positions

2. **Add the consumer to the plugin**:
   - import `loadLayout, findElementById, getCachedLayout, parseElementIdHex` from `../ui/ac_layout.js`
   - declare `<PLUGIN>_LAYOUT_ID` + named element-id constants at module scope
   - add `apply<Plugin>Layout(refs)` function that chains `loadLayout` and walks each ref through `findElementById`; mirror inventory's `applyBox(el, layoutEl)` helper
   - call from `mount()` AFTER the elements are appended to the DOM (so `parseFloat(el.style.left)` reads can find anchors for relative children)
   - if the plugin mounts via `mountBar()` (before `init_resource_source`), include the 8-retry × 2s backoff loop from radar.js (`?diag=1` shows `[plugin-layout]` console messages for verification)

3. **Write the e2e verifier**:
   - copy `verify_radar_layout_e2e.cjs` or `verify_inventory_layout_e2e.cjs`
   - swap the EXPECTED region map for the new layout's elements
   - run from `/mnt/wbterminal1/tmp/claude-scratch/` per `feedback_use_external_drives_for_scratch`

4. **Document + commit**:
   - update this plan doc's status table
   - one commit per layout, message `feat(layout-port): wire <plugin> from <gmName> <id>`
   - reference screenshot in `docs/layout-<plugin>-2026-05-24.png`
   - update the vitaeum-parity-plan-2026-05-23.md status log section

## Gotchas (load-bearing lessons from radar)

These can re-occur on any plugin that mounts before wasm is ready:

1. **`ac_layout.js` inflight-cache race** — *FIXED in commit `5a1b957e`* but worth knowing. If you see a layout consumer reporting "wasm=false" repeatedly with no `[ac-layout]` fetch logs, the inflight Map entry may be stuck. The fix is `await Promise.resolve()` at the top of the IIFE so the body yields a microtask before running.

2. **CSS centering translates re-apply when inline `transform = ""`** — clearing an inline transform lets the CSS rule's `translateX(-50%)` re-take effect. Set `transform = "none"` explicit-override instead; the rAF tick captures it and special-cases "none" → "" before chaining downstream rotations.

3. **Boot-order: `mountBar()` runs BEFORE `window.__hbWasm`** — any plugin mounted via the bar (not user-initiated panel-open) must handle the wasm-not-yet-ready case. The radar's 8 × 2s retry loop is the established pattern.

4. **Hand-tuned values often diverge from retail in surprising ways** — the paperdoll case had weapons scattered across the body diagram instead of in a top row at y=8. Visual differences are usually authentic-retail; ask the user before reverting.
