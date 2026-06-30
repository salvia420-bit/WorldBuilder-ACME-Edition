# holtburger-web HUD ⇄ Retail Parity Workflow Brief

**Generated:** 2026-06-04 from laptop pre-flight research (6 Explore agents over acclient decomp, ACE server, chorizite, melt, holtburger-web).
**Target machine:** cloud `buildbox` (GCE us-central1-a, 18 vCPU / 96 GB).
**Required model:** **`claude-opus-4-7`** (set via `/model claude-opus-4-7` or `--model claude-opus-4-7`).
**Effort:** `/effort max`.
**Workflow tool:** use the `Workflow` tool to orchestrate. Concurrency cap = 16. Total agent cap = 1000.
**Working tree:** `~/WorldBuilder-ACME-Edition/external/holtburger/apps/holtburger-web/` (sibling repo at `~/WorldBuilder-ACME-Edition/external/holtburger/` — same git repo, paths relative to repo root).
**Branch:** create `feat/hud-retail-parity-2026-06-04` off `main`. Per-panel commits.

---

## Mission

Bring the **holtburger-web HUD** into **maximum achievable visual + behavioral parity with the retail Asheron's Call client** (1999–2017). Every retail panel that exists in `apps/holtburger-web/plugins/` should look, anchor, font, sprite, and behave like the layout-*.png reference screenshots in `external/holtburger/docs/`. Close every gap in `ui-conformance-audit-2026-05-17.md` plus any new gaps discovered.

**What "parity" means here, in priority order**:

1. **Anchoring** — vitals top-left-center, radar top-right, hotbar right-edge, inventory bottom-right (per memory `[Retail UI anchor screenshot]` and `layout-*.png` refs). No centred HUDs.
2. **Identity** — dark stone/leather + brass-gold trim + serif text. NOT modern dark glass. Match `[Retail AC UI identity]` memory + 80 ref images.
3. **Sprite use** — every panel uses real DAT `0x06xxxxxx` sprites from `data/ui-sprites/` (255 files) where retail had one. No CSS gradients masquerading as sprites.
4. **Font** — `ac_font.js` rendering 0x40000000 (16px) / 0x4000001C (10px) for ALL labels. No system fonts in HUD chrome.
5. **Behavior** — every server→client GameMessage/GameEvent listed in §"Source ground truth → ACE" updates the right panel.
6. **State states** — buttons honor LayoutDesc states (normal/hover/pressed/locked) via `m_states` table. The `G3 states emission` rework in `layout-port-plan-2026-05-24.md` is in-scope.
7. **Floaty chrome** — corner sprites + border sprites for every panel that is draggable/resizable in retail, mirroring `gmFloaty*UI` border element pattern (acclient.h:33715 `UIElement::m_bResizeLine`).

**Non-goals**: don't touch 3D world rendering. Don't refactor wasm. Don't introduce new dependencies. Don't add features that don't exist in retail (the Holtburger-only `dye-preview` is out of scope this round).

---

## Source ground truth (verified by Explore agents, 2026-06-04)

### Decomp (most authoritative for retail behavior)
- `~/ac-headers/acclient.h` — 70,719 lines, 348 enums, 6936 structs
- `~/ac-headers/acclient.c` — 31 MB pseudo-C
- `~/ac-headers/acclient.txt` — Binary Ninja text dump (large; grep, never full-read)
- `~/ac-headers/acclient_2013.bndb_pseudo_c.txt` — Binja decompile
- `~/ac-headers/handoff-acclient-pdb-cvdump-2026-05-28.md` — overview

