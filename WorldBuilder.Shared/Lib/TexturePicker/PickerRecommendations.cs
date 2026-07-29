using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace WorldBuilder.Shared.Lib.TexturePicker {
    /// <summary>
    /// X-track texture-picker input contract — <c>picker-recommendations.json</c>, produced by the
    /// Python ranking pipeline (X-track task #2) at
    /// <c>/mnt/wbterminal2/pbr-terrain/picker/picker-recommendations.json</c>.
    ///
    /// Every member is a PROPERTY, never a field: System.Text.Json silently drops public fields
    /// unless <c>IncludeFields</c> is set, which would round-trip every score/repeat factor to 0
    /// (see <see cref="WorldBuilder.Shared.Lib.JsonOpts"/> for the same trap on Vector3).
    /// </summary>
    public sealed class PickerRecommendations {
        public int Version { get; set; } = 1;

        /// <summary>Candidate pool the ranking ran over (e.g. "ambientcg-cc0").</summary>
        public string? Pool { get; set; }

        /// <summary>Free-form provenance string written by the ranking pipeline.</summary>
        public string? GeneratedBy { get; set; }

        public List<PickerRow> Rows { get; set; } = new();

        /// <summary>Deserialization options — camelCase on disk, tolerant of any casing on read.</summary>
        public static readonly JsonSerializerOptions SerializerOptions = new() {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
            PropertyNameCaseInsensitive = true,
            DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
            WriteIndented = true,
        };

        /// <summary>Reads a recommendations file. Returns null when the file does not exist.</summary>
        public static PickerRecommendations? Load(string path) {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path)) return null;
            var json = File.ReadAllText(path);
            return JsonSerializer.Deserialize<PickerRecommendations>(json, SerializerOptions);
        }

        public static PickerRecommendations Parse(string json) =>
            JsonSerializer.Deserialize<PickerRecommendations>(json, SerializerOptions)
            ?? throw new InvalidDataException("picker-recommendations.json deserialized to null");

        /// <summary>Rows in worklist order: ascending x2Rank (rank 1 = biggest placement win), rsId as tiebreak.</summary>
        public IReadOnlyList<PickerRow> RowsInWorklistOrder() =>
            Rows.OrderBy(r => r.X2Rank).ThenBy(r => r.RsId, StringComparer.OrdinalIgnoreCase).ToList();
    }

    /// <summary>One retail RenderSurface (0x06……) awaiting a human taste decision.</summary>
    public sealed class PickerRow {
        /// <summary>Retail RenderSurface DID, "0x06003C25" style. The picks/export key.</summary>
        public string RsId { get; set; } = "";

        /// <summary>Rank from the X2 tiling worklist; 1 = highest placement impact.</summary>
        public int X2Rank { get; set; }

        /// <summary>Total placements of this surface across the world.</summary>
        public long Placements { get; set; }

        /// <summary>"X", "Y", "XY" or "-" — which axes tile cleanly at the retail edges.</summary>
        public string? WrapAxes { get; set; }

        /// <summary>Absolute path to the retail texture PNG (the A side of the A/B toggle).</summary>
        public string? RetailPng { get; set; }

        /// <summary>Estimated retail repeat period, used to seed the repeat stepper.</summary>
        public PickerVec2? PeriodEstimate { get; set; }

        /// <summary>Candidates sorted descending by score, up to 8.</summary>
        public List<PickerCandidate> Candidates { get; set; } = new();
    }

    /// <summary>One CC0 replacement candidate.</summary>
    public sealed class PickerCandidate {
        /// <summary>
        /// Asset id — "Bricks068" (ambientCG) or "plaster_brick_01" (polyhaven). For ambientCG this
        /// also names the statics-x3 set directory; polyhaven sets are never local (see
        /// <see cref="CandidateImageResolver"/>).
        /// </summary>
        public string AssetId { get; set; } = "";

        /// <summary>
        /// Which CC0 catalogue the asset came from. The real pipeline emits exactly
        /// <see cref="CandidateImageResolver.SourceAmbientCg"/> or
        /// <see cref="CandidateImageResolver.SourcePolyHaven"/>; anything else is treated as
        /// "might have a local set" so an unknown future source is not silently dropped.
        /// </summary>
        public string? Source { get; set; }

        /// <summary>
        /// SPHERE RENDER, not a texture — both catalogues thumbnail their assets on a lit ball
        /// (PICKER-RANKING-REPORT §10.3). Only used when <see cref="FlatPreview"/> is missing.
        /// </summary>
        public string? Thumb { get; set; }

        /// <summary>
        /// Flat colour map (max-512 JPG) — the image a human can actually judge tiling and hue
        /// against, and therefore the sidebar/preview default. Present for every candidate in the
        /// real file; may be absent in older fixtures, hence the thumb fallback.
        /// </summary>
        public string? FlatPreview { get; set; }

        /// <summary>Human-readable catalogue name, e.g. "Plaster Brick 01".</summary>
        public string? DisplayName { get; set; }

        /// <summary>Catalogue category ("Bricks", "brick", "wall"…). Vocabulary differs per source.</summary>
        public string? Category { get; set; }

        /// <summary>Catalogue page URL for the asset.</summary>
        public string? Link { get; set; }

        /// <summary>
        /// 0 = the asset's category matched the row's family filter, 1 = penalised ring
        /// (category could not be determined). Higher = weaker categorical evidence.
        /// </summary>
        public int CategoryTier { get; set; }

        /// <summary>Overall ranking score (higher is better).</summary>
        public double Score { get; set; }

        public PickerSubScores? Sub { get; set; }

        /// <summary>
        /// Suggested tiling repeat for this candidate against the retail surface. Either axis may be
        /// null when the period comparison was not decidable on that axis — that is a legitimate
        /// "n/a", never 1.0 (see <see cref="TexturePickerSession.RepeatX"/>).
        /// </summary>
        public PickerVec2? RepeatFactor { get; set; }

        /// <summary>Label for the tile / tooltip: display name when the catalogue gave one, else the id.</summary>
        public string Label => string.IsNullOrWhiteSpace(DisplayName) ? AssetId : DisplayName!;
    }

    /// <summary>Per-axis ranking breakdown shown next to the candidate thumb.</summary>
    public sealed class PickerSubScores {
        public double Hue { get; set; }
        public double Orient { get; set; }
        public double Period { get; set; }

        /// <summary>Detail-density agreement. Carried by the real pipeline (weight 0.15).</summary>
        public double Busy { get; set; }
    }

    /// <summary>
    /// Two-component value used for both periodEstimate and repeatFactor.
    ///
    /// Both axes are NULLABLE on purpose: the ranking pipeline emits <c>{"x": 0.467, "y": null}</c>
    /// when one axis is legitimately incomparable. A non-nullable double here would make
    /// System.Text.Json throw on the real file, and coercing to 0/1 would invent a tiling decision
    /// the pipeline explicitly declined to make.
    /// </summary>
    public sealed class PickerVec2 {
        public double? X { get; set; }
        public double? Y { get; set; }

        public PickerVec2() { }
        public PickerVec2(double? x, double? y) { X = x; Y = y; }
    }
}
