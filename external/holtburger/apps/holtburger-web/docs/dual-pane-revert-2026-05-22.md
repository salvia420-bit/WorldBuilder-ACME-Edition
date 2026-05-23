# Dual-pane revert (PR-FF, 2026-05-22)

Rolls back PR-DD (`0edbaa1`, "refactor(ui): dual-pane main-panel
(gmFloatyPanelUI + gmFloatyEnvPanelUI)") and follow-up `ae6cefa`.

## Why PR-DD was wrong

After PR-DD shipped, the user corrected:

> "the drag items to sell uses the second horizontal pane .. attributes
> skills etc is here, was supposed to be associated with the main pane"

PR-DD had mounted `gmFloatyEnvPanelUI` as a general-purpose second
view container. The post-feedback acclient.c dig shows that's wrong:

### `gmFloatyEnvPanelUI` hosts read-only env-info displays, not generic panels

From `~/ac-headers/acclient.c` (re-audited 2026-05-22, sub-agent
`ac0a9065c022f7431`):

- Lines 5016–5027: class declarations.
- `gmFloatyEnvPanelUI` (layout 0x2100006D) inherits from `gmEnvPanelUI`
  at acclient.c:260451; `gmFloatyCombatPanelUI` inherits from
  `gmCombatPanelUI` at acclient.c:260975 — they are sibling classes,
  not the same base. Lines 5020 / 5024 / 5027 declare
  `UpdateLockedStatus` / `ListenToGlobalMessage` / `MoveTo` on
  `gmFloatyCombatPanelUI` but with a `gmFloatyEnvPanelUI *this`
  parameter — a Hex-Rays decompiler artifact, not a real shared base.
- `gmFloatyEnvPanelUI::PostInit` (acclient.c:260412–260565) registers
  only the standard 16 floaty-chrome border/corner elements + the
  read-only **time / weather / location** display fields. **No
  `gmConfigUI` children, no enum-18–23 sub-panels** — the earlier
  claim was wrong. The point still stands: it is *not* a generic
  Skills / Attributes / Titles container; those views belong to
  `gmPanelUI`'s child framework (acclient.c:239469–239553, which
  registers 16+ child panel types).

### "Drag items to sell" lives INSIDE gmVendorUI

From acclient.c lines 4582–4637:

```
gmVendorUI (parent)
├── VendorItemsUI  — vendor's stock items (4595, 4597, 4609–10, 4623–24)
├── VendorBuyUI    — items player queued to BUY (4590, 4598, 4611, 4612)
├── VendorSellUI   — items player dragged to SELL (4591, 4599, 4613–14,
│                    4625, 4626)
└── tab navigation (gmVendorUI::OpenTab, 4588)
```

Notable retail symbols:
- `VendorSellUI::DragItemAcceptable` (4625) +
  `VendorSellUI::OnItemListDragOver` (4626) — actual drag-drop sink,
  living INSIDE the vendor window.
- `gmVendorUI::SendShopEvent` (4582) — Confirm-button atomic flush.
- `gmVendorUI::BuySingleItem` (4637), `ResetShopState` (4636).

So retail's vendor flow is **queue-based** inside one window:
1. Click item → queued into `VendorBuyUI`.
2. Drag inventory → queued into `VendorSellUI`.
3. Confirm → `SendShopEvent` flushes both atomically.

## What this revert restores

- `plugins/main-panel.js` → single pane (281 lines, byte-identical to
  `0edbaa1^`). No `panes = {primary,secondary}` object, no `_pane` ctx
  injection, no `currentPaneOf` helper.
- `plugins/{allegiance,fellowship,journal,contracts}-panel.js` →
  tab-swap handlers back to plain `window.__mainPanel.showView(t.swap)`
  (no pane arg).
- `index.html` — agent-mode whitelist drops `#hb-main-panel-2`; F-key
  handler no longer reads `ev.shiftKey`; the `autoOpenPanesOnReady()`
  IIFE is removed.
- `plugins/vendor-ui.js` — already untouched by PR-DD; preserved as-is
  (will be rewritten in PR-GG).

## What ships next

PR-GG rebuilds `vendor-ui.js` with VendorItemsUI / VendorBuyUI /
VendorSellUI sub-areas + Confirm buttons, all inside the single
main-panel pane.

## Preserved for resurrection

If we ever want an env-info HUD (time / weather / coords readout) as
an always-on top-left strip, the dual-pane implementation is preserved
at:

```
/mnt/wbterminal1/tmp/claude-scratch/ui-port-wave1/pr-ff-revert/main-panel-dual-pane.js.bak
```

It should NOT be a registered-view container — it should be a
purpose-built env-info HUD with its own children, matching retail's
actual sub-panel structure.