**Top retail HUD classes to mirror (with header lines):**
- `gmVitalsUI` (acclient.h:55024), `gmFloatyVitalsUI` (55122)
- `gmToolbarUI` (55080), `gmFloatyToolbarUI` (55100)
- `gmRadarUI` (54522) + `RadarInfo` (54506) + `RadarBlipShape` enum (6575)
- `gmPowerbarUI` (54499)
- `gmCombatUI` (55262), `gmCombatPanelUI` (54635)
- `gmMainChatUI` (54923), `gmFloatyMainChatUI` (54934)
- `gmInventoryUI` (55657), `gmBackpackUI` (55605), `gm3DItemsUI` (55598), `gmExternalContainerUI` (55268)
- `gmSpellbookUI` (56108), `gmSpellcastingUI` (55334)
- `gmCharacterInfoUI` (55451), `gmAttributeUI` (55880), `gmSkillUI` (55886), `gmStatManagementUI` (55862)
- `gmExaminationUI` (54765), `gmFloatyExaminationUI` (54849) + `ItemExamineUI`/`CreatureExamineUI`/`CharExamineUI`/`SpellExamineUI` (54780–54825)
- `gmVendorUI` (55366), `gmSecureTradeUI` (55286), `gmSalvageUI` (55277), `gmSlumlordUI` (55303)
- `gmFellowshipUI` (56065), `gmAllegianceUI` (56038)
- `gmJournalUI` (55919), `gmContractsUI` (55973)
- `gmMapUI` (55673), `gmHouseUI` (55666), `gmBookUI` (55432)
- `gmEffectsUI` (55465) + `EffectInfoRegion` (54741)
- `VividTargetIndicator` (54559) — on/off-screen target ring
- `gmIndicatorsUI` (54871), `gmFloatyIndicatorsUI` (54876) + per-icon classes (`gmUIElement_BurdenIndicator` 54056, `gmUIElement_VitaeIndicator` 54086, `gmUIElement_LinkStatusIndicator` 54067, `gmUIElement_PortalStormIndicator` 54080, `gmUIElement_MiniGameIndicator` 54075)
- `gmCharacterSettingsUI` (55745), `gmChatOptionsUI` (55817), `gmConfigUI` (55846), `gmGameplayOptionsUI` (55857), `gmKeyboardUI` (54467), `gmCharacterTitleUI` (55893)
- `gmCharGenMainUI` (56232) + page classes (56210–56444)
- Base classes: `UIMainFramework` (34319), `UIFlow` (34333), `UIElement` (33782), `UIRegion` (33608), `UIListener` (33568)
- Widgets: `UIElement_Text` (53392), `UIElement_Button` (53423), `UIElement_Meter` (53451), `UIElement_Panel` (53482), `UIElement_Field` (53368), `UIElement_Scrollbar` (53431), `UIElement_ListBox` (45131), `UIElement_Scrollable` (45120), `UIElement_Menu` (53466), `UIElement_ColorPicker` (53543), `UIElement_GroupBox` (53551), `UIElement_Viewport` (52574), `UIElement_ItemList` (54192)
- Layout: `LayoutDesc` (33881), `ElementDesc` (33693), `StateDesc` (33640), `MediaDesc` + variants (33707, MD_Data_Cursor=34168)
- Font: `Font` (38825), `TextureBasedFont` (39059), `TextureBasedFontCharacter` (39082), `FontReference` (52093), `FontMapper` (52108)
- Render: `UIObject` (33832), `RenderUI` (49251), `UISurfaceObject` (49142), `UIRectangleObject` (49184), `RenderTexture` (32232), `RenderSurface` (32193)
- Input: `CInputHandler` (27634), `CInputMap` (30002), `CMasterInputMap` (30023)

### Holtburger-web (current state — verified 2026-06-04)

Repo: `~/WorldBuilder-ACME-Edition/external/holtburger/`
Web app: `apps/holtburger-web/`

**40 plugins + loader + api** in `apps/holtburger-web/plugins/`:
- vitals-hud (434 LOC, layout 0x2100006C), combat-hud (1184, 0x21000007), combat-bar (1548, Holtburger-only), hotbar (580, 0x21000016+0x21000070), target-bar (627, 0x21000016), status-indicators (619, 0x21000071), buffs-hud (995, no retail layout — INVESTIGATE if `gmFloatyBuffsUI` exists), compass-hud (716, **no manifest, no retail layout — Phase I candidate**), radar (388, 0x21000074), sneak-hud (222), examine-target (898, 0x2100006B), chat-panel (857, 0x2100006F), inventory (1912, 0x21000023+0x21000024), main-panel (613, 0x2100006E), character-info (1084, 0x2100001A+0x2100002C+0x2100002D+0x2100005E), spellbook (1260, 0x21000032), vendor-ui (1645, 0x21000012), journal-panel (801, 0x21000066), contracts-panel (958, 0x21000069), allegiance-panel (1582, 0x2100002F), fellowship-panel (1646, 0x21000030), house-panel (703), trade-panel (563), container-panel (380), book-panel (579), map-panel (395, 0x21000026), options-panel (862, 0x21000029), dye-preview (526, Holtburger-only — skip), emote-panel (445), radial-menu (330), lifestone-popup (325), debug-overlay (337, dev-only), character-creation (1533), stance-toggle (135), social-panel (983), train-skills (654), tradeskill (363), spell-research-panel (935), world-state (1142, plumbing), inventory_helpers (110, plumbing).

**24 UI primitives** in `apps/holtburger-web/ui/`:
- ac_font.js (556), ac_strings.js (231), keymap.js (634), bar.js (1183), ac_layout.js (332), ac_icon_cache.js (144), ac_paperdoll_viewport.js (348), ac_dye_viewport.js (470), ac_character_options.js (54), ac_palette.js (128), ac_palette_set.js (113), ac_clothing.js (171), ac_attack_type_for_weapon.js (706), ac_combat_maneuver.js (247), ac_damage_rating.js (318), ac_aim_level_for_velocity.js (328), ac_spell_cast_sequence.js (289), ac_spell_shape.js (290), ac_sneak_attack_predict.js (270), ac_play_script.js (254), ac_lod.js (126), ac_physics_script_table.js (271), graphics_settings.js (506).

**Assets**: 255 PNG sprites in `apps/holtburger-web/data/ui-sprites/` (range 0x06000133–0x06004CF1) + INDEX.json + slot-hints/INDEX.json.

