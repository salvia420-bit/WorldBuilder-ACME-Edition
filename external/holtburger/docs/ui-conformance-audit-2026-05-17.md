# UI Conformance Audit — holtburger-web vs Retail AC

**Date:** 2026-05-17
**Source:** asheron.fandom.com wiki dump (2024-01-19, extracted from
`/mnt/wbterminal1/ac-refs/ac-data-repo/asheron.fandom.com/2024-01-19-asheron_backup2_pages_full.xml`).
Audited pages: `User Interface`, `Combat`, `Magic Panel`, `Options Panel`,
`Inventory Panel`, `Radar`, `Allegiance Panel`, `Vitae`.

This doc audits everything we've shipped through Phase G against the retail
UI as documented on the fandom wiki, so Phase H (and beyond) targets the
right gaps.

## Status legend

- ✅ shipped and matches retail
- 🟡 partial / not quite retail
- 🔴 missing
- ⬜ out of scope (not a UI concern for this client)

## Combat panel

The retail Combat panel (per `Combat` page §Interface) shows up when you
toggle into combat mode, and its layout is **derived from the equipped
weapon**:

> "The combat bar has a slider for changing the speed versus power when
> wielding a melee weapon or speed vs accuracy when holding a missile
> weapon. The high, medium and low buttons refer to the attack height."

For magic (`Magic#Magic Mode`), the same bar slot transforms into a spell
bar / spell picker.

| Element | Retail | Our state | Notes |
|---|---|---|---|
| **Peace ↔ Combat toggle (dove icon)** | Visible button on the main UI | 🟡 `client.player.toggleCombatMode()` exists but no on-screen button | Phase H: surface as a bar icon or in the Combat Bar panel. Click dove → enter combat (stance derived from weapon). |
| **Speed↔Power slider (melee)** | Yes | ✅ Combat Bar plugin (Phase D) | Slider 0–100% maps to wire `power_level` ∈ [0,1]. |
| **Speed↔Accuracy slider (missile)** | Yes | ✅ Phase E — label flips when stance is ranged | Same underlying value as melee Power. |
| **High / Medium / Low attack height** | Yes | ✅ Phase D — Hi/Mid/Lo buttons | Wire values 1/2/3 confirmed in Phase A doc. |
| **Power-bar meter (fills during swing)** | Yes (`Combat#Power bar maneuvers`) | 🔴 not implemented | Subscribe to `attackDone` + `combatCommenceAttack` events; animate refill bar over the ACE-driven `nextRefillTime`. **Phase H priority.** |
| **Auto-repeat attacks tickbox** | Yes (Options Panel: "Automatically Repeat Attacks") | ✅ Phase D combat-bar plugin tickbox | Wire-side `CharacterOption.AutoRepeatAttacks` not yet round-tripped to server — set client-side only. **Phase H:** wire round-trip. |
| **Charge Attack (auto-move into range)** | Yes (`Combat#Charge Attacks`, Options "Use Charge Attack") | 🔴 not implemented | Player must be in melee range or attack fails. Retail auto-charges. **Phase H:** when click-attack target is out of range, send a MoveToState toward target first. |
| **Combat-mode panel pop-up** | Yes (auto-shows when entering combat) | 🟡 Combat Bar is a manual click | UX departure. Phase H decision: should combat-bar auto-open when stance changes from NonCombat to anything else? |

## Magic panel — Spellbook + Spell Bars

From `Magic Panel` (verbatim):

> "The spellbook panel (F5) list all spells currently known by your
> character. You can filter the list by magic school and spell level by
> using the check bubbles at the bottom of the panel.
>
> Right clicking any spell in the list displays more information…
>
> You can add a spell from the book to your currently open spellbar by
> dragging it or double clicking it. You can also add a spell to your
> other closed spellbars by dragging it to one of the numbered tabs.
>
> Any spell that you no longer use can be removed from the list by
> selecting it and pressing delete."

