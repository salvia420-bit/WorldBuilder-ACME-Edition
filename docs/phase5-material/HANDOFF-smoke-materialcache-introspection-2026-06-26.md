# HANDOFF — boot-smoke can't introspect MaterialCache (`window.liveScene3d.materialCache` is null)

**Date:** 2026-06-26 · **Branch:** merged to `master` (`44e28557`) · **Severity:** LOW — *diagnostics only, NOT a render bug.*

## 1. Issue
The Phase-5 in-world boot-smoke reaches in-world cleanly (0 console errors) but **cannot confirm the baked
roughness/AO maps actually attached or that texchan sidecars were fetched**, because its diagnostic probe
`window.liveScene3d.materialCache` returns **null/undefined**. Observed diag:
```
bootState: in-world  reloads: 0  consoleErrors: 0
diag: {"suiteStats":"no _texchanSource","mats":"no materialCache","manifestSize":null}
```
So we have *structural* confidence (boots, 0 errors, attach path exception-free) but no *observed* proof of
`roughnessMap`/`aoMap` on real materials or `SuiteAssetSource` fetch hits. THIS HANDOFF = make the smoke able to
read the live cache so that proof can be captured (the last gap before only the 1070 look-tuning remains owed).

**Not in scope / already covered:** map-attach *correctness* is proven offline — S6a byte-faithfulness 800/800,
S6b-1 decode 60/0 — and the *look* is the 1070's job (`?material=off` is a byte-identical escape). This is
ONLY about runtime observability.

## 2. Root cause (found)
`window.liveScene3d.materialCache` is a **stale one-time snapshot**, not a live reference:

- `scene3d/index.js:2490` builds the `liveScene3d` object literal during `init3D`.
- `scene3d/index.js:2541`: `materialCache: scene3dForBuilders.materialCache ?? null,` — a plain property,
  evaluated **once** at that moment.
- `window.liveScene3d = liveScene3d` at `scene3d/index.js:2925`.
- BUT the `MaterialCache` is created **lazily** on the first landblock surface load —
  `getOrCreateMaterialCache()` stamps `scene3d.materialCache` at `statics.js:485/513` (and `buildings.js:534`),
  which runs **after** `init3D` built `liveScene3d`. So at snapshot time `scene3dForBuilders.materialCache` is
  still null → `liveScene3d.materialCache` is captured as `null` and never updates.
- The **live** cache lives on `scene3dForBuilders.materialCache` — but `scene3dForBuilders` is **not exposed on
  `window`** (confirmed: no `window.* = scene3dForBuilders`). Hence no reachable handle from the smoke.

(The same stale-snapshot pattern likely affects the sibling props at index.js:2544–2545 `detailTileCache`,
`forceDetail`, and the `buildings`/`statics` summaries — out of scope, but note it.)

## 3. Reproduce
Stack up (serve.py :8765, wsbridge :8080, ACE 9000/9001), then:
```
node /…/scratchpad/smoke_inworld.mjs   # playwright-core in ~/.npm/_npx/<hash>/node_modules
# (URL: …/index.html?nosw=1&autoLogin=1&account=phase4demo&password=phase4demo&autoSpawn=first&nullRender=1&netDrainHz=30&material=on)
```
The script polls `window.__bootState` to `in-world`, then evals `window.liveScene3d?.materialCache` → null.

## 4. Fix options (pick one)
- **(A) RECOMMENDED — make it a live getter** (`scene3d/index.js:2541`). Tiny prod change, fixes the stale
  semantic for *any* consumer, not just the smoke:
  ```js
  get materialCache() { return scene3dForBuilders.materialCache ?? null; },
  ```
  (Consider the same for `detailTileCache`/`buildings`/`statics` if other tools snapshot them.) Gate: bare boot
  still 0 errors; smoke now reads a non-null cache.
- **(B) Diag-only window handle** — `window.__scene3dForBuilders = scene3dForBuilders;` near the other
  `window.__*` handles (index.js has ~20 already). Smoke reads `window.__scene3dForBuilders.materialCache`.
  Zero risk to the render path; no change to `liveScene3d`'s shape.
- **(C) Smoke-side scene-graph traversal** — if a scene/group root is exposed, traverse for
  `mesh.material.roughnessMap`. Currently no obvious `window` handle for the THREE scene root → least preferred.

## 5. Post-fix: what the smoke should assert (the proof we want)
Once the cache is reachable (`MC`):
```js
const mc = window.liveScene3d.materialCache;            // (A)  or window.__scene3dForBuilders.materialCache (B)
let tot=0, r=0, a=0;
for (const m of mc.materials.values()) { tot++; if (m.roughnessMap) r++; if (m.aoMap) a++; }
const stats = mc._texchanSource?.stats?.();             // { fetchCount, hits, absent, errors }
// PASS if: tot>0, (r>0 || a>0), stats.hits>0, stats.errors===0
```
- `m.roughnessMap` set ⇒ S6b-2 attach fired. `m.aoMap` set ⇒ F1 fired. `_texchanSource.stats().hits>0` ⇒
  texchan sidecars actually fetched in-world. (`_texchanSource` is built lazily in `materials.js`
  `_ensureTexchanInit`; null until the first gated `_attachRoughnessMap`.)

## 6. Secondary checks / traps
- **Surfaces must actually load** for the cache to populate. The smoke uses `?nullRender=1` — per the url-flags
  contract `nullRender` skips `render()` but sim/drain still run, so scenery bake/ingest *should* happen. If the
  cache is still empty after the global fix, **drop `nullRender`** (or lengthen the settle) and confirm statics/
  buildings stream in. Holtburg outdoor (`autoSpawn=first`) is dense enough to have textured surfaces.
- **Do NOT re-chase `window.__hbWasm.fetch_suite_artifact_by_key === undefined`** — that's a FALSE alarm. The
  consumer uses `scene3d.wasmExports` (the init3D opts object, which has `by_key`), NOT the curated
  `window.__hbWasm` debug literal. by_key is correctly wired (index.html, both sites; verified count=2).
- **ACE flake** — first connect sometimes lands `bootState:error`; the smoke already reload-retries (≤3). It
  reached in-world in ~18s on the last two runs, so this is usually fine.

## 7. State / pointers
- Smoke scripts (this session, scratchpad — recreate as needed): `smoke_load.mjs` (page-load: 0 module-load
  errors, reliable), `smoke_inworld.mjs` (in-world; the one with the null-cache diag).
- Consumer code: `materials.js` `_attachRoughnessMap`/`_resolveRough`/`_applyRough`/`_ensureTexchanInit`;
  transport `suite_assets.js` (`getByKey`/`getByKeyAsync`, `decodeTexchanBytes`, `loadTexchanManifest`).
- Artifacts: `${HOLTBURGER_DIST:-/mnt/wbterminal2/holtburger-dist}/suite/*.texchan.bin` (5475) +
  `texchan-manifest.json`.
- Ledger: `docs/phase5-material/PLAN.md` (F2 entry records this gap).
- Effort: ~30 min (option A or B + re-run the smoke + capture the asserts in §5).
