using System.Globalization;
using System.Text.Json;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Terminal;

// ─────────────────────────────────────────────────────────────────────────────
//  Visual-Behavior Suite — WorldBuilder.Terminal command surface (Phase 0 / commit 2)
//
//  Build-spec §12 (command surface) + §3 (auto-classifier) + §4 (cascade).
//  Two-tier pattern (CommandEngine.cs:26-28): the REPL/JSON handler parses
//  tokens → calls these Vfx* engine methods → returns a structured record the
//  caller serializes. This commit implements two of the nine §12.2 verbs:
//
//    vfx classify <DID|landblock>  — run the §3.2 cascade, return
//                                    {did, archetype, components, confidence, signals[]}
//    vfx emit-allowlist <archetype> — enumerate all DIDs the archetype's rule
//                                    matches → the DID set (Phase-0 seed).
//
//  The classifier is offline + deterministic + git-diff-auditable. It reads ONLY
//  static/derived inputs (build-spec §4): the ontology geometry index
//  (_ontologyService) + the weenie identity index (_weenieIndex) + the
//  archetype-rule registry (visual_archetype_rules.jsonl).
//
//  DATA GAP (build-spec §18 open-question #1): WeaponType / MaterialType /
//  ValidLocations are NOT on WeenieIndexEntry yet, so the WeaponType selectors
//  (rigid-glint / tip-flex tier-1) cannot fire from data this commit. The rule
//  REGISTRY transcribes them faithfully (so the taxonomy is stable and
//  emit-allowlist enumerates the seed sets), but `vfx classify` only resolves
//  the data it has: the trunk-canopy wind allowlist (stage 2) + geometry hints +
//  the rigid fallback. Maturing the weapon-prop selectors is Phase-1.
// ─────────────────────────────────────────────────────────────────────────────

public partial class CommandEngine {
    // Lazily-loaded archetype-rule registry (single source of truth). Loaded
    // from visual_archetype_rules.jsonl resolved against: project dir → the
    // tool's own directory (shipped Content) → CWD. Cached after first load;
    // null until first use.
    private List<VisualArchetypeRule>? _vfxRulesCache;

    /// <summary>The committed rule registry, in cascade-tier order. Loads on first access.</summary>
    private IReadOnlyList<VisualArchetypeRule> VfxRules() {
        if (_vfxRulesCache != null) return _vfxRulesCache;
        _vfxRulesCache = LoadArchetypeRules();
        return _vfxRulesCache;
    }

    /// <summary>Drop the cached rules so the next access re-reads the file (used after edits / on load).</summary>
    internal void InvalidateVfxRules() => _vfxRulesCache = null;

    /// <summary>
    /// Resolve + parse <c>visual_archetype_rules.jsonl</c>. Resolution order:
    /// (1) the current project directory, (2) the tool's base directory (the
    /// file ships as Content next to the binary), (3) the working directory.
    /// Throws when no copy is found (the registry is load-bearing — fail loud).
    /// </summary>
    private List<VisualArchetypeRule> LoadArchetypeRules() {
        var path = ResolveVfxRulesPath();
        var rules = new List<VisualArchetypeRule>();
        foreach (var line in File.ReadLines(path)) {
            var trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            var rule = JsonSerializer.Deserialize<VisualArchetypeRule>(trimmed, JsonOpts.CaseInsensitive);
            if (rule == null || string.IsNullOrEmpty(rule.Id)) continue;
            rules.Add(rule);
        }
        // Cascade order: lower select.tier runs first (build-spec §4.3). Stable
        // sort keeps file order among equal tiers.
        return rules.OrderBy(r => r.Select?.Tier ?? int.MaxValue).ToList();
    }

    private static readonly string VfxRulesFileName = "visual_archetype_rules.jsonl";

