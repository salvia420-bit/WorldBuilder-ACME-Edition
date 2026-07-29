using System;
using System.IO;

namespace WorldBuilder.Shared.Lib.TexturePicker {
    /// <summary>
    /// Resolves the best available on-disk image for a candidate, and answers the one question the
    /// export cares about: is a shippable full-resolution diffuse actually on this box?
    ///
    /// SOURCE-AWARE. Only ambientCG sets were ever downloaded (statics-x3/sets/&lt;AssetId&gt;/).
    /// PolyHaven candidates — 430 of the 936 in the real recommendations file — have no local set at
    /// all, and their ids ("plaster_brick_01") are not ambientCG set-directory names, so probing the
    /// sets root for them is meaningless. <see cref="SupportsLocalSets"/> short-circuits that: a
    /// polyhaven pick reports "set not downloaded" and is excluded from the export bundle instead of
    /// silently resolving to a nonexistent path.
    ///
    /// Preview preference order:
    ///   1. Local full-resolution ambientCG set — <c>&lt;setsRoot&gt;/&lt;AssetId&gt;/&lt;AssetId&gt;_1K-PNG_Color.png</c>
    ///   2. <c>flatPreview</c> — the flat colour map (max-512). This is the one a human can judge.
    ///   3. <c>thumb</c> — LAST RESORT: both catalogues thumbnail on a lit sphere
    ///      (PICKER-RANKING-REPORT §10.3), which is useless for a tiling/hue judgement.
    ///
    /// <see cref="TryFetchMissingSet"/> is the seam for a future on-demand downloader —
    /// deliberately NOT implemented here (v0 is offline / no network).
    /// </summary>
    public class CandidateImageResolver {
        /// <summary>Default root of the locally downloaded CC0 sets (ambientCG only).</summary>
        public const string DefaultSetsRoot = "/mnt/wbterminal2/pbr-terrain/statics-x3/sets";

        /// <summary>The <c>source</c> value the ranking pipeline writes for ambientCG assets.</summary>
        public const string SourceAmbientCg = "ambientcg";

        /// <summary>The <c>source</c> value the ranking pipeline writes for PolyHaven assets.</summary>
        public const string SourcePolyHaven = "polyhaven";

        public string SetsRoot { get; }

        public CandidateImageResolver(string? setsRoot = null) {
            SetsRoot = string.IsNullOrWhiteSpace(setsRoot) ? DefaultSetsRoot : setsRoot!;
        }

        /// <summary>
        /// True when a candidate from this source could plausibly have a full-res set under
        /// <see cref="SetsRoot"/>. PolyHaven never can. An unknown/missing source is treated as
        /// "maybe" so a future catalogue is not silently excluded from export.
        /// </summary>
        public static bool SupportsLocalSets(string? source) =>
            !string.Equals(source?.Trim(), SourcePolyHaven, StringComparison.OrdinalIgnoreCase);

        /// <summary>Expected full-res diffuse path for an ambientCG asset id, existence NOT checked.</summary>
        public string FullResolutionPath(string assetId) =>
            Path.Combine(SetsRoot, assetId, $"{assetId}_1K-PNG_Color.png");

        /// <summary>
        /// Path to the full-resolution diffuse for an asset, or null when the set is not present
        /// locally. This is the PNG the export bundle ships.
        /// </summary>
        public string? ResolveFullResolution(string? assetId, string? source = null) {
            if (string.IsNullOrWhiteSpace(assetId)) return null;
            if (!SupportsLocalSets(source)) return null;
            string path;
            try { path = FullResolutionPath(assetId!); }
            catch (ArgumentException) { return null; }   // an id with path-illegal characters
            if (File.Exists(path)) return path;
            return TryFetchMissingSet(assetId!);
        }

        public string? ResolveFullResolution(PickerCandidate? candidate) =>
            candidate == null ? null : ResolveFullResolution(candidate.AssetId, candidate.Source);

        /// <summary>
        /// Small image for the sidebar tile: the flat colour map, falling back to the sphere thumb
        /// only when there is no flat preview on disk.
        /// </summary>
        public string? ResolveTile(PickerCandidate? candidate) {
            if (candidate == null) return null;
            if (Exists(candidate.FlatPreview)) return candidate.FlatPreview;
            if (Exists(candidate.Thumb)) return candidate.Thumb;
            return null;
        }

        /// <summary>
        /// Best preview image for a candidate: the local full-res set if there is one, else the flat
        /// colour map, else the sphere thumb, else null.
        /// </summary>
        public string? ResolvePreview(PickerCandidate? candidate) {
            if (candidate == null) return null;
            var full = ResolveFullResolution(candidate);
            if (full != null) return full;
            return ResolveTile(candidate);
        }

        /// <summary>True when the preview being shown is the full-res set.</summary>
        public bool HasFullResolution(PickerCandidate? candidate) =>
            ResolveFullResolution(candidate) != null;

        /// <summary>Which image <see cref="ResolvePreview"/> handed back, for the panel header.</summary>
        public CandidateImageKind PreviewKind(PickerCandidate? candidate) {
            if (candidate == null) return CandidateImageKind.None;
            if (ResolveFullResolution(candidate) != null) return CandidateImageKind.FullResolution;
            if (Exists(candidate.FlatPreview)) return CandidateImageKind.FlatPreview;
            if (Exists(candidate.Thumb)) return CandidateImageKind.SphereThumb;
            return CandidateImageKind.None;
        }

        /// <summary>
        /// Why a candidate cannot be exported, or null when it can. The wording "set not downloaded"
        /// is what the panel status line shows.
        /// </summary>
        public string? ExportBlockedReason(PickerCandidate? candidate) {
            if (candidate == null) return "no candidate selected";
            if (!SupportsLocalSets(candidate.Source))
                return $"set not downloaded — {candidate.Source} full-res sets are not local";
            if (ResolveFullResolution(candidate) == null)
                return "set not downloaded — no local full-res set";
            return null;
        }

        private static bool Exists(string? path) {
            if (string.IsNullOrWhiteSpace(path)) return false;
            try { return File.Exists(path); }
            catch (Exception) { return false; }   // a malformed path is "absent", never a crash
        }

        /// <summary>
        /// SEAM for on-demand CC0 downloading. v0 never downloads: an override would fetch
        /// &lt;AssetId&gt;_1K-PNG.zip into <see cref="SetsRoot"/> and return the extracted
        /// _Color.png path. Base implementation returns null (flat-preview fallback).
        /// </summary>
        protected virtual string? TryFetchMissingSet(string assetId) => null;
    }

    /// <summary>Which of the three image tiers a candidate resolved to.</summary>
    public enum CandidateImageKind {
        None,
        FullResolution,
        FlatPreview,
        SphereThumb,
    }
}