**22 retail layout reference screenshots** in `external/holtburger/docs/layout-*.png` (paperdoll, inventory-full, vitals-hud, combat-hud, hotbar, target-bar, status-indicators, main-panel, chat-panel, character-info, spellbook, options-panel, vendor-ui, journal-panel, contracts-panel, map-panel, allegiance-panel, fellowship-panel, examine-target, radar, ac-font-hud, layout-combat-hud, layout-vitals-hud).

**Existing gap docs (read these first):**
- `external/holtburger/docs/ui-conformance-audit-2026-05-17.md` — 10 Phase H gaps
- `external/holtburger/docs/ui-shell-plugin-architecture-spec-2026-05-17.md` — plugin API surface
- `external/holtburger/docs/layout-port-plan-2026-05-24.md` — 20 wired layouts + G3 states reland
- `external/holtburger/docs/handoff-ac-font-2026-05-24.md` — font engine
- `external/holtburger/docs/vitaeum-parity-plan-2026-05-23.md` — master plan
- `apps/holtburger-web/docs/discord-deficiency-2026-05-25/holtburger-web-inventory.md` — discord audit

### Chorizite (community port — pattern reference)

Repo: `~/WorldBuilder-ACME-Edition/external/chorizite/`

**Top 10 files to mirror (already verified):**

1. `Chorizite/Chorizite.Core/Plugins/PluginManifest.cs:13-148` — manifest schema
2. `Chorizite/Chorizite.Core/Plugins/PluginInstance.cs:103-164` — 7-event lifecycle (OnBeforeLoad/OnLoad/OnBeforeReload/OnAfterReload/OnBeforeUnload/OnUnload/OnRequestReload)
3. `Chorizite/Chorizite.Core/Backend/IChoriziteBackend.cs:17-75` — abstract backend
4. `Chorizite/Chorizite.Core/Backend/Client/IClientBackend.cs:19-104` — game commands + event bus
5. `Chorizite/Chorizite.Core/Backend/Client/IClientUIBackend.cs:9-67` — drag/drop, tooltip, root toggle
6. `RmlUiPlugin/Lib/Panel.cs:17-80` — Panel(IsGhost, ShowInBar, WantsAttention, PullToFront)
7. `RmlUiPlugin/Lib/PanelManager.cs:18+` — Create/Destroy + OnPanelAdded/Removed/VisibilityChanged
8. `Chorizite/Chorizite.Core/Render/BitmapTexture.cs:24-530` — `dat://0x06xxxxxx` loader + overlay/underlay composition (PORT THIS to JS for any missing sprite composition)
9. `DatReaderWriter.Extensions/.../RenderSurfaceExtensions.cs:98-285` — 10 pixel formats → RGBA8
10. `Chorizite.ACProtocol/.../S2CMessageHandler.generated.cs` — typed event dispatch
11. `Chorizite/Chorizite.Core/Render/ACFont.cs:18-87` + `FontManager.cs:20-54` — font load from DAT 0x04xxxxxx (foreground+background surface + FontCharDesc[])

**Chorizite uses RmlUi (HTML/CSS) for panel rendering. We use plain web. Our `ac_layout.js` already reads the same LayoutDesc DAT records — same architecture, different render layer.**

### ACE server (message catalog — verified 87 opcodes + 109 event types)

Repo: `~/ace-server/Source/`

**HUD-driving message coverage matrix (from agent report — 95% complete server-side):**

| HUD surface | Outbound | Status |
|---|---|---|
| Vitals (H/S/M) | `GameMessagePrivateUpdateAttribute2ndLevel` (0x02E9) + `PrivateUpdateVital` (0x02E7) | ✓ FULL |
| Target health bar | `GameEventUpdateHealth` (0x01C0) | ✓ FULL (~5s heartbeat on selected target) |
| Examine | `GameEventIdentifyObjectResponse` (0x00C9) | ✓ FULL (RNG-gated by skill) |
| Vendor open | `GameEventApproachVendor` (0x0062) | ✓ FULL (item list + prices + alt currency) |
| Inventory | `GameMessagePickupEvent` (0xF74A) + `InventoryPutObjInContainer` (0x0022) + `PrivateUpdateInstanceID` (0x02D9) | ✓ FULL |
| Container open | `GameEventViewContents` (0x0196) | ✓ FULL |
| Spellbook add/remove | `GameEventMagicUpdateSpell` (0x02C1) / `MagicRemoveSpell` (0x01A8) | ✓ FULL |
| Spell fizzle | (none — motion timeout only) | ⚠ STUB — client must infer |
| Combat hit/miss | `Defender`/`AttackerNotification` (0x01B1/0x01B2) + `Evasion*` (0x01B3/0x01B4) | ✓ FULL |
| Attack done | `GameEventAttackDone` (0x01A7) | ✓ FULL |
| Auto-repeat | (none — server-driven via `CharacterOption.AutoRepeatAttacks`) | ✓ FULL (check option locally) |
| Allegiance | `GameEventAllegianceUpdate` (0x0020) + `AllegianceLoginNotification` (0x027A) + `AllegianceInfoResponse` (0x027C) | ✓ FULL |
| Fellowship | `FellowshipFullUpdate` (0x02BE) + `FellowshipUpdateFellow` (0x02C0) + `FellowshipDisband` (0x02BF) | ✓ FULL (batched on tick via `FellowVitalUpdate` flag) |
| Chat | `GameEventChannelBroadcast` (0x0147) + `Tell` (0x02BD) + `HearSpeech` (0x02BB) | ✓ FULL |
| Emote | `GameMessageEmoteText` (0x01E0) + `SoulEmote` (0x01E2) | ✓ FULL |
| Death | `GameEventVictimNotification` (0x01AC) + `PlayerKilled` (0x019E) | ✓ FULL (multi-phase) |
| Vitae | `GameEventMagicUpdateEnchantment` (0x02C2) (Vitae buff layer) | ✓ FULL |
| Sound | `GameMessageSound` (0xF750) | ✓ FULL |
| Buffs | `MagicUpdateEnchantment` (0x02C2) + `MagicRemoveEnchantment` (0x02C3) + `MagicUpdateMultipleEnchantments` (0x02C4) + `MagicPurgeEnchantments` (0x02C6) | ✓ FULL (stacked by layer 0–3) |
| Hotbar save | inbound only (0x019C `AddShortCut`) | ✓ FULL (client-owned state) |
| Character options | inbound only (0x01A1 `SetCharacterOptions`) | ✓ FULL (read on login from `PlayerDescription`) |

