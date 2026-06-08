using System.Collections.Generic;

namespace WorldBuilder.Shared.Lib.AceDb {
    /// <summary>
    /// E1 (wave-2) PR3 — the pure, DB-free plan for a live <c>--apply</c>: which SQL scripts go to
    /// the WORLD connection and which go to the SHARD connection, kept SEPARATE so the two are never
    /// crossed (HARD CONSTRAINT 3). Assembling this is side-effect-free, so the routing can be
    /// asserted in tests WITHOUT opening any database — the only DB-touching step is handing each
    /// list to the matching connector's
    /// <see cref="AceDbConnector.ExecuteScriptsTransactionalAsync"/> (verified live separately).
    /// </summary>
    public static class EnrichmentApplyPlan {
        public sealed class Plan {
            /// <summary>Placement rows + per-class (Option A) enrichment — apply to the WORLD DB.</summary>
            public List<string?> WorldScripts { get; } = new();
            /// <summary>Per-placement (Option B) biota override — apply to the SHARD DB.</summary>
            public List<string?> ShardScripts { get; } = new();
            /// <summary>True when there is at least one Option B biota script (a shard connection is required).</summary>
            public bool RequiresShard => ShardScripts.Count > 0;
        }

        /// <summary>
        /// Build the world/shard apply plan from the already-generated placement SQL + the two
        /// enrichment bundles. Pure: no IO, no DB. The WORLD list carries the placement directive SQL
        /// (landblock_instance) plus every per-class <c>weenie_properties_*</c> table; the SHARD list
        /// carries every <c>biota*</c> table. Empty/null inputs are simply omitted.
        /// </summary>
        public static Plan Build(
            string? outdoorSql, int outdoorCount,
            string? dungeonSql, int dungeonCount,
            EnrichmentSqlExporter.EnrichmentSqlBundle worldBundle,
            BiotaEnrichmentSqlExporter.BiotaSqlBundle shardBundle) {
            var plan = new Plan();

            if (outdoorCount > 0 && !string.IsNullOrWhiteSpace(outdoorSql)) plan.WorldScripts.Add(outdoorSql);
            if (dungeonCount > 0 && !string.IsNullOrWhiteSpace(dungeonSql)) plan.WorldScripts.Add(dungeonSql);
            foreach (var t in worldBundle.Tables) plan.WorldScripts.Add(t.Sql);

            foreach (var t in shardBundle.Tables) plan.ShardScripts.Add(t.Sql);

            return plan;
        }
    }
}
