using DatReaderWriter.DBObjs;
using System;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Dungeon;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using WorldBuilder.Lib;
using SharedAnalyzer = WorldBuilder.Shared.Lib.Dungeon.DungeonRoomAnalyzer;

namespace WorldBuilder.Editors.Dungeon {

    /// <summary>
    /// UI-layer wrapper for the shared DungeonRoomAnalyzer.
    /// Provides the LocationDatabase-based dungeon name resolver that the
    /// shared layer doesn't depend on.
    /// </summary>
    public static class DungeonRoomAnalyzer {

        /// <summary>
        /// Run analysis on the DAT, resolving dungeon names from the UI-embedded LocationDatabase.
        /// Delegates all scanning logic to the shared DungeonRoomAnalyzer.
        /// </summary>
        public static SharedAnalyzer.AnalysisReport Run(IDatReaderWriter dats) {
            return SharedAnalyzer.Run(dats, ResolveDungeonNames);
        }

        /// <summary>
        /// Save report to JSON and a human-readable summary.
        /// </summary>
        public static void SaveReport(SharedAnalyzer.AnalysisReport report, string outputPath) {
            SharedAnalyzer.SaveReport(report, outputPath);
        }

        public static string FormatSummary(SharedAnalyzer.AnalysisReport report) {
            return SharedAnalyzer.FormatSummary(report);
        }

        /// <summary>
        /// Resolve landblock IDs to dungeon names from LocationDatabase.
        /// This is the UI-specific dependency that we inject into the shared analyzer.
        /// </summary>
        private static List<string> ResolveDungeonNames(List<ushort> landblockIds) {
            var names = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
            foreach (var lbId in landblockIds) {
                var matches = LocationDatabase.Dungeons
                    .Where(e => e.LandblockId == lbId)
                    .Select(e => e.Name.Trim())
                    .Where(n => !string.IsNullOrEmpty(n));
                foreach (var name in matches.Take(2)) names.Add(name);
            }
            return names.OrderBy(n => n).ToList();
        }
    }
}

