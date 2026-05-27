# Wave 15 — Icon manifest + opt-in bulk preload (2026-05-26)

## Summary

Two related fixes:

1. **Inventory items-grid now fetches real icons** (was rendering only
   TYPE_COLOR fallbacks). Per the pre-Wave 15 audit, the paperdoll +
   vendor + container + trade + buffs paths all correctly called
   `fetch_surface_pixels` already; the items-grid cell builder
   `makeSlot()` in `plugins/inventory.js` was the lone holdout —
   icons were reachable in `portal.dat` and the `iconId` was already
   on the cached `playerInventory()` snapshot via
   `InventoryItem.iconId` (`src/lib.rs:14252-14257`), but the cell
   render path never asked for them. Phase 15.1 wires this up.

2. **Boot-time bulk preload behind URL flag.** New
   `?preloadIcons=1` URL flag (default OFF) that, when set, fetches
   every icon in the new `data/icon-manifest.json` after the scene
   is ready and populates the shared `ui/ac_icon_cache.js` cache.
   Subsequent inventory/vendor/container/trade/buffs/spell-research
   icon displays then resolve synchronously.

## URL flag

| Flag                   | Default | Behaviour                              |
| ---------------------- | ------- | -------------------------------------- |
| `?preloadIcons=1`      | OFF     | Bulk-preload all 4,224 manifest icons. |

Use cases when ON:
- Offline test / replay sessions.
- Demo recording or screenshot capture (no flicker as TYPE_COLOR
  swaps to real icon).
- CI-style runs where determinism matters more than first-paint
  latency.

Use cases when OFF (default):
- Production browsing. First-paint latency wins; icons fetch lazily
  as the user opens panels.

## Cost when `?preloadIcons=1` is set

Estimates measured against the v1 manifest (4,224 unique icon DIDs
from `spells-catalog.json` spell.icon + LSD-Partial weenies
didStats keys 8/50/51/52 — `PropertyDataId.Icon`,
`IconOverlay`, `IconOverlaySecondary`, `IconUnderlay`):

- **Wall time**: +3-8 s after scene-ready (deferred 2s after the
  ready signal so first paint isn't blocked; fetches run in
  batches of 32 via `Promise.all`).
- **RAM**: ~25 MB. Each icon is a PNG data URL backed by an
  HTMLCanvasElement (32×32 RGBA typical, ~4-6 KB per icon as a
  base64 string in `iconCache`).
- **Network**: zero. The wasm `fetch_surface_pixels` resolves
  out of the already-loaded `portal.dat`; no HTTP request per icon.

## Architecture

```
                              ┌────────────────────┐
                              │  ?preloadIcons=1   │
                              │  (scene3d/index.js │
                              │  L3344-3389)       │
                              └─────────┬──────────┘
                                        │ awaited 2s after scene ready
                                        ▼
                              ┌────────────────────┐
                              │ preloadAllIcons()  │
                              │ ui/ac_icon_cache.js│◀──── reads
                              └─────────┬──────────┘    data/icon-manifest.json
                                        │ 32-at-a-time batches
                                        ▼
                              ┌────────────────────┐
                              │ fetch_surface_pixels│
                              │  (wasm)            │
                              └─────────┬──────────┘
                                        │
                                        ▼
                              ┌──────────────────────┐
                              │  iconCache: Map<     │
                              │    iconId, dataUrl>  │  ── SHARED ──┐
                              │  (ui/ac_icon_cache.js│              │
                              └──────────────────────┘              │
                                                                    │
            ┌──────────────────┬──────────────────┬─────────────────┤
            │                  │                  │                 │
inventory.js     vendor-ui.js    container-panel.js    spell-research-panel.js
buffs-hud.js     trade-panel.js
            │                  │                  │                 │
            ▼                  ▼                  ▼                 ▼
  thin fetchIconDataUrl wrappers (preserve historical warn labels);
  spell-research adds an iconCacheGetSync wrapper around
  getIconImmediate for the drag-ghost synchronous-peek path.
```

## Files

- `apps/holtburger-web/ui/ac_icon_cache.js` — new shared cache +
  `preloadAllIcons()`.
- `apps/holtburger-web/scripts/build_icon_manifest.py` — new
  generator. Scans `data/spells-catalog.json` and
  `external/LSD-Partial-2025-02-23_16-15/weenies/*.json`. Output:
  `apps/holtburger-web/data/icon-manifest.json` (4,224 IDs, 41.9 KB).
- `apps/holtburger-web/plugins/inventory.js` — wired items-grid
  `makeSlot()` to fetch real icons; both this plugin's wrappers
  now delegate to the shared cache.
- `apps/holtburger-web/plugins/vendor-ui.js` — delegate.
- `apps/holtburger-web/plugins/container-panel.js` — delegate.
- `apps/holtburger-web/plugins/trade-panel.js` — delegate.
- `apps/holtburger-web/plugins/buffs-hud.js` — delegate.
- `apps/holtburger-web/plugins/spell-research-panel.js` — delegate
  + `iconCacheGetSync` for the drag-ghost path.
- `apps/holtburger-web/scene3d/index.js` — import + URL flag parse +
  deferred call site.

## Regenerating the manifest

```bash
python3 external/holtburger/apps/holtburger-web/scripts/build_icon_manifest.py
```

Output reports per-source counts so a future expansion
(e.g. UI sprite atlas IDs, vendor catalog icons) can be sanity-
checked against the previous run.
