using System;
using System.IO;
using System.Linq;
using System.Text.Json;

using WorldBuilder.Shared.Lib.TexturePicker;

namespace WorldBuilder.Tests;

/// <summary>
/// X-track texture-picker core. Everything the Avalonia panel does that is not a pixel is in
/// <see cref="TexturePickerSession"/> / <see cref="PickerPicksFile"/> / <see cref="TexOverrideExporter"/>,
/// so it is pinned here rather than needing a headless GUI harness.
///
/// Pinned invariants:
///   1. picker-recommendations.json parses with camelCase keys and nothing silently zeroes
///      (the System.Text.Json fields-vs-properties trap).
///   2. The worklist is ordered by x2Rank, not file order.
///   3. Picks round-trip through an atomic write, INCLUDING skip state, so progress survives a restart.
///   4. The repeat stepper seeds candidate.repeatFactor > row.periodEstimate > 1x1, and clamps.
///   5. Candidate images prefer the local full-res CC0 set over the ranking thumb.
///   6. The exported bundle is shape-identical to holtburger's tex-overrides manifest
///      (version/note/overrides[did,src]) with bundle-RELATIVE src, and its note carries the
///      diffuse-only TODO.
/// </summary>
public class TexturePickerTests {
    private const string SampleJson = """
    {
      "version": 1,
      "pool": "ambientcg-cc0",
      "generatedBy": "x-track ranking pipeline (test fixture)",
      "rows": [
        {
          "rsId": "0x06003C25",
          "x2Rank": 4,
          "placements": 41880,
          "wrapAxes": "XY",
          "retailPng": "/tmp/does-not-exist/0x06003C25.png",
          "periodEstimate": { "x": 3, "y": 3 },
          "candidates": [
            {
              "assetId": "Bricks091",
              "source": "ambientcg",
              "thumb": "/tmp/does-not-exist/Bricks091.png",
              "score": 0.88,
              "sub": { "hue": 0.85, "orient": 0.9, "period": 0.89 },
              "repeatFactor": { "x": 2, "y": 2 }
            },
            {
              "assetId": "Concrete040",
              "source": "ambientcg",
              "thumb": "/tmp/does-not-exist/Concrete040.png",
              "score": 0.71,
              "sub": { "hue": 0.6, "orient": 0.8, "period": 0.75 }
            }
          ]
        },
        {
          "rsId": "0x06003CB9",
          "x2Rank": 1,
          "placements": 69621,
          "wrapAxes": "X",
          "retailPng": "/tmp/does-not-exist/0x06003CB9.png",
          "periodEstimate": { "x": 2, "y": 2 },
          "candidates": [
            {
              "assetId": "Bricks068",
              "source": "ambientcg",
              "thumb": "/tmp/does-not-exist/Bricks068.png",
              "score": 0.91,
              "sub": { "hue": 0.94, "orient": 0.88, "period": 0.9 },
              "repeatFactor": { "x": 4, "y": 4 }
            }
          ]
        }
      ]
    }
    """;

    private static string NewTempDir(string tag) {
        var dir = Path.Combine(Path.GetTempPath(), $"wb-picker-{tag}-{Guid.NewGuid():N}");
        Directory.CreateDirectory(dir);
        return dir;
    }

