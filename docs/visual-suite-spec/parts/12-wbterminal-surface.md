I have everything I need. Citations are confirmed across the C# two-tier dispatch, the data models, the `Load` auto-restore pattern, and the client scenery-fetch + tree-wind consumption seams. Here is the buildable spec for my slice.

---

# Slice 12 — WB.Terminal Command Surface (`CommandEngine.Vfx.cs`) — BUILD SPEC

## Goal

Give WorldBuilder.Terminal an agentic, no-GUI `vfx` command family that **produces and audits the Visual-Behavior descriptor artifacts** the holtburger client consumes. Concretely:

1. Nine verbs (`classify / sample / anchor-parts / preview / gauge / assign / audit / emit-allowlist / export`) wired into **both** dispatchers (REPL `Dictionary<string,Action<string[]>>` and JSON `Dictionary<string,Func<JsonNode,string>>`), following the two-tier pattern (`CommandEngine.cs:22-28`).
2. Two on-disk artifacts — `visual_descriptors.jsonl` (per-DID descriptors) and `visual_archetype_rules.jsonl` (the classifier's rule table, regenerable) — keyed by DID, auto-loaded alongside `ontology_cache.jsonl` (`CommandEngine.cs:129-136`).
3. A baked-manifest fetch the client loads once at scene-init, mirroring `init_scenery_base_url` (`lib.rs:2131`) → the `TREE_WIND_DIDS` hardcoded Set (`tree_wind.js:64`) becomes a generated catalog.

This slice **owns the command/artifact/fetch plumbing**. The classifier *body* is slice 03's deliverable (I call `_engine.VfxClassify(did)`); the archetype taxonomy/config is slice 02's; the gauge cost-model is slice 11's. I define the **seams** those plug into.

---

## Design

### A. Canonical artifact model (shared lib, mirrors `WeenieIndex.cs`)

New file `WorldBuilder.Shared/Lib/VisualDescriptor.cs`. This is the single source of truth both the classifier (slice 03) and the command surface read/write; it gives us `SaveJsonl`/`LoadJsonl` round-trip for free by copying `WeenieIndex.cs:122-164`.

```csharp
namespace WorldBuilder.Shared.Lib;

/// One classified DID's visual-behavior descriptor. Keyed by DID, stored in
/// the sibling visual_descriptors.jsonl (NOT inline in OntologyEntry — the
/// adjudicated decision; mirrors the .scenery.materials.json sidecar precedent).
public sealed record VisualDescriptor(
    uint   Did,                         // setup/gfx DID (0x02… / 0x01…)
    string Archetype,                   // slice-02 archetype id, e.g. "trunk-canopy"
    double Confidence,                  // [0,1]; manual overrides = 1.0
    string Source,                      // "classifier" | "manual" | "self-label"
    IReadOnlyList<string> Components,   // e.g. ["procMotion.windBend"]
    // Per-component config bag. Key = component id; value = arbitrary JSON object.
    // Kept as JsonObject so slice-02 can evolve config schema without a model bump.
    System.Text.Json.Nodes.JsonObject? Config = null,
    // Mechanism hint per component (A=CPU keyframe, B=GPU vertex). Slice-04 owns
    // the routing rule; this just records the chosen mechanism for the client.
    string? Mech = null,
    // Audit trail: the feature-vector signals the classifier fired on. Stripped
    // from the BAKED client catalog (export --slim) but kept in the project file.
    IReadOnlyList<VisualSignal>? Signals = null);

public sealed record VisualSignal(string Name, string Value, double Weight);

/// A regenerable classifier rule (priority-ordered). Emitted by `vfx export`
/// as visual_archetype_rules.jsonl so a human can diff/audit the decision logic.
public sealed record VisualArchetypeRule(
    int    Priority,                    // lower = evaluated first (DAT self-label=0)
    string RuleId,                      // "weapontype:spear→tip-flex"
    string Archetype,
    string Predicate,                   // human-readable condition (audit only)
    double Confidence);
```

`VisualDescriptorIndex` (an in-memory `Dictionary<uint,VisualDescriptor>` with `SaveJsonl`/`LoadJsonl`/`Get`/`Entries`) is a verbatim structural copy of `WeenieIndex` (`WeenieIndex.cs:84-165`), serialized with the same `JsonOpts` (camelCase, `WhenWritingNull`, `WeenieIndex.cs:122-125`).

**DID serialization:** `Did` is a `uint` in the model but serialized as a `"0x%08X"` hex string for git-diff auditability (matches the E9a sidecar convention, `CommandEngine.SurfaceMaterials.cs:41`, and `ParseDid` at `:263` which accepts hex-or-decimal). Add a `JsonConverter<uint>` that writes `"0x{v:X8}"` and parses via the existing `ParseDid` logic.

### B. `visual_descriptors.jsonl` — artifact schema

One JSON object per line, sorted by DID (mirrors `WeenieIndex.SaveJsonl` ordering, `WeenieIndex.cs:138`). camelCase. Example line (the worked Atlan-spear example, design §2.3):

```jsonc
{"did":"0x02000724","archetype":"tip-flex","confidence":0.62,"source":"classifier",
 "components":["procMotion.tipFlex","emissive.glint"],
 "config":{"procMotion.tipFlex":{"ampDeg":1.5,"gripAnchor":"holdingLoc","tipWeightCurve":"smoothstep","mech":"gpu"},
           "emissive.glint":{"strength":0.4,"metalBias":0.9}},
 "mech":"B",
 "signals":[{"name":"weaponType","value":"5","weight":0.7},{"name":"aspectRatio","value":"8.2","weight":0.4}]}
```

The shipped tree (round-trip proof for Phase 0) serializes as:

```jsonc
{"did":"0x02000258","archetype":"trunk-canopy","confidence":1.0,"source":"manual",
 "components":["procMotion.windBend"],
 "config":{"procMotion.windBend":{"pivot":"partZmin","swayAmpTrunkScale":0.3}},"mech":"A"}
```

### C. `visual_archetype_rules.jsonl` — artifact schema

The auditable, regenerable rule table (the §3.2 decision rules). One rule per line, sorted by `priority`:

```jsonc
{"priority":0,"ruleId":"dathook:setomega→display-spin","archetype":"display-spin","predicate":"SetupModel.default_animation fires AnimationHook 22","confidence":1.0}
{"priority":1,"ruleId":"weapontype:spear→tip-flex","archetype":"tip-flex","predicate":"WeaponType in {Spear(5),Staff}","confidence":0.85}
{"priority":2,"ruleId":"allowlist:foliage→trunk-canopy","archetype":"trunk-canopy","predicate":"DID in trunk-canopy seed OR SurfaceCategory=Foliage & PartCount>1","confidence":0.9}
{"priority":99,"ruleId":"fallback→rigid","archetype":"rigid","predicate":"no match","confidence":0.3}
```

### D. Command specs (engine signatures + return records)

Engine methods live in new partial `CommandEngine.Vfx.cs` (sibling of `CommandEngine.SurfaceMaterials.cs:34`). Return records go in new `CommandResults.Vfx.cs` (mirrors `CommandResults.cs:487`). The two-tier rule (`CommandEngine.cs:24-26`): the engine "operates on parsed parameters and returns structured result records — it never touches Console or JSON directly."

| Verb | Engine signature | Returns |
|---|---|---|
| `classify` | `VfxClassifyResult VfxClassify(uint did)` | `(bool Success, string Did, string Archetype, IReadOnlyList<string> Components, double Confidence, string Source, IReadOnlyList<VisualSignal> Signals, string? Error)` |
| `sample` | `VfxSampleResult VfxSample(int n, string area, ulong seed, string? outPath)` | `(bool Success, int Requested, int Drawn, string Area, ulong Seed, string OutputPath, IReadOnlyList<VfxSampleRow> Rows, string? Error)` |
| `anchor-parts` | `VfxAnchorPartsResult VfxAnchorParts(uint setupDid)` | `(bool Success, string SetupDid, IReadOnlyList<VfxAnchorCandidate> Candidates, string? Error)` |
| `preview` | `VfxPreviewResult VfxPreview(uint did, string? archetypeOverride, string? outPath)` | `(bool Success, string Did, string Archetype, string PngPath, long PngBytes, string? Error)` |
| `gauge` | `VfxGaugeResult VfxGauge(string @ref, string quality)` | `(bool Success, string Ref, string Quality, int Placements, int UniqueModels, IReadOnlyList<VfxBudgetLine> PerArchetype, double EstGpuPct, double CeilingPct, bool WithinBudget, string? Error)` |
| `assign` | `VfxAssignResult VfxAssign(uint did, string archetype)` | `(bool Success, string Did, string Archetype, string Source, double Confidence, string DescriptorPath, string? Error)` |
| `audit` | `VfxAuditResult VfxAudit(string? archetype, double threshold, string? outPath)` | `(bool Success, int TotalDescriptors, int BelowThreshold, int OverrideCount, int OutlierCount, string CsvPath, string? Error)` |
| `emit-allowlist` | `VfxEmitAllowlistResult VfxEmitAllowlist(string archetype, string? outPath)` | `(bool Success, string Archetype, int DidCount, string OutputPath, bool RoundTripMatchesSeed, string? Error)` |
| `export` | `VfxExportResult VfxExport(string? outDir, bool slim)` | `(bool Success, int DescriptorCount, int RuleCount, string DescriptorsPath, string RulesPath, string? Error)` |

Supporting records:
```csharp
public sealed record VfxSampleRow(string Did, int? Wcid, string? ModelType,
    int? WeenieType, int PartCount, float AspectRatio, float MaxDimension);
public sealed record VfxAnchorCandidate(int PartIndex, string Role,   // canopy|head|tip|bowl|contact|grip
    float[] BboxMin, float[] BboxMax, double Score);
public sealed record VfxBudgetLine(string Archetype, string CostClass, // cheap|medium|expensive
    int VisibleInstances, int UniqueDrivers, double DrawCallDelta, double EstAluPct, double FillDelta);
```

**`vfx preview`** reuses the existing render path: `_engine.RenderPreview(...)`/`RenderGalleryCurator` (`CommandEngine.RenderGallery.cs`, `RenderGalleryCurator.cs:1-231`) to render a single-object thumbnail; `archetypeOverride` lets an auditor preview a manual reclassification before committing.

**`vfx anchor-parts`** runs the C# port of `wind_rig.js buildBboxRig`/`partBBox` (`wind_rig.js:59`) over `OntologyEntry` part geometry (`OntologyEntry.cs:17-29` bounds/part-count) to nominate canopy/head/tip/bowl/contact/grip part indices — the selector slice 09 (particles) and slice 03 (classifier distal-test) both consume.

**`vfx assign`** is the manual override: writes a `source="manual", confidence=1.0` descriptor into the in-memory `VisualDescriptorIndex` and persists (`SaveJsonl`). Mirrors how `surface-materials import` is the explicit-write verb.

### E. REPL registration (subcommand-dispatch, mirrors `surface-materials`)

In `TerminalRepl.cs` `BuildCommandHandlers()` (`TerminalRepl.cs:83-215`), add one key beside `["surface-materials"]` (`:165`):

```csharp
["vfx"] = HandleVfx,
```

`HandleVfx` is a `switch(tokens[1].ToLowerInvariant())` exactly like `HandleSurfaceMaterials` (`TerminalRepl.cs:2909-2960`):

```csharp
private void HandleVfx(string[] tokens) {
    if (!CheckProject()) return;                       // every vfx verb needs a loaded project
    if (tokens.Length < 2) { PrintVfxUsage(); return; }
    try {
        switch (tokens[1].ToLowerInvariant()) {
            case "classify": {
                if (tokens.Length < 3) { Console.WriteLine("Usage: vfx classify <DID|landblock>"); return; }
                if (!TryParseUint(tokens[2], "did", out uint did)) return;  // reuse TerminalRepl helper
                var r = _engine.VfxClassify(did);
                Console.WriteLine($"  0x{did:X8} → {r.Archetype}  (conf {r.Confidence:F2}, {r.Source})");
                Console.WriteLine($"  components: {string.Join(", ", r.Components)}");
                foreach (var s in r.Signals) Console.WriteLine($"    · {s.Name}={s.Value} (w={s.Weight:F2})");
                break;
            }
            case "sample":         /* parse <n> --area --seed --out, call _engine.VfxSample */ break;
            case "anchor-parts":   /* call _engine.VfxAnchorParts */ break;
            case "preview":        /* call _engine.VfxPreview, print PNG path */ break;
            case "gauge": {
                string @ref = "holtburg", quality = "high";
                for (int i = 2; i < tokens.Length; i++) {
                    if (tokens[i] == "--ref" && i+1 < tokens.Length) @ref = tokens[++i];
                    else if (tokens[i] == "--quality" && i+1 < tokens.Length) quality = tokens[++i];
                }
                var g = _engine.VfxGauge(@ref, quality);
                Console.WriteLine($"  gauge {@ref}@{quality}: {g.EstGpuPct:F0}% GPU vs {g.CeilingPct:F0}% ceiling — "
                    + (g.WithinBudget ? "WITHIN BUDGET" : "OVER BUDGET ✗"));
                foreach (var b in g.PerArchetype)
                    Console.WriteLine($"    {b.Archetype,-16} {b.CostClass,-9} ×{b.VisibleInstances} drv={b.UniqueDrivers} ΔALU={b.EstAluPct:F1}%");
                break;
            }
            case "assign":         /* call _engine.VfxAssign, persist */ break;
            case "audit":          /* call _engine.VfxAudit, print CSV path */ break;
            case "emit-allowlist": /* call _engine.VfxEmitAllowlist, print round-trip flag */ break;
            case "export":         /* call _engine.VfxExport, print both paths */ break;
            default: Console.WriteLine($"Unknown vfx subcommand: {tokens[1]}"); break;
        }
    } catch (Exception ex) { Console.WriteLine($"Error: {ex.Message}"); }
}
```

### F. JSON registration (flat verbs, mirrors `creature-*`/`ace-db-ingest-*`)

The JSON processor flattens subcommands to hyphenated verbs (e.g. `creature-get`, `placement-list`, `JsonCommandProcessor.cs:237-258`). In `BuildCommandHandlers()` (`JsonCommandProcessor.cs:151-310`), add beside the gallery block (`:305-306`):

```csharp
["vfx-classify"]       = CmdVfxClassify,
["vfx-sample"]         = CmdVfxSample,
["vfx-anchor-parts"]   = CmdVfxAnchorParts,
["vfx-preview"]        = CmdVfxPreview,
["vfx-gauge"]          = CmdVfxGauge,
["vfx-assign"]         = CmdVfxAssign,
["vfx-audit"]          = CmdVfxAudit,
["vfx-emit-allowlist"] = CmdVfxEmitAllowlist,
["vfx-export"]         = CmdVfxExport,
```

Each handler follows the `CmdEmitRenderGallery` template (`JsonCommandProcessor.cs:1047-1086`): pull fields with `node["x"]?.GetValue<T>() ?? default`, call the engine, return `Serialize(new {...})` (the `Serialize` helper at `:4855` uses `JsonOpts` camelCase/null-ignoring, `:32-36`). Example:

```csharp
private string CmdVfxClassify(System.Text.Json.Nodes.JsonNode node) {
    uint did = ParseDidNode(node["did"]) ?? throw new ArgumentException("Missing 'did' field");
    var r = _engine.VfxClassify(did);
    return Serialize(new {
        success = r.Success, command = "vfx-classify",
        did = $"0x{did:X8}", archetype = r.Archetype, confidence = r.Confidence,
        source = r.Source, components = r.Components,
        signals = r.Signals.Select(s => new { name = s.Name, value = s.Value, weight = s.Weight }),
        error = r.Error,
    });
}

private string CmdVfxGauge(System.Text.Json.Nodes.JsonNode node) {
    string @ref = node["ref"]?.GetValue<string>() ?? "holtburg";
    string quality = node["quality"]?.GetValue<string>() ?? "high";
    var g = _engine.VfxGauge(@ref, quality);
    // FAIL is data, not exception: success=false flips the agent's gate.
    return Serialize(new {
        success = g.WithinBudget, command = "vfx-gauge",
        @ref = g.Ref, quality = g.Quality, placements = g.Placements, uniqueModels = g.UniqueModels,
        estGpuPct = g.EstGpuPct, ceilingPct = g.CeilingPct, withinBudget = g.WithinBudget,
        perArchetype = g.PerArchetype.Select(b => new {
            b.Archetype, costClass = b.CostClass, b.VisibleInstances, b.UniqueDrivers,
            b.DrawCallDelta, b.EstAluPct, b.FillDelta }),
        error = g.Error,
    });
}
```

Add a help-list entry per verb in the JSON `commands` array (`JsonCommandProcessor.cs:2659-2660`):

```csharp
new { name = "vfx-gauge", args = "ref?, quality?",
      description = "A/B the active descriptor set against the 222-placement Holtburg ref; success=false when over the <75%-GPU ceiling." },
```

### G. Auto-load on project `Load` (mirrors `AutoRestoreOntology`)

In `CommandEngine.cs` add two fields beside `_weenieIndex` (`CommandEngine.cs:81`):

```csharp
private VisualDescriptorIndex _visualDescriptors = VisualDescriptorIndex.Empty;
private IReadOnlyList<VisualArchetypeRule> _visualRules = Array.Empty<VisualArchetypeRule>();
```

In `Load` (`CommandEngine.cs:124-142`) add two restore calls + extend `LoadAutoRestoreReport`:

```csharp
var vfxDesc  = AutoRestoreVisualDescriptors(p.ProjectDirectory);
var vfxRules = AutoRestoreVisualRules(p.ProjectDirectory);
```

`AutoRestoreVisualDescriptors` is a verbatim copy of `AutoRestoreOntology` (`CommandEngine.cs:144-160`) pointed at `visual_descriptors.jsonl`, returning the same `LoadAutoRestoreEntry(path, FilePresent, Loaded, Count, Error)`. Absent file → empty index, no error (descriptors are optional, like the gazetteers).

### H. Baked-manifest client fetch (mirror `init_scenery_base_url`)

**Recommendation: one packed JSON catalog fetched once at scene-init, JS-side (no WASM rebuild — satisfies Phase-0 "JS-only").** Per-DID `{vfxBase}{did_hex}.vfx.jsonl` (the design-doc-named form) is wrong for this access pattern: the descriptor is looked up by `model_id` at *every* placement across the whole ring, so per-DID HTTP would be thousands of round-trips, whereas the catalog is ~2,763 unique DIDs × ~200 B ≈ 0.5 MB — one gzipped fetch. (Scenery is fetched per-LB through WASM only because it's bulky SoA binary; the vfx catalog is small plain JSON that JS consumes directly.)

New module `scene3d/vfx_catalog.js`, flag/memoize pattern copied from `tree_wind.js:15-56`:

```js
// scene3d/vfx_catalog.js — loads the baked descriptor catalog once.
// Mirrors init_scenery_base_url (lib.rs:2131): set base once, fetch lazily.
let _base = null, _catalog = null, _loadPromise = null;

export function initVfxCatalogUrl(url) {            // call once at scene init
  _base = url.endsWith("/") ? url : url + "/";
}

export async function loadVfxCatalog() {            // idempotent; one fetch
  if (_catalog) return _catalog;
  if (_loadPromise) return _loadPromise;
  if (!_base || !visualEnabled()) { _catalog = new Map(); return _catalog; }
  _loadPromise = (async () => {
    const map = new Map();
    try {
      const res = await fetch(`${_base}vfx_descriptors.jsonl`);
      if (res.ok) for (const line of (await res.text()).split("\n")) {
        const t = line.trim(); if (!t) continue;
        const d = JSON.parse(t);
        map.set((parseInt(d.did, 16) >>> 0), d);     // "0x02000258" → 0x02000258
      }
    } catch (_) { /* absent catalog ⇒ frozen path, byte-identical */ }
    return (_catalog = map);
  })();
  return _loadPromise;
}

/** Descriptor for a model_id, or null (→ frozen). */
export function vfxDescriptorFor(modelId) {
  return _catalog ? (_catalog.get(modelId >>> 0) || null) : null;
}

/** `?visual=archetypes` master gate; DEFAULT-OFF, like ?treeWind. */
let _vis;
export function visualEnabled() {
  if (_vis !== undefined) return _vis;
  const v = new URLSearchParams(location.search).get("visual");
  return (_vis = v != null && /^(on|1|true|yes|archetypes)$/i.test(v));
}
```

**Consumption seam (generalizes the tree-wind divert).** Today `statics.js:1594-1600` filters `isTreeDid(modelId)` out of the frozen path and routes to `attachWindTrees` (`statics.js:1846`, `:2393`; `animated_scenery.js:495`). Generalize to a descriptor lookup that routes by mechanism:

```js
// statics.js — replaces the treeWindEnabled()/isTreeDid() divert at :1594.
if (visualEnabled()) {
  await loadVfxCatalog();
  const mechA = statics.filter(p => vfxDescriptorFor(p.modelId)?.mech === "A");
  if (mechA.length) {
    windTrees = mechA;                                         // → shared-mixer player (MECH-A)
    statics = statics.filter(p => vfxDescriptorFor(p.modelId)?.mech !== "A");
  }
  // MECH-B / fragment descriptors stay in `statics` and attach a cached material
  // variant at InstancedMesh build (getCachedVariant(did, component) — slice 01).
}
```

`trunk-canopy` (the only `mech:"A"` archetype today) reproduces the current behaviour exactly; `?treeWind=on` is kept as a back-compat alias that injects the 6 tree DIDs when no catalog is present.

---

## Integration seams (file:line)

| What | Where |
|---|---|
| Partial-class engine pattern + two-tier contract | `WorldBuilder.Terminal/CommandEngine.cs:22-28` |
| New `CommandEngine.Vfx.cs` sibling (template) | `WorldBuilder.Terminal/CommandEngine.SurfaceMaterials.cs:34,79` |
| Return-record file (template) | `WorldBuilder.Terminal/CommandResults.cs:487` (`ExportClassificationSignalsResult`) |
| REPL dict registration (`["vfx"]=HandleVfx`) | `WorldBuilder.Terminal/TerminalRepl.cs:165` (beside `surface-materials`) |
| REPL subcommand-switch template | `WorldBuilder.Terminal/TerminalRepl.cs:2909-2960` (`HandleSurfaceMaterials`) |
| REPL uint-parse + project-check helpers | `TerminalRepl.cs:228` (`TryParseUint`), `CheckProject` |
| JSON dict registration (`vfx-*`) | `WorldBuilder.Terminal/JsonCommandProcessor.cs:305-306` (beside gallery) |
| JSON handler template + `Serialize`/`JsonOpts` | `JsonCommandProcessor.cs:1047-1086`, `:4855`, `:32-36` |
| JSON help-list `commands` array | `JsonCommandProcessor.cs:2659-2660` |
| Auto-load on `Load` (template) | `CommandEngine.cs:124-142` + `AutoRestoreOntology` `:144-160` |
| Engine state fields (beside `_weenieIndex`) | `CommandEngine.cs:81` |
| Project-dir resolver for default out-paths | `CommandEngine.Placements.cs:18` (`GetCurrentProjectDirectoryOrCwd`) |
| Shared artifact model (template) | `WorldBuilder.Shared/Lib/WeenieIndex.cs:32-74,122-165` |
| Classifier geometry inputs | `WorldBuilder.Shared/Lib/OntologyEntry.cs:17-29,61,73,79` |
| Identity inputs (SetupDid etc.) | `WeenieIndex.cs:32-74` |
| `vfx preview` render reuse | `CommandEngine.RenderGallery.cs`, `RenderGalleryCurator.cs:1-231` |
| Client init seam to mirror | `lib.rs:2131` (`init_scenery_base_url`), `:2174` (URL format), `:2432` (`pub use`) |
| Client flag/memoize pattern to copy | `scene3d/tree_wind.js:15-56,64-76` |
| Client consumption seam (generalize) | `scene3d/statics.js:1594-1600,1846,2393`; `animated_scenery.js:495` |

---

## Edge cases & legacy-safety check (per THE RULE)

This slice is an **offline C# tool + a one-time JSON fetch**; it never touches a render transform, material, or wire value. THE RULE applies transitively to what the artifacts *cause*, so:

- **Reads only static/derived inputs.** The classifier reads `OntologyEntry` geometry (`OntologyEntry.cs:17-29`), `WeenieIndex` identity (`WeenieIndex.cs:32-74`), DAT self-labels, SurfaceCategory — all DAT/weenie static data. No server-replicated/mutable state is read. ✔
- **Writes only project-dir artifacts + cloned render state.** `vfx export`/`assign` write `visual_descriptors.jsonl` in the **project directory** (never a DAT, never the wire). The client catalog only *selects* effects whose writes are already RULE-bound by slices 01/04. ✔
- **`vfx gauge` is a hard gate, not advice.** Over-budget returns `success=false`/`withinBudget=false` (the gate an agent or CI keys on), mirroring the design's "FAIL if over budget." It must never auto-disable an effect server-side — it only reports.
- **Absent catalog ⇒ byte-identical frozen path.** `loadVfxCatalog` swallows fetch/parse errors → empty Map → `vfxDescriptorFor` returns null → no divert, exactly today's frozen instancing. This preserves the `tree_wind.js` "off ⇒ statics unchanged" invariant (`statics.js:1592`). A corrupt catalog line is skipped, never thrown (matches `WeenieIndex.LoadJsonl`'s tolerant `continue`, `WeenieIndex.cs:158-160`).
- **`emit-allowlist` round-trip guard.** `vfx emit-allowlist trunk-canopy` must reproduce the 6 DIDs in `TREE_WIND_DIDS` (`tree_wind.js:64-71`) exactly; the return carries `RoundTripMatchesSeed` so the Phase-0 exit bar ("classifier round-trips the tree allowlist") is machine-checkable.
- **DID parse robustness.** Accept `"0x02000258"` or decimal `33554520` everywhere (reuse the `ParseDid` convention, `CommandEngine.SurfaceMaterials.cs:263`); reject malformed DIDs with a graceful `Error` result, not an exception that kills the JSON loop (`JsonCommandProcessor.cs:82-84`).
- **No GUI / no side effects beyond files.** All verbs return records; `preview` writes a PNG to an explicit/derived path (like `render-preview`, `TerminalRepl.cs:256-258`). `serve`-style side effects are out of scope.
- **`?visual` default-OFF.** Master gate ships OFF (`visualEnabled()` default false), per the design's per-archetype-flag → batched-eye-test → default-ON-with-`=off`-escape ladder.

---

## GPU cost

This slice adds **zero per-frame GPU cost of its own**. Two cost touchpoints:

1. **One-time catalog fetch:** ~0.5 MB JSON (≈2,763 DIDs), fetched once at scene-init, parsed into a `Map`. Negligible vs the scenery/mesh fetches already in flight. No per-frame work — the `Map` is consulted only at landblock-bake time (the same place `isTreeDid` is consulted today, `statics.js:1595`), not per rAF.
2. **`vfx gauge` is the budget authority, not a cost.** It runs offline in C#, estimating the *downstream* GPU cost of the active descriptor set against the 222-placement / 66-model Holtburg ref (`statics.js:37-44`) using slice-11's cost table, and FAILS the build if the set would exceed the `<75% GPU at full Dereth` ceiling. The command surface's job is to surface that pass/fail as `success`/`withinBudget` so agents and CI can gate on it.

Classification deliberately runs on **original DAT pixels** (not upscaled — design §4.4 isolated-track note), so it never perturbs `SurfaceStats`; that's a correctness note the `vfx classify`/`sample` inputs must honor (they read `OntologyEntry`/`WeenieIndex`, never the AI-sidecar buffers).

---

## Build checklist

1. **Shared model.** Add `WorldBuilder.Shared/Lib/VisualDescriptor.cs`: `VisualDescriptor`, `VisualSignal`, `VisualArchetypeRule` records + `VisualDescriptorIndex` (`Empty`/`Get`/`Entries`/`SaveJsonl`/`LoadJsonl`) by copying `WeenieIndex.cs:84-165`. Add the `"0x%08X"` `uint` JsonConverter.
2. **Return records.** Add `WorldBuilder.Terminal/CommandResults.Vfx.cs` with the 9 result records + `VfxSampleRow`/`VfxAnchorCandidate`/`VfxBudgetLine` (§D), styled like `CommandResults.cs:487`.
3. **Engine partial.** Add `WorldBuilder.Terminal/CommandEngine.Vfx.cs` (`public partial class CommandEngine`) with the 9 `Vfx*` methods. `VfxClassify` calls into the slice-03 classifier; `VfxGauge` into slice-11's cost model; `VfxAnchorParts` ports `wind_rig.js buildBboxRig` (`wind_rig.js:59`); `VfxPreview` calls `RenderPreview`/`RenderGalleryCurator`. `VfxExport` writes both JSONLs via `SaveJsonl` to `GetCurrentProjectDirectoryOrCwd()` (`CommandEngine.Placements.cs:18`); `--slim` strips `Signals` from the client catalog.
4. **State + auto-load.** Add `_visualDescriptors`/`_visualRules` fields (`CommandEngine.cs:81`); add `AutoRestoreVisualDescriptors`/`AutoRestoreVisualRules` (copy `:144-160`) and call them in `Load` (`:124-142`); extend `LoadAutoRestoreReport` with the two entries.
5. **REPL wiring.** Register `["vfx"]=HandleVfx` in `TerminalRepl.cs:165`; implement `HandleVfx` subcommand-switch (§E) modeled on `HandleSurfaceMaterials` (`:2909`); add `PrintVfxUsage`.
6. **JSON wiring.** Register the 9 `vfx-*` verbs in `JsonCommandProcessor.cs:305`; implement `CmdVfx*` handlers (§F) returning `Serialize(new {...})`; add 9 entries to the help `commands` array (`:2659`). `vfx-gauge` maps over-budget → `success=false`.
7. **Phase-0 round-trip test.** Seed `visual_descriptors.jsonl` with the 6 `trunk-canopy` DIDs; assert `VfxEmitAllowlist("trunk-canopy").RoundTripMatchesSeed == true` against `TREE_WIND_DIDS` (`tree_wind.js:64-71`).
8. **Client loader.** Add `scene3d/vfx_catalog.js` (`initVfxCatalogUrl`/`loadVfxCatalog`/`vfxDescriptorFor`/`visualEnabled`, §H). Call `initVfxCatalogUrl` next to `init_scenery_base_url` in `index.html:1145`/`:4122` and `scene3d/bake_worker.js:38`.
9. **Client consumption.** Replace the `treeWindEnabled()`/`isTreeDid` divert at `statics.js:1594-1600` (and the mirror at `:2112`) with the `vfxDescriptorFor`-by-`mech` router (§H); keep `?treeWind=on` as a catalog-less back-compat alias. MECH-B/fragment descriptors hand off to slice-01's `getCachedVariant`.
10. **Bake hook.** Have `vfx export` also drop the catalog under `dist/scenery/`-sibling `dist/vfx/vfx_descriptors.jsonl` so the client's default `initVfxCatalogUrl("../../dist/vfx/")` resolves (mirrors the scenery staging at `lib.rs:1880`).
11. **Verify.** `dotnet build`; smoke each verb in REPL + JSON mode; confirm bare-default client load (`?visual` absent) is byte-identical to frozen (no catalog fetch when gate off), and `?visual=archetypes` loads the catalog with 0 console errors.
