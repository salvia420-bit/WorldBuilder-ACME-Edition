# task-GFXOBJ-RELIEF — "the gfxobj textures aren't showing up": which of the three cases is it

**Session:** 2026-08-11, local agent on the OWNER'S LAPTOP (Mesa/Intel HD520 iGPU,
8 GB, ~1-2.8 GB free throughout). Branch `orch/s12-gfxobj` from `c53a4448`.
No buildbox, no other agent's branch, no touch on the owner's ACE server or his
`serve.py` on :8765 (my probe server ran on :8791 and is stopped).

**The question, in the owner's words:** *"i noticed in the screenshot we dont have
our gfxobj textures working … quite recently an agent was working on it with these
new textures. im not sure how far it got or if there was a bug, but im not noticing
them."*

**Answer: case 2 — NOT ARMED, and the thing it would arm is smaller than he expects.**
Nothing is broken. The bake shipped, the wasm exports are present, the owner's live
dist really does carry the relief variants, and the consumer works end-to-end when
asked — but it is behind `?reliefBundles=on` (DEFAULT-OFF per I7), and on the
migration arm he most likely boots (`?packSource=on&geomBundles=on`) the client
**actively forces relief OFF** and says so in the console. Details, evidence and the
recommended flip gate below. §5 is the part he actually needs to see: even fully
armed, the shipped relief is a **6 cm x 5 cm bevel on convex edges and material
boundaries** — not stones and timber protruding across a wall face.

---

## 1. What a bare boot arms — MEASURED live, three arms, on his dist

Probe: `scripts/serve.py --port 8791` over MY worktree (so the §4 diag fix is in
play) against the owner's real dist symlink
(`/mnt/wbterminal2/holtburger-dist-hires-bc7m-xu7t2`, the same target his own
checkout serves) and his real `pkg/` (symlinked read-only from
`~/WorldBuilder-ACME-Edition/.../pkg`, 6,469,407 B — it HAS
`assemble_model_geometry_relief` + `geom_relief_rows_resident`). Playwright
chromium, 900x700, `?renderScale=1&nosw=1`. Raw JSON + full console per arm:
`/tmp/s12/live/{bare,gb,gbrelief}.json`.

| arm | URL added | `__gfxRelief.enabled` | `__diag.geometry.relief` | verdict |
|---|---|---|---|---|
| bare | *(none)* | **true** (`source: preset`, `preset=mid`, `subdivLevel 0`, `applied.main.ok true`) | *(absent — see below)* | **RUNTIME relief is ON.** He is already seeing rails. |
| gb | `packSource=on&geomBundles=on` | **false** | `{armed:false, variantRowsResident:0, modelsAssembled:0}` | **FLAT.** Client logs `[geomBundles] forcing gfxRelief OFF`. |
| gbrelief | `+ reliefBundles=on` | **true** | `{armed:true, variantRowsResident:104, modelsAssembled:0}` | **BAKED relief ON**, 104 GEOMR rows resident at boot. |

Verbatim from arm `gb`:

```
[geomBundles] forcing gfxRelief OFF (bundles carry relief-free geometry; author
  ?reliefBundles=on for baked relief, or ?gfxRelief=on to keep runtime relief —
  that disarms bundles)
[gfxRelief:main] enabled=false subdivLevel=0 scale=1 (preset=mid)
[gfxRelief:bake-worker] enabled=false subdivLevel=0 scale=1 (preset=mid)
```

and from arm `gbrelief`:

```
[gfxRelief:main] enabled=true subdivLevel=0 scale=1 (preset=mid)
[geomBundles] armed — statics/buildings/anim-scenery/cells consume HBG1 bundles
  (relief variants ON)
```

The static readers behind that table, all opened this session:

* `scene3d/geom_bundles.js:54` `geomBundlesEnabled` — EXACT-MATCH, absent ⇒ OFF.
* `scene3d/geom_bundles.js:68` `reliefBundlesEnabled` — EXACT-MATCH, absent ⇒ OFF.
* `scene3d/quality.js:115` `low.gfxRelief = false`; `:263` / `:366` / `:457`
  `mid`/`high`/`ultra` `gfxRelief = true`, `gfxSubdivLevel = 0` on every tier.