**Five surprises** the workflow must encode:

1. **Auto-repeat is server-driven** — server checks `CharacterOption.AutoRepeatAttacks` on heartbeat (~0.1s); client must NOT assume sequential inbound from itself.
2. **Double-Connect dance** — `CharacterEnterWorldRequest` → `CharacterEnterWorldServerReady` → `CharacterEnterWorld` → full world sync → `LoginComplete` (0x00A1).
3. **Fellowship vitals batched** — `FellowVitalUpdate` flag deferred to next world tick (~100ms).
4. **Enchantments stacked by layer 0–3** — buff UI must show multiple instances of same spell.
5. **Death is multi-phase** — `OnDeath` → `InflictVitaePenalty` → `BeginPortalCrop` (delay) → `ThreadSafeTeleportOnDeath` (teleport). HUD must show "Dying…/Resurrecting…" state.

### melt (DAT parsers — vendor only what's missing)

Repo: `~/WorldBuilder-ACME-Edition/external/melt/`

Top 5 reference files: `Source/ACE.DatLoader/FileTypes/UiLayout.cs` (DAT 0x7E layout), `Surface.cs` (0x08 surface), `Texture.cs` (0x06 texture + DxtUtil dispatch), `Font.cs` (0x40 font), `DxtUtil.cs` (DXT1/3/5). 24 AnimationHook subclasses cataloged (Sound/SoundTable/SoundTweaked, Attack, Replace/Ethereal/Transparent[Part], Luminous[Part], Diffuse[Part], Scale, TextureVelocity[Part], CreateParticle/CreateBlockingParticle/Destroy/Stop, SetLight, SetOmega, NoDraw, DefaultScriptPart, CallPES) — HUD-relevant ones already wired per memory `[AnimationHook dispatch done 2026-05-28]`.

### EXCLUDED: LSD-Partial

**Do NOT use** `~/WorldBuilder-ACME-Edition/external/LSD-Partial-2025-02-23_16-15/`. Despite memory references, the laptop pre-flight confirmed this directory is **server content data only** — 28,196 weenie JSONs, recipes, spawnMaps, spells.json. No UI source code, no client headers. Ignore for this workflow.

---

## Pre-flight on the VM (do this before launching the workflow)

```bash
# 1. Ensure mirror is fresh
# (run on laptop, NOT VM)
NAME=buildbox ZONE=us-central1-a ~/cloudbox/mirror-to-box.sh

# 2. SSH in
gcloud compute ssh buildbox --zone=us-central1-a

# 3. Pin the box so 30-min auto-stop doesn't kill the workflow
touch ~/.keep-awake

# 4. Set model AND effort in the Claude session you launch this from
#    /model claude-opus-4-7
#    /effort max

# 5. Create the branch
cd ~/WorldBuilder-ACME-Edition/external/holtburger
git fetch origin
git checkout -b feat/hud-retail-parity-2026-06-04 origin/main
```

---

## Phase plan — fan out via the Workflow tool

When you (Claude-on-VM) receive this brief, **invoke the `Workflow` tool** with the script below. Set `model: 'opus'` on every agent call (we want Opus 4.7 throughout). Use `pipeline()` as the default — no barriers unless a stage genuinely needs cross-item state.

### Phase 1 — DISCOVER (parallel, ~8 agents)

For each of the 8 dimensions below, spawn one agent:

