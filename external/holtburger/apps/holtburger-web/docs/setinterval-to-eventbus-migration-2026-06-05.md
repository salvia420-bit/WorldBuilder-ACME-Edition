# setInterval → event-bus migration plan (P3-41)

The cross-find report flagged Pattern E (combat-hud-behavior-power-
slider + family): plugins use `setInterval(500)` polling instead of
subscribing to events on `pluginClient`. This doc enumerates the
remaining sites and the migration pattern; each site is a small
follow-on per plugin.

## Pattern

**Before** (poll):
```js
const timer = setInterval(() => {
  const v = window.__combatBarState?.powerLevel ?? 1.0;
  if (v !== last) { last = v; render(); }
}, 500);
```

**After** (event):
```js
await pluginClient.ready;
pluginClient.events.on("powerLevelChanged", ({ powerLevel }) => render());
```

Requires the event to be emitted somewhere (typically picking.js for
target/selection events, the recv-loop for server-driven events). The
combat-bar already emits `playerStatsUpdated`; some events need to be
added to plugins/api.js's event surface.

## Sites needing migration (10 plugins)

| File:Line | Purpose | Suggested event |
|---|---|---|
| `vitals-hud.js:445` | poll until client ready | (use `await pluginClient.ready`) |
| `book-panel.js:546` | subscription bootstrap | (use `await pluginClient.ready`) |
| `target-bar.js:594` | selected-target poll | `playerSelectedTargetChanged` |
| `target-bar.js:614` | stance poll | `playerStatsUpdated` (already wired by combat-bar — combine) |
| `status-indicators.js:300` | link-status metric poll | `linkStatusChanged` (new — emit from network-quality module) |
| `status-indicators.js:582` | client bootstrap | (use `await pluginClient.ready`) |
| `combat-hud.js:1057` | combat-bar state poll | `powerLevelChanged` (new — emit from combat-bar) |
| `combat-hud.js:1131` | DR plugin poll | `damageRatingChanged` (new) |
| `vendor-ui.js:1582` | client bootstrap | (use `await pluginClient.ready`) |
| `sneak-hud.js:195` | sneak state poll | `sneakStateChanged` (new) |

## Categories

**Bootstrap polls (5)** — `await pluginClient.ready` replaces the
"poll until client appears" pattern. Smallest cost. Targets:
vitals-hud, book-panel, status-indicators:582, vendor-ui,
combat-bar:581 (already wired, listed for reference).

**State observation polls (5)** — need a new event on the bus + the
emit site. Targets: target-bar (2), status-indicators:300,
combat-hud (2), sneak-hud.

## Action items

This task closes as DOCUMENTATION + PLAN. Per-plugin migrations are
mechanical and can be done one file at a time. The cross-find Pattern
E is the leverage point; this doc is the work-list.

## Why deferred

- Each migration changes a hot path. Without a regression test for
  each polled signal, the change must be visually verified.
- Some events don't exist yet on the bus and need to be added at the
  emit site (e.g., combat-bar would need to emit `powerLevelChanged`).
- The polls are slow (500ms) but correct. The event-driven version is
  more idiomatic but functionally equivalent.

Pickup as opportunistic refactor when touching each plugin for other
reasons.