| Element | Retail | Our state | Notes |
|---|---|---|---|
| **Spellbook (F5) panel** | Yes | ✅ Phase G `plugins/spellbook.js` + F5 hotkey | Matches retail muscle memory. |
| **Known-spells filtered to player's spellbook** | Yes | ✅ Phase G — `Entity.spell_book` via `playerKnownSpells()` | Wire-sourced, not hardcoded. |
| **School filter (check bubbles)** | Yes | ✅ Phase G — War/Life/Item/Creature/Void toggles | |
| **Level filter (check bubbles)** | Yes (level I–VIII) | 🟡 not implemented | Phase H quick win. Catalog has `level` field. |
| **Right-click spell details** | Yes (school / mana / duration / desc / components / formula) | 🔴 not implemented | Phase H — popover with desc + mana + components. Components live in LSD `Components: List<uint>`. |
| **Drag-and-drop spell → bar** | Yes (primary mechanism) | 🟡 double-click only | Phase H — add HTML5 drag-and-drop alongside dbl-click. |
| **Double-click adds to currently open spellbar** | Yes | ✅ Phase G | Adds to first empty of 8 slots. |
| **Drag to a numbered tab → adds to a different spellbar** | Yes (multiple tabs) | 🔴 single bar only | Phase H — add tab strip. Retail had 7 numbered tabs. |
| **Delete key removes from spellbook** | Yes | 🔴 not implemented | Phase H — keyboard handler in spellbook plugin. (Wire opcode commented out in protocol's `opcodes.rs:398` — `RemoveSpellFromBook`.) |
| **Components panel (lists comps in packs)** | Yes | 🔴 not implemented | Phase J? Needs inventory filtering. |
| **Component Buyer + @fillcomps** | Yes (vendor + chat command) | 🔴 not implemented | Phase J? Needs vendor UI first. |

## Vitals (Health / Stamina / Mana)

Per `User Interface` page, the three vital bars are persistent at the top
of the screen.

| Element | Retail | Our state |
|---|---|---|
| Health bar (red) | Yes | ✅ `#vitals-panel` in index.html (pre-plugin DOM) |
| Stamina bar (yellow) | Yes | ✅ same |
| Mana bar (blue) | Yes | ✅ same |
| Bar position | Top of screen | 🟡 Currently in `#panels-row` below canvas. **Phase H:** move into the bar plugin area or top overlay. |
| Numeric label | Yes (current/max) | ✅ shown |

## Chat panel

Retail had a main chat window + 4 secondary windows, with per-window
category filters (Combat / Magic / Area / Tells / Allegiance / Fellowship
/ Trade / LFG / Roleplay / Society / Errors).

| Element | Retail | Our state |
|---|---|---|
| Chat panel with categories | Yes (tabs) | ✅ `#chat-panel` + `#chat-tabs` |
| Category filters | Per-window subscription list | 🟡 Tabs exist but filter logic is light. **Phase H:** verify all category bits surface correctly. |
| Multiple windows | 4 secondary | 🔴 Single chat panel | Out of scope unless someone asks. |
| Inactive vs Active opacity | Slider | 🔴 Not implemented | Low priority. |
| Stay-in-chat-mode after send | Toggle | 🟡 We exit after every send | Trivial to flip. |

## Inventory

| Element | Retail | Our state |
|---|---|---|
| Paper doll (equipped) | Yes | ✅ Inventory panel renders equipped list |
| Pack inventory (multi-pack) | Yes | 🟡 Single list, no pack tabs |
| Drag-drop equip / unequip | Yes | 🔴 Click-only model |
| Use Selected Item button | Yes | 🟡 useObject exists but no Selected Item state |
| Examine Selected Item button | Yes | 🔴 Not implemented |
| Selected Item Box | Yes (always visible) | 🔴 Not implemented |
| Shortcut Slots (action bar) | Yes | 🔴 Not implemented |

Phase H: introduce a `selectedItemGuid` global mirroring `selectedTargetGuid`, plus Use/Examine bar buttons.

## Radar

The `Radar` page describes a circular minimap top-right with zoom
controls + filter toggles for player / monster / item / corpse / NPC.

| Element | Retail | Our state |
|---|---|---|
| Circular radar (top-right) | Yes | 🔴 Not implemented |
| Filter toggles | Yes | 🔴 |
| Zoom in/out | Yes | 🔴 |

Phase I — dedicated radar plugin.

## Options Panel

Big options page. Notable for combat:

- "Run as Default Movement" — Phase D combat-bar's `run` field
- "Advanced Combat Interface" — alternate combat UI layout. Retail had two modes.
- **"Auto Target"** — server-side selection assistance
- **"Automatically Repeat Attacks"** — ✅ already shipped as tickbox in combat-bar plugin
- **"Use Charge Attack"** — auto-move to target (gap above)
- "Lead Missile Targets", "Use Fast Missiles"

| Element | Retail | Our state |
|---|---|---|
| Options Panel UI | Yes (4 tabs: Gameplay / Character / Chat / Config) | 🔴 Not implemented |
| Persisted to server | Yes (CharacterOption bitfield) | 🟡 We use localStorage; no server round-trip |

Phase J — Options Panel plugin (large).

## Bar / icon layout vs retail panel-strip

Retail's main UI strip near the bottom (per `User Interface` page Visual
Guide) had these icons in a row:
1. Peace/Combat Mode (dove)
2. Social Systems Panel
3. Magic Panel
4. Attributes, Skills, & Titles Panel
5. Map Panel
6. Options Panel
7. Open/Close Inventory
8. Use Selected Item / Selected Item Box / Examine Selected Item
9. Shortcut Slots (hotkey bar)