| Agent | Reads | Returns (structured JSON) |
|---|---|---|
| `gap-conformance` | `external/holtburger/docs/ui-conformance-audit-2026-05-17.md` + `vitaeum-parity-plan-2026-05-23.md` + `layout-port-plan-2026-05-24.md` | `{knownGaps: [{id, panel, severity, ref}]}` |
| `gap-visual-vitals` | layout-vitals-hud-2026-05-24.png + `plugins/vitals-hud.js` + acclient.h:55024 (gmVitalsUI) | `{matches: [], differs: [{aspect, retail, ours, fixHint}]}` |
| `gap-visual-combat` | layout-combat-hud-2026-05-24.png + `plugins/combat-hud.js` + acclient.h:55262 (gmCombatUI) + 54499 (gmPowerbarUI) | same shape |
| `gap-visual-hotbar` | layout-hotbar-2026-05-24.png + layout-target-bar-2026-05-24.png + `plugins/hotbar.js` + `plugins/target-bar.js` + acclient.h:55080 (gmToolbarUI) | same shape |
| `gap-visual-inventory` | layout-inventory-full-2026-05-24.png + layout-paperdoll-2026-05-24.png + `plugins/inventory.js` + `ui/ac_paperdoll_viewport.js` + acclient.h:55657 (gmInventoryUI) | same shape |
| `gap-visual-chat` | layout-chat-panel-2026-05-24.png + `plugins/chat-panel.js` + acclient.h:54923 (gmMainChatUI) | same shape |
| `gap-visual-spellbook-exam-vendor` | layout-spellbook + layout-examine-target + layout-vendor-ui + the 3 plugins + acclient.h gmSpellbookUI/gmExaminationUI/gmVendorUI | same shape (3 sub-panels) |
| `gap-visual-radar-compass-buffs-indicators` | layout-radar-2026-05-24.png + `plugins/radar.js` + `plugins/compass-hud.js` (NO retail layout known) + `plugins/buffs-hud.js` + `plugins/status-indicators.js` + acclient.h gmRadarUI/gmEffectsUI/gmIndicatorsUI | same shape |

**Adversarial verify** (Phase 1.5): for each finding, spawn 2 skeptics in parallel that try to refute via independent lens (`{lens: "is-this-actually-in-retail"}`, `{lens: "is-our-current-impl-already-correct"}`). Findings with ≥1 refutation drop or downgrade.

### Phase 2 — DESIGN (5 agents in parallel)

| Agent | Task |
|---|---|
| `design-anchoring` | Produce a single doc: per-panel anchor table (corner, offset, z-layer) matching `[Retail UI anchor screenshot]` memory + layout-*.png refs. |
| `design-identity` | Audit current CSS/sprite use in every plugin vs dark-stone/leather/brass identity. Output: per-plugin diff list (replace `linear-gradient` → 9-slice sprite, etc.). |
| `design-states` | Spec the G3 states reland: `StateDesc` → CSS state classes for normal/hover/pressed/locked/disabled. Reference `external/holtburger/docs/layout-port-plan-2026-05-24.md`. |
| `design-floaty-chrome` | Spec the gmFloaty* border/corner sprite system: which sprites, which 9-slice slots, which panels need it. Reference acclient.h:33715. |
| `design-font` | Audit all `<ac-text>` use sites; flag any system-font usage in HUD chrome. Output: per-plugin migration list. |

### Phase 3 — IMPLEMENT (parallel per panel, **isolation: 'worktree'** — each panel mutates files independently)

Pipeline over the 22 retail panels — each item flows through `read-design → patch → unit-verify` without barrier:

```
PANELS = [
  'vitals-hud', 'combat-hud', 'hotbar', 'target-bar', 'status-indicators',
  'radar', 'compass-hud', 'buffs-hud', 'chat-panel', 'inventory',
  'main-panel', 'character-info', 'spellbook', 'vendor-ui', 'journal-panel',
  'contracts-panel', 'allegiance-panel', 'fellowship-panel', 'house-panel',
  'trade-panel', 'container-panel', 'map-panel', 'options-panel',
  'examine-target', 'lifestone-popup'
]
```

For each panel: read the design doc + the plugin file + the layout-*.png + the relevant acclient.h class. Patch the plugin in a worktree. Emit a per-panel commit. Schema: `{panel, anchor, identity, font, states, chrome, behavior, commitSha}`.

**Concurrency note**: Workflow caps at 16 agents at once. Pass all 25 panels — the rest queue. Wall-clock = slowest single panel chain.

### Phase 4 — VERIFY (parallel adversarial, 3-lens per panel)

For each patched panel, spawn 3 skeptics — each with a different verification lens — and require ≥2 PASS to keep the change:

- `verify-layout`: does the panel anchor + size match the layout-*.png within ±5% of canvas?
- `verify-identity`: does the panel use real DAT sprites + ac_font + brass-gold trim? No CSS gradients.
- `verify-behavior`: does the panel respond to the ACE message(s) listed in §"ACE coverage matrix"? Trace `client.events.on(...)`.

Panels failing ≥2 lenses revert in a separate commit; capture the failure in the final report.

### Phase 5 — SYNTHESIZE

A single final agent reads all per-panel results and writes:

