using System.Collections.Generic;
using System.IO;

namespace WorldBuilder.Shared.Lib.TexturePicker {
    /// <summary>
    /// A tiny hand-written <c>picker-recommendations.json</c> equivalent, used for Avalonia
    /// design-time preview and as a schema pin in tests. It exists so the panel can be reviewed when
    /// the real ranking output is not present (the picker data lives on a separate data volume,
    /// located at run time by <see cref="TexturePickerPaths"/>).
    ///
    /// Kept field-for-field in step with the REAL pipeline output — same <c>source</c> vocabulary
    /// ("ambientcg" / "polyhaven"), the same flatPreview/displayName/category/link/categoryTier
    /// members, and at least one null repeat axis, because "n/a" is a shape the panel has to render
    /// and a design-time fixture that never produces one hides the bug.
    ///
    /// The rsIds and assetIds here are real. The image paths are BUILT from the configured pool /
    /// retail roots rather than hard-coded, so a design-time run still resolves against whatever is
    /// actually on disk on this machine, and discloses nothing when nothing is configured: the roots
    /// then fall back to the neutral relative default, the images simply do not exist, and the panel
    /// takes the same "no preview" path an unmounted volume always took.
    /// </summary>
    public static class TexturePickerSampleData {
        /// <summary>
        /// Builds the fixture. Both roots are optional — null means "ask
        /// <see cref="TexturePickerPaths"/>", which is what every production caller does.
        /// </summary>
        /// <param name="poolRoot">CC0 preview pool root, holding <c>&lt;source&gt;/flat</c> and
        /// <c>&lt;source&gt;/thumbs</c>. Null uses <see cref="TexturePickerPaths.PoolRoot"/>.</param>
        /// <param name="retailRoot">Root of the extracted retail terrain PNGs. Null uses
        /// <see cref="TexturePickerPaths.RetailRoot"/>.</param>
        public static PickerRecommendations Build(string? poolRoot = null, string? retailRoot = null) {
            var pool = string.IsNullOrWhiteSpace(poolRoot) ? TexturePickerPaths.PoolRoot : poolRoot!;
            var retail = string.IsNullOrWhiteSpace(retailRoot) ? TexturePickerPaths.RetailRoot : retailRoot!;

            var acgFlat = Join(pool, CandidateImageResolver.SourceAmbientCg, "flat");
            var acgThumbs = Join(pool, CandidateImageResolver.SourceAmbientCg, "thumbs");
            var phFlat = Join(pool, CandidateImageResolver.SourcePolyHaven, "flat");
            var phThumbs = Join(pool, CandidateImageResolver.SourcePolyHaven, "thumbs");

            return new PickerRecommendations {
                Version = 1,
                Pool = "ambientcg-cc0 (sample)",
                GeneratedBy = "TexturePickerSampleData (hand-written design-time fixture)",
                Rows = new List<PickerRow> {
                    new() {
                        RsId = "0x06003CB9",
                        X2Rank = 1,
                        Placements = 69621,
                        WrapAxes = "X",
                        RetailPng = Join(retail, "0x06003CB9.png"),
                        PeriodEstimate = new PickerVec2(7.01, 22.0),
                        Candidates = new List<PickerCandidate> {
                            Candidate(acgFlat, acgThumbs, "Bricks068", "Bricks 068", "Bricks", 0.91, 0.94, 0.88, 0.90, 0.61, 2, 2),
                            Candidate(acgFlat, acgThumbs, "Bricks074", "Bricks 074", "Bricks", 0.87, 0.90, 0.85, 0.86, 0.58, 2, 2),
                            Candidate(acgFlat, acgThumbs, "Concrete040", "Concrete 040", "Concrete", 0.79, 0.71, 0.84, 0.82, 0.55, 1, 1),
                            // A candidate the pipeline could not settle the Y axis on — renders "n/a".
                            Candidate(acgFlat, acgThumbs, "Gravel032", "Gravel 032", "Gravel", 0.68, 0.60, 0.72, 0.74, 0.44, 4, null),
                            Candidate(acgFlat, acgThumbs, "Granite007A", "Granite 007 A", "Rock", 0.61, 0.66, 0.55, 0.62, 0.40, 1, 1),
                        },
                    },
                    new() {
                        RsId = "0x06003C25",
                        X2Rank = 2,
                        Placements = 41880,
                        WrapAxes = "XY",
                        RetailPng = Join(retail, "0x06003C25.png"),
                        PeriodEstimate = new PickerVec2(1, 1),
                        Candidates = new List<PickerCandidate> {
                            Candidate(acgFlat, acgThumbs, "Bricks091", "Bricks 091", "Bricks", 0.88, 0.85, 0.90, 0.89, 0.60, 1, 1),
                            Candidate(acgFlat, acgThumbs, "Bricks096", "Bricks 096", "Bricks", 0.82, 0.80, 0.83, 0.84, 0.57, 1, 1),
                            // PolyHaven — no local full-res set exists for ANY polyhaven asset, so this
                            // one exercises the "set not downloaded" / excluded-from-export path.
                            PolyHavenCandidate(phFlat, phThumbs, "plaster_brick_01", "Plaster Brick 01", "brick",
                                0.75, 0.75, 0.89, 0.48, 0.37, 0.467, 8.799),
                        },
                    },
                    new() {
                        RsId = "0x06003AED",
                        X2Rank = 3,
                        Placements = 22104,
                        WrapAxes = "-",
                        RetailPng = Join(retail, "0x06003AED.png"),
                        // A row whose Y period was never estimated.
                        PeriodEstimate = new PickerVec2(1, null),
                        Candidates = new List<PickerCandidate> {
                            Candidate(acgFlat, acgThumbs, "Bricks076A", "Bricks 076 A", "Bricks", 0.72, 0.70, 0.74, 0.71, 0.50, null, null),
                            Candidate(acgFlat, acgThumbs, "Bricks099", "Bricks 099", "Bricks", 0.64, 0.62, 0.66, 0.65, 0.47, 1, 1),
                        },
                    },
                },
            };
        }

