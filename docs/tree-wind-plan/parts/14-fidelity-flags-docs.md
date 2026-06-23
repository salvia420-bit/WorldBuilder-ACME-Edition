I now have everything I need: the exact url-flags.md format (the dated `### …` subsection + `| Flag | What it does | Eye-test | Pass criteria |` table used by the animScenery/skyBirds families), the flag-parse convention (`animated_scenery.js:50-96`), the divert seam (`statics.js:1576-1581`), the loop tick site (`loop.js:1772`), and the TREE_DIDs from established facts. Here is my section.

---

## Assignment (task 14 — fidelity flags + docs + eye-test queue)

Define the shipping surface for tree-wind: the `?treeWind` master flag (**default-OFF**, non-retail enhancement) plus `?treeWindStrength` / `?treeWindDir` / `?treeWindLod` tuning flags. Format-match `docs/url-flags.md` and give the exact diff. Specify how this honors the project rules (flag-gated render feature, retail fidelity preserved when off, BATCHED 1070 eye-test, live-source location, ACE untouched). Output: **precise flag list + url-flags.md diff + eye-test checklist**.

---

## Findings (file:line)

- **Doc has two table formats.** Numbered sections use `| Flag | Values | Default | Effect | Where |` (`docs/url-flags.md:120`, `:133`). The *recent feature work* (2026-06-23 arc) uses a **dated `### YYYY-MM-DD — <feature>` subsection** with a prose intro paragraph + a `| Flag | What it does | Eye-test | Pass criteria |` table — see `animScenery` at `docs/url-flags.md:616-631` and `skyBirds` at `:607-614`. **My entry must match the dated-subsection form** (it is the same animated-scenery family).
- **Boolean-flag convention** is documented at `docs/url-flags.md:75-76`: `on`/`true`/`1`/`yes` → true; `off`/`false`/`0`/`no` → false; ints via `parseInt`, floats via `parseFloat`.
- **Default-OFF parse pattern** to mirror: `animSceneryEnabled()` at `scene3d/animated_scenery.js:69-81` (default-ON: `!== "off"`). I invert it to `=== "on"` (default-OFF). Numeric tuning knobs mirror `_numFlag` / `animSceneryFps()` at `animated_scenery.js:44-67, 83-96`.
- **Central parsing-locations list** the doc maintains: `docs/url-flags.md:67-74`. A new `scene3d/tree_wind.js` parse home must be added here.
- **The leading "default-off on purpose" callout** is `docs/url-flags.md:61` — `treeWind` belongs in it (genuine render toggle, opt-in).
- **Divert seam** (where the flag takes effect, for the "Where" column): `scene3d/statics.js:1576-1581` (`if (animSceneryEnabled()) { … }`, mirrored at `:2086`); import site `statics.js:89`.
- **Per-frame uniform write site** (shader-route flag plumbing): `scene3d/loop.js:1772` (`tickWeatherState`) and the existing `uTime` push at `loop.js:827-828`.
- **TREE_DIDs** (from established ground truth, used in the checklist): top scenery `0x02001063` (fern ~1.25m, 317k placements), `0x020007A2` (6-part shrub, 236k), `0x02000246` (5-part, 232k), tall tree `0x02000258` (~22m: trunk `0x0100379F` / branch `0x010037A1` / canopy `0x010037A2`), `0x0200035F` (11 parts).
- **There is NO standalone eye-test queue file.** Eye-tests live inline as the `Eye-test`/`Pass criteria` columns and are flagged "**Pending 1070 eye-test (BATCHED)**" (e.g. `url-flags.md:643`). "Batched" = all pending rows are run in one 1070 session. The 1070 infra + capture workflow is in `docs/HANDOFF-3d-render-fidelity-2026-05-28.md:49-110` (Chrome on `127.0.0.1:9333`, `young@100.127.215.75`, A/B JPEG pairs like `eyetest-2026-05-28/holtburg-cull{on,off}.jpg`).

---

## Concrete coding steps

### Step 1 — New module `scene3d/tree_wind.js` with the flag readers (JS-ONLY)