* `index.html:2389` the force-off leg — fires only when `geomBundles` is ON and
  `reliefBundles` is not authored and `?gfxRelief=on` was not typed explicitly.
* `scene3d/geom_bundles.js:165-206` the four relief arming legs (flag, wasm export,
  `subdivLevel === 0`, relief resolving ON).

**So which case is the owner in?** If he boots bare (or with `?packSource=on` alone)
on a mid/high/ultra tier, relief is **already on** and the answer is case 1 —
working, imperceptible (§5 quantifies why). If he boots the migration arm
`?packSource=on&geomBundles=on` — which is what the hi-res BC7 dist wants, since
`?texCompressedOnly` structurally requires `?packSource` — the answer is case 2, the
client is force-disabling relief and telling him so in the console. **I could not
recover his actual URL from any artifact on this laptop** (no bookmark, no shell
history hit); the console line above is the one-second way for him to settle it —
if he sees `forcing gfxRelief OFF`, that is his answer.

**Also found, unrelated to relief but worth one line:** `serve.py --check` warns
`pkg wasm predates the last Rust-touching commit` on his checkout. The relief
exports are present, so this task is unaffected, but any *other* measurement he
takes on that pkg is against a stale wasm.

---

## 2. His dist REALLY IS relief-baked — 2,179 rows, read out of the packs

`dist/pack-report.json` claims it, and I re-derived it from the pack bytes rather
than trusting the report (`scripts/relief/dist-relief-census.py` over all
**51,953** `.hbp` files — 285 carry a GEOMR section):

| | pack-report.json | re-read from the packs |
|---|---|---|
| GEOMR rows | 2,179 | **2,179** |
| distinct models changed | 1,417 | **1,417** |
| models identical (no row) | 6,081 | — |
| added triangles | 252,740 | **252,740** |
| variant key | `rails-l0-s1.000-w0.060-h0.050-rw0.050-rh0.030-e1.000-c60.0` | same |

So this is a **full-world** relief bake, not the bounded region the RELIEF-BAKE
report measured. **The 10 % census the queue carries (83 of 796) is the bounded
Holtburg region and does NOT describe this dist: here it is 1,417 of 7,498 distinct
GfxObjs = 18.9 %.** GEOMR-bearing packs by kind: 192 tile, 57 interior, 36
meta-shared.

**And the models that carry a variant are not marginal.** Over the 1,417 changed
models the variant adds 252,740 triangles on top of 205,996 — **a median growth of
+156 %, i.e. the typical variant-bearing model MORE THAN DOUBLES its triangle
count.** Top of the list: `0x01004C66` 1,532→2,948 tris; `0x010021D7` 320→1,616
(+405 %).

---

## 3. The close-up nobody had done — and where to stand for it

