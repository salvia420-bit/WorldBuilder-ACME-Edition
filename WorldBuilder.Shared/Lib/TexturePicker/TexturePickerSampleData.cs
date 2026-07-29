using System.Collections.Generic;

namespace WorldBuilder.Shared.Lib.TexturePicker {
    /// <summary>
    /// A tiny hand-written <c>picker-recommendations.json</c> equivalent, used for Avalonia
    /// design-time preview and as a schema pin in tests. It exists so the panel can be reviewed when
    /// the real ranking output is not mounted (the picker data lives on /mnt/wbterminal2).
    ///
    /// Kept field-for-field in step with the REAL pipeline output — same <c>source</c> vocabulary
    /// ("ambientcg" / "polyhaven"), the same flatPreview/displayName/category/link/categoryTier
    /// members, and at least one null repeat axis, because "n/a" is a shape the panel has to render
    /// and a design-time fixture that never produces one hides the bug.
    ///
    /// The rsIds / assetIds / paths here are real, so a design-time run resolves against whatever is
    /// actually on disk.
    /// </summary>
    public static class TexturePickerSampleData {
        private const string FlatRoot = "/mnt/wbterminal2/pbr-terrain/cc0-pool/ambientcg/flat";
        private const string ThumbRoot = "/mnt/wbterminal2/pbr-terrain/cc0-pool/ambientcg/thumbs";
        private const string RetailRoot = "/mnt/wbterminal2/pbr-terrain/statics-x1/x4-input";

        public static PickerRecommendations Build() => new() {
            Version = 1,
            Pool = "ambientcg-cc0 (sample)",
            GeneratedBy = "TexturePickerSampleData (hand-written design-time fixture)",
            Rows = new List<PickerRow> {
                new() {
                    RsId = "0x06003CB9",
                    X2Rank = 1,
                    Placements = 69621,
                    WrapAxes = "X",
                    RetailPng = $"{RetailRoot}/0x06003CB9.png",
                    PeriodEstimate = new PickerVec2(7.01, 22.0),
                    Candidates = new List<PickerCandidate> {
                        Candidate("Bricks068", "Bricks 068", "Bricks", 0.91, 0.94, 0.88, 0.90, 0.61, 2, 2),
                        Candidate("Bricks074", "Bricks 074", "Bricks", 0.87, 0.90, 0.85, 0.86, 0.58, 2, 2),
                        Candidate("Concrete040", "Concrete 040", "Concrete", 0.79, 0.71, 0.84, 0.82, 0.55, 1, 1),
                        // A candidate the pipeline could not settle the Y axis on — renders "n/a".
                        Candidate("Gravel032", "Gravel 032", "Gravel", 0.68, 0.60, 0.72, 0.74, 0.44, 4, null),
                        Candidate("Granite007A", "Granite 007 A", "Rock", 0.61, 0.66, 0.55, 0.62, 0.40, 1, 1),
                    },
                },
                new() {
                    RsId = "0x06003C25",
                    X2Rank = 2,
                    Placements = 41880,
                    WrapAxes = "XY",
                    RetailPng = $"{RetailRoot}/0x06003C25.png",
                    PeriodEstimate = new PickerVec2(1, 1),
                    Candidates = new List<PickerCandidate> {
                        Candidate("Bricks091", "Bricks 091", "Bricks", 0.88, 0.85, 0.90, 0.89, 0.60, 1, 1),
                        Candidate("Bricks096", "Bricks 096", "Bricks", 0.82, 0.80, 0.83, 0.84, 0.57, 1, 1),
                        // PolyHaven — no local full-res set exists for ANY polyhaven asset, so this
                        // one exercises the "set not downloaded" / excluded-from-export path.
                        PolyHavenCandidate("plaster_brick_01", "Plaster Brick 01", "brick",
                            0.75, 0.75, 0.89, 0.48, 0.37, 0.467, 8.799),
                    },
                },
                new() {
                    RsId = "0x06003AED",
                    X2Rank = 3,
                    Placements = 22104,
                    WrapAxes = "-",
                    RetailPng = $"{RetailRoot}/0x06003AED.png",
                    // A row whose Y period was never estimated.
                    PeriodEstimate = new PickerVec2(1, null),
                    Candidates = new List<PickerCandidate> {
                        Candidate("Bricks076A", "Bricks 076 A", "Bricks", 0.72, 0.70, 0.74, 0.71, 0.50, null, null),
                        Candidate("Bricks099", "Bricks 099", "Bricks", 0.64, 0.62, 0.66, 0.65, 0.47, 1, 1),
                    },
                },
            },
        };

        private static PickerCandidate Candidate(
            string assetId, string displayName, string category,
            double score, double hue, double orient, double period, double busy,
            double? repeatX, double? repeatY) => new() {
                AssetId = assetId,
                Source = CandidateImageResolver.SourceAmbientCg,
                CategoryTier = 0,
                Thumb = $"{ThumbRoot}/{assetId}.png",
                FlatPreview = $"{FlatRoot}/{assetId}.jpg",
                DisplayName = displayName,
                Category = category,
                Link = $"https://ambientcg.com/view?id={assetId}",
                Score = score,
                Sub = new PickerSubScores { Hue = hue, Orient = orient, Period = period, Busy = busy },
                RepeatFactor = new PickerVec2(repeatX, repeatY),
            };

        private static PickerCandidate PolyHavenCandidate(
            string assetId, string displayName, string category,
            double score, double hue, double orient, double period, double busy,
            double? repeatX, double? repeatY) => new() {
                AssetId = assetId,
                Source = CandidateImageResolver.SourcePolyHaven,
                CategoryTier = 0,
                Thumb = $"/mnt/wbterminal2/pbr-terrain/cc0-pool/polyhaven/thumbs/{assetId}.png",
                FlatPreview = $"/mnt/wbterminal2/pbr-terrain/cc0-pool/polyhaven/flat/{assetId}.jpg",
                DisplayName = displayName,
                Category = category,
                Link = $"https://polyhaven.com/a/{assetId}",
                Score = score,
                Sub = new PickerSubScores { Hue = hue, Orient = orient, Period = period, Busy = busy },
                RepeatFactor = new PickerVec2(repeatX, repeatY),
            };
    }
}