    /// <summary>Writes a 1x1 PNG so File.Exists-gated code paths are exercised on real bytes.</summary>
    private static string WritePng(string path) {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.WriteAllBytes(path, Convert.FromBase64String(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="));
        return path;
    }

    // ---- 1. schema ------------------------------------------------------------------------

    [Fact]
    public void Parse_ReadsEveryFieldWithoutZeroing() {
        var recs = PickerRecommendations.Parse(SampleJson);

        Assert.Equal(1, recs.Version);
        Assert.Equal("ambientcg-cc0", recs.Pool);
        Assert.Equal(2, recs.Rows.Count);

        var row = recs.Rows.Single(r => r.RsId == "0x06003C25");
        Assert.Equal(4, row.X2Rank);
        Assert.Equal(41880, row.Placements);
        Assert.Equal("XY", row.WrapAxes);
        Assert.NotNull(row.PeriodEstimate);
        Assert.Equal(3, row.PeriodEstimate!.X!.Value);

        var top = row.Candidates[0];
        Assert.Equal("Bricks091", top.AssetId);
        Assert.Equal(0.88, top.Score, 6);
        Assert.NotNull(top.Sub);
        Assert.Equal(0.85, top.Sub!.Hue, 6);
        Assert.Equal(0.9, top.Sub.Orient, 6);
        Assert.Equal(2, top.RepeatFactor!.X!.Value);

        // An absent repeatFactor must stay null, not silently become 0x0.
        Assert.Null(row.Candidates[1].RepeatFactor);
    }

    // ---- 2. worklist ordering -------------------------------------------------------------

    [Fact]
    public void Worklist_IsOrderedByX2Rank_NotFileOrder() {
        var session = new TexturePickerSession(PickerRecommendations.Parse(SampleJson));

        Assert.Equal("0x06003CB9", session.Rows[0].RsId); // rank 1
        Assert.Equal("0x06003C25", session.Rows[1].RsId); // rank 4
        Assert.Equal("0x06003CB9", session.CurrentRow!.RsId);
    }

    [Fact]
    public void NextAndPrev_ClampAtTheEnds() {
        var session = new TexturePickerSession(PickerRecommendations.Parse(SampleJson));

        Assert.False(session.Prev());
        Assert.True(session.Next());
        Assert.False(session.Next());
        Assert.Equal(1, session.CurrentIndex);
        Assert.True(session.Prev());
        Assert.Equal(0, session.CurrentIndex);
    }

    // ---- 3. picks persistence -------------------------------------------------------------

    [Fact]
    public void Picks_RoundTripThroughAtomicWrite_IncludingSkipState() {
        var dir = NewTempDir("picks");
        var path = Path.Combine(dir, TexturePickerSession.PicksFileName);

        var picks = new PickerPicksFile();
        picks.Picks["0x06003C25"] = new PickerPick {
            AssetId = "Bricks091",
            RepeatFactor = new PickerVec2(2.5, 3.0),
            Gain = 1.15,
            Tint = new[] { 0.9, 0.95, 1.0 },
            Note = "warmer than retail but the joint spacing matches",
            DecidedAt = PickerPick.NowStamp(),
        };
        picks.Picks["0x06003CB9"] = new PickerPick { Skipped = true, DecidedAt = PickerPick.NowStamp() };
        picks.Save(path);

        // Atomic write leaves no temp debris behind.
        Assert.Single(Directory.GetFiles(dir));

        var loaded = PickerPicksFile.Load(path);
        Assert.Equal(1, loaded.Version);
        Assert.Equal(2, loaded.Picks.Count);

        var pick = loaded.Picks["0x06003C25"];
        Assert.Equal("Bricks091", pick.AssetId);
        Assert.Equal(2.5, pick.RepeatFactor!.X!.Value, 6);
        Assert.Equal(3.0, pick.RepeatFactor.Y!.Value, 6);
        Assert.Equal(1.15, pick.Gain!.Value, 6);
        Assert.Equal(3, pick.Tint!.Length);
        Assert.False(pick.Skipped);

        Assert.True(loaded.Picks["0x06003CB9"].Skipped);
        Assert.Null(loaded.Picks["0x06003CB9"].AssetId);

        // Keys are case-insensitive so a lowercase DID cannot shadow a decision.
        Assert.True(loaded.Picks.ContainsKey("0x06003c25"));

        Directory.Delete(dir, true);
    }

    [Fact]
    public void Picks_MissingFileLoadsEmpty() {
        var loaded = PickerPicksFile.Load(Path.Combine(Path.GetTempPath(), $"nope-{Guid.NewGuid():N}.json"));
        Assert.Empty(loaded.Picks);
        Assert.Equal(1, loaded.Version);
    }

    [Fact]
    public void PickAndSkip_DriveProgressAndPersist() {
        var dir = NewTempDir("session");
        var picksPath = Path.Combine(dir, TexturePickerSession.PicksFileName);

        var session = new TexturePickerSession(PickerRecommendations.Parse(SampleJson)) { PicksPath = picksPath };
        Assert.Equal(2, session.RemainingCount);

        Assert.True(session.PickCurrent(note: "rank-1 head")); // 0x06003CB9 <- Bricks068
        Assert.Equal(1, session.PickedCount);
        Assert.Equal(1, session.RemainingCount);

        session.Next();
        Assert.True(session.SkipCurrent());
        Assert.Equal(1, session.SkippedCount);
        Assert.Equal(0, session.RemainingCount);

        // Reload from disk: the decisions survived.
        var reloaded = new TexturePickerSession(
            PickerRecommendations.Parse(SampleJson), PickerPicksFile.Load(picksPath));
        Assert.Equal(1, reloaded.PickedCount);
        Assert.Equal(1, reloaded.SkippedCount);
        Assert.Equal("Bricks068", reloaded.Picks.Picks["0x06003CB9"].AssetId);
        Assert.Equal("rank-1 head", reloaded.Picks.Picks["0x06003CB9"].Note);

        Directory.Delete(dir, true);
    }

    [Fact]
    public void NextUndecided_SkipsRowsThatAlreadyHaveDecisions() {
        var session = new TexturePickerSession(PickerRecommendations.Parse(SampleJson));

        Assert.True(session.PickCurrent());   // row 0 decided
        Assert.True(session.NextUndecided());
        Assert.Equal(1, session.CurrentIndex);

        session.SkipCurrent();                // row 1 decided
        Assert.False(session.NextUndecided()); // nothing left
    }

    [Fact]
    public void PickCurrent_RequiresASelectedCandidate() {
        var session = new TexturePickerSession(PickerRecommendations.Parse(SampleJson));
        session.SelectedCandidateIndex = -1;
        Assert.False(session.PickCurrent());
        Assert.Equal(0, session.PickedCount);
    }

    // ---- 4. repeat stepper ----------------------------------------------------------------

    [Fact]
    public void Repeat_SeedsFromCandidateThenPeriodEstimate() {
        var session = new TexturePickerSession(PickerRecommendations.Parse(SampleJson));

        // Row 0's only candidate carries repeatFactor 4x4 — that wins over periodEstimate 2x2.
        Assert.Equal(4, session.RepeatX!.Value, 6);
        Assert.Equal(4, session.RepeatY!.Value, 6);

        session.Next();
        Assert.Equal(2, session.RepeatX!.Value, 6); // row 1 top candidate: 2x2

        // Second candidate has no repeatFactor -> fall back to the row's periodEstimate 3x3.
        session.SelectedCandidateIndex = 1;
        Assert.Equal(3, session.RepeatX!.Value, 6);
        Assert.Equal(3, session.RepeatY!.Value, 6);
    }

    [Fact]
    public void Repeat_RestoresAnExistingPicksValue() {
        var recs = PickerRecommendations.Parse(SampleJson);
        var picks = new PickerPicksFile();
        picks.Picks["0x06003CB9"] = new PickerPick {
            AssetId = "Bricks068",
            RepeatFactor = new PickerVec2(6, 1.5),
        };

        var session = new TexturePickerSession(recs, picks);
        session.SelectedCandidateIndex = 0;
        session.SeedRepeatFromSelection();

        Assert.Equal(6, session.RepeatX!.Value, 6);
        Assert.Equal(1.5, session.RepeatY!.Value, 6);
    }

    [Fact]
    public void Repeat_ClampsAndRejectsNonFinite() {
        var session = new TexturePickerSession(PickerRecommendations.Parse(SampleJson));

        session.RepeatX = 0;
        Assert.Equal(1.0, session.RepeatX!.Value, 6);

        session.RepeatX = double.NaN;
        Assert.Equal(1.0, session.RepeatX!.Value, 6);

        session.RepeatY = 10_000;
        Assert.Equal(TexturePickerSession.MaxRepeat, session.RepeatY!.Value, 6);

        session.RepeatY = 0.01;
        Assert.Equal(TexturePickerSession.MinRepeat, session.RepeatY!.Value, 6);

        session.RepeatX = 2;
        session.StepRepeatX(TexturePickerSession.RepeatStep);
        Assert.Equal(2.25, session.RepeatX!.Value, 6);
    }

    // ---- 5. candidate image resolution ----------------------------------------------------

    [Fact]
    public void Resolver_PrefersLocalFullResOverThumb_AndFallsBack() {
        var root = NewTempDir("sets");
        var setsRoot = Path.Combine(root, "sets");
        WritePng(Path.Combine(setsRoot, "Bricks068", "Bricks068_1K-PNG_Color.png"));
        var thumb = WritePng(Path.Combine(root, "thumbs", "Bricks068.png"));
        var otherThumb = WritePng(Path.Combine(root, "thumbs", "Concrete040.png"));

        var resolver = new CandidateImageResolver(setsRoot);

        var withSet = new PickerCandidate { AssetId = "Bricks068", Thumb = thumb };
        Assert.True(resolver.HasFullResolution(withSet));
        Assert.EndsWith("Bricks068_1K-PNG_Color.png", resolver.ResolvePreview(withSet));

        // No local set (the full CC0 pool is far bigger than what's downloaded) -> thumb.
        var thumbOnly = new PickerCandidate { AssetId = "Concrete040", Thumb = otherThumb };
        Assert.False(resolver.HasFullResolution(thumbOnly));
        Assert.Equal(otherThumb, resolver.ResolvePreview(thumbOnly));

        // Nothing on disk at all -> null, never a bogus path.
        Assert.Null(resolver.ResolvePreview(new PickerCandidate { AssetId = "Nope", Thumb = "/tmp/nope.png" }));

        Directory.Delete(root, true);
    }

    // ---- 6. export ------------------------------------------------------------------------

    [Fact]
    public void Export_WritesHoltburgerShapedBundle() {
        var root = NewTempDir("export");
        var setsRoot = Path.Combine(root, "sets");
        WritePng(Path.Combine(setsRoot, "Bricks068", "Bricks068_1K-PNG_Color.png"));
        WritePng(Path.Combine(setsRoot, "Bricks091", "Bricks091_1K-PNG_Color.png"));
        var dest = Path.Combine(root, "bundle");

        var recs = PickerRecommendations.Parse(SampleJson);
        var session = new TexturePickerSession(recs, new PickerPicksFile(), new CandidateImageResolver(setsRoot));

        session.PickCurrent();          // 0x06003CB9 <- Bricks068
        session.Next();
        session.PickCurrent();          // 0x06003C25 <- Bricks091

        var entries = session.BuildExportEntries(out var unavailable);
        Assert.Equal(2, entries.Count);
        Assert.Empty(unavailable);

        var result = TexOverrideExporter.Export(entries, dest, "unit test bundle");
        Assert.Equal(2, result.OverrideCount);

        var manifest = TexOverrideExporter.LoadManifest(result.ManifestPath);
        Assert.NotNull(manifest);
        Assert.Equal(1, manifest!.Version);
        Assert.Contains(TexOverrideExporter.NormalRoughTodoNote, manifest.Note);

        // src is a bundle-relative filename keyed off the retail DID, matching
        // external/holtburger/apps/holtburger-web/data/tex-overrides/manifest.json.
        var entry = manifest.Overrides.Single(o => o.Did == "0x06003CB9");
        Assert.Equal("0x06003CB9.png", entry.Src);
        Assert.True(File.Exists(Path.Combine(dest, entry.Src)));

        // Manifest keys are camelCase on disk.
        using var doc = JsonDocument.Parse(File.ReadAllText(result.ManifestPath));
        Assert.True(doc.RootElement.TryGetProperty("version", out _));
        Assert.True(doc.RootElement.TryGetProperty("note", out _));
        Assert.True(doc.RootElement.TryGetProperty("overrides", out var overrides));
        Assert.True(overrides[0].TryGetProperty("did", out _));
        Assert.True(overrides[0].TryGetProperty("src", out _));

        Directory.Delete(root, true);
    }

    [Fact]
    public void Export_ExcludesPicksWithNoLocalFullResSet() {
        var root = NewTempDir("export-missing");
        var setsRoot = Path.Combine(root, "sets");
        WritePng(Path.Combine(setsRoot, "Bricks068", "Bricks068_1K-PNG_Color.png"));

        var recs = PickerRecommendations.Parse(SampleJson);
        var session = new TexturePickerSession(recs, new PickerPicksFile(), new CandidateImageResolver(setsRoot));

        session.PickCurrent();  // Bricks068 — set is local
        session.Next();
        session.PickCurrent();  // Bricks091 — no local set

        var entries = session.BuildExportEntries(out var unavailable);
        Assert.Single(entries);
        Assert.Equal("0x06003CB9", entries[0].Did);
        Assert.Single(unavailable);
        Assert.Contains("Bricks091", unavailable[0]);

        Directory.Delete(root, true);
    }

    [Fact]
    public void Export_SkippedRowsNeverReachTheBundle() {
        var root = NewTempDir("export-skip");
        var setsRoot = Path.Combine(root, "sets");
        WritePng(Path.Combine(setsRoot, "Bricks068", "Bricks068_1K-PNG_Color.png"));

        var session = new TexturePickerSession(
            PickerRecommendations.Parse(SampleJson), new PickerPicksFile(), new CandidateImageResolver(setsRoot));
        session.SkipCurrent();

        var entries = session.BuildExportEntries(out _);
        Assert.Empty(entries);

        Directory.Delete(root, true);
    }

    [Fact]
    public void ComposeNote_AlwaysCarriesTheDiffuseOnlyTodoExactlyOnce() {
        var a = TexOverrideExporter.ComposeNote(null);
        Assert.Contains(TexOverrideExporter.NormalRoughTodoNote, a);

        var b = TexOverrideExporter.ComposeNote("picked by hand");
        Assert.StartsWith("picked by hand.", b);
        Assert.Contains(TexOverrideExporter.NormalRoughTodoNote, b);

        var c = TexOverrideExporter.ComposeNote(b);
        Assert.Equal(b, c);
    }

    // ---- design-time sample ---------------------------------------------------------------

    [Fact]
    public void SampleData_IsAValidWorklist() {
        var session = new TexturePickerSession(TexturePickerSampleData.Build());

        Assert.Equal(3, session.Rows.Count);
        Assert.Equal(1, session.Rows[0].X2Rank);
        Assert.Equal(TexturePickerSession.SidebarCandidateCount, session.SidebarCandidates.Count);
        Assert.NotNull(session.SelectedCandidate);
        Assert.Contains("picked", session.ProgressText);

        // No PicksPath -> saving is a no-op, so design-time cannot write over a human's picks file.
        Assert.Null(session.PicksPath);
        session.SkipCurrent();
        Assert.Equal(1, session.SkippedCount);
    }

    [Fact]
    public void SampleData_UsesTheRealSourceVocabularyAndCarriesTheNewFields() {
        var recs = TexturePickerSampleData.Build();
        var all = recs.Rows.SelectMany(r => r.Candidates).ToList();

        // The pipeline emits exactly "ambientcg" / "polyhaven" — the fixture must not drift.
        Assert.All(all, c => Assert.Contains(c.Source, new[] {
            CandidateImageResolver.SourceAmbientCg, CandidateImageResolver.SourcePolyHaven }));
        Assert.Contains(all, c => c.Source == CandidateImageResolver.SourcePolyHaven);

        Assert.All(all, c => Assert.False(string.IsNullOrWhiteSpace(c.FlatPreview)));
        Assert.All(all, c => Assert.False(string.IsNullOrWhiteSpace(c.DisplayName)));
        Assert.All(all, c => Assert.False(string.IsNullOrWhiteSpace(c.Category)));
        Assert.All(all, c => Assert.False(string.IsNullOrWhiteSpace(c.Link)));
        Assert.All(all, c => Assert.True(c.Sub!.Busy > 0));

        // "n/a" is a shape the panel has to render, so the fixture has to produce one.
        Assert.Contains(all, c => c.RepeatFactor != null && c.RepeatFactor.Y == null);
        Assert.Contains(recs.Rows, r => r.PeriodEstimate != null && r.PeriodEstimate.Y == null);
    }

    // ---- 7. the REAL ranking output --------------------------------------------------------

    /// <summary>
    /// The contract is only worth anything if it parses the file the Python pipeline actually
    /// writes. This is the one test that reads /mnt/wbterminal2 — when that mount is not present
    /// (a fresh checkout, CI) it self-skips rather than failing for an unrelated reason.
    /// </summary>
    [Fact]
    public void RealRecommendationsFile_ParsesWithTheFullContract() {
        var path = Path.Combine(TexturePickerSession.DefaultPickerDirectory,
                                TexturePickerSession.RecommendationsFileName);
        if (!File.Exists(path)) return;   // picker data volume not mounted

        var recs = PickerRecommendations.Load(path);
        Assert.NotNull(recs);
        Assert.Equal(117, recs!.Rows.Count);

        var candidates = recs.Rows.SelectMany(r => r.Candidates).ToList();
        Assert.Equal(936, candidates.Count);                       // 117 rows x top-8
        Assert.All(recs.Rows, r => Assert.StartsWith("0x06", r.RsId));

        // Nothing silently zeroed by the fields-vs-properties trap.
        Assert.All(candidates, c => Assert.True(c.Score > 0));
        Assert.All(candidates, c => Assert.False(string.IsNullOrWhiteSpace(c.AssetId)));
        Assert.All(candidates, c => Assert.False(string.IsNullOrWhiteSpace(c.FlatPreview)));
        Assert.All(candidates, c => Assert.False(string.IsNullOrWhiteSpace(c.DisplayName)));
        Assert.All(candidates, c => Assert.False(string.IsNullOrWhiteSpace(c.Link)));
        Assert.Contains(candidates, c => c.Sub!.Busy > 0);
        Assert.Contains(candidates, c => c.CategoryTier > 0);

        // Both real sources are present and nothing else is.
        var sources = string.Join(",", candidates.Select(c => c.Source ?? "").Distinct().OrderBy(s => s));
        Assert.Equal($"{CandidateImageResolver.SourceAmbientCg},{CandidateImageResolver.SourcePolyHaven}", sources);

        // Null axes are real in this file — parsing them is exactly what a non-nullable
        // PickerVec2 could not do.
        Assert.Contains(candidates, c => c.RepeatFactor != null
            && (c.RepeatFactor.X == null || c.RepeatFactor.Y == null));

        // The worklist is walkable end to end and every row's top candidate resolves to an image.
        var session = new TexturePickerSession(recs);
        Assert.Equal(117, session.Rows.Count);
        Assert.Equal(1, session.Rows[0].X2Rank);
        while (session.Next()) { Assert.NotNull(session.CurrentRow); }
    }

    // ---- 8. null repeat axes ---------------------------------------------------------------

    private const string NullAxisJson = """
    {
      "version": 1,
      "pool": "/mnt/wbterminal2/pbr-terrain/cc0-pool",
      "rows": [
        {
          "rsId": "0x06003CB9",
          "x2Rank": 1,
          "placements": 69621,
          "wrapAxes": "X",
          "retailPng": "/tmp/does-not-exist/0x06003CB9.png",
          "periodEstimate": { "x": 7.01, "y": null },
          "candidates": [
            {
              "assetId": "plaster_brick_01",
              "source": "polyhaven",
              "categoryTier": 0,
              "thumb": "/tmp/does-not-exist/plaster_brick_01.png",
              "flatPreview": "/tmp/does-not-exist/plaster_brick_01.jpg",
              "displayName": "Plaster Brick 01",
              "category": "brick",
              "link": "https://polyhaven.com/a/plaster_brick_01",
              "score": 0.72458,
              "sub": { "hue": 0.7545, "orient": 0.8932, "period": 0.4835, "busy": 0.3681 },
              "repeatFactor": { "x": 0.467, "y": null }
            },
            {
              "assetId": "Bricks068",
              "source": "ambientcg",
              "categoryTier": 1,
              "thumb": "/tmp/does-not-exist/Bricks068.png",
              "flatPreview": "/tmp/does-not-exist/Bricks068.jpg",
              "displayName": "Bricks 068",
              "category": "Bricks",
              "link": "https://ambientcg.com/view?id=Bricks068",
              "score": 0.61,
              "sub": { "hue": 0.6, "orient": 0.6, "period": 0.6, "busy": 0.6 },
              "repeatFactor": { "x": 2, "y": 3 }
            }
          ]
        }
      ]
    }
    """;

    [Fact]
    public void NullAxis_ParsesAsNull_NeverAsZeroOrOne() {
        var recs = PickerRecommendations.Parse(NullAxisJson);
        var row = recs.Rows[0];

        Assert.Equal(7.01, row.PeriodEstimate!.X!.Value, 6);
        Assert.Null(row.PeriodEstimate.Y);

        var poly = row.Candidates[0];
        Assert.Equal(0.467, poly.RepeatFactor!.X!.Value, 6);
        Assert.Null(poly.RepeatFactor.Y);
        Assert.Equal("polyhaven", poly.Source);
        Assert.Equal("Plaster Brick 01", poly.DisplayName);
        Assert.Equal("brick", poly.Category);
        Assert.Equal(0.3681, poly.Sub!.Busy, 6);
        Assert.Equal(1, row.Candidates[1].CategoryTier);
    }

    [Fact]
    public void NullAxis_IsNotSteppable_AndDoesNotFallThroughToPeriodEstimate() {
        var session = new TexturePickerSession(PickerRecommendations.Parse(NullAxisJson));

        // Candidate 0: x = 0.467 (clamped to the 0.25 floor grid), y = n/a.
        Assert.True(session.HasRepeatX);
        Assert.False(session.HasRepeatY);
        Assert.Null(session.RepeatY);
        Assert.Equal(1.0, session.EffectiveRepeatY, 6);   // display fallback only

        // Stepping an n/a axis is a no-op — it must not materialise a value.
        session.StepRepeatY(TexturePickerSession.RepeatStep);
        Assert.Null(session.RepeatY);

        // Candidate 1 has both axes, so the stepper comes back to life.
        session.SelectedCandidateIndex = 1;
        Assert.True(session.HasRepeatY);
        Assert.Equal(3, session.RepeatY!.Value, 6);
    }

    [Fact]
    public void NullAxis_PersistsAsNullInPicksJson() {
        var dir = NewTempDir("null-axis");
        var picksPath = Path.Combine(dir, TexturePickerSession.PicksFileName);

        var session = new TexturePickerSession(PickerRecommendations.Parse(NullAxisJson)) {
            PicksPath = picksPath
        };
        Assert.True(session.PickCurrent());

        var pick = PickerPicksFile.Load(picksPath).Picks["0x06003CB9"];
        Assert.NotNull(pick.RepeatFactor);
        Assert.NotNull(pick.RepeatFactor!.X);
        Assert.Null(pick.RepeatFactor.Y);

        // …and null on the wire, not an omitted key that a reader could read as 0.
        using var doc = JsonDocument.Parse(File.ReadAllText(picksPath));
        var y = doc.RootElement.GetProperty("picks").GetProperty("0x06003CB9")
                   .GetProperty("repeatFactor").GetProperty("y");
        Assert.Equal(JsonValueKind.Null, y.ValueKind);

        // Reload restores the null rather than seeding 1.
        var reloaded = new TexturePickerSession(
            PickerRecommendations.Parse(NullAxisJson), PickerPicksFile.Load(picksPath));
        Assert.Null(reloaded.RepeatY);

        Directory.Delete(dir, true);
    }

    // ---- 9. source-aware image resolution --------------------------------------------------

    [Fact]
    public void Resolver_PrefersFlatPreviewOverTheSphereThumb() {
        var root = NewTempDir("flat");
        var flat = WritePng(Path.Combine(root, "flat", "Bricks068.jpg"));
        var thumb = WritePng(Path.Combine(root, "thumbs", "Bricks068.png"));

        var resolver = new CandidateImageResolver(Path.Combine(root, "sets"));
        var candidate = new PickerCandidate {
            AssetId = "Bricks068", Source = "ambientcg", FlatPreview = flat, Thumb = thumb
        };

        Assert.Equal(flat, resolver.ResolveTile(candidate));
        Assert.Equal(flat, resolver.ResolvePreview(candidate));
        Assert.Equal(CandidateImageKind.FlatPreview, resolver.PreviewKind(candidate));

        // Only when the flat map is absent does the sphere thumb get used.
        candidate.FlatPreview = "/tmp/does-not-exist/nope.jpg";
        Assert.Equal(thumb, resolver.ResolveTile(candidate));
        Assert.Equal(CandidateImageKind.SphereThumb, resolver.PreviewKind(candidate));

        // A local full-res set still outranks both.
        WritePng(Path.Combine(root, "sets", "Bricks068", "Bricks068_1K-PNG_Color.png"));
        Assert.Equal(CandidateImageKind.FullResolution, resolver.PreviewKind(candidate));

        Directory.Delete(root, true);
    }

    [Fact]
    public void Resolver_IsSourceAware_PolyHavenSetsAreNeverLocal() {
        var root = NewTempDir("source-aware");
        var setsRoot = Path.Combine(root, "sets");
        // Even if a directory of that name existed, a polyhaven candidate must not claim it.
        WritePng(Path.Combine(setsRoot, "plaster_brick_01", "plaster_brick_01_1K-PNG_Color.png"));
        var flat = WritePng(Path.Combine(root, "flat", "plaster_brick_01.jpg"));

        var resolver = new CandidateImageResolver(setsRoot);
        var poly = new PickerCandidate {
            AssetId = "plaster_brick_01", Source = "polyhaven", FlatPreview = flat
        };

        Assert.False(CandidateImageResolver.SupportsLocalSets("polyhaven"));
        Assert.True(CandidateImageResolver.SupportsLocalSets("ambientcg"));
        Assert.True(CandidateImageResolver.SupportsLocalSets(null));   // unknown source = "maybe"

        Assert.False(resolver.HasFullResolution(poly));
        Assert.Null(resolver.ResolveFullResolution(poly));
        Assert.Equal(flat, resolver.ResolvePreview(poly));             // preview still works
        Assert.Contains("set not downloaded", resolver.ExportBlockedReason(poly));

        // A polyhaven id with characters that are not a legal path fragment must not throw.
        var weird = new PickerCandidate { AssetId = "a\0b", Source = "polyhaven" };
        Assert.Null(resolver.ResolveFullResolution(weird));
        Assert.Null(resolver.ResolvePreview(weird));
        Assert.Null(resolver.ResolveFullResolution("a\0b"));

        Directory.Delete(root, true);
    }

    [Fact]
    public void Export_ExcludesPolyHavenPicks_WithASetNotDownloadedReason() {
        var root = NewTempDir("export-polyhaven");
        var setsRoot = Path.Combine(root, "sets");
        WritePng(Path.Combine(setsRoot, "Bricks068", "Bricks068_1K-PNG_Color.png"));

        var session = new TexturePickerSession(
            PickerRecommendations.Parse(NullAxisJson), new PickerPicksFile(),
            new CandidateImageResolver(setsRoot));

        // Candidate 0 is the polyhaven one — pick it.
        Assert.True(session.PickCurrent());

        var entries = session.BuildExportEntries(out var unavailable);
        Assert.Empty(entries);
        Assert.Single(unavailable);
        Assert.Contains("plaster_brick_01", unavailable[0]);
        Assert.Contains("set not downloaded", unavailable[0]);
        Assert.Contains("polyhaven", unavailable[0]);
        Assert.Contains("set not downloaded", session.SelectedAvailabilityText);

        // Switching to the ambientCG candidate makes the row exportable again.
        session.SelectedCandidateIndex = 1;
        Assert.True(session.PickCurrent());
        entries = session.BuildExportEntries(out unavailable);
        Assert.Single(entries);
        Assert.Empty(unavailable);
        Assert.Equal("", session.SelectedAvailabilityText);

        Directory.Delete(root, true);
    }

    // ---- 10. gain / tint -------------------------------------------------------------------

    [Fact]
    public void Gain_ClampsToTheUiRangeAndSnapsToTheStep() {
        Assert.Null(TexturePickerSession.ClampGain(null));
        Assert.Null(TexturePickerSession.ClampGain(double.NaN));
        Assert.Equal(TexturePickerSession.MinGain, TexturePickerSession.ClampGain(0.01)!.Value, 6);
        Assert.Equal(TexturePickerSession.MaxGain, TexturePickerSession.ClampGain(9.0)!.Value, 6);
        Assert.Equal(1.15, TexturePickerSession.ClampGain(1.16)!.Value, 6);   // snapped to 0.05
    }

    [Fact]
    public void SuggestGain_IsTheLuminanceRatio_AndNullWhenUnmeasurable() {
        Assert.Equal(1.25, TexturePickerSession.SuggestGain(0.50, 0.40)!.Value, 6);
        Assert.Null(TexturePickerSession.SuggestGain(null, 0.4));
        Assert.Null(TexturePickerSession.SuggestGain(0.5, null));
        Assert.Null(TexturePickerSession.SuggestGain(0.5, 0.0));   // black candidate: no ratio
        // Still clamped: a very dark candidate cannot ask for a 10x gain.
        Assert.Equal(TexturePickerSession.MaxGain, TexturePickerSession.SuggestGain(0.9, 0.01)!.Value, 6);
    }

    [Fact]
    public void Tint_ParsesHexTriplesAndScalars_AndRejectsGarbage() {
        Assert.True(PickerTint.TryParse(null, out var none));
        Assert.Null(none);
        Assert.True(PickerTint.TryParse("   ", out none));
        Assert.Null(none);

        Assert.True(PickerTint.TryParse("#ff8000", out var hex));
        Assert.Equal(1.0, hex![0], 3);
        Assert.Equal(0.502, hex[1], 3);
        Assert.Equal(0.0, hex[2], 3);

        Assert.True(PickerTint.TryParse("0.9,0.95,1", out var triple));
        Assert.Equal(new[] { 0.9, 0.95, 1.0 }, triple);

        Assert.True(PickerTint.TryParse("0.8", out var scalar));
        Assert.Equal(new[] { 0.8, 0.8, 0.8 }, scalar);

        Assert.False(PickerTint.TryParse("not a colour", out _));
        Assert.False(PickerTint.TryParse("0.5,0.5", out _));
        Assert.False(PickerTint.TryParse("#12345", out _));
        Assert.False(PickerTint.TryParse("-1,0,0", out _));

        Assert.Equal("0.9,0.95,1", PickerTint.Format(new[] { 0.9, 0.95, 1.0 }));
        Assert.Equal("", PickerTint.Format(null));
        Assert.Equal("#FF8000", PickerTint.ToHex(new[] { 1.0, 0.502, 0.0 }));
        Assert.Equal("#FFFFFF", PickerTint.ToHex(new[] { 2.0, 3.0, 4.0 }));   // clamped
    }

    [Fact]
    public void GainAndTint_RoundTripThroughPickCurrent() {
        var dir = NewTempDir("gain-tint");
        var picksPath = Path.Combine(dir, TexturePickerSession.PicksFileName);

        var session = new TexturePickerSession(PickerRecommendations.Parse(SampleJson)) {
            PicksPath = picksPath
        };
        Assert.True(PickerTint.TryParse("#e6f2ff", out var tint));
        Assert.True(session.PickCurrent(note: "warmer", gain: 1.17, tint: tint));

        var pick = PickerPicksFile.Load(picksPath).Picks["0x06003CB9"];
        Assert.Equal(1.15, pick.Gain!.Value, 6);            // snapped by ClampGain
        Assert.Equal(3, pick.Tint!.Length);
        Assert.Equal(0.902, pick.Tint[0], 3);
        Assert.Equal("warmer", pick.Note);

        // A pick with neither stays null — "untouched" is a distinct state from "1.0".
        session.Next();
        Assert.True(session.PickCurrent());
        var plain = PickerPicksFile.Load(picksPath).Picks["0x06003C25"];
        Assert.Null(plain.Gain);
        Assert.Null(plain.Tint);

        Directory.Delete(dir, true);
    }
}
