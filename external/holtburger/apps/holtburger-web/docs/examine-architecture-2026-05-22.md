# Examine / Inventory architecture in retail Asheron's Call

Researched 2026-05-22 against `~/ac-headers/acclient.c` (Hex-Rays decomp of
retail `acclient.exe`) + the SkunkTrader keymap dump at
<https://gitlab.com/Cyprias/SkunkTrader/-/raw/master/docs/acclient.keymap.txt>.
This explains the *shared* relationship between the Inventory window
and the Examine system that surfaced during the Wave 1 UI port.

## Key binding — how examine starts

The keymap file exposes exactly one examine-related action:

| Action | Key | Section |
|---|---|---|
| `SelectionExamine` | **E** | `UICommands` |

Pressing **E** triggers `SelectionExamine`, which routes through
`ClientUISystem::ExamineObject(unsigned int i_iid)` (acclient.c:402002).

Right-click in the inventory also takes this path via
`ClientUISystem::ExecuteTargetModeForItem(_itemID, Target_Mode::EXAMINE)`
at acclient.c:402078 — mode `2` calls `ExamineObject` with the clicked
item's GUID.

## `ClientUISystem::ExamineObject(i_iid)` (acclient.c:402002)

Two branches:

1. **`i_iid != 0`** — we already know what to examine. Sends
   `CM_Examine::SendNotice_ExamineObject(i_iid)` to the server
   (acclient.c:14487). The server returns an `AppraisalProfile`.

2. **`i_iid == 0`** — no target yet. Enters **examine target mode**:
   - `targetMode = 2`
   - Cursor swaps to the red examine cursor (DAT sprite likely
     `0x06004D6A` per the cursor pair `0x06004D69` standard +
     `0x06004D6A` examine variant).
   - Registers an input-map so the next click on any object fires
     `ExamineObject(clickedGuid)` recursively.
   - Esc cancels target mode (handled via `m_bLeaveTargetMode`).

There's a parallel `ClientUISystem::ExamineSpell(i_spellID)` at
acclient.c:402025 that routes to `CM_Examine::SendNotice_ExamineSpell`.
Used by the Spellbook panel and `gmSpellComponentUI`.

## Wire layer — `CM_Examine`

Three send methods (acclient.c:14487-14489):

```c
CM_Examine::SendNotice_ExamineObject(unsigned int i_objid);
CM_Examine::SendNotice_ExamineSpell(unsigned int i_spellid);
CM_Examine::SendNotice_SetAppraiseInfo(unsigned int i_objid, AppraisalProfile *i_prof);
```

The `SetAppraiseInfo` round-trip is the *response* — server packs an
`AppraisalProfile` and sends it back; client receives via
`gmExaminationUI::RecvNotice_SetAppraiseInfo`
(acclient.c:4407).

## `gmExaminationUI` — the examine panel logic

Class lives at acclient.c:226504 (ctor); inherits from `UIElement_Field`.
Its layout is **0x2100006B** (gmFloatyExaminationUI's
LayoutDesc when used as a standalone floating window) — but the same
class also lives *inside* the inventory window (see next section).

Internal state (set in ctor):

```c
v4->m_activeUI                = 0;   // pointer to whichever sub-UI is shown
v4->m_itemUI                  = 0;   // ItemExamineUI
v4->m_creatureUI              = 0;   // CreatureExamineUI (extends BasicCreatureExamineUI)
v4->m_charUI                  = 0;   // CharExamineUI (other players)
v4->m_spellUI                 = 0;   // SpellExamineUI
v4->m_displayedNameText       = 0;
v4->awaiting_appraisal_ID     = 0;
v4->current_appraisal_ID      = 0;
v4->m_examineNewlySelectedItem = 1;  // auto-examine on selection-change
```

`PostInit` at acclient.c:228634 creates all four sub-UIs as siblings,
then calls `SetActiveExamineUI(m_itemUI)` to pick the default.
`SetActiveExamineUI(ExamineSubUI *ui)` (acclient.c:4324) shows the
selected sub-UI and hides the other three.

Sub-UI selection rules (read from `RecvNotice_ExamineObject` +
`RecvNotice_ExamineSpell`):

| Examined target | Active sub-UI |
|---|---|
| Item (weapon, armor, scroll, consumable) | `m_itemUI` |
| Generic creature/monster | `m_creatureUI` |
| Another player character | `m_charUI` |
| Spell (from spellbook / scroll appraisal) | `m_spellUI` |

`CharExamineUI` (acclient.c:228468) adds four player-specific text
fields on top of the BasicCreatureExamineUI base:

```c
v2->m_displayText_Heritage       (element 0x10000150)
v2->m_displayText_Profession     (element 0x10000151)
v2->m_displayText_PlayerKiller   (element 0x10000152)
v2->m_displayText_AllegianceName (element 0x1000053A)
```