- `apps/holtburger-web/docs/2026-06-04-hud-parity-workflow/REPORT.md` — what shipped, what reverted, what's left.
- An updated `ui-conformance-audit` with all closed/open items.
- A laptop-runnable verify script (`scripts/verify-hud-parity.cjs`) that screenshots each panel via the wire-agent setup (1070 firefox-driver per memory `[Firefox-driver visual-verify]`).

---

## Workflow script skeleton (paste into the `Workflow` tool's `script` arg)

```javascript
export const meta = {
  name: 'hud-retail-parity-2026-06-04',
  description: 'Bring holtburger-web HUD into visual + behavioral parity with retail AC (acclient.h-driven, layout-*.png-verified).',
  phases: [
    { title: 'Discover', detail: '8 gap-finders + adversarial verify' },
    { title: 'Design',   detail: '5 design docs (anchor/identity/states/chrome/font)' },
    { title: 'Implement', detail: '25 panels, worktree-isolated' },
    { title: 'Verify',   detail: '3-lens adversarial per panel' },
    { title: 'Synthesize', detail: 'final report + verify script' },
  ],
}

const REPO = '/home/wbterminal/WorldBuilder-ACME-Edition/external/holtburger'
const WEB  = `${REPO}/apps/holtburger-web`
const DOCS = `${REPO}/docs`

// ---------- Phase 1: Discover ----------
phase('Discover')
const DIMS = [
  { key: 'gap-conformance', files: [`${DOCS}/ui-conformance-audit-2026-05-17.md`, `${DOCS}/vitaeum-parity-plan-2026-05-23.md`, `${DOCS}/layout-port-plan-2026-05-24.md`] },
  { key: 'gap-visual-vitals', files: [`${DOCS}/layout-vitals-hud-2026-05-24.png`, `${WEB}/plugins/vitals-hud.js`, '~/ac-headers/acclient.h@55024'] },
  { key: 'gap-visual-combat', files: [`${DOCS}/layout-combat-hud-2026-05-24.png`, `${WEB}/plugins/combat-hud.js`, '~/ac-headers/acclient.h@55262,54499'] },
  { key: 'gap-visual-hotbar', files: [`${DOCS}/layout-hotbar-2026-05-24.png`, `${DOCS}/layout-target-bar-2026-05-24.png`, `${WEB}/plugins/hotbar.js`, `${WEB}/plugins/target-bar.js`, '~/ac-headers/acclient.h@55080'] },
  { key: 'gap-visual-inventory', files: [`${DOCS}/layout-inventory-full-2026-05-24.png`, `${DOCS}/layout-paperdoll-2026-05-24.png`, `${WEB}/plugins/inventory.js`, `${WEB}/ui/ac_paperdoll_viewport.js`, '~/ac-headers/acclient.h@55657'] },
  { key: 'gap-visual-chat', files: [`${DOCS}/layout-chat-panel-2026-05-24.png`, `${WEB}/plugins/chat-panel.js`, '~/ac-headers/acclient.h@54923'] },
  { key: 'gap-visual-spellbook-exam-vendor', files: [`${DOCS}/layout-spellbook-2026-05-24.png`, `${DOCS}/layout-examine-target-2026-05-24.png`, `${DOCS}/layout-vendor-ui-2026-05-24.png`, `${WEB}/plugins/spellbook.js`, `${WEB}/plugins/examine-target.js`, `${WEB}/plugins/vendor-ui.js`, '~/ac-headers/acclient.h@56108,54765,55366'] },
  { key: 'gap-visual-radar-compass-buffs-indicators', files: [`${DOCS}/layout-radar-2026-05-24.png`, `${DOCS}/layout-status-indicators-2026-05-24.png`, `${WEB}/plugins/radar.js`, `${WEB}/plugins/compass-hud.js`, `${WEB}/plugins/buffs-hud.js`, `${WEB}/plugins/status-indicators.js`, '~/ac-headers/acclient.h@54522,55465,54871'] },
]

const FINDING_SCHEMA = {
  type: 'object',
  required: ['dimension', 'findings'],
  properties: {
    dimension: { type: 'string' },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['id', 'panel', 'aspect', 'retail', 'ours', 'fixHint', 'severity'],
        properties: {
          id: { type: 'string' },
          panel: { type: 'string' },
          aspect: { type: 'string', enum: ['anchor', 'identity', 'font', 'sprite', 'states', 'chrome', 'behavior', 'message-wiring'] },
          retail: { type: 'string' },
          ours: { type: 'string' },
          fixHint: { type: 'string' },
          severity: { type: 'string', enum: ['blocker', 'high', 'medium', 'low'] },
        },
      },
    },
  },
}

const VERDICT_SCHEMA = {
  type: 'object',
  required: ['findingId', 'refuted', 'reason'],
  properties: { findingId: { type: 'string' }, refuted: { type: 'boolean' }, reason: { type: 'string' } },
}

const discovered = await pipeline(
  DIMS,
  d => agent(
    `Read these sources (file paths + line refs):\n${d.files.map(f => '  - '+f).join('\n')}\n\n` +
    `Identify every retail-vs-current divergence for dimension "${d.key}". For each finding, name the panel, the specific aspect (anchor/identity/font/sprite/states/chrome/behavior/message-wiring), what retail does, what we do, a one-sentence fix hint, and severity. Be concrete — point at file:line in our plugin, and acclient.h:line for retail. Skip Holtburger-only panels (dye-preview).`,
    { label: `find:${d.key}`, phase: 'Discover', schema: FINDING_SCHEMA, model: 'opus' }
  ),
  // adversarial verify: 2 skeptics per finding, refute if uncertain
  found => parallel((found?.findings || []).flatMap(f => [
    () => agent(`Try to REFUTE this finding (lens: is-this-actually-in-retail). Default to refuted=true if you can't confirm the retail claim from acclient.h or the layout PNG. Finding: ${JSON.stringify(f)}`, { label: `refute-retail:${f.id}`, phase: 'Discover', schema: VERDICT_SCHEMA, model: 'opus' }),
    () => agent(`Try to REFUTE this finding (lens: is-our-current-impl-already-correct). Read ${WEB}/plugins/${f.panel}.js carefully. Default to refuted=true if the current impl already does the retail behavior. Finding: ${JSON.stringify(f)}`, { label: `refute-ours:${f.id}`, phase: 'Discover', schema: VERDICT_SCHEMA, model: 'opus' }),
  ]))
)