§-11 of the T4 forward list wanted *"a RELIEF close-up on a variant-bearing model"*;
every arm so far was a wide/street vantage or an interior (flat by design, D2).
`scripts/relief/locate-variant-models.py` resolves what a region actually renders
(scenery JSONL + LBINFO `objects`/`buildings`, setups resolved through their part
rows) against the variant set. Over the Holtburg 7x7-tile window (LBs around
`0xA9B4`, the T4 anchor's landblock):

* **buildings: 162 total, 153 carry a relief variant (94 %).** The architecture is
  railed. My earlier working hypothesis that the Holtburg-area variants were all
  vegetation was **wrong** and is deleted: it came from looking at the scenery layer
  only, where indeed only 7 objects (trees, 24→72 tris) carry one.
* scenery objects: 2,226, of which 66 carry a variant.
* No *tile* pack within ±4 tiles of Holtburg carries a GEOMR row — the building
  variants ride the **meta-shared commons/regional** packs, because those models are
  deduped world-wide. (This is why a tile-local search finds nothing and looks like
  a bug. It is not one.)

Named close-up targets, both in LB `0xA9B4`:

| model | world pos | relief OFF | relief ON |
|---|---|---|---|
| `0x0100082E` (cottage) | `32602.06, 34692.70, 66.0` | 90 tris | **282 tris (+213 %)** |
| `0x01002232` | `32609.93, 34567.50, 94.0` — 78 m from the T4 anchor | 369 tris | **689 tris (+87 %)** |

Frames (`scripts/relief/render-relief-pair.py`: same model, same camera, same light,
the ONLY variable is which of the two co-located payloads is drawn — this is the
shipped bake bytes, not a simulation). **Taildropped to the redmi:**

* `s12-gfxobj-cottage0100082E-street22m-offVSon.png` — OFF | ON | diff, 22 m
* `s12-gfxobj-cottage0100082E-closeup6m-offVSon.png` — OFF | ON | diff, 6 m
* `s12-gfxobj-house01002232-street22m-offVSon.png` — OFF | ON | diff, 22 m
* `s12-gfxobj-cottage0100082E-relief-OFF.png` / `-relief-ON.png` — the two full
  frames on their own, to swipe between

**RIG LABEL:** these are CPU renders (numpy rasteriser on this laptop), not a GPU
eye verdict — deliberately, because this laptop's HD520 has disagreed with the T4
before. They are untextured and flat-Lambert, which **overstates** the rails: the
client's albedo detail and scene clutter hide them further.

---

## 4. Fixed: `__diag.geometry.relief` could never be read (T4-EYES §3.3)

Commit `47d0c950`. T4-EYES recorded the symptom; this is the measured cause.
**BOTH** `scene3d/geom_bundles.js` (`_installDiag`, the `_stats` object registered in
`harness/lib/diag_schema.mjs`) **and** `scene3d/diag/geometry.js` (`attachGeometry`,
the 2026-07-02 geom-audit) installed on `window.__diag.geometry` with a
**whole-object assignment**. Last write won. The audit ran last, so in every arm:

* `__diag.geometry.relief` was the audit's `?gfxRelief` **gate function**, not the
  registered `{armed, variantRowsResident, modelsAssembled}` — the queue's
  `relief.variantRowsResident > 0` evaluated `undefined > 0`;
* `bundles.*`, `entityDecode.*`, `geomFallback.*` were absent entirely — the T13
  counters were unreadable too, which nobody had noticed;
* a function does not survive `JSON.stringify`, so a headless capture of
  `__diag.geometry` **silently dropped** the field instead of failing.

The two surfaces now compose on one object: `geom_bundles.js` keeps the object
IDENTITY (`__diag.geometry === geomBundleStats()`, the registry contract) and
carries across anything attached before it; `attachGeometry` attaches ONTO what is
there. The registered data fields keep the `relief` key; the gfxRelief RESOLUTION
gate is renamed **`reliefGate()`** (they answer different questions). No flag default
moved; no behaviour outside the diag surface.

**Verified live, not just in node** — arm `gbrelief` above returned
`relief: {armed:true, variantRowsResident:104, ...}` read literally off
`__diag.geometry.relief`, AND the same object survived `JSON.parse(JSON.stringify())`.
That is exactly the assertion the T4 session had to abandon.

**Sub-finding (documentation, corrected in place):** the registry note said
`__diag.geometry` is "installed by geom_bundles.js on module load". It is not —
`index.html:2905-2914` does not even *import* the module unless `?geomBundles` is
on, so on a bare boot `__diag.geometry` carries only the audit entry points. The
bare arm above shows exactly that (`diagGeometryKeys: [lastResult, audit, summary,
reliefGate]`). Availability is install-on-arm.

## 5. Why he cannot see it even when it IS armed — the honest part

The relief that ships is **`gfx_remodel`'s OP1 convex-edge + OP3 material-boundary
RAILS at `gfxSubdivLevel 0`** — additive triangles, 6 cm wide, standing 5 cm proud,
inheriting their parent polygon's surface (so: no new material, no new draw call, no
new texture). The per-texel / luminance height path — the one that would make brick
coursing and Tudor timber jut out of a wall FACE — was retired 2026-07-30 on
measurement, and `gfxSubdivLevel` is 0 on every preset tier. **Nothing in the frame
gets thicker; edges get a bevel.**