## Inventory ↔ Examine — the *shared window* relationship

`gmInventoryUI::PostInit` (acclient.c:222318) resolves four sub-elements
into the inventory's runtime composition:

```c
0x100001CD → m_paperDollUI    (gmPaperDollUI)   // left,   224×214  equipped armor view
0x100001CE → m_backpackUI     (gmBackpackUI)    // right,  61×339   bag-tab column
0x100001CF → m_3DItemsUI      (gm3DItemsUI)     // lower,  234×120  *items grid + examine swap*
0x100001D3 → m_titleText      (UIElement_Text)  // top,    276×25   title strip
```

The third one is the load-bearing surface. `gm3DItemsUI` serves *both*:

1. **Default state**: shows the player's pack contents as a grid of
   3D-rendered item icons (the retail "items" panel).
2. **On item-click / E-key on item / right-click → Examine**: that same
   area swaps to show the examined item's enlarged 3D model + the
   appraisal stat block.

So examining an **inventory item** doesn't pop a separate window —
the inventory's lower region just changes state. The floating
`gmFloatyExaminationUI` (layout 0x2100006B) only auto-pops when you
examine something *outside* inventory:

- Creature picked in the 3D world (E key on a target)
- Spell from `gmSpellbookUI` right-click → Examine
- Item dropped on the ground (ground-pickup overlay)

## `gmFloatyExaminationUI` — the floating-window wrapper

Class at acclient.c:259684. Inherits from `gmExaminationUI` and adds
the standard floating-panel chrome:

```c
m_pTopBorder           m_pTopBorder_Locked
m_pLeftBorder          m_pLeftBorder_Locked
m_pBottomBorder        m_pBottomBorder_Locked
m_pRightBorder         m_pRightBorder_Locked
m_pTopLeftCorner       m_pTopLeftCorner_Locked
m_pTopRightCorner      m_pTopRightCorner_Locked
m_pBottomLeftCorner    m_pBottomLeftCorner_Locked
m_pBottomRightCorner   m_pBottomRightCorner_Locked
m_eWindowID
```

Same pattern as the other `gmFloatyXxxUI` panels in Wave 1
(`gmFloatyVitalsUI`, `gmFloatyMainChatUI`, `gmFloatyToolbarUI`,
`gmFloatyIndicatorsUI`, `gmFloatyPanelUI`) — inner content class +
two parallel chrome sets (locked/unlocked) wrapping it.

## Implications for the holtburger-web port

Current Wave 1 implementation (commits `54f47b9` + `bed4ad6` on
master):

- `plugins/inventory.js`: separate inventory window with paperdoll +
  bag tabs + items grid. **Missing**: the items grid doesn't swap to
  examine view on item-click.
- `plugins/examine-target.js`: separate floating popup that polls
  `entityManager.getSelectedTarget()`. **Correct** for in-world
  creature picking, but **wrong** for inventory items.

Proposed restructure (queued as PR-T candidate):

1. Add an **examine-view mode** to the inventory's items grid region
   (the `m_3DItemsUI` analog). On item click, the grid swaps to a
   bigger item icon + appraisal rows + "Back to items" button.
2. Keep the floating `examine-target.js` plugin, but only auto-pop on
   non-inventory selection (creature picking, spell right-click).
3. Bind the **E key** globally:
   - If an inventory item is selected → fire inventory in-place
     examine.
   - Else if a creature is selected → fire floating examine popup.
   - Else → enter examine target mode (cursor swap + click-to-select).

## Source citations

| Symbol | Location |
|---|---|
| `SelectionExamine` keymap | <https://gitlab.com/Cyprias/SkunkTrader/-/raw/master/docs/acclient.keymap.txt> |
| `ClientUISystem::ExamineObject` | acclient.c:402002 |
| `ClientUISystem::ExamineSpell` | acclient.c:402025 |
| `ClientUISystem::ExecuteTargetModeForItem` | acclient.c:402078 |
| `CM_Examine::SendNotice_ExamineObject` | acclient.c:14487 |
| `CM_Examine::SendNotice_ExamineSpell` | acclient.c:14488 |
| `CM_Examine::SendNotice_SetAppraiseInfo` | acclient.c:14489 |
| `gmExaminationUI` ctor | acclient.c:226504 |
| `gmExaminationUI::PostInit` (4 sub-UIs) | acclient.c:228634 |
| `gmExaminationUI::RecvNotice_SetAppraiseInfo` | acclient.c:4407 |
| `gmExaminationUI::SetActiveExamineUI` | acclient.c:4324 |
| `gmInventoryUI::PostInit` (4 children) | acclient.c:222318 |
| `gmFloatyExaminationUI` ctor (chrome) | acclient.c:259684 |
| `CharExamineUI` ctor | acclient.c:228468 |
| `gm3DItemsUI` (the shared surface) | acclient.c:222761 |