const surviving = []
let i = 0
for (const d of discovered.filter(Boolean)) {
  const verdicts = discovered[i++ + DIMS.length] || [] // skeptics interleaved
  for (const f of (d.findings || [])) {
    const refutations = (verdicts || []).filter(Boolean).filter(v => v.findingId === f.id && v.refuted).length
    if (refutations < 1) surviving.push(f)
  }
}
log(`Discover: ${surviving.length} surviving findings`)

// ---------- Phase 2: Design ----------
phase('Design')
const DESIGN_TOPICS = [
  ['anchoring', 'Produce a per-panel anchor table: panel, corner (TL/TR/BL/BR/center), pixel offset, z-layer. Match layout-*.png and the memory note [Retail UI anchor screenshot]. Output markdown table.'],
  ['identity', 'Audit every plugin for CSS/sprite identity vs retail dark-stone/leather/brass-gold serif. Per-plugin migration list — replace `linear-gradient` with 9-slice DAT sprite, swap system-font for ac_font, etc.'],
  ['states', 'Spec the G3 states reland: map StateDesc IDs (normal/hover/pressed/locked/disabled) to CSS class names + media swap rules. Reference layout-port-plan-2026-05-24.md.'],
  ['floaty-chrome', 'Spec the gmFloaty* border/corner sprite system: list each border sprite DID, the 9-slice slot it fills, and which panels need it. Reference acclient.h:33715 UIElement::m_bResizeLine.'],
  ['font', 'Audit every <ac-text> use; flag system-font usage in HUD chrome. Per-plugin migration list.'],
]
const designs = await parallel(DESIGN_TOPICS.map(([k, p]) => () =>
  agent(`Topic: ${k}\nSurviving findings (relevant subset):\n${JSON.stringify(surviving.filter(f => f.aspect === k || k === 'anchoring' || k === 'identity'), null, 2).slice(0, 8000)}\n\n${p}`, { label: `design:${k}`, phase: 'Design', model: 'opus' })))

// ---------- Phase 3: Implement (worktree-isolated per panel) ----------
phase('Implement')
const PANELS = [
  'vitals-hud','combat-hud','hotbar','target-bar','status-indicators',
  'radar','compass-hud','buffs-hud','chat-panel','inventory',
  'main-panel','character-info','spellbook','vendor-ui','journal-panel',
  'contracts-panel','allegiance-panel','fellowship-panel','house-panel',
  'trade-panel','container-panel','map-panel','options-panel',
  'examine-target','lifestone-popup',
]
const PATCH_SCHEMA = {
  type: 'object',
  required: ['panel', 'changed', 'commitSha', 'summary'],
  properties: {
    panel: { type: 'string' },
    changed: { type: 'array', items: { type: 'string' } },
    commitSha: { type: 'string' },
    summary: { type: 'string' },
  },
}
const patches = await pipeline(
  PANELS,
  panel => agent(
    `You are patching the "${panel}" plugin in ${WEB}/plugins/${panel}.js.\n\n` +
    `Relevant findings:\n${JSON.stringify(surviving.filter(f => f.panel === panel), null, 2)}\n\n` +
    `Design docs (excerpt):\n${designs.filter(Boolean).join('\n\n').slice(0, 12000)}\n\n` +
    `Layout reference: ${DOCS}/layout-${panel.replace('-hud','').replace('-panel','')}-2026-05-24.png\n` +
    `Retail class refs: see acclient.h class for ${panel} (vitals→55024, combat→55262, hotbar→55080, etc.).\n\n` +
    `Edit ${WEB}/plugins/${panel}.js (and any css/js it pulls in) to close the findings. Use real DAT sprites from ${WEB}/data/ui-sprites/, ac_font for all text, brass-gold trim. Don't introduce new dependencies. Create a single git commit titled "hud-parity(${panel}): <one-line>" — return its sha + a summary.`,
    { label: `patch:${panel}`, phase: 'Implement', schema: PATCH_SCHEMA, model: 'opus', isolation: 'worktree' }
  ),
)

