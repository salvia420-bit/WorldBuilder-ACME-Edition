# UI Shell + Plugin Architecture Spec

**Date:** 2026-05-17
**Status:** spec — not yet implemented
**Audience:** next agent picking up the in-viewport UI work

## TL;DR

Build a single horizontal icon-bar overlay that serves as both the **plugin manager** and the future **HUD container**. Plugins (RynthSuite-port chief among them) sit on the left, HUD elements (when they exist) on the right, separator `|` between. The bar replaces what retail AC players got from the **Decal sidebar + AC native UI** combined — cleaner because everything lives in one customizable surface.

This spec captures the load-bearing decisions so the next agent doesn't re-derive them.

## Mission context

`holtburger-web` is a Rust→wasm + Three.js browser client for Asheron's Call. The product hypothesis: by removing install/launch/server-config friction (no download, no Decal, no launcher chaining), we make AC accessible to a vastly wider audience. To over-deliver on that promise, we bundle quality-of-life plugins that retail players had to install separately — chief among them an auto-hunt feature equivalent to Virindi Tank.

What's shipped so far (as of 2026-05-17):
- 3D viewport (Three.js, r184)
- Movement: walk/run/turn/strafe/jump (with proper ACE-formula ballistic prediction)
- Entity collision (cylinder; BSP-poly deferred)
- PhysicsState draw-gate (hidden/cloaked entities)
- Chat panel, character select, door state
- Wire protocol surface: opcodes, GameAction, position sync, motion, vital broadcasts
- Sky/atmosphere, particles, ambient sounds

What's missing (relevant to this spec):
- **Any in-viewport UI.** All UI today lives in `index.html` DOM outside the canvas — chat panel, char-list, status bar, etc. None is embedded in the viewport.
- **Combat system.** Player can't attack, cast spells, or take damage feedback.
- **Inventory UI.** Player has inventory state (server-side) but no visualization.
- **HUD elements.** No vitals bars, no compass, no minimap, no buff display.

This is a *good* state for committing to a plugin-driven architecture: we have nothing to refactor yet.

## Load-bearing methodology (read first)

Before writing any code for a new game system, cross-reference three sources:

| Source | Question | Local path |
|---|---|---|
| **ACE-master** | What does the server expect to receive / what does it send back? | `~/ace-server/Source/` |
| **RynthSuite / RynthCore** | What client-level command API does a working bot call? | `github.com/tombohar/{RynthSuite,RynthCore}` — clone to `/mnt/wbterminal1/tmp/rynthsuite-spec/` and `/mnt/wbterminal1/tmp/rynthcore-spec/` |
| **acclient.h** | What does the retail client internally do? | `~/ac-headers/acclient.h` |

When all three agree, you have a complete picture. **The bot's API surface is our client's API surface** — same primitives, same names where reasonable. `StartAttackRequest`, `CastSpellOnSelf`, `ChangeCombatMode` are not bot abstractions; they're the AC client API the bot calls. We implement those primitives once in JS+wasm; the bot and the manual UI both consume them.

For every new system, produce a 1-page cross-reference doc citing all three sources before writing implementation code.

See memory: `feedback_three_source_cross_reference.md` for the canonical statement of this rule.

## The bar — primary UI surface

### Visual model

A single horizontal icon-bar overlay on top of the canvas. Default position: bottom-center. Icon-only (no text labels in the bar itself — text appears as tooltips on hover and as titles inside the panel that opens on click).

```
┌───────────────────────────────────────────────────────────────────┐
│                                                                   │
│                       (3D viewport)                               │
│                                                                   │
│                                                                   │
│                                                                   │
│                                                                   │
│                                                                   │
│ [*]  [*]  [*]  |  [ ]  [ ]  [ ]  [ ]                              │
│   plugins         HUD slots (empty today — placeholders or hide)  │
└───────────────────────────────────────────────────────────────────┘
```

