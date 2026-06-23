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