// ---------- Phase 4: Verify (3-lens adversarial per panel) ----------
phase('Verify')
const VERIFY_SCHEMA = {
  type: 'object',
  required: ['panel', 'lens', 'pass', 'reason'],
  properties: { panel: { type: 'string' }, lens: { type: 'string', enum: ['layout','identity','behavior'] }, pass: { type: 'boolean' }, reason: { type: 'string' } },
}
const verified = await parallel(patches.filter(Boolean).flatMap(p => [
  () => agent(`Verify panel "${p.panel}" (lens: LAYOUT). Compare ${WEB}/plugins/${p.panel}.js anchor/size against ${DOCS}/layout-${p.panel}-2026-05-24.png. Within ±5% of canvas? Default fail if uncertain.`, { label: `verify-layout:${p.panel}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'opus' }),
  () => agent(`Verify panel "${p.panel}" (lens: IDENTITY). Does it use real DAT sprites (data/ui-sprites/) + ac_font + brass-gold trim? No CSS gradients. Default fail if any system-font in chrome.`, { label: `verify-identity:${p.panel}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'opus' }),
  () => agent(`Verify panel "${p.panel}" (lens: BEHAVIOR). Trace client.events.on(...) for the relevant ACE messages (see workflow brief §ACE coverage matrix). Wired? Default fail if a relevant message has no listener.`, { label: `verify-behavior:${p.panel}`, phase: 'Verify', schema: VERIFY_SCHEMA, model: 'opus' }),
]))

const panelResults = {}
for (const v of verified.filter(Boolean)) {
  panelResults[v.panel] ||= { pass: 0, fail: 0, lenses: [] }
  panelResults[v.panel][v.pass ? 'pass' : 'fail']++
  panelResults[v.panel].lenses.push(v)
}
const confirmed = patches.filter(Boolean).filter(p => (panelResults[p.panel]?.pass || 0) >= 2)
const reverted  = patches.filter(Boolean).filter(p => (panelResults[p.panel]?.pass || 0) < 2)

// ---------- Phase 5: Synthesize ----------
phase('Synthesize')
const finalReport = await agent(
  `Write the final REPORT.md to ${WEB}/docs/2026-06-04-hud-parity-workflow/REPORT.md covering:\n` +
  `  - Confirmed (${confirmed.length}): ${JSON.stringify(confirmed)}\n` +
  `  - Reverted (${reverted.length}): ${JSON.stringify(reverted)}\n` +
  `  - Surviving findings (${surviving.length}): ${JSON.stringify(surviving)}\n` +
  `Also update ${DOCS}/ui-conformance-audit-2026-05-17.md with closed items.\n` +
  `Also write ${WEB}/scripts/verify-hud-parity.cjs — a Playwright Firefox script that opens each panel via ?autoLogin and captures a PNG to /mnt/wbterminal1/tmp/claude-scratch/hud-parity-2026-06-04/.\n` +
  `Commit each file. Return the list of new commit shas.`,
  { label: 'synthesize', phase: 'Synthesize', model: 'opus' }
)

return { confirmed, reverted, surviving, finalReport }
```

---

## Acceptance criteria

The workflow is successful when:

1. ≥18 of the 25 panels pass ≥2 of 3 verify lenses.
2. All 10 known Phase H gaps from `ui-conformance-audit-2026-05-17.md` are closed OR explicitly downgraded with reason.
3. `REPORT.md` exists with: confirmed list, reverted list, surviving findings, follow-on backlog.
4. `verify-hud-parity.cjs` runs to completion on the laptop against the 1070 firefox-driver setup and captures all 25 panel screenshots.
5. No new dependencies in `package.json`.
6. No regressions in existing wired layouts (the 20 currently wired).

---

## Costs & operational notes

- Expect ~150–250 agent calls total (8 discover + ~16 skeptics + 5 design + 25 patch + 75 verify + 1 synth + retries).
- At Opus 4.7 rates and average ~30k output tokens per agent call, this is roughly $50–$150 in API spend.
- VM hourly cost ($0.67/hr) for ~3–6h wall clock = $2–$4.
- Hit pin (`touch ~/.keep-awake`) before launching; remove and stop the VM when done.

## After the workflow returns

Read `apps/holtburger-web/docs/2026-06-04-hud-parity-workflow/REPORT.md`. Run `scripts/verify-hud-parity.cjs` on the laptop. Open a PR off `feat/hud-retail-parity-2026-06-04` with the report linked.

---

*This brief was assembled on the laptop on 2026-06-04 by 6 parallel Explore agents over the full source set (acclient decomp, ACE server, chorizite, melt, holtburger-web). All file paths and line numbers were verified against the actual tree on the laptop. The cloud buildbox mirror preserves the same paths.*