The frames make this unarguable: the diff panel is *entirely thin lines* along
eaves, ridges, corners and the wall/foundation material boundary. Wall faces are
byte-identical. And the tighter you stand, the LESS there is to see —

| vantage | pixels changed (>8/255) |
|---|---|
| 22 m, whole cottage in frame | 2.46 % |
| 6 m, wall face filling the frame | **0.21 %** |

That is the reconciliation with T4-EYES §3.3: the differ says yes (relief arms stand
well off the flat arm — 7.6 % / 18 % of pixels) while the eye says no, because the
changed pixels are a one-to-three-pixel edge highlight distributed over every
silhouette rather than a localised, recognisable shape. **83-of-796 sparsity was
never the main reason** (and on this dist it is 1,417-of-7,498 anyway, with 94 % of
Holtburg's buildings railed) — the reason is the *kind* of change.

So the gap between what the owner expects ("stones/timber protrude 5-10 cm") and what
ships is real, and it is a DESIGN gap that predates this task, not a bug. Closing it
means a bakeable height source for `subdiv_level > 0`, which `ReliefBake::is_noop()`
deliberately refuses today. Named, not attempted.

---

## 6. What I recommend (I7: I did not flip anything)

1. **Settle his URL first.** One boot, look for `[geomBundles] forcing gfxRelief OFF`.
   If it is there, he has been looking at a deliberately flat world and no amount of
   staring will change it.
2. **Flip `?reliefBundles` to default-ON, gated on:** (a) `variantRowsResident > 0`
   asserted through `__diag.geometry.relief` — now possible, §4; (b) an E-RELIEF eye
   pair on the **1070**, arms as spelled in the RELIEF-BAKE handoff, scored on
   **exterior architecture only** (interiors are flat by design, D2); (c) a shadow-pass
   frame-cost read, since the variant more than doubles triangles on ~19 % of distinct
   models world-wide and shadows re-draw the same buffer. The flip is the owner's,
   serialized per SPEC §3.
3. **Do not read the relief as "textures".** If what he wants is the wall FACE to
   have depth, that is the retired per-texel path, and re-opening it is a new task
   with a new measurement — not a fix to this one.

## Tests run

No Rust built, no wasm rebuilt (a wasm-pack build is buildbox-scale — not attempted
here, and none was needed: the exports were already in his `pkg/`). Node direct;
one headless chromium at 2.4 GB free, three short arms, nothing left running.

```
node harness/test_geom_bundles.mjs        91 passed, 0 failed  (was 78; NEW PART 8 =
                                          13 checks: both install orders, object
                                          identity, relief-as-data, gate survival,
                                          bundle-counter survival, JSON round-trip)
node harness/test_diag_schema.mjs         69 passed, 0 failed
node harness/test_console_allowlist.mjs   ✅
node harness/test_cell_fusion.mjs         20 passed, 0 failed
node scripts/lint-url-flags.mjs --strict  exit 0 (3 pre-existing presence-guards:
                                          envcellRing, fogRingCap, stableDepthShare —
                                          none in files this task touched)
python3 scripts/serve.py --check          all layers present (263 shards / 65,025
                                          scenery / 38,153 spawns / 256 packs)
live: bare / geomBundles / geomBundles+reliefBundles arms — §1 table
```

## Risks & handoffs

* **The `pkg/` staleness warning on the owner's checkout** is unrelated to relief but
  will silently poison any other measurement taken there. Worth a rebuild on the
  buildbox next time one is running.
* **`scripts/relief/*` reads `dist/` directly and caches a 51,953-pack header index
  to `/tmp`.** Re-run `build-pack-index.py` after any re-bake or the census lies.
* The offline renderer is a fidelity floor, not a substitute for the 1070 eye pair —
  it has no textures, no atlas, no shadows. It answers "what did the bake add",
  which is a different question from "what does the frame look like".
* **Not done / out of lane:** ENV interior variants (D2 remainder, unchanged); the
  `subdiv_level > 0` ladder (refused by design, needs a bakeable height source);
  any default flip (I7).
