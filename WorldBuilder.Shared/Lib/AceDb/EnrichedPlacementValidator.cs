using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// E1 (wave-2) PR3 / E6 — OFFLINE validation gate for enriched placements (SPEC §6).
    ///
    /// Runs BEFORE any SQL emission / apply, using the in-memory <see cref="Lib.WeenieIndex"/>
    /// (persisted as <c>weenie_index.jsonl</c>) so NO live ACE DB is needed. Each check resolves a
    /// piece of enrichment against canonical wcid identity + ACE value domains:
    ///
    /// <list type="number">
    /// <item><b>wcid resolves</b> — the placement <c>WeenieClassId</c> and every
    /// <c>PlacementGenerator.WeenieClassId</c> (the spawn target) are in the index. Unknown = ERROR.</item>
    /// <item><b>setup exists</b> — the wcid has a Setup DID (renderable). Missing = WARNING.</item>
    /// <item><b>dye addressability</b> — <c>SubPaletteId</c>, when set, is a 0x04 Palette DID; else
    /// ERROR. <c>Shade</c> ∈ [0,1] or null; out of range = WARNING. <c>PaletteTemplate</c> ≥ 0 and
    /// &lt; ~256; out of range = WARNING (negative = surfaced specifically, the deferred PR2
    /// diagnostic).</item>
    /// <item><b>position keys</b> — every key is a defined <see cref="PositionType"/>; ephemeral keys
    /// (Home) for durable export = WARNING.</item>
    /// <item><b>generator sanity</b> — <c>InitCreate ≤ MaxCreate</c>; <c>WhenCreate</c>/
    /// <c>WhereCreate</c> are known flag combos.</item>
    /// </list>
    ///
    /// Errors BLOCK export unless <c>--force</c>; warnings never block. Output is a
    /// <c>validation_report.jsonl</c> sidecar — the SAME resolver E6 self-validation reuses.
    /// </summary>
    public static class EnrichedPlacementValidator {
        /// <summary>The 0x04 Palette DID range a real SubPaletteId must fall in (HARD CONSTRAINT 3).</summary>
        public const uint PaletteDidMin = 0x04000000u;
        public const uint PaletteDidMax = 0x04FFFFFFu;

        /// <summary>Plausible upper bound for the PaletteTemplate enum (~95 named values; allow headroom).</summary>
        public const int PaletteTemplateMaxPlausible = 256;

        /// <summary>RegenerationType valid-flag mask (Destruction|PickUp|Death = 0x7).</summary>
        public const uint RegenerationTypeMask = 0x7u;
        /// <summary>RegenLocationType valid-flag mask (OnTop..Treasure = 0x7F).</summary>
        public const uint RegenLocationTypeMask = 0x7Fu;

        /// <summary>Outdoor landblock edge length (metres); 8×8 cells of 24m each (F170 coherence check).</summary>
        public const float LandblockSizeMeters = 192f;
        /// <summary>Outdoor cell edge length (metres) — LandblockSizeMeters / 8 (F170 coherence check).</summary>
        public const float OutdoorCellSizeMeters = 24f;

        public enum Severity { Error, Warning }

        public sealed class Finding {
            public Severity Severity { get; init; }
            public string Code { get; init; } = "";
            public string Kind { get; init; } = "";      // placement Kind (outdoor/dungeon)
            public ushort Landblock { get; init; }
            public ushort CellNumber { get; init; }
            public uint WeenieClassId { get; init; }
            public uint? Guid { get; init; }
            public string Detail { get; init; } = "";
        }

        public sealed class ValidationReport {
            public IReadOnlyList<Finding> Findings { get; init; } = Array.Empty<Finding>();
            public int PlacementsChecked { get; init; }
            public int ErrorCount => Findings.Count(f => f.Severity == Severity.Error);
            public int WarningCount => Findings.Count(f => f.Severity == Severity.Warning);
            /// <summary>True when there are no errors (export may proceed without --force).</summary>
            public bool Ok => ErrorCount == 0;
        }

        /// <summary>
        /// Validate a set of enriched placements against the WeenieIndex. Pure / offline; no DB.
        /// When <paramref name="index"/> is empty, wcid-resolution checks are SKIPPED (the index was
        /// never ingested) and a single advisory warning is emitted — so an un-ingested project does
        /// not hard-fail a dry-run/file-emit export, but the operator is told resolution was not
        /// performed.
        ///
        /// <para>When <paramref name="applying"/> is true (a LIVE <c>--apply</c>), an empty index is a
        /// BLOCKING ERROR instead — a live world+shard write must not proceed with zero wcid/type
        /// resolution (the E6 resolver is the only offline guard against an unspawnable biota). The
        /// caller can still override with <c>--force</c>.</para>
        /// </summary>
        public static ValidationReport Validate(IEnumerable<EnrichedPlacement> placements, Lib.WeenieIndex index, bool applying = false) {
            var findings = new List<Finding>();
            bool resolveWcids = index != null && index.Count > 0;
            int checkedCount = 0;

            if (!resolveWcids) {
                if (applying) {
                    findings.Add(new Finding {
                        Severity = Severity.Error, Code = "index_not_ingested_for_apply", Kind = "", Detail =
                            "WeenieIndex is empty (not ingested) but --apply was requested — a live write must not " +
                            "skip wcid/WeenieType resolution. Run ingest-weenie-index first (or --force to override).",
                    });
                }
                else {
                    findings.Add(new Finding {
                        Severity = Severity.Warning, Code = "index_empty", Kind = "", Detail =
                            "WeenieIndex is empty (not ingested) — wcid resolution checks were skipped. " +
                            "Run ingest-weenie-index to enable the E6 resolver gate.",
                    });
                }
            }

            foreach (var p in placements) {
                checkedCount_Increment(ref checkedCount);

                void Add(Severity sev, string code, string detail) => findings.Add(new Finding {
                    Severity = sev, Code = code, Kind = p.Kind, Landblock = p.Landblock,
                    CellNumber = p.CellNumber, WeenieClassId = p.WeenieClassId, Guid = p.Guid, Detail = detail,
                });

                // 1/2. wcid resolves + setup exists (placement's own wcid).
                if (resolveWcids) {
                    var entry = index!.Get((int)p.WeenieClassId);
                    if (entry == null) {
                        Add(Severity.Error, "wcid_unresolved",
                            $"placement wcid {p.WeenieClassId} (0x{p.WeenieClassId:X8}) not found in WeenieIndex.");
                    }
                    else {
                        if (!index.TryGetSetup((int)p.WeenieClassId, out _)) {
                            Add(Severity.Warning, "wcid_no_setup",
                                $"placement wcid {p.WeenieClassId} has no Setup DID (not renderable).");
                        }
                        // Option B precondition: a per-placement biota override needs a non-Undef
                        // WeenieType, else CreateWorldObject(biota) returns null and the placement
                        // vanishes (WorldObjectFactory.cs:154-155). Block at the gate.
                        if (p.Scope == EnrichmentScope.PlacementOverride && entry.WeenieType == 0) {
                            Add(Severity.Error, "override_weenie_type_undef",
                                $"PlacementOverride wcid {p.WeenieClassId} resolves to WeenieType.Undef — an Undef biota " +
                                "stub produces a NULL WorldObject on load (the placement would vanish).");
                        }
                    }
                }

                // Option B static-range precondition: a declared override guid that is NOT in the
                // landblock's 0x70000xxx static window would never be read by the server
                // (ShardDatabase.GetStaticObjectsByLandblock). Surface as an ERROR at the gate so the
                // silent biota-emit skip is visible in the validation report (HARD CONSTRAINT 3).
                if (p.Scope == EnrichmentScope.PlacementOverride && p.Guid is { } og
                    && !StaticGuidAllocator.IsInLandblockStaticRange(p.Landblock, og)) {
                    Add(Severity.Error, "override_guid_out_of_static_range",
                        $"PlacementOverride guid 0x{og:X8} is outside landblock 0x{p.Landblock:X4}'s static range " +
                        $"(0x{StaticGuidAllocator.FirstStaticGuid(p.Landblock):X8}..0x{StaticGuidAllocator.MaxStaticGuid(p.Landblock):X8}); " +
                        "the server would not read this biota override.");
                }

                // F170: cell/origin coherence (outdoor only). The obj_Cell_Id low word is derived from
                // the origin: cellX = floor(originX / 24), cellY = floor(originY / 24), each in [0,7], so
                // cell = (cellX * 8 + cellY) + 1 must equal the supplied CellNumber. A defaulted
                // CellNumber:1 against an origin like (150,150) emits an inconsistent obj_Cell_Id and ACE
                // spawns at a cell/origin pair that disagree.
                if (p.Kind.Equals("outdoor", StringComparison.OrdinalIgnoreCase)
                    && p.CellNumber >= 1 && p.CellNumber <= 64
                    && float.IsFinite(p.OriginX) && float.IsFinite(p.OriginY)
                    && p.OriginX >= 0f && p.OriginX < LandblockSizeMeters
                    && p.OriginY >= 0f && p.OriginY < LandblockSizeMeters) {
                    int cellX = (int)(p.OriginX / OutdoorCellSizeMeters);
                    int cellY = (int)(p.OriginY / OutdoorCellSizeMeters);
                    int derivedCell = (cellX * 8 + cellY) + 1;
                    if (derivedCell != p.CellNumber) {
                        Add(Severity.Error, "cell_origin_incoherent",
                            $"CellNumber {p.CellNumber} disagrees with the origin-derived cell {derivedCell} " +
                            $"(origin ({p.OriginX.ToString(CultureInfo.InvariantCulture)}, {p.OriginY.ToString(CultureInfo.InvariantCulture)}) " +
                            $"→ cellX {cellX}, cellY {cellY}); the emitted obj_Cell_Id would be inconsistent.");
                    }
                }

                // 3. Dye addressability.
                if (p.Dye is { } dye) {
                    if (dye.SubPaletteId is { } sub && (sub < PaletteDidMin || sub > PaletteDidMax)) {
                        Add(Severity.Error, "dye_subpalette_not_did",
                            $"Dye.SubPaletteId 0x{sub:X8} is outside the 0x04 Palette DID range " +
                            $"(0x{PaletteDidMin:X8}..0x{PaletteDidMax:X8}) — it is an index, not an addressable remap.");
                    }
                    if (dye.Shade is { } sh && (sh < 0f || sh > 1f || !float.IsFinite(sh))) {
                        Add(Severity.Warning, "dye_shade_out_of_range",
                            $"Dye.Shade {sh.ToString(CultureInfo.InvariantCulture)} is outside [0,1].");
                    }
                    if (dye.PaletteTemplate is { } pt) {
                        if (pt < 0)
                            Add(Severity.Warning, "dye_palette_template_negative",
                                $"Dye.PaletteTemplate {pt} is negative — it will be CLAMPED to 0 on export (degenerate data).");
                        else if (pt >= PaletteTemplateMaxPlausible)
                            Add(Severity.Warning, "dye_palette_template_implausible",
                                $"Dye.PaletteTemplate {pt} is implausibly large (>= {PaletteTemplateMaxPlausible}); expected a small enum index.");
                    }
                }

                // 4. Position keys (every key is a defined PositionType; ephemeral keys are durable-export warnings).
                if (p.Positions is { } positions) {
                    foreach (var key in positions.Keys) {
                        if (!Enum.IsDefined(typeof(PositionType), key)) {
                            Add(Severity.Error, "position_key_undefined",
                                $"Positions key {(ushort)key} is not a defined PositionType.");
                        }
                        else if (key == PositionType.Home) {
                            Add(Severity.Warning, "position_key_ephemeral",
                                $"Positions key {key} is ephemeral in ACE; exporting it as a durable position may not round-trip at runtime.");
                        }
                    }
                }

                // 5. Generator sanity (+ spawn-target wcid resolves).
                if (p.Generators is { } gens) {
                    for (int gi = 0; gi < gens.Count; gi++) {
                        var g = gens[gi];
                        if (resolveWcids && index!.Get((int)g.WeenieClassId) == null) {
                            Add(Severity.Error, "generator_target_unresolved",
                                $"generator[{gi}] target wcid {g.WeenieClassId} (0x{g.WeenieClassId:X8}) not found in WeenieIndex.");
                        }
                        if (g.InitCreate > g.MaxCreate && g.MaxCreate != 0) {
                            Add(Severity.Warning, "generator_init_gt_max",
                                $"generator[{gi}] InitCreate {g.InitCreate} > MaxCreate {g.MaxCreate}.");
                        }
                        if ((g.WhenCreate & ~RegenerationTypeMask) != 0) {
                            Add(Severity.Warning, "generator_when_create_unknown",
                                $"generator[{gi}] WhenCreate 0x{g.WhenCreate:X} has bits outside the RegenerationType mask (0x{RegenerationTypeMask:X}).");
                        }
                        if ((g.WhereCreate & ~RegenLocationTypeMask) != 0) {
                            Add(Severity.Warning, "generator_where_create_unknown",
                                $"generator[{gi}] WhereCreate 0x{g.WhereCreate:X} has bits outside the RegenLocationType mask (0x{RegenLocationTypeMask:X}).");
                        }
                        if (g.PaletteTemplate is { } gpt) {
                            if (gpt < 0)
                                Add(Severity.Warning, "generator_palette_template_negative",
                                    $"generator[{gi}] PaletteTemplate {gpt} is negative — it will be CLAMPED to 0 on export (degenerate data).");
                            else if (gpt >= PaletteTemplateMaxPlausible)
                                Add(Severity.Warning, "generator_palette_template_implausible",
                                    $"generator[{gi}] PaletteTemplate {gpt} is implausibly large (>= {PaletteTemplateMaxPlausible}); expected a small enum index.");
                        }
                    }
                }
            }

            // Deterministic finding order so the report sidecar is byte-stable.
            var ordered = findings
                .OrderBy(f => f.Severity == Severity.Error ? 0 : 1)
                .ThenBy(f => f.Landblock)
                .ThenBy(f => f.CellNumber)
                .ThenBy(f => f.WeenieClassId)
                .ThenBy(f => f.Code, StringComparer.Ordinal)
                .ThenBy(f => f.Detail, StringComparer.Ordinal)
                .ToList();

            return new ValidationReport { Findings = ordered, PlacementsChecked = checkedCount };
        }

        private static void checkedCount_Increment(ref int n) => n++;

        /// <summary>
        /// Serialize the report to <c>validation_report.jsonl</c> text (one finding per line) and
        /// return it. A header line carries the summary counts.
        /// </summary>
        public static string SerializeReport(ValidationReport report) {
            var sb = new StringBuilder();
            sb.Append("{\"summary\":true,\"placementsChecked\":")
              .Append(report.PlacementsChecked.ToString(CultureInfo.InvariantCulture))
              .Append(",\"errors\":").Append(report.ErrorCount.ToString(CultureInfo.InvariantCulture))
              .Append(",\"warnings\":").Append(report.WarningCount.ToString(CultureInfo.InvariantCulture))
              .Append(",\"ok\":").Append(report.Ok ? "true" : "false").Append('}').Append('\n');
            foreach (var f in report.Findings) {
                sb.Append('{')
                  .Append("\"severity\":\"").Append(f.Severity == Severity.Error ? "error" : "warning").Append("\",")
                  .Append("\"code\":\"").Append(Esc(f.Code)).Append("\",")
                  .Append("\"kind\":\"").Append(Esc(f.Kind)).Append("\",")
                  .Append("\"landblock\":").Append(f.Landblock.ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"cellNumber\":").Append(f.CellNumber.ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"wcid\":").Append(f.WeenieClassId.ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"guid\":").Append((f.Guid ?? 0u).ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"detail\":\"").Append(Esc(f.Detail)).Append("\"")
                  .Append('}').Append('\n');
            }
            return sb.ToString();
        }

        /// <summary>Write the report to <c>validation_report.jsonl</c> under <paramref name="outDir"/>.</summary>
        public static string WriteReport(string outDir, ValidationReport report) {
            Directory.CreateDirectory(outDir);
            var path = Path.Combine(outDir, "validation_report.jsonl");
            File.WriteAllText(path, SerializeReport(report), new UTF8Encoding(false));
            return path;
        }

        private static string Esc(string s) =>
            s.Replace("\\", "\\\\").Replace("\"", "\\\"");
    }
}
