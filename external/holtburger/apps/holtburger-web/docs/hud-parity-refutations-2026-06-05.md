# HUD-parity refuted findings reconciliation — 2026-06-05

Closes P3-43. The cross-find synthesis flagged a handful of findings
for re-verification or outright withdrawal; this doc records the
disposition of each so future audits don't relitigate them.

## Withdrawn (refuted)

- **chat-line-category-glyph** — self-refuted by the cross-find agent;
  retail's A/L/T/C strip are filter buttons, not per-line category
  prefixes. The 4-tab strip in `chat-panel.js` is the correct shape.
- **indicators-behavior-click-01** — layout 0x21000071 surfaces both
  Positive (`buffs`) and Negative (`debuffs`) effect slots; the
  click-routing claim doesn't apply. `status-indicators.js` is
  retail-faithful.
- **radar-sprite-centre-01** — code already matches retail (centre
  marker = `0x060074C9` per `radar.js:111`). No fix needed.
- **radar-states-cardinals-01** — counter-rotation in `radar.js:362`
  is correct against retail's `gmRadarUI::Update`. Withdrawn.
- **EX-04** — children of the examine panel are pane-relative;
  gutters are baked in. Withdrawn.
- **VN-07** — `VendorItemsUI` carries BOTH `m_buyButton` AND
  `m_addButton` per acclient.h:55382-55391 (confirmed by the explore
  agent). Rescoped as a wire-modeling detail, not a UI gap.

## Severity reduced

- **SB-02 / SB-07** — retail spellbook tabs only have Normal +
  Pressed states (no disabled-state). Drop SB-07's disabled-state
  assertion; reduce SB-02 severity.

## Pending re-verification (visual eye-test)

- **VN-02** (`UIElement_ItemList` orientation) — generic h/v container.
  Retail PNG + 710x32 supports horizontal. Re-verify in-game before
  any orientation refactor.
- **gap-027 buffs identity** — confirmed by acclient.c agent that
  `gmEffectsUI` IS retail (verified at acclient.c:4414-4442). The
  ListBox collapse in `buffs-hud.js` (task P3-32) is the right shape.

## Action items (none)

All refutations are recorded in plugin-site comments where they touch
existing code. No code changes required for this task.
