using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Linq;
using System.Text;

using WorldBuilder.Shared.Models;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// E1 (wave-2) PR3 — Option B (per-PLACEMENT) SHARD-DB biota override SQL generator.
    ///
    /// Consumes the set of <see cref="EnrichedPlacement"/> records and produces the per-table
    /// SHARD <c>biota</c> + <c>biota_properties_*</c> SQL via <see cref="AceDbConnector"/>'s biota
    /// emitters, resolving the per-PLACEMENT (biota-level) boundary:
    ///
    /// <list type="number">
    /// <item>Only placements with <see cref="EnrichmentScope.PlacementOverride"/> are emitted here.
    /// <see cref="EnrichmentScope.ClassDefault"/> is the PR2 world path (<see cref="EnrichmentSqlExporter"/>)
    /// — they are NEVER crossed (HARD CONSTRAINT 3).</item>
    /// <item>Each override is keyed by the placement GUID (<c>biota.id == landblock_instance.guid</c>).
    /// A placement that arrives WITHOUT a guid gets one MINTED in the canonical static range
    /// (<see cref="StaticGuidAllocator"/>, <c>0x70000xxx</c>) so the override is addressable and the
    /// server will actually read it (SPEC §2.4). A guid that is already present but OUT of the static
    /// range is RECORDED as a warning (it would be a silent no-op on the server) and SKIPPED.</item>
    /// </list>
    ///
    /// <para>Determinism (golden stability): placements are processed by allocated guid ascending;
    /// within generator the profile list order is preserved; within positions the keys are ascending
    /// by <see cref="PositionType"/> ushort.</para>
    ///
    /// <para>NO LIVE DB: <see cref="WriteFiles"/> is a pure file-emit (same contract as the PR2
    /// exporter) — it writes per-table <c>.sql</c> + a manifest and never opens a connection.</para>
    /// </summary>
    public static class BiotaEnrichmentSqlExporter {
        /// <summary>One generated per-table shard artifact.</summary>
        public sealed class BiotaSqlTable {
            public string Table { get; init; } = "";
            public string FileName { get; init; } = "";
            public string Sql { get; init; } = "";
            /// <summary>Number of biotas (placements) contributing rows to this table.</summary>
            public int BiotaCount { get; init; }
        }

        /// <summary>A diagnostic surfaced during biota export (non-fatal).</summary>
        public sealed class BiotaWarning {
            public uint? Guid { get; init; }
            public uint WeenieClassId { get; init; }
            public string Kind { get; init; } = "";
            public string Detail { get; init; } = "";
        }

        /// <summary>The full set of generated per-placement biota artifacts + diagnostics.</summary>
        public sealed class BiotaSqlBundle {
            public BiotaSqlTable? Biota { get; init; }
            public BiotaSqlTable? Palette { get; init; }
            public BiotaSqlTable? Generator { get; init; }
            public BiotaSqlTable? Position { get; init; }
            public BiotaSqlTable? Int { get; init; }
            public BiotaSqlTable? Float { get; init; }

            /// <summary>
            /// Per-placement guid assignments actually used (after threading/minting), keyed by the
            /// placement's stable key. Lets the re-import / round-trip path recover the guid that was
            /// written even when the placement arrived without one.
            /// </summary>
            public IReadOnlyList<BiotaGuidAssignment> Assignments { get; init; }
                = Array.Empty<BiotaGuidAssignment>();

            /// <summary>Diagnostics: out-of-static-range guids skipped, negative PaletteTemplate clamps, etc.</summary>
            public IReadOnlyList<BiotaWarning> Warnings { get; init; } = Array.Empty<BiotaWarning>();

            /// <summary>Count of PlacementOverride placements that were skipped (bad guid).</summary>
            public int Skipped { get; init; }

            public IEnumerable<BiotaSqlTable> Tables {
                get {
                    if (Biota != null) yield return Biota;
                    if (Palette != null) yield return Palette;
                    if (Generator != null) yield return Generator;
                    if (Position != null) yield return Position;
                    if (Int != null) yield return Int;
                    if (Float != null) yield return Float;
                }
            }

            public bool HasAny => Tables.Any();
        }

        /// <summary>Records the guid a single placement override was written under.</summary>
        public sealed class BiotaGuidAssignment {
            public string Kind { get; init; } = "";
            public ushort Landblock { get; init; }
            public ushort CellNumber { get; init; }
            public uint WeenieClassId { get; init; }
            public uint Guid { get; init; }
            /// <summary>True when the guid was minted here (the placement arrived with no guid).</summary>
            public bool Minted { get; init; }
        }

        // ── A resolved per-placement override (guid + its enrichment facets) ──

        private sealed class ResolvedBiota {
            public uint Guid;
            public uint WeenieClassId;
            public int WeenieType;
            public ushort Landblock;
            public ushort CellNumber;
            public string Kind = "";
            public bool Minted;
            public EnrichedPlacement Source = default!;
            public PlacementDye? Dye;
            public List<PlacementGenerator>? Generators;
            public Dictionary<PositionType, PlacementPosition>? Positions;
        }

        /// <summary>
        /// Build the per-placement biota override bundle from the enriched placements. Threads /
        /// mints guids in the static range, AND writes each resolved guid back onto its source
        /// <see cref="EnrichedPlacement.Guid"/> so the minted key is stable and persistable
        /// (the JSONL written after this call records the real guid). Pure in-memory; no DB.
        ///
        /// <para><paramref name="index"/> resolves the real ACE <c>WeenieType</c> for each override's
        /// wcid — REQUIRED because an Undef (type 0) biota produces a NULL WorldObject on load (the
        /// placement would vanish). When the index is empty or the wcid is unresolved, the override is
        /// SKIPPED with a warning (an unspawnable biota must not reach the SQL).</para>
        /// </summary>
        public static BiotaSqlBundle Build(IEnumerable<EnrichedPlacement> placements, Lib.WeenieIndex? index = null) {
            var warnings = new List<BiotaWarning>();
            var assignments = new List<BiotaGuidAssignment>();
            int skipped = 0;
            bool canResolveType = index != null && index.Count > 0;

            // Per-landblock guid allocator state, seeded with any explicit guids already in use so a
            // mint never collides with a hand-assigned override.
            var usedByLandblock = new Dictionary<ushort, HashSet<uint>>();
            HashSet<uint> Used(ushort lb) =>
                usedByLandblock.TryGetValue(lb, out var s) ? s : (usedByLandblock[lb] = new HashSet<uint>());

            // First pass: reserve every explicit, in-range guid so minting fills the gaps around them.
            foreach (var p in placements) {
                if (p.Scope != EnrichmentScope.PlacementOverride) continue;
                if (!HasEnrichment(p)) continue;
                if (p.Guid is { } g && StaticGuidAllocator.IsInLandblockStaticRange(p.Landblock, g))
                    Used(p.Landblock).Add(g);
            }

            var resolved = new List<ResolvedBiota>();
            foreach (var p in placements) {
                if (p.Scope != EnrichmentScope.PlacementOverride) continue;
                if (!HasEnrichment(p)) continue;

                uint guid;
                bool minted = false;
                if (p.Guid is { } existing) {
                    if (!StaticGuidAllocator.IsInLandblockStaticRange(p.Landblock, existing)) {
                        // An override guid outside its landblock's static window would never be read by
                        // the server (ShardDatabase.GetStaticObjectsByLandblock). Surface + skip — do
                        // NOT silently write an unreachable biota (HARD CONSTRAINT 3).
                        warnings.Add(new BiotaWarning {
                            Guid = existing, WeenieClassId = p.WeenieClassId, Kind = "guid_out_of_static_range",
                            Detail = $"placement guid 0x{existing:X8} is not in landblock 0x{p.Landblock:X4}'s static range " +
                                     $"(0x{StaticGuidAllocator.FirstStaticGuid(p.Landblock):X8}..0x{StaticGuidAllocator.MaxStaticGuid(p.Landblock):X8}); " +
                                     "the server would not read this biota override — skipped.",
                        });
                        skipped++;
                        continue;
                    }
                    guid = existing;
                }
                else {
                    guid = StaticGuidAllocator.Allocate(p.Landblock, Used(p.Landblock));
                    minted = true;
                }

                // Resolve the real, non-Undef WeenieType. An Undef (0) stub yields a NULL WorldObject
                // on load (WorldObjectFactory.cs:154-155); BiotaConverter does NOT reconcile from the
                // weenie. Without a resolvable type the override is unspawnable → SKIP with a warning
                // rather than emit a biota that silently vanishes on the server.
                int weenieType;
                if (canResolveType) {
                    var entry = index!.Get((int)p.WeenieClassId);
                    if (entry == null || entry.WeenieType == 0) {
                        warnings.Add(new BiotaWarning {
                            Guid = guid, WeenieClassId = p.WeenieClassId, Kind = "weenie_type_unresolved",
                            Detail = $"wcid {p.WeenieClassId} has no non-Undef WeenieType in the WeenieIndex; " +
                                     "an Undef biota stub produces a NULL WorldObject on load (the placement would vanish) — skipped.",
                        });
                        skipped++;
                        continue;
                    }
                    weenieType = entry.WeenieType;
                }
                else {
                    // No index ingested. We cannot certify a non-Undef type. Surface a warning and
                    // SKIP — emitting an Undef stub would be a silent no-op on a live server. (The
                    // E6 validation gate + the apply gate also block this case, but defend here too.)
                    warnings.Add(new BiotaWarning {
                        Guid = guid, WeenieClassId = p.WeenieClassId, Kind = "weenie_index_not_ingested",
                        Detail = $"WeenieIndex not ingested — cannot resolve a non-Undef WeenieType for wcid {p.WeenieClassId}; " +
                                 "biota override skipped (run ingest-weenie-index before emitting Option B).",
                    });
                    skipped++;
                    continue;
                }

                // Persist the resolved guid back onto the SOURCE placement so the addressable key is
                // stable across export round-trips (the JSONL written after Build records this guid,
                // and the world landblock_instance row is generated from the same guid).
                p.Guid = guid;

                // Negative-PaletteTemplate DIAGNOSTIC (the degenerate-data masking deferred from PR2).
                // The emitter clamps a negative PaletteTemplate to 0 (ACE's palette_Id is uint?), which
                // silently masks bad upstream data. Surface a warning so it is visible.
                if (p.Generators != null) {
                    foreach (var gen in p.Generators) {
                        if (gen.PaletteTemplate is { } pt && pt < 0) {
                            warnings.Add(new BiotaWarning {
                                Guid = guid, WeenieClassId = p.WeenieClassId, Kind = "negative_palette_template_clamped",
                                Detail = $"generator PaletteTemplate {pt} clamped to 0 (ACE palette_Id is uint?) " +
                                         $"on biota 0x{guid:X8} (target wcid {gen.WeenieClassId}).",
                            });
                        }
                    }
                }

                resolved.Add(new ResolvedBiota {
                    Guid = guid, WeenieClassId = p.WeenieClassId, WeenieType = weenieType,
                    Landblock = p.Landblock, CellNumber = p.CellNumber, Kind = p.Kind, Minted = minted,
                    Source = p, Dye = p.Dye, Generators = p.Generators, Positions = p.Positions,
                });
            }

            // Determinism: order by allocated guid ascending.
            resolved.Sort((a, b) => a.Guid.CompareTo(b.Guid));

            var biotaBlocks = new List<(uint, string)>();
            var paletteBlocks = new List<(uint, string)>();
            var generatorBlocks = new List<(uint, string)>();
            var positionBlocks = new List<(uint, string)>();
            var intBlocks = new List<(uint, string)>();
            var floatBlocks = new List<(uint, string)>();

            foreach (var r in resolved) {
                biotaBlocks.Add((r.Guid, AceDbConnector.GenerateBiotaStubSql(r.Guid, r.WeenieClassId, r.WeenieType)));

                if (r.Dye != null) {
                    var pal = AceDbConnector.GenerateBiotaPaletteSql(r.Guid, r.Dye);
                    if (pal != null) paletteBlocks.Add((r.Guid, pal));
                    var i = AceDbConnector.GenerateBiotaPaletteTemplateIntSql(r.Guid, r.Dye);
                    if (i != null) intBlocks.Add((r.Guid, i));
                    var f = AceDbConnector.GenerateBiotaShadeFloatSql(r.Guid, r.Dye);
                    if (f != null) floatBlocks.Add((r.Guid, f));
                }
                if (r.Generators != null && r.Generators.Count > 0) {
                    var s = AceDbConnector.GenerateBiotaGeneratorSql(r.Guid, r.Generators);
                    if (s != null) generatorBlocks.Add((r.Guid, s));
                }
                if (r.Positions != null && r.Positions.Count > 0) {
                    var s = AceDbConnector.GenerateBiotaPositionSql(r.Guid, r.Positions);
                    if (s != null) positionBlocks.Add((r.Guid, s));
                }

                assignments.Add(new BiotaGuidAssignment {
                    Kind = r.Kind, Landblock = r.Landblock, CellNumber = r.CellNumber,
                    WeenieClassId = r.WeenieClassId, Guid = r.Guid, Minted = r.Minted,
                });
            }

            // Warnings sorted deterministically (guid, kind) so the manifest is byte-stable.
            var sortedWarnings = warnings
                .OrderBy(w => w.Guid ?? 0u)
                .ThenBy(w => w.Kind, StringComparer.Ordinal)
                .ThenBy(w => w.WeenieClassId)
                .ToList();

            return new BiotaSqlBundle {
                Biota = Assemble("biota", AceDbConnector.BiotaSqlFileName, biotaBlocks),
                Palette = Assemble("biota_properties_palette", AceDbConnector.BiotaPaletteSqlFileName, paletteBlocks),
                Generator = Assemble("biota_properties_generator", AceDbConnector.BiotaGeneratorSqlFileName, generatorBlocks),
                Position = Assemble("biota_properties_position", AceDbConnector.BiotaPositionSqlFileName, positionBlocks),
                Int = Assemble("biota_properties_int", AceDbConnector.BiotaIntSqlFileName, intBlocks),
                Float = Assemble("biota_properties_float", AceDbConnector.BiotaFloatSqlFileName, floatBlocks),
                Assignments = assignments,
                Warnings = sortedWarnings,
                Skipped = skipped,
            };
        }

        /// <summary>
        /// Build the bundle and WRITE each non-empty table to <paramref name="outDir"/> as
        /// <c>biota*.sql</c>, plus a <c>biota_manifest.json</c>. NEVER touches a live DB. Returns the
        /// bundle and written paths.
        /// </summary>
        public static (BiotaSqlBundle Bundle, List<string> WrittenPaths, string ManifestPath) WriteFiles(
            string outDir, IEnumerable<EnrichedPlacement> placements, Lib.WeenieIndex? index = null) {
            Directory.CreateDirectory(outDir);
            var bundle = Build(placements, index);

            var written = new List<string>();
            var enc = new UTF8Encoding(false);
            foreach (var t in bundle.Tables) {
                var path = Path.Combine(outDir, t.FileName);
                File.WriteAllText(path, t.Sql, enc);
                written.Add(path);
            }

            var manifestPath = Path.Combine(outDir, "biota_manifest.json");
            File.WriteAllText(manifestPath, BuildManifestJson(bundle), enc);

            return (bundle, written, manifestPath);
        }

        // ── Manifest (deterministic, no DB) ─────────────────────────────────

        private static string BuildManifestJson(BiotaSqlBundle bundle) {
            var sb = new StringBuilder();
            sb.Append('{');
            sb.Append("\"scope\":\"PlacementOverride\",");
            sb.Append("\"db\":\"shard\",");
            sb.Append("\"tables\":[");
            bool first = true;
            foreach (var t in bundle.Tables) {
                if (!first) sb.Append(',');
                first = false;
                sb.Append('{')
                  .Append("\"table\":\"").Append(Esc(t.Table)).Append("\",")
                  .Append("\"file\":\"").Append(Esc(t.FileName)).Append("\",")
                  .Append("\"biotaCount\":").Append(t.BiotaCount.ToString(CultureInfo.InvariantCulture))
                  .Append('}');
            }
            sb.Append("],");
            sb.Append("\"assignments\":[");
            for (int i = 0; i < bundle.Assignments.Count; i++) {
                if (i > 0) sb.Append(',');
                var a = bundle.Assignments[i];
                sb.Append('{')
                  .Append("\"kind\":\"").Append(Esc(a.Kind)).Append("\",")
                  .Append("\"landblock\":").Append(a.Landblock.ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"cellNumber\":").Append(a.CellNumber.ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"wcid\":").Append(a.WeenieClassId.ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"guid\":").Append(a.Guid.ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"minted\":").Append(a.Minted ? "true" : "false")
                  .Append('}');
            }
            sb.Append("],");
            sb.Append("\"warnings\":[");
            for (int i = 0; i < bundle.Warnings.Count; i++) {
                if (i > 0) sb.Append(',');
                var w = bundle.Warnings[i];
                sb.Append('{')
                  .Append("\"guid\":").Append((w.Guid ?? 0u).ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"wcid\":").Append(w.WeenieClassId.ToString(CultureInfo.InvariantCulture)).Append(',')
                  .Append("\"kind\":\"").Append(Esc(w.Kind)).Append("\",")
                  .Append("\"detail\":\"").Append(Esc(w.Detail)).Append("\"")
                  .Append('}');
            }
            sb.Append("],");
            sb.Append("\"skipped\":").Append(bundle.Skipped.ToString(CultureInfo.InvariantCulture));
            sb.Append('}');
            return sb.ToString();
        }

        private static string Esc(string s) => s.Replace("\\", "\\\\").Replace("\"", "\\\"");

        // ── Internals ───────────────────────────────────────────────────────

        private static bool HasEnrichment(EnrichedPlacement p) =>
            (p.Dye != null && (p.Dye.SubPaletteId.HasValue || p.Dye.PaletteTemplate.HasValue || p.Dye.Shade.HasValue))
            || (p.Generators != null && p.Generators.Count > 0)
            || (p.Positions != null && p.Positions.Count > 0);

        private static BiotaSqlTable? Assemble(string table, string fileName, List<(uint Guid, string Sql)> blocks) {
            if (blocks.Count == 0) return null;
            var sb = new StringBuilder();
            sb.Append("-- ACME WorldBuilder E1: ").Append(table).Append(" (per-placement biota override, Option B / shard)").Append('\n');
            sb.Append("-- ").Append(blocks.Count.ToString(CultureInfo.InvariantCulture)).Append(" biota(s)").Append('\n');
            sb.Append('\n');
            for (int i = 0; i < blocks.Count; i++) {
                sb.Append(blocks[i].Sql);
                sb.Append('\n');
            }
            return new BiotaSqlTable {
                Table = table,
                FileName = fileName,
                Sql = sb.ToString(),
                BiotaCount = blocks.Count,
            };
        }
    }
}