    private string ResolveVfxRulesPath() {
        // 1) project directory (a project may carry a regenerated copy).
        var projectDir = _projectManager.CurrentProject?.ProjectDirectory;
        if (!string.IsNullOrEmpty(projectDir)) {
            var p = Path.Combine(projectDir, VfxRulesFileName);
            if (File.Exists(p)) return p;
        }
        // 2) shipped Content next to the binary (VfxData/ subdir or alongside).
        var baseDir = AppContext.BaseDirectory;
        foreach (var candidate in new[] {
            Path.Combine(baseDir, "VfxData", VfxRulesFileName),
            Path.Combine(baseDir, VfxRulesFileName),
        }) {
            if (File.Exists(candidate)) return candidate;
        }
        // 3) working directory (and a sibling VfxData/).
        foreach (var candidate in new[] {
            Path.Combine(Directory.GetCurrentDirectory(), VfxRulesFileName),
            Path.Combine(Directory.GetCurrentDirectory(), "VfxData", VfxRulesFileName),
        }) {
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException(
            $"{VfxRulesFileName} not found (looked in project dir, {Path.Combine(baseDir, "VfxData")}, and CWD).");
    }

    private VisualArchetypeRule? FindRule(string archetypeId) =>
        VfxRules().FirstOrDefault(r => string.Equals(r.Id, archetypeId, StringComparison.OrdinalIgnoreCase));

    // ─────────────────────────────────────────────────────────────────
    //  Cost model (cost_model.jsonl) — one row per VFX COMPONENT id,
    //  scored on the five §11.2/§11.3 cost axes. Loaded lazily, mirrors
    //  the rule registry resolution (project → shipped Content → CWD).
    // ─────────────────────────────────────────────────────────────────

    private Dictionary<string, VfxComponentCost>? _vfxCostCache;
    private static readonly string VfxCostFileName = "cost_model.jsonl";

    /// <summary>The committed component cost model, keyed by component id. Loads on first access.</summary>
    private IReadOnlyDictionary<string, VfxComponentCost> VfxCostModel() {
        if (_vfxCostCache != null) return _vfxCostCache;
        _vfxCostCache = LoadCostModel();
        return _vfxCostCache;
    }

    /// <summary>Drop the cached cost model so the next access re-reads the file.</summary>
    internal void InvalidateVfxCostModel() => _vfxCostCache = null;

    private Dictionary<string, VfxComponentCost> LoadCostModel() {
        var path = ResolveVfxDataPath(VfxCostFileName);
        var map = new Dictionary<string, VfxComponentCost>(StringComparer.Ordinal);
        foreach (var line in File.ReadLines(path)) {
            var trimmed = line.Trim();
            if (trimmed.Length == 0) continue;
            var row = JsonSerializer.Deserialize<VfxComponentCost>(trimmed, JsonOpts.CaseInsensitive);
            if (row == null || string.IsNullOrEmpty(row.Id)) continue;
            map[row.Id] = row;
        }
        return map;
    }

    /// <summary>
    /// Generalized VfxData resolution (project dir → shipped Content
    /// VfxData/ → CWD). The rule-registry path resolver predates this; this
    /// serves the cost model + any future VfxData sidecar.
    /// </summary>
    private string ResolveVfxDataPath(string fileName) {
        var projectDir = _projectManager.CurrentProject?.ProjectDirectory;
        if (!string.IsNullOrEmpty(projectDir)) {
            var p = Path.Combine(projectDir, fileName);
            if (File.Exists(p)) return p;
        }
        var baseDir = AppContext.BaseDirectory;
        foreach (var candidate in new[] {
            Path.Combine(baseDir, "VfxData", fileName),
            Path.Combine(baseDir, fileName),
            Path.Combine(Directory.GetCurrentDirectory(), fileName),
            Path.Combine(Directory.GetCurrentDirectory(), "VfxData", fileName),
        }) {
            if (File.Exists(candidate)) return candidate;
        }
        throw new FileNotFoundException(
            $"{fileName} not found (looked in project dir, {Path.Combine(baseDir, "VfxData")}, and CWD).");
    }

    // ─────────────────────────────────────────────────────────────────
    //  vfx emit-allowlist <archetype>
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Enumerate every DID the archetype's rule matches → the DID set seed
    /// (build-spec §12.2). For an archetype carrying an explicit Phase-0 seed
    /// (<c>select.dids</c>, e.g. trunk-canopy) this returns exactly that seed —
    /// reproducing the JS allowlist by construction. For selector-only
    /// archetypes (weapon-prop rules) the matched-set is empty until the
    /// weenie-prop selectors land (build-spec §18 #1), reported via
    /// <see cref="VfxEmitAllowlistResult.SelectorOnly"/>.
    /// </summary>
    public VfxEmitAllowlistResult VfxEmitAllowlist(string archetypeId) {
        var rule = FindRule(archetypeId);
        if (rule == null) {
            var known = string.Join(", ", VfxRules().Select(r => r.Id));
            return new VfxEmitAllowlistResult(false, archetypeId,
                Array.Empty<uint>(), false, $"Unknown archetype '{archetypeId}'. Known: {known}.");
        }

        var seed = rule.Select?.Dids;
        if (seed is { Length: > 0 }) {
            // Order-insensitive set, sorted ascending for deterministic output.
            var dids = seed.Distinct().OrderBy(d => d).ToArray();
            return new VfxEmitAllowlistResult(true, rule.Id, dids, false, null);
        }

        // No explicit seed. A selector predicate could still enumerate matches,
        // but the weapon/material props it needs aren't on the WeenieIndex this
        // commit. Report the selector-only state honestly rather than guessing.
        bool selectorOnly = rule.Select?.WeaponTypes is { Length: > 0 }
                            || !string.IsNullOrEmpty(rule.Select?.Predicate);
        return new VfxEmitAllowlistResult(true, rule.Id, Array.Empty<uint>(), selectorOnly, null);
    }

    // ─────────────────────────────────────────────────────────────────
    //  vfx classify <DID|landblock>
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Classify a single SetupDID — run the §3.2 priority cascade and return the
    /// selected archetype + resolved component bundle + confidence + the feature
    /// signals that drove the decision. Deterministic; reads only static/derived
    /// inputs (ontology geometry + weenie identity + the rule registry).
    /// </summary>
    public VfxClassifyResult VfxClassify(uint did) {
        var signals = new List<VisualSignal>();

        // ── Feature vector (the inputs the cascade reads) ──────────────
        var onto = _ontologyService.GetEntry(did);
        if (onto != null) {
            signals.Add(new VisualSignal { Name = "category", Value = onto.Category, Weight = 0.3 });
            signals.Add(new VisualSignal { Name = "maxDimension", Value = onto.MaxDimension.ToString("F2", CultureInfo.InvariantCulture), Weight = 0.2 });
            signals.Add(new VisualSignal { Name = "aspectRatio", Value = onto.AspectRatio.ToString("F2", CultureInfo.InvariantCulture), Weight = 0.2 });
            signals.Add(new VisualSignal { Name = "partCount", Value = onto.PartCount.ToString(CultureInfo.InvariantCulture), Weight = 0.2 });
        }

        // ── Cascade (build-spec §4.3, the subset this commit can resolve) ──
        // Stage 2 — wind allowlist (the trunk-canopy seed). Authoritative,
        // confidence 1.0; this is the round-trip anchor.
        var trunk = FindRule(VisualArchetypeIds.TrunkCanopy);
        if (trunk?.Select?.Dids is { Length: > 0 } windSeed && windSeed.Contains(did)) {
            signals.Add(new VisualSignal { Name = "windAllowlist", Value = "true", Weight = 1.0 });
            return BuildResult(did, trunk, trunk.Select.Confidence, "allowlist", signals);
        }

        // Stage 2/3 — geometry-derived trunk-canopy hint: foliage/scenery,
        // multi-part, tall. A ramped confidence (mirrors OntologyService.Ramp).
        if (onto != null && trunk != null
            && (IsFoliageLike(onto.Category) ) && onto.PartCount >= 2 && onto.MaxDimension >= 4f) {
            double conf = onto.MaxDimension >= 8f ? 0.9 : 0.5 + 0.5 * (onto.MaxDimension - 4f) / 4f;
            signals.Add(new VisualSignal { Name = "geometryTrunkCanopy", Value = "foliage+multipart+tall", Weight = conf });
            return BuildResult(did, trunk, conf, conf >= AuditThreshold ? "classifier" : "classifier-low", signals);
        }

        // Stage 1 (geometry surrogate) — tip-flex by thin-distal geometry. With
        // no WeaponType data (build-spec §18 #1), a strong single-axis aspect on
        // a low-part-count model is the only available distal-protrusion proxy.
        var tip = FindRule(VisualArchetypeIds.TipFlex);
        if (onto != null && tip != null && onto.AspectRatio >= 3f && onto.PartCount <= 2) {
            double conf = 0.7; // geometry-only surrogate, below the WeaponType-exact 0.95
            signals.Add(new VisualSignal { Name = "geometryTipFlex", Value = $"aspect={onto.AspectRatio:F2},parts={onto.PartCount}", Weight = conf });
            return BuildResult(did, tip, conf, conf >= AuditThreshold ? "classifier" : "classifier-low", signals);
        }

        // Stage 5 — default rigid (build-spec §4.3). The byte-identical frozen path.
        var rigid = FindRule(VisualArchetypeIds.Rigid)
                    ?? new VisualArchetypeRule { Id = VisualArchetypeIds.Rigid, Components = new(), Select = new VisualArchetypeSelect { Tier = 5, Confidence = 0.6 } };
        signals.Add(new VisualSignal { Name = "fallback", Value = "no-rule-matched", Weight = 0.6 });
        return BuildResult(did, rigid, rigid.Select?.Confidence ?? 0.6, "classifier", signals);
    }

    /// <summary>The audit confidence threshold below which a result is `classifier-low` (build-spec §4.6).</summary>
    private const double AuditThreshold = 0.6;

    private static bool IsFoliageLike(string? category) =>
        category != null &&
        (category.Equals("Scenery", StringComparison.OrdinalIgnoreCase)
         || category.Contains("Foliage", StringComparison.OrdinalIgnoreCase)
         || category.Contains("Tree", StringComparison.OrdinalIgnoreCase)
         || category.Contains("Plant", StringComparison.OrdinalIgnoreCase));

    /// <summary>
    /// Resolve an archetype rule into a descriptor result: build the component
    /// refs (id + channel + merged config) from the rule's components + defaults.
    /// </summary>
    private VfxClassifyResult BuildResult(
        uint did, VisualArchetypeRule rule, double confidence, string source, List<VisualSignal> signals) {
        var comps = new List<VisualComponentRef>();
        foreach (var compId in rule.Components) {
            System.Text.Json.Nodes.JsonObject? cfg = null;
            if (rule.Defaults != null && rule.Defaults.TryGetPropertyValue(compId, out var node) && node is System.Text.Json.Nodes.JsonObject obj)
                cfg = (System.Text.Json.Nodes.JsonObject)obj.DeepClone();
            comps.Add(new VisualComponentRef {
                Name = compId,
                Channel = ChannelForComponent(compId),
                Config = cfg,
            });
        }
        return new VfxClassifyResult(
            true, did, rule.Id, comps, confidence, source, rule.Mech, signals, null);
    }

    /// <summary>
    /// The §14 conflict channel a component owns, inferred from its family
    /// prefix (the small commit-2 vocabulary; the full map lives in the JS
    /// registry). A single driver may own each channel per object.
    /// </summary>
    private static string? ChannelForComponent(string compId) {
        if (compId.StartsWith("deformation.", StringComparison.Ordinal)) return "transform";
        if (compId.StartsWith("emissive.", StringComparison.Ordinal)) return "emissive";
        if (compId.StartsWith("weathering.", StringComparison.Ordinal)) return "diffuse";
        if (compId.StartsWith("texture.", StringComparison.Ordinal)) return "uvScroll";
        if (compId.StartsWith("particle.", StringComparison.Ordinal)) return "particle";
        return null;
    }

    // ─────────────────────────────────────────────────────────────────
    //  vfx gauge [--ref holtburg]  — Half-A static estimator
    //
    //  Build-spec §11.6 Half-A: enumerate the reference-area UNIQUE model
    //  DIDs → classify each via the §3 cascade → sum the cost rows BY THE
    //  SCALING INVARIANT (per UNIQUE DRIVER, NOT per placement, §11.2) →
    //  emit a structural report + run the structural gates G1–G3 → FAIL
    //  FAST if any trips (CI pre-flight, BEFORE any GPU work).
    //
    //  CRITICAL (§11.6 / §18 #9): this box is SwiftShader/CI, so the
    //  TIMING meter (Half-B, gates G5–G7) is N/A. The verdict is
    //  STRUCTURAL-PASS, *never* PASS — timing is 1070-only.
    // ─────────────────────────────────────────────────────────────────

    /// <summary>The structural-gate caps (build-spec §11.6).</summary>
    // G1 — Δprograms must be O(unique drivers); the hard link-explosion cap.
    // A cheap-frag-dominated Holtburg ref links ≤1 program per unique driver,
    // so a cap of (uniqueDrivers + a small slack) holds; a per-placement link
    // explosion (the failure §2.1/§11.2 guards) would blow far past it.
    private const int GaugeKpSlack = 8;
    // G3 — ΔVRAM budget for the reference ring (per-driver textures only; no
    // per-instance growth). Holtburg's cheap set adds ~0; a healthy ceiling.
    private const double GaugeVramBudgetMB = 16.0;

    /// <summary>
    /// The Holtburg radius-1 reference UNIQUE model set (build-spec §11.2 cites
    /// 222 placements / 66 unique). Enumerated offline from the shipped Holtburg
    /// ring scenery (<c>dist/scenery/0x{lb}.scenery.jsonl</c> <c>obj_id</c>s, the
    /// 9-LB ring around 0xA9B4): 299 placements → 27 unique SetupDIDs, ALL six
    /// trunk-canopy wind DIDs present. Baked here so the gauge runs with zero
    /// external deps (the static objects path is WASM-only / not baked to jsonl).
    /// The placement counts ride alongside ONLY to prove the invariant in the
    /// report (cost is summed per-unique, never per-placement).
    /// </summary>
    private static readonly (uint Did, int Placements)[] HoltburgRefModels = {
        (0x02000240u, 1), (0x02000246u, 35), (0x02000256u, 5),  (0x02000257u, 8),
        (0x02000258u, 31),(0x020002D3u, 27),(0x020002D8u, 2),  (0x020002D9u, 13),
        (0x020002DAu, 5), (0x020002DBu, 9), (0x020002F2u, 2),  (0x020002F5u, 2),
        (0x0200035Fu, 2), (0x020003D1u, 38),(0x020003D2u, 11), (0x02000493u, 6),
        (0x02000494u, 9), (0x020004B0u, 3), (0x020005ACu, 5),  (0x020005C9u, 12),
        (0x020007A2u, 11),(0x020007A3u, 12),(0x020007A4u, 5),  (0x020007A5u, 6),
        (0x02001063u, 33),(0x02001064u, 5), (0x02001065u, 1),
    };

    /// <summary>
    /// <c>vfx gauge --ref holtburg</c> — the Half-A static estimator. Enumerates
    /// the Holtburg-ref unique model DIDs, classifies each, sums the cost-model
    /// rows per unique driver (the scaling invariant), runs the structural gates
    /// G1–G3, and reports a STRUCTURAL-PASS / STRUCTURAL-FAIL verdict. Returns
    /// <see cref="VfxGaugeResult.Success"/>=false (and WithinBudget=false) when a
    /// gate trips — the CI pre-flight gate fails fast.
    /// </summary>
    public VfxGaugeResult VfxGauge(string reference) {
        if (!string.Equals(reference, "holtburg", StringComparison.OrdinalIgnoreCase)) {
            return VfxGaugeResult.Failure(reference,
                $"Unknown --ref '{reference}'. Phase-0 supports: holtburg.");
        }

        // ── Enumerate the reference unique-driver set ──────────────────
        var models = HoltburgRefModels;
        int uniqueModels = models.Length;
        int totalPlacements = models.Sum(m => m.Placements);
        var cost = VfxCostModel();

        // ── Classify each unique model + sum cost BY UNIQUE DRIVER ─────
        // THE SCALING INVARIANT (§11.2): every axis is summed ONCE per unique
        // model (one driver per model×surface×patch-set), NEVER × placements.
        int programsDelta = 0;          // Σ dProgramsPerDriver (the G1 axis)
        int drawcallsDelta = 0;         // Σ dCallsPerInstance — MUST stay 0 for non-particle effects (G2)
        double vramMB = 0.0;            // Σ dVramMB per driver (G3)
        int particleEmitters = 0;       // Σ dParticleEmitters per driver
        int lightsDelta = 0;            // Σ dLightsPerDriver — MUST stay 0 (G4 no-relink invariant)
        var perArchetype = new Dictionary<string, int>(StringComparer.Ordinal);
        var missingCostRows = new List<string>();

        foreach (var (did, _) in models) {
            var cls = VfxClassify(did);
            perArchetype[cls.Archetype] = perArchetype.GetValueOrDefault(cls.Archetype) + 1;

            // Sum every resolved component's cost row ONCE (per unique driver).
            foreach (var comp in cls.Components) {
                if (!cost.TryGetValue(comp.Name, out var row)) {
                    if (!missingCostRows.Contains(comp.Name)) missingCostRows.Add(comp.Name);
                    continue;
                }
                programsDelta += row.DProgramsPerDriver;
                drawcallsDelta += row.DCallsPerInstance;   // 0 for every non-particle row
                vramMB += row.DVramMB;
                particleEmitters += row.DParticleEmitters;
                lightsDelta += row.DLightsPerDriver;       // 0 for every row (the no-relink invariant)
            }
            // A rigid (zero-component) model still counts the "rigid" no-op row
            // for completeness if present — it contributes nothing on any axis.
            if (cls.Components.Count == 0 && cost.TryGetValue(VisualArchetypeIds.Rigid, out var rr)) {
                programsDelta += rr.DProgramsPerDriver;
                drawcallsDelta += rr.DCallsPerInstance;
                vramMB += rr.DVramMB;
                particleEmitters += rr.DParticleEmitters;
                lightsDelta += rr.DLightsPerDriver;
            }
        }

        if (missingCostRows.Count > 0) {
            return VfxGaugeResult.Failure(reference,
                "cost_model.jsonl is missing rows for resolved component(s): "
                + string.Join(", ", missingCostRows) + ". The cost model must score every emitted component.");
        }

        // ── Structural gates (build-spec §11.6) ───────────────────────
        var gates = new List<VfxGaugeGate>();

        // G1 — Δprograms = O(unique drivers) ≤ Kp [hard FAIL — link-explosion].
        int kp = uniqueModels + GaugeKpSlack;
        bool g1 = programsDelta <= kp;
        gates.Add(new VfxGaugeGate(
            "G1", "Δprograms = O(unique drivers) ≤ Kp (link-explosion guard)",
            g1, $"programsDelta={programsDelta} ≤ Kp={kp} (uniqueDrivers {uniqueModels} + slack {GaugeKpSlack})"));

        // G2 — ΔCalls = 0 per non-particle effect. (No particle archetypes in
        // the Phase-0 3-archetype set, so the whole drawcall delta must be 0.)
        bool g2 = drawcallsDelta == 0;
        gates.Add(new VfxGaugeGate(
            "G2", "ΔCalls = 0 per non-particle effect",
            g2, $"drawcallsDelta={drawcallsDelta} (particleEmitters={particleEmitters})"));

        // G3 — ΔVRAM within budget, no per-instance texture growth.
        bool g3 = vramMB <= GaugeVramBudgetMB;
        gates.Add(new VfxGaugeGate(
            "G3", "ΔVRAM ≤ budget, no per-instance texture growth",
            g3, $"vramMB={vramMB:F2} ≤ budget={GaugeVramBudgetMB:F1}"));

        // G4 — Δlights = 0 (no light-COUNT change). A light effect (light.flameFlicker)
        // modulates an EXISTING light's .intensity only; ANY added light forces a
        // MeshStandard relink + frame freeze (THE RULE — the spell-freeze light-pool
        // history). Mirrors the JS manifest's lightCountDelta==0 enforcement on the C#
        // side, so a future light component that tried to grow the count FAILs here.
        bool g4 = lightsDelta == 0;
        gates.Add(new VfxGaugeGate(
            "G4", "Δlights = 0 (intensity-only, no light-count relink)",
            g4, $"lightsDelta={lightsDelta} (must be 0 — no MeshStandard relink)"));

        bool allPass = g1 && g2 && g3 && g4;

        // Headroom on the binding gate (G1, the link budget) — how much of the
        // unique-driver program cap the suite consumes. 100% = empty, 0% = at cap.
        double headroomPct = kp > 0 ? 100.0 * (kp - programsDelta) / kp : 0.0;
        if (headroomPct < 0) headroomPct = 0;

        // SwiftShader/CI verdict is STRUCTURAL-PASS, never PASS (§11.6 / §18 #9).
        string verdict = allPass ? "STRUCTURAL-PASS" : "STRUCTURAL-FAIL";

        return new VfxGaugeResult(
            Success: allPass,
            Reference: "holtburg",
            UniqueModels: uniqueModels,
            TotalPlacements: totalPlacements,
            DrawcallsDelta: drawcallsDelta,
            ProgramsDelta: programsDelta,
            VramMB: Math.Round(vramMB, 3),
            ParticleEmitters: particleEmitters,
            LightsDelta: lightsDelta,
            HeadroomPct: Math.Round(headroomPct, 1),
            WithinBudget: allPass,
            Verdict: verdict,
            TimingMeter: "N/A (SwiftShader/CI — timing gates G5–G7 are 1070-only, queued-for-1070)",
            ArchetypeBreakdown: perArchetype,
            Gates: gates,
            Error: null);
    }
}

// ── Result records (CommandResults.Vfx pattern — see build-spec §12.1) ──

/// <summary>Result of <c>vfx classify &lt;DID&gt;</c>.</summary>
public record VfxClassifyResult(
    bool Success,
    uint Did,
    string Archetype,
    List<WorldBuilder.Shared.Lib.VisualComponentRef> Components,
    double Confidence,
    string Source,
    string? Mech,
    List<WorldBuilder.Shared.Lib.VisualSignal> Signals,
    string? Error);

/// <summary>Result of <c>vfx emit-allowlist &lt;archetype&gt;</c>.</summary>
public record VfxEmitAllowlistResult(
    bool Success,
    string Archetype,
    uint[] Dids,
    bool SelectorOnly,
    string? Error);

/// <summary>
/// One cost-model row (<c>cost_model.jsonl</c>) — a VFX component scored on the
/// five §11.2/§11.3 cost axes. NO axis may scale with placement count
/// (<c>dCallsPerInstance</c>/<c>dProgramsPerDriver</c> that grow with placements
/// are a hard FAIL by the scaling invariant, §11.2).
/// </summary>
public sealed record VfxComponentCost {
    [System.Text.Json.Serialization.JsonPropertyName("id")] public string Id { get; init; } = "";
    [System.Text.Json.Serialization.JsonPropertyName("costClass")] public string? CostClass { get; init; }
    /// <summary>Program links added PER UNIQUE DRIVER (model×surface×patch-set), never per placement. The G1 axis.</summary>
    [System.Text.Json.Serialization.JsonPropertyName("dProgramsPerDriver")] public int DProgramsPerDriver { get; init; }
    /// <summary>Draw calls added per instance — MUST be 0 for non-particle effects (G2).</summary>
    [System.Text.Json.Serialization.JsonPropertyName("dCallsPerInstance")] public int DCallsPerInstance { get; init; }
    /// <summary>VRAM (MB) added per unique driver (G3); 0 for uniform-only effects.</summary>
    [System.Text.Json.Serialization.JsonPropertyName("dVramMB")] public double DVramMB { get; init; }
    /// <summary>Particle emitters added per driver (only the particle family is non-zero).</summary>
    [System.Text.Json.Serialization.JsonPropertyName("dParticleEmitters")] public int DParticleEmitters { get; init; }
    /// <summary>Lights ADDED per driver (the G4 axis). MUST be 0 for every effect — a light-count change forces a
    /// MeshStandard relink + frame freeze (THE RULE; the spell-freeze light-pool history). flameFlicker modulates
    /// an existing light's .intensity only, so this stays 0. Absent on legacy rows ⇒ deserializes to 0 (no churn).</summary>
    [System.Text.Json.Serialization.JsonPropertyName("dLightsPerDriver")] public int DLightsPerDriver { get; init; }
    /// <summary>ALU class estimate: none|low|medium|high (POM/heat-haze only).</summary>
    [System.Text.Json.Serialization.JsonPropertyName("dAluClass")] public string? DAluClass { get; init; }
    [System.Text.Json.Serialization.JsonPropertyName("mech")] public string? Mech { get; init; }
    [System.Text.Json.Serialization.JsonPropertyName("note")] public string? Note { get; init; }
}

/// <summary>One structural gate result (build-spec §11.6 G1–G4).</summary>
public sealed record VfxGaugeGate(string Id, string Name, bool Pass, string Detail);

/// <summary>
/// Result of <c>vfx gauge --ref holtburg</c> (Half-A static estimator). The
/// structural report (§11.6) + the verdict. On SwiftShader/CI the verdict is
/// <c>STRUCTURAL-PASS</c>, never <c>PASS</c> — the timing meter (Half-B, gates
/// G5–G7) is 1070-only and reported as N/A. <see cref="Success"/>/<see
/// cref="WithinBudget"/> are false when a structural gate trips (FAIL-fast).
/// </summary>
public sealed record VfxGaugeResult(
    bool Success,
    string Reference,
    int UniqueModels,
    int TotalPlacements,
    int DrawcallsDelta,
    int ProgramsDelta,
    double VramMB,
    int ParticleEmitters,
    int LightsDelta,
    double HeadroomPct,
    bool WithinBudget,
    string Verdict,
    string TimingMeter,
    Dictionary<string, int> ArchetypeBreakdown,
    List<VfxGaugeGate> Gates,
    string? Error) {

    /// <summary>A failed gauge (unknown ref / missing cost rows). Not within budget.</summary>
    public static VfxGaugeResult Failure(string reference, string error) => new(
        Success: false, Reference: reference, UniqueModels: 0, TotalPlacements: 0,
        DrawcallsDelta: 0, ProgramsDelta: 0, VramMB: 0, ParticleEmitters: 0, LightsDelta: 0,
        HeadroomPct: 0, WithinBudget: false, Verdict: "STRUCTURAL-FAIL",
        TimingMeter: "N/A (SwiftShader/CI — 1070-only)",
        ArchetypeBreakdown: new Dictionary<string, int>(), Gates: new List<VfxGaugeGate>(),
        Error: error);
}
