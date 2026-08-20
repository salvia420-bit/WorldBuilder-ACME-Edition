using System;
using System.Collections.Generic;
using System.IO;
using AcmeRedline.Lib;
using AcmeRedline.Model;
using Microsoft.Extensions.Logging;

namespace AcmeRedline.Services {
    /// <summary>
    /// Reads the optional <c>acme-meta.json</c> sidecar that the ACME kit builder ships alongside
    /// the dats, and answers two questions for the rest of the plugin:
    ///
    ///   (a) WHICH RELEASE is this reporter running? -> <see cref="BuildClientRelease"/>, stamped
    ///       onto every queue entry so the pipeline can reproduce what the reporter saw.
    ///   (b) IS THIS SELECTION DANGEROUS? -> <see cref="EvaluateGuards"/>, so the panel can warn
    ///       at capture time when the picked RenderSurfaces are terrain-protected or reached
    ///       through a palette route.
    ///
    /// The sidecar is optional. On a vanilla install it is absent and every field comes back null;
    /// nothing here throws or blocks a report.
    /// </summary>
    public sealed class KitMeta {
        public const string FileName = "acme-meta.json";

        private readonly ILogger _log;
        private readonly HashSet<uint> _terrainProtected = [];
        private readonly HashSet<uint> _paletteRoute = [];

        /// <summary>The parsed sidecar, or null when none was found / it was malformed.</summary>
        public AcmeMeta? Meta { get; private set; }

        /// <summary>Where the sidecar was loaded from, for logging and for the panel's footer.</summary>
        public string? LoadedFrom { get; private set; }

        public KitMeta(ILogger log) {
            _log = log;
        }

        /// <summary>
        /// Load the sidecar.
        ///
        /// <paramref name="explicitPath"/> wins when set. Otherwise probe, in order:
        ///   the directory of each dat the client has open, then the plugin's own directory.
        /// Chorizite does not publish the dat directory as a path - IDatReaderInterface
        /// (external/chorizite/Chorizite/Chorizite.Core/Dats/IDatReaderInterface.cs) exposes
        /// PortalDatabase/CellDatabase objects, not filenames - so callers pass the candidate
        /// directories in. See <see cref="AcmeRedline.AcmeRedlinePlugin"/> for what it passes.
        /// </summary>
        public void Load(string? explicitPath, IEnumerable<string> candidateDirs) {
            Meta = null;
            LoadedFrom = null;
            _terrainProtected.Clear();
            _paletteRoute.Clear();

            foreach (var path in Candidates(explicitPath, candidateDirs)) {
                try {
                    if (!File.Exists(path)) continue;
                    var parsed = RedlineJson.MetaFromJson(File.ReadAllText(path));
                    if (parsed is null) {
                        _log.LogWarning("redline: {Path} is not valid acme-meta.json; ignoring", path);
                        continue;
                    }
                    Meta = parsed;
                    LoadedFrom = path;
                    foreach (var s in parsed.TerrainProtectedRs) {
                        var id = Hex.Parse(s);
                        if (id != 0) _terrainProtected.Add(id);
                    }
                    foreach (var s in parsed.PaletteRouteRs) {
                        var id = Hex.Parse(s);
                        if (id != 0) _paletteRoute.Add(id);
                    }
                    _log.LogInformation("redline: kit meta {Tag} loaded from {Path} " +
                                        "({Terrain} terrain-protected, {Palette} palette-routed)",
                                        parsed.KitTag, path, _terrainProtected.Count, _paletteRoute.Count);
                    return;
                }
                catch (Exception ex) {
                    _log.LogDebug(ex, "redline: could not read {Path}", path);
                }
            }

            _log.LogInformation("redline: no {File} found; entries will carry a null clientRelease", FileName);
        }

        private static IEnumerable<string> Candidates(string? explicitPath, IEnumerable<string> dirs) {
            if (!string.IsNullOrWhiteSpace(explicitPath)) yield return explicitPath!;
            foreach (var d in dirs) {
                if (string.IsNullOrWhiteSpace(d)) continue;
                yield return Path.Combine(d, FileName);
            }
        }

        /// <summary>
        /// The clientRelease block for a queue entry. Always non-null so the schema shape is
        /// stable; its members are null when no sidecar was found.
        /// </summary>
        public ClientRelease BuildClientRelease() => new() {
            KitTag = Meta?.KitTag,
            PortalSha256 = Meta?.PortalSha256,
            HighresSha256 = Meta?.HighresSha256,
        };

        /// <summary>True when the sidecar marks this RenderSurface as terrain-protected.</summary>
        public bool IsTerrainProtected(uint renderSurfaceId) => _terrainProtected.Contains(renderSurfaceId);

        /// <summary>True when the sidecar marks this RenderSurface as palette-routed.</summary>
        public bool IsPaletteRoute(uint renderSurfaceId) => _paletteRoute.Contains(renderSurfaceId);

        /// <summary>
        /// Evaluate the guards for a whole selection. A guard trips if ANY selected RenderSurface
        /// is flagged - the pipeline needs to know the report touches protected pixels at all,
        /// not how many.
        /// </summary>
        public Guards EvaluateGuards(SelectionSet selection) {
            var g = new Guards();
            foreach (var rsId in selection.Surfaces.Keys) {
                if (IsTerrainProtected(rsId)) g.TerrainProtected = true;
                if (IsPaletteRoute(rsId)) g.PaletteRoute = true;
            }
            return g;
        }

        /// <summary>
        /// Human-readable warning for the panel, or null when the selection is clean.
        /// Shown BEFORE submit, which is the whole point of (b) above.
        /// </summary>
        public string? WarningFor(SelectionSet selection) {
            var g = EvaluateGuards(selection);
            if (!g.TerrainProtected && !g.PaletteRoute) return null;
            if (g.TerrainProtected && g.PaletteRoute)
                return "Heads up: this selection touches a terrain-protected AND palette-routed surface. " +
                       "The fix may need to go through the terrain atlas and the palette route, not a direct repaint.";
            if (g.TerrainProtected)
                return "Heads up: this selection touches a terrain-protected surface. " +
                       "Repainting it changes the landscape atlas, not just this object.";
            return "Heads up: this selection touches a palette-routed surface. " +
                   "Its on-screen colour comes from a palette shift, so the dat pixels are not the colour you see.";
        }
    }
}