Create the canonical parse home (added to the doc's central-locations list). Mirrors `animated_scenery.js:69-96` but **default-OFF**.

```js
// scene3d/tree_wind.js — ?treeWind flag family (NON-RETAIL enhancement, default-OFF).
const DEFAULT_WIND_DIR_DEG = 135;   // SE breeze in the XY plane (AC Z-up); overridden by the
                                    // weather wind-state module (task 12) when present.
const TRUTHY = new Set(["on", "true", "1", "yes"]);   // url-flags.md:75-76 convention

function _params() {
  try { if (typeof window !== "undefined" && window.location)
          return new URLSearchParams(window.location.search); } catch (_) {}
  return null;
}

let _treeWindFlag;
export function treeWindEnabled() {                       // master gate, DEFAULT-OFF
  if (_treeWindFlag !== undefined) return _treeWindFlag;
  const p = _params();
  _treeWindFlag = !!p && TRUTHY.has((p.get("treeWind") || "").toLowerCase());
  return _treeWindFlag;
}

let _strength;
export function treeWindStrength() {                      // global amplitude multiplier
  if (_strength !== undefined) return _strength;
  const p = _params(); const n = p ? parseFloat(p.get("treeWindStrength")) : NaN;
  _strength = Number.isFinite(n) && n >= 0 ? n : 1.0;     // default 1.0, clamp >=0
  return _strength;
}

let _dirRad;
export function treeWindDirRad() {                        // wind heading, radians in XY plane
  if (_dirRad !== undefined) return _dirRad;
  const p = _params(); const d = p ? parseFloat(p.get("treeWindDir")) : NaN;
  const deg = Number.isFinite(d) ? d : DEFAULT_WIND_DIR_DEG;
  _dirRad = (deg * Math.PI) / 180;
  return _dirRad;
}

let _lod;
export function treeWindLod() {                           // LOD-tier ceiling, see task 13
  if (_lod !== undefined) return _lod;
  const p = _params(); const v = (p && p.get("treeWindLod") || "auto").toLowerCase();
  _lod = ["auto", "near", "mid", "far", "off"].includes(v) ? v : "auto";
  return _lod;
}
```

- `?treeWind=off`/absent ⇒ `treeWindEnabled()` false ⇒ every downstream peel/attach is skipped ⇒ **frozen BatchedMesh path unchanged** (retail fidelity preserved). This is the rollback hatch.
- `?treeWindDir` is a *forced* override; when the weather wind-state module (task 12) lands it supplies the live direction and this flag only overrides for tuning. **Caveat for task 12 author:** `treeWindDirRad()` memoizes — if wind direction must vary at runtime, the weather module owns the live value and the flag is read once as the override; do not route the live value through this memoized getter.

### Step 2 — Gate the divert + attach behind the flag (JS-ONLY)

At the `statics.js` seam (`scene3d/statics.js:1576-1581`, mirrored `:2086`), the parallel `windTrees` peel (task 02) wraps in `if (treeWindEnabled())`. Import at `statics.js:89`:

```js
import { treeWindEnabled, treeWindStrength, treeWindDirRad, treeWindLod } from "./tree_wind.js";
```

Net: with the flag off, no `windTrees` filter runs, the `TREE_DID` placements stay in the frozen instanced batch — **byte-identical to today**.

### Step 3 — Shader-route uniform plumbing reads the flags (JS-ONLY)

In `loop.js` (the `uTime` push site `:827`, inside the `tickWeatherState` block `:1772`), the wind material's shared uniforms (task 05) read `treeWindStrength()` / `treeWindDirRad()` (and the live wind vector from task 12) only when `treeWindEnabled()`. When off, `getTreeWind()` is never created, so the standard lit material (`materials.js`) is used — shadows/fog/lighting identical to retail-frozen.

### Step 4 — `docs/url-flags.md` diff (DOC-ONLY)

**4a. Add to the "default-off on purpose" callout** — `docs/url-flags.md:61`, append to the "genuine render toggles" clause:

```diff
- weather `rain`/`snow`/`lightning`/`skyWeather`, and the texture/palette overrides.
+ weather `rain`/`snow`/`lightning`/`skyWeather`, the **non-retail** `treeWind` tree-sway family
+ (`treeWind`/`treeWindStrength`/`treeWindDir`/`treeWindLod`), and the texture/palette overrides.
```

**4b. Add to the central parsing-locations list** — after `docs/url-flags.md:73`:

```diff
 - **`scene3d/weather/manager.js`** ~30–61 — `parseUrlOverrides()` for weather flags.
+- **`scene3d/tree_wind.js`** — `?treeWind` family readers (`treeWindEnabled`,
+  `treeWindStrength`, `treeWindDirRad`, `treeWindLod`); consumed by `scene3d/statics.js`
+  (divert seam ~1576/2086) + the wind material in `scene3d/materials.js` + `scene3d/loop.js`.
```

**4c. New dated subsection** — insert in section 2 **after line 637** (the interior static `default_script` block) and **before line 639** (`### 2026-06-12 — get_link`):

```markdown
### 2026-06-23 — tree wind sway (trees sway in the wind) — NON-RETAIL enhancement, DEFAULT-OFF

**Beyond-retail.** Retail AC trees do NOT sway — every scenery tree is a frozen multi-part
SetupModel (`default_animation == 0`) baked into the merged/instanced BatchedMesh
(`statics.js`). This family adds procedural wind motion as an *enhancement*, so it ships
**flag-gated, default-OFF**, and `?treeWind=off` (the default) is **byte-identical to the
retail-faithful frozen render**. Staged delivery (see the tree-wind plan): 1a per-part
foliage rustle + canopy hinge via the existing `animated_scenery.js` player fed a SYNTHETIC
clip; 2 offline skeleton+harmonic-sim baked to a VAT (forest scale) / AC-native Animation
0x03 (hero); 3 wind-state + storm-coupled gusts + LOD. Honors the live-source rule (edits at
`apps/holtburger-web`, never a stale copy) and touches **NOTHING server-side — ACE stays
vanilla** (wind is a pure client visual; no protocol/STB/wire change). Flags parsed in
`scene3d/tree_wind.js`; divert at `scene3d/statics.js:1576`/`:2086`.

| Flag | What it does | Eye-test | Pass criteria |
|------|--------------|----------|---------------|
| **`?treeWind=on`** (default **OFF** — non-retail) | Master gate. ON peels `TREE_DID` placements out of the frozen instanced batch (`statics.js` `windTrees` filter, mirrors the `animScenery` peel) and animates them (per-part synthetic clip / VAT / shader per LOD tier). The pivot is each part's **vertex Zmin (its base)**, never the model origin (co-located-origin parts would shear). OFF = no peel, frozen render byte-identical. Rollback = drop the flag. | 1070 (BATCHED): bare-default vs `?treeWind=on` A/B at identical camera over forest/town. | OFF = byte-identical frozen; ON = canopy sways, trunk base planted, no joint cracking, no FPS regression. |
| `?treeWindStrength=<f>` (default 1.0, ≥0) | Global sway-amplitude multiplier (0 = still, 1 = nominal, >1 = storm-like). Tuning knob; live gust strength comes from the weather wind-state module. | Sweep 0 → 0.5 → 1 → 2. | 0 = visually frozen; amplitude scales smoothly; no clipping/inversion at high values. |
| `?treeWindDir=<deg>` (default 135) | Wind heading in degrees, XY plane (AC Z-up); 0 = +X. Forced override of the weather-derived direction. | Set 0 / 90 / 180. | Canopies lean consistently downwind in the set direction; all trees agree. |
| `?treeWindLod=auto\|near\|mid\|far\|off` (default `auto`) | Caps the wind LOD tier: `near` per-part/VAT high quality, `mid` VAT/shader on the batch, `far` procedural-shader/frozen, `off` frozen, `auto` = distance-driven crossover (task 13). | `=near` vs `=far` at range. | `auto` picks the cheap tier far out with no visible pop; forced tiers behave; no FPS cliff in dense forest. |

**Phase status:** Phase 1a (synthetic-clip foliage rustle, JS-only via the existing player) is
the first-visible-motion target; subsequent tiers (skeleton sim / VAT / wind-state) land behind
the SAME `?treeWind` gate. **Pending 1070 eye-test (BATCHED).** No wasm rebuild for 1a/1b
(runs off the existing `fetchBuildingPlacement` per-part meshes); VAT/skeleton bakes are OFFLINE
(buildbox), never on the 8GB laptop.
```

---

## Eye-test queue checklist (BATCHED — append to the next 1070 session)

Project rule: 1070 GPU eye-tests are **batched, not piecemeal** — this checklist is queued alongside the other "Pending 1070 eye-test (BATCHED)" rows (`animScenery`, `skyBirds`, `ambientBaked`, `getLink`, …) and run in one session. Infra + capture workflow: `docs/HANDOFF-3d-render-fidelity-2026-05-28.md:49-110` (off-screen Chrome on `127.0.0.1:9333` at `young@100.127.215.75`; A/B JPEG pairs like `eyetest-2026-05-28/holtburg-cull{on,off}.jpg`). Method for every row: same camera/time-of-day, capture **bare-default (OFF)** then **`&treeWind=on`**, diff the pair.

```
TREE WIND — 1070 eye-test queue  (flag: ?treeWind=on; default OFF)
Base URL: …/apps/holtburger-web/?nosw=1&autoLogin=1&account=tailnet1&password=tailnet1&autoSpawn=first

[ ] T-0  REGRESSION GUARD (off = frozen): bare-default load, NO treeWind flag.
         PASS = trees are FROZEN exactly as today; A/B pixel-diff vs the pre-change
         frozen capture is ~zero. (This is the retail-fidelity gate — must pass first.)

[ ] T-1  Short foliage rustle — fern 0x02001063 / shrub 0x020007A2.
         View: a grassy LB dense with low scenery (e.g. Holtburg outskirts).
         PASS = leaf/frond clusters rustle with small high-freq motion; clusters stay
         PLANTED at ground (no sliding/floating); ?treeWind=off = dead still.

[ ] T-2  Canopy hinge + planted base — tall tree 0x02000258 (~22m: trunk 0x0100379F /
         branch 0x010037A1 / canopy 0x010037A2), near-field hero distance (<140m).
         PASS = canopy/upper parts SWAY (hinge about each part's Zmin base); trunk base
         is PLANTED (no swing-through-arc about model origin — the co-located-origin
         shear gotcha); part joints do NOT crack/separate.

[ ] T-3  No-lockstep across a forest — wide view of a dense tree LB (many placements of
         one DID, e.g. the 317k-placement 0x02001063 region).
         PASS = trees sway with INDEPENDENT phase (per-instance offset), NOT in unison;
         no obvious tiling/sync artifact; downwind lean agrees with ?treeWindDir.

[ ] T-4  Perf — same dense forest view, watch the FPS HUD / diag (?diag).
         Baseline: 1070 outdoor is CPU-bound ~20fps. PASS = treeWind=on holds within
         ~1–2 fps of the OFF baseline (uniform-only shader updates; no per-instance CPU
         on the bulk); no GC stutter; the 512-cap per-part player is near-field only.

[ ] T-5  Direction + strength knobs — ?treeWind=on&treeWindDir=0 vs 180, then
         &treeWindStrength=0 / 0.5 / 2.
         PASS = leaning direction tracks treeWindDir; strength=0 reads as frozen;
         amplitude scales smoothly with no clipping/inversion.

[ ] T-6  LOD crossover — ?treeWind=on&treeWindLod=auto vs =near vs =far, fly toward a
         tree line.
         PASS = auto swaps tiers with NO visible pop/snap at the crossover; far tier is
         cheap (no FPS cliff); forced =near/=far behave; =off renders frozen.

[ ] T-7  Town interaction — Holtburg (trees among buildings/animated flags).
         PASS = trees sway, flags/banners (animScenery) still wave, no double-render
         (frozen+wind), no z-fighting/cracking at tree↔building seams; shadows/fog intact.

[ ] T-8  Lighting/shadow survival (shader route) — dawn/dusk over swaying trees.
         PASS = swaying trees still receive sun/shadow/fog correctly (displacement
         injected before begin_vertex), no flat/unlit canopies, no shadow detachment.
```

**Overall PASS bar:** OFF = byte-identical frozen (T-0); ON = base planted + canopy sways + no cracking + no perf regression + no-lockstep (T-1…T-4); knobs + LOD behave (T-5, T-6); coexists cleanly (T-7, T-8). Any FAIL ⇒ flag stays default-OFF; ship as opt-in only.

---

## Risks & open questions

- **Default-OFF discipline.** Unlike the 2026-06-23 animated-scenery family (which the user flipped default-ON), tree-wind is an **enhancement beyond retail** — it must ship **default-OFF** and stay there until the BATCHED 1070 eye-test passes. The leading callout (`url-flags.md:6-9`) lists default-ON flips; `treeWind` must NOT be added there — it goes in the "default-off on purpose" list (`:61`). Flag-flip to default-ON requires explicit user sign-off after the eye-test, exactly like `velScale`/`skyObjLum`.
- **`treeWindDir` memoization vs live wind.** My `treeWindDirRad()` caches on first read. If task 12's wind-state must rotate the wind at runtime, the live direction must NOT flow through this getter — the flag is the *override*, the weather module is the *source*. Need to confirm the contract with task 12 so the two don't fight. (Resolution: weather module owns the live uniform; flag value, when present, pins it.)
- **`treeWindLod` enum vs task 13.** I defined `auto|near|mid|far|off`; task 13 owns the actual crossover thresholds and tier set. If task 13 lands a different tier vocabulary, this enum must track it. Open: should `treeWindLod` also accept a numeric crossover radius (like `?animSceneryRadius`)? Left as a follow-on knob to avoid over-specifying before task 13.
- **Boolean convention strictness.** Established facts and the assignment say "`?treeWind=on`"; I accept the full truthy set (`on|true|1|yes`) to honor `url-flags.md:75-76`. If reviewers prefer strict `=on`-only (as the prose implies), tighten `TRUTHY` to `=== "on"`. Low-risk either way.
- **Eye-test infra fragility.** The 1070 driver loop is "infrastructure-painful" (ghost-session races, OOM on the headless box — `docs/animation-handoff-codereview-2026-06-03.md:3`). The local chrome-devtools MCP smoke renders dark under swiftshader, so it can confirm *load/spawn/0-errors/a wind node attaches* but **cannot validate the visual sway** — that is strictly the 1070's job. The checklist's T-0 regression guard (off=frozen) is the only row partly verifiable headlessly (pixel-diff of frozen geometry).
- **No ACE touch — verify in review.** Wind is pure client visual; the doc entry asserts "ACE stays vanilla." Reviewer should confirm no new wire field / STB / protocol dependency sneaks in via the wind-state module (task 12 couples to the *existing* `is_storm`/daygroup state, not a new server message).