Plugins appear first, then a `|` separator, then HUD elements (none exist yet — placeholders or hide them entirely).

### Required behaviors

1. **Tooltip on hover.** Hovering over any icon shows the plugin/element name. Example: hover over the RynthSuite icon → tooltip reads "RynthSuite".
2. **Click to open.** Click any icon → opens the associated panel/box (the plugin's UI). Click again to close. The panel is a draggable overlay independent of the bar.
3. **Customization controls** (right-click bar or settings gear → settings menu):
   - **Color** — background tint
   - **Size** — icon size (small / medium / large or px slider)
   - **Orientation** — horizontal ↔ vertical toggle
   - **Position** — anywhere on screen (drag to move; persists across sessions)
   - **Transparency** — alpha slider
   - **Minimize / maximize** — minimize collapses to a tiny pill (single icon: bar-of-icons glyph). Click to restore. Maximize returns to default horizontal bar.
4. **Persistence.** All customization survives reload via `localStorage`.

### Implementation notes

- The bar is plain DOM (HTML/CSS), absolutely positioned over the canvas — same model as the existing chat panel in `index.html`.
- No Three.js / wasm involvement for the bar itself.
- The bar's state lives in JS (no wasm round-trip).
- Plugin panel content is the plugin's responsibility; the bar just hosts the icon + opens the panel.

### Icons — start placeholder, upgrade later

For the first ship, use:
- A Unicode glyph or `*` character as a placeholder icon (e.g., `⚔` for combat, `🎒` for inventory).
- OR an in-game icon from the AC `0x05xxxxxx` surface range. The DAT cache already supports surface loading — could use a known icon ID at low risk. Memory `reference_ac_dat_file_types.md` documents the 0x05 prefix.

Defer in-game icon selection until the bar mechanics work. Placeholder unblocks the architecture.

## Plugin architecture

### Plugin = JS module + panel UI

A plugin is an ES module that:
1. Exports a manifest: `{ id, name, icon, version, description }`.
2. Registers a panel renderer: takes a host-supplied DOM container, populates it.
3. Subscribes to client events via the plugin facade API.
4. Calls client methods (e.g., `client.player.attack(targetGuid)`) when its logic decides to act.

```js
// Sketch of plugin shape
export const manifest = {
  id: "rynthsuite",
  name: "RynthSuite",
  icon: "⚔",                    // or surface DID
  version: "0.0.1",
  description: "Combat assistant ported from NexTank/VTank",
};

export function activate(client, panelEl) {
  // Subscribe to events
  client.on("entitySpawned", (entity) => { /* ... */ });
  client.on("vitalChanged", (vital) => { /* ... */ });

  // Populate panel
  panelEl.innerHTML = `<div>RynthSuite — combat & navigation</div>`;

  // Call client methods
  // client.player.attack(targetGuid);
}

export function deactivate() { /* cleanup */ }
```

### Client facade API surface

Wraps the existing wasm `SessionHandle` exports + WorldEvent stream into a plugin-friendly object. **Don't move the underlying logic** — just rename and shape.

Strawman namespaces (informed by RynthSuite's `CombatManager.cs` + Chorizite's `IClientBackend.cs`):

```
client.player.{jump(power), attack(targetGuid), castSpell(spellId, targetGuid),
               setCombatMode(mode), useObject(guid)}
client.player.position           // current WorldPosition
client.player.vitals             // {health, stamina, mana}
client.player.skills             // map of skill values

client.movement.{setForward(i8), setStrafe(i8), setTurn(i8), stop()}

client.chat.{send(msg), on("received", handler)}

client.entities.{get(guid), nearby(radius), iter()}
client.entities.on(eventName, handler)
  // events: "spawn", "despawn", "airborne", "stateChanged"

client.world.{currentCell, currentLandblock, terrainHeightAt(x,y)}

client.ui.{
  registerBarSlot(manifest),     // adds icon to the bar
  openPanel(pluginId),
  closePanel(pluginId),
}

client.events.{on(name, handler), off(name, handler), once(name, handler)}
```

Plugin authors who've seen Chorizite's `IClientBackend.cs` or RynthCore's `PluginSdk` should recognize this shape immediately.

### Plugin loading

V1: ES modules loaded via `import()` at runtime. Bundled plugins (RynthSuite-port etc.) live in `apps/holtburger-web/plugins/` and load on init. User-installed plugins (future) load from URL or local filesystem via File Input API.

No sandbox in v1 — plugins have full DOM and wasm access. Sandboxing (iframes, Web Workers, capabilities) is a Tier 2 follow-on if security becomes a concern. Vibe-code is acceptable for now.

### Stability disclaimer

Mark the plugin API as `version: "0.x.y"` until 3-5 internal plugins (chat, char-select, vitals, RynthSuite-port stub, inventory) have been built against it. Trying to stabilize before use leads to ugly compromises. Document that breaking changes are expected pre-1.0.

## Bundled plugins — order of development

Plugins to build against the facade, in priority order:

1. **Chat** — port the existing chat panel to plugin shape. Validates the API on something we already have working. ~1 day.
2. **Character/Vitals stub** — health/stamina/mana display. Validates the vital-event subscription. ~1 day. (HUD precursor.)
3. **RynthSuite-port stub** — minimal panel showing "RynthSuite [version]" + status. No combat logic yet. Just proves the bar can host a plugin with the canonical icon + tooltip. ~half day.
4. **Inventory** — needs combat + drag-drop event hooks first. Defer until combat lands.
5. **RynthSuite-port real** — port `CombatManager.cs` algorithm + meta/nav/loot parsers gradually as combat primitives land. Open-ended, weeks to months.

## Combat — first system to develop against the methodology

Combat is the next major game system AND the precondition for a real RynthSuite-port. Use it as the first proof of the three-source cross-reference cycle.

### Phase A: cross-reference research (deliverable: 1-page doc, no code)

For the first combat primitive (melee attack):
1. **ACE** — find `GameActionAttack` or equivalent in `~/ace-server/Source/ACE.Server/Network/GameAction/Actions/`. Document the wire packet shape, what events ACE emits back (damage, target lock, vital broadcasts).
2. **RynthSuite** — read `Plugins/RynthCore.Plugin.RynthAi/Combat/CombatManager.cs`. Find `StartAttackRequest` (we noticed the auto-repeat comment in earlier investigation). Map RynthCore's PluginSdk call back to the underlying client function.
3. **acclient.h** — find the matching retail client struct/enum. Confirm the wire-vs-internal mapping.

Output: `docs/combat-melee-cross-reference-YYYY-MM-DD.md` with citations.

### Phase B: wire the primitive (deliverable: passing tests, no UI)

- Add `GameAction::Attack` (exact name from ACE) to `holtburger-protocol/src/messages/`.
- Add `SessionCommand::Attack { target_guid, power }` + recv arm.
- Add `SessionHandle.attack(targetGuid, power)` wasm method.
- Unit tests for the wire packet pack/unpack (precedent: existing tests for `JumpActionData`).

### Phase C: visible behavior (deliverable: in-game)

- JS: click an entity → `handle.attack(guid)`.
- ACE responds with damage / hit-result events through existing vital/chat channels.
- Maybe a swing animation (vibe-coded like the jump pose if motion-table wiring isn't in place yet).
- Plugin-API parity check: same `client.player.attack(targetGuid)` that JS click handler calls is what a future bot plugin would call. **No extra work** — the API is shared.

### Phase D: next primitive (repeat cycle)

Combat-mode change, then spell cast, then defensive buffs, etc. Each gets its own cross-reference doc + wire + JS surface.

## Honest constraints

1. **RynthSuite is not literally portable.** It's x86 NativeAOT C# with `acclient.exe` injection. Mine it for algorithms + data formats + API names; don't try to load its DLLs.
2. **Chorizite is also not literally portable.** Same reason. Use `Docs/Chorizite_Hook_Gap_Analysis.md` (inside RynthSuite repo) as the spec for what plugin events bot authors expect.
3. **The bot-ecosystem bet is speculative.** Whether RynthSuite/Chorizite plugins ever materialize at scale is unknowable. Build the architecture because it's clean separation of concerns, not because plugin authors are queued up.
4. **Don't pre-add Lua.** Most "extend my client" people on the web are JS people. Wasmoon (Lua-in-wasm) is a 1-day add when a real Lua-only plugin author shows up. Until then, JS-only.
5. **No sandbox in v1.** Plugins have full access. Iframes/Workers come later if needed.
6. **API stability is 0.x until 3-5 plugins exist.** Don't promise stability before having usage data.

## Reference material in user's existing setup

| Resource | Path / URL | What it has |
|---|---|---|
| ACE server source | `~/ace-server/Source/` | Server-side AC reference |
| acclient.h (348 enums + 6936 structs) | `~/ac-headers/acclient.h` | Retail client debug-info catalog |
| WorldBuilder.Terminal | `~/WorldBuilder-ACME-Edition/WorldBuilder.Terminal/` (C#) | DAT byte-level oracle |
| DatReaderWriter (+.Extensions) | `~/WorldBuilder-ACME-Edition/external/DatReaderWriter/` + sibling | C# DAT toolkit, already wired into WorldBuilder |
| ACDataRepository (Mega) | `https://mega.nz/folder/L1MniCKJ#1dQCCFPc2ddcFILa_JGeZw` | EoR acclient.exe + decompiled .c / .h / .bndb / .i64 |
| RynthSuite + RynthCore | `github.com/tombohar/{RynthSuite,RynthCore}` | Modern NexTank/VTank port; AC bot literature as readable code |
| Chorizite | `github.com/Chorizite/Chorizite` | Decal-successor plugin host (C# .NET 8) |

Memory cross-references:
- `feedback_three_source_cross_reference.md` — the methodology
- `reference_ac_re_artifacts.md` — acclient.h + ACDataRepository provenance
- `feedback_no_phatac.md` — ACE-only for server references; do not use PhatSDK
- `feedback_base_dats_only_for_bake.md` — base DATs at `~/ac_base_dats/`
- `project_holtburger_jump_done_2026-05-16.md` — jump system as worked example of the methodology

## First concrete deliverable for the next agent

Build the bar. Six bullets:

1. **DOM overlay** in `apps/holtburger-web/index.html` (or a separate `ui/bar.js` module if cleaner). Absolutely positioned, bottom-center by default.
2. **Single hardcoded plugin slot** with `⚔` placeholder icon. Tooltip "RynthSuite" on hover. Click opens an empty panel titled "RynthSuite".
3. **Customization controls** wired:
   - Right-click bar → settings menu
   - Sliders/inputs for color, size, transparency
   - Orientation toggle (horizontal ↔ vertical)
   - Drag-to-reposition
   - Minimize button → collapses to single-icon pill
4. **Persistence** in `localStorage` keyed by user preferences.
5. **Plugin facade stub** at `apps/holtburger-web/plugins/api.js` exposing the strawman namespaces in this doc — empty stubs are fine. The point is having the import path stabilized.
6. **Spec test** (manual): launch dev server, see the bar appears, customize it, refresh, customizations persist.

After that ships: do the combat melee Phase A cross-reference as the next session's work.

## Out of scope for this session

- Actual combat implementation (Phase B+ of the methodology — start with cross-reference doc only)
- Lua runtime
- Plugin sandbox / iframe isolation
- HUD elements (none exist; reserve the bar slots, leave them empty/hidden)
- In-game icon resolution (placeholder text/glyph is fine until bar mechanics work)
- Sandboxed plugin store / install UI / signing
- Cross-plugin event coordination (single plugin per session is fine in v1)