Our bar today:
1. ⚔ RynthSuite (stub)
2. ⚒ Combat Bar (our plugin)
3. 📖 Spellbook (Phase G)
4. ⚙ Settings (bar config)

**Recommendation for Phase H:** add icons for the retail-equivalent
panels we already have DOM for (Vitals, Inventory, Chat) and the
Peace/Combat toggle. The architecture supports this — each is a new
slot in `barSlots`. Their "panel" body wraps the existing DOM elements
or reads from facade getters.

## Phase H proposed scope (revised from Phase G's open follow-ups)

Ranked by user-visible impact + retail conformance gap:

1. **Peace/Combat dove icon** — visible toggle in the bar (or as a
   button inside Combat Bar). Hotkey: `\`` (backtick) like retail.
2. **Power-bar UI** during swing — subscribes to `attackDone` /
   `combatCommenceAttack` events and animates a fill over the refill
   duration. Visible meter in the Combat Bar panel.
3. **Charge Attack** — when picking.js fires an attack and target is
   out of melee range, queue a MoveToState toward the target first.
   Gated by an option toggle (default: on).
4. **Right-click spell details** — popover with description / mana /
   components. Catalog already has `mana`, need to widen catalog with
   `desc` + `components`.
5. **Drag-and-drop** spell → bar (alongside double-click).
6. **Level filter** in spellbook (catalog already has `level`).
7. **Delete-to-remove** from spellbook (with wire opcode
   `RemoveSpellFromBook` to be uncommented in protocol).
8. **Vitals bar repositioning** — move into a draggable HUD slot
   anchored top-center, instead of `#panels-row`.
9. **Selected Item Box** — mirror of `selectedTargetGuid` for items,
   plus Use / Examine buttons inside the inventory plugin panel.
10. **Multiple spell-bar tabs** (retail had 7 numbered) — defer to
    Phase I if Phase H is full.

## Out of scope (later phases)

- **Radar** (Phase I)
- **Compass** (Phase I)
- **Options Panel** plugin (Phase J)
- **Components panel + @fillcomps** (Phase J)
- **Map panel** (Phase J+)
- **Allegiance/Social Systems panels** (Phase K+)
- **Stretch UI / chat font face / 800x600 layout fidelity** — these
  are retail-era pixel-perfect choices; we're free to modernize.

## Source citations

- `User Interface` — UI Visual Guide showing the bottom-strip icon row
  and the Status Panels.
- `Combat` — Peace/Combat mode toggle (dove), combat bar (speed↔power /
  speed↔accuracy), attack heights, Charge Attacks, Power bar maneuvers.
- `Magic Panel` — Spellbook (F5), school+level filter check bubbles,
  drag/double-click to add to spellbar, right-click for details,
  Delete to remove, numbered spellbar tabs, Components panel,
  @fillcomps vendor commands.
- `Options Panel` — `Automatically Repeat Attacks`, `Use Charge
  Attack`, `Run as Default Movement`, `Advanced Combat Interface`,
  `Auto Target`, full chat-window category list.
- `Inventory Panel` — Paper Doll, pack contents, Selected Item Box,
  Use / Examine buttons.
- `Radar` — circular minimap, filter toggles, zoom controls.

See also:
- [[reference-external-drive-layout]] for the wiki dump location.
- [[project-holtburger-combat-phase-g-done-2026-05-17]] for what just
  shipped pre-audit.