        /// <summary>
        /// Path join that tolerates a caller-supplied root of any shape. Nothing here is ever
        /// rooted at a compile-time constant, so an empty/whitespace root yields a plain relative
        /// path rather than throwing.
        /// </summary>
        private static string Join(string root, params string[] parts) {
            var acc = string.IsNullOrWhiteSpace(root) ? "" : root;
            foreach (var part in parts) {
                acc = acc.Length == 0 ? part : Path.Combine(acc, part);
            }
            return acc;
        }

        private static PickerCandidate Candidate(
            string flatRoot, string thumbRoot,
            string assetId, string displayName, string category,
            double score, double hue, double orient, double period, double busy,
            double? repeatX, double? repeatY) => new() {
                AssetId = assetId,
                Source = CandidateImageResolver.SourceAmbientCg,
                CategoryTier = 0,
                Thumb = Join(thumbRoot, $"{assetId}.png"),
                FlatPreview = Join(flatRoot, $"{assetId}.jpg"),
                DisplayName = displayName,
                Category = category,
                Link = $"https://ambientcg.com/view?id={assetId}",
                Score = score,
                Sub = new PickerSubScores { Hue = hue, Orient = orient, Period = period, Busy = busy },
                RepeatFactor = new PickerVec2(repeatX, repeatY),
            };

        private static PickerCandidate PolyHavenCandidate(
            string flatRoot, string thumbRoot,
            string assetId, string displayName, string category,
            double score, double hue, double orient, double period, double busy,
            double? repeatX, double? repeatY) => new() {
                AssetId = assetId,
                Source = CandidateImageResolver.SourcePolyHaven,
                CategoryTier = 0,
                Thumb = Join(thumbRoot, $"{assetId}.png"),
                FlatPreview = Join(flatRoot, $"{assetId}.jpg"),
                DisplayName = displayName,
                Category = category,
                Link = $"https://polyhaven.com/a/{assetId}",
                Score = score,
                Sub = new PickerSubScores { Hue = hue, Orient = orient, Period = period, Busy = busy },
                RepeatFactor = new PickerVec2(repeatX, repeatY),
            };
    }
}
