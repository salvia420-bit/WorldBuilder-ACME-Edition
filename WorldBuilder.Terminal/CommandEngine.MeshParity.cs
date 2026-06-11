using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using DRW = DatReaderWriter;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave 4.C + 4.D — Mesh-parity (GfxObj + Setup) and EnvCell-parity sweeps.
///
/// See <c>docs/diagnostic-toolset-plan-2026-05-19.md</c> §3 row 11 and §6
/// Wave 4 W4.C + W4.D. Sibling to <c>CommandEngine.TextureParity.cs</c>
/// (W4.A + W4.B) and <c>CommandEngine.DatParity.cs</c> (W2.A/B/D); same
/// pattern: one partial, two chunk commands, sha-keyed result cache,
/// resumable. The validator (<c>validate_mesh_parity.cjs</c>) drives both
/// commands plus the Rust <c>parse_dat_record</c> example binary and
/// performs the cross-port diff in JS.
///
/// <para>
/// Commands in this file:
/// </para>
///
/// <list type="bullet">
///   <item>
///     <c>mesh-vs-obj-export-chunk &lt;startId&gt; &lt;endId&gt;</c> — for
///     every <see cref="DRW.DBObjs.GfxObj"/> and <see cref="DRW.DBObjs.Setup"/>
///     in the half-open ID range, parse via the Chorizite (DRW) oracle,
///     count surfaces / vertices / polygons / physics-polys / BSP presence,
///     sha-key the result by raw DAT bytes, and emit a chunk-level
///     <c>progress.json</c>. The validator diffs these counts against the
///     Rust-side <c>holtburger-dat::file_type::GfxObj</c> /
///     <c>SetupModel</c> output of <c>parse_dat_record</c>.
///   </item>
///   <item>
///     <c>env-cell-vs-setup-model-chunk &lt;startId&gt; &lt;endId&gt;</c> —
///     for every <see cref="DRW.DBObjs.EnvCell"/> in the half-open ID
///     range, parse via Chorizite, capture portal/surface/visible-cell
///     counts + flags / cell-id / position, sha-key, emit progress.
///     The validator diffs against Rust EnvCell. <c>visibleCells[]</c>
///     ordering on at least one record (<c>0x72040335</c>) is a known
///     Wave 2.D drift — the validator allowlists / categorizes it.
///   </item>
/// </list>
///
/// <para>
/// **Chunk-resume contract** (mirrors W4.A/B):
/// Each chunk writes one per-chunk <c>progress-&lt;chunkLabel&gt;.json</c>
/// under the cache root, keyed by the DAT sha256 + chunk record count.
/// A re-run whose DAT sha + chunk record count match the sealed
/// progress.json short-circuits the whole chunk (all-or-nothing resume,
/// reported as <c>resumedRecordCount</c>); there is NO per-record
/// <c>&lt;sha&gt;.json</c> cache. Base DATs are immutable per
/// [[feedback_base_dats_only_for_bake]], so steady-state diag-run-all
/// repeats skip the entire chunk parse.
/// </para>
///
/// <para>
/// **Why counts, not full field-by-field**: Wave 2.D already covers full
/// field-tree diff (<c>chorizite-parse-dat-record</c>). This brick is the
/// _surface_ check — geometry topology (poly count, vertex count, surface
/// list, BSP presence) is what the renderer + collision actually consume.
/// Drift here indicates a wire-layout bug that escaped the W2.D smoke,
/// usually because the rare-record path wasn't exercised. Whole-DAT sweep
/// at this level catches the long tail.
/// </para>
///
/// <para>
/// Source-of-truth precedence per [[feedback_dat_parser_mislabels]]: when
/// DRW disagrees with <c>~/ac-headers/acclient.c::CGfxObj::*</c> /
/// <c>CEnvCell::*</c>, acclient.c wins. Any such cases land as method-doc
/// footnotes + W4 follow-on tickets.
/// </para>
///
/// <para>
/// Integrity discipline per [[feedback_base_dats_only_for_bake]]: refuses
/// to parse from a DAT bundle whose IDs contain modder-range entries
/// (<c>0x__FFxxxx</c>, with 0xFFFFxxxx iteration metadata exempt).
/// </para>
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────
    //  Result records
    // ─────────────────────────────────────────────────────────────────

    /// <summary>One mesh chunk's roll-up. Holds aggregate counts +
    /// a bounded list of failures (full per-record entries live in the
    /// per-chunk progress JSON next to the cache).</summary>
    public sealed record MeshChunkResult(
        string ChunkLabel,
        string DatPath,
        string DatSha256,
        uint StartId,
        uint EndId,
        int RecordCount,
        int PassCount,
        int FailCount,
        int CachedCount,
        int ParseErrorCount,
        string CacheRoot,
        string ProgressJsonPath,
        IReadOnlyList<MeshRecordResult> Failures,
        string Source);

    /// <summary>Per-record outcome for the chunk. Counts are the
    /// Chorizite-side oracle values; the validator compares them
    /// against the Rust side and decides pass/fail.</summary>
    public sealed record MeshRecordResult(
        string IdHex,
        uint Id,
        string TypeName,
        string RecordSha256,
        string Status,                  // "ok" | "parse-error" | "missing"
        int Surfaces,                   // GfxObj.Surfaces.Count
        int Vertices,                   // GfxObj.VertexArray.Vertices.Count
        int Polygons,                   // GfxObj.Polygons.Count
        int PhysicsPolygons,            // GfxObj.PhysicsPolygons.Count
        bool HasDrawingBsp,
        bool HasPhysicsBsp,
        bool HasDidDegrade,
        // Setup-specific (null for GfxObj):
        int? SetupPartCount,            // Setup.Parts.Count
        int? PlacementFrameCount,       // Setup.PlacementFrames.Count
        int? CylSphereCount,
        int? SphereCount,
        int? LightCount,
        int? HoldingLocationCount,
        int? ConnectionPointCount,
        // EnvCell-specific (null for GfxObj/Setup):
        int? PortalCount,               // EnvCell.CellPortals.Count
        int? VisibleCellCount,          // EnvCell.VisibleCells.Count
        int? EnvSurfaceCount,           // EnvCell.Surfaces.Count
        int? StaticObjectCount,
        int? RestrictionCount,
        int? StabCount,
        uint? EnvCellId,                // .Id of the cell (parsed)
        // Diagnostics:
        string? FailureReason);

    /// <summary>Roll-up of an EnvCell chunk. Same shape as
    /// <see cref="MeshChunkResult"/> — separate type so future divergence
    /// in fields (e.g. visibleCells drift counters) can land here without
    /// rippling through the mesh side.</summary>
    public sealed record EnvCellChunkResult(
        string ChunkLabel,
        string DatPath,
        string DatSha256,
        uint StartId,
        uint EndId,
        int RecordCount,
        int PassCount,
        int FailCount,
        int CachedCount,
        int ParseErrorCount,
        int KnownDriftCount,            // bumped per visibleCells[] drift hits
        string CacheRoot,
        string ProgressJsonPath,
        IReadOnlyList<MeshRecordResult> Failures,
        string Source);

    // Cache + path roots. Configurable via the JSON command; defaults
    // land under the canonical external scratch drive per
    // [[feedback_use_external_drives_for_scratch]].
    private const string DefaultMeshCacheRoot =
        "/mnt/wbterminal1/holtburger-validator-fixtures/wave4/mesh";
    private const string DefaultEnvCacheRoot =
        "/mnt/wbterminal1/holtburger-validator-fixtures/wave4/envcell";

    // Known drift surfaces (per [[project_wave2d_done_2026-05-19]]).
    // EnvCell 0x72040335 visibleCells[] ordering disagrees between
    // Rust and DRW (real cross-port divergence, not allowlist). The
    // chunk command bumps KnownDriftCount per hit; the validator
    // classifies these as DRIFT rather than FAIL.
    //
    // **NOTE** — the EnvCell chunk command does NOT bake the
    // canonical-ordering check (that requires both oracles side-by-
    // side, which is the validator's job). It just COUNTS records
    // that fall in the known-drift allowlist; the validator does
    // the actual diff.
    private static readonly HashSet<uint> KnownEnvCellDriftIds = new() {
        0x72040335u,
    };

    // ─────────────────────────────────────────────────────────────────
    //  mesh-vs-obj-export-chunk
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Sweeps the half-open ID range <c>[startId, endId)</c> across the
    /// portal DAT, parsing every GfxObj (0x01xxxxxx) and Setup (0x02xxxxxx)
    /// via the Chorizite DRW oracle, then sha-keys the raw bytes + caches
    /// the resulting counts. Returns the chunk roll-up.
    ///
    /// <para>
    /// Naming: the ID range is FILE-id (0x01xxxxxx for GfxObj, 0x02xxxxxx
    /// for Setup). A "mesh chunk" can therefore span the GfxObj→Setup
    /// boundary in a single call; the resulting <c>MeshRecordResult.TypeName</c>
    /// disambiguates.
    /// </para>
    ///
    /// <para>
    /// <paramref name="cacheRoot"/> defaults to
    /// <c>/mnt/wbterminal1/holtburger-validator-fixtures/wave4/mesh</c>
    /// per [[feedback_use_external_drives_for_scratch]]. A null or empty/
    /// whitespace string is coerced to that default root — the cache (the
    /// per-chunk <c>progress-*.json</c> resume file) is always enabled; it
    /// cannot be disabled via this parameter.
    /// </para>
    ///
    /// <para>
    /// <paramref name="fastMode"/> selects the Holtburg subset: the
    /// validator hands us the 81-model Holtburg subset (from
    /// <c>fetch_landblock_objects(0xA9B4)</c>) via
    /// <paramref name="fastModeIds"/> instead of the whole-range walk.
    /// fastMode only takes effect when <paramref name="fastModeIds"/> is
    /// non-empty; when fastMode is true but no ids are supplied the code
    /// falls back to the full <c>[startId, endId)</c> BTree walk. This is
    /// the per-commit CI gate per §6 W4 architecture.
    /// </para>
    /// </summary>
    public MeshChunkResult MeshVsObjExportChunk(
        uint startId, uint endId,
        string? datPath, string? cacheRoot,
        bool fastMode,
        IReadOnlyList<uint>? fastModeIds = null) {

        var resolved = ResolveDatPathForType(datPath, typeof(DRW.DBObjs.GfxObj));
        var sha = ComputeDatSha256(resolved);
        var effCacheRoot = string.IsNullOrWhiteSpace(cacheRoot) ? DefaultMeshCacheRoot : cacheRoot!;
        var hasCache = !string.IsNullOrWhiteSpace(effCacheRoot);
        if (hasCache) Directory.CreateDirectory(effCacheRoot);

        using var dat = new DRW.DatDatabase(o => {
            o.FilePath = resolved;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Upfront;
        });

        // Enumerate target IDs.
        var ids = new List<uint>();
        if (fastMode && fastModeIds != null && fastModeIds.Count > 0) {
            // Fast-mode: use the explicit Holtburg subset the validator
            // passed us. We don't filter the prefix here — the validator
            // is responsible for handing us only GfxObj+Setup IDs.
            ids.AddRange(fastModeIds.Where(id => {
                byte p = (byte)(id >> 24);
                return p == 0x01 || p == 0x02;
            }).Distinct().OrderBy(x => x));
        } else {
            // Walk DRW's BTree for any record IDs in [startId, endId)
            // whose prefix is GfxObj (0x01) or Setup (0x02).
            foreach (var id in EnumerateIdsInRange(dat, startId, endId)) {
                byte p = (byte)(id >> 24);
                if (p == 0x01 || p == 0x02) ids.Add(id);
            }
        }

        // Modder-DAT pre-flight per [[feedback_base_dats_only_for_bake]].
        var modderId = FindModderIdAmongIds(ids);
        if (modderId.HasValue) {
            throw new InvalidOperationException(
                $"Modder-range ID detected: 0x{modderId.Value:X8}. Refusing to parse from non-base DAT bundle.");
        }

        // Per-chunk resume: if a progress.json already exists for this
        // chunk + DAT sha, return the cached roll-up without re-parsing.
        // This is the cheap path for diag-run-all repeats. Resume is
        // all-or-nothing at the chunk level; there is no per-record cache.
        // Fast-mode resume key must depend on the actual id SET, not just
        // its count — a different set of the same count must never collide
        // with a prior run's cached results (F70).
        var fastSig = (fastMode && fastModeIds != null && fastModeIds.Count > 0)
            ? $"-ids{ComputeFastModeIdsHash(ids)}"
            : "";
        var chunkLabel = $"mesh-{startId:X8}-{endId:X8}{(fastMode ? "-fast" : "")}{fastSig}";
        var progressPath = hasCache
            ? Path.Combine(effCacheRoot, $"progress-{chunkLabel}.json")
            : "";
        if (!string.IsNullOrEmpty(progressPath) && File.Exists(progressPath)) {
            var resumeOpt = TryResumeChunk(progressPath, sha, ids.Count);
            if (resumeOpt is MeshChunkResult resumed) {
                return resumed with {
                    ChunkLabel = chunkLabel,
                    DatPath = resolved,
                    StartId = startId,
                    EndId = endId,
                    CacheRoot = effCacheRoot,
                    ProgressJsonPath = progressPath,
                    Source = $"MeshVsObjExportChunk RESUMED from {progressPath}",
                };
            }
        }

        var failures = new List<MeshRecordResult>();
        var perRecord = new List<MeshRecordResult>(ids.Count);
        int pass = 0, fail = 0, parseErr = 0;

        foreach (var id in ids) {
            var bytes = TryReadRecordBytes(dat, id);
            if (bytes == null) {
                var miss = MakeMissingRecord(id, "GfxObj/Setup not present in DAT");
                perRecord.Add(miss);
                fail++;
                failures.Add(miss);
                continue;
            }
            var recordSha = ComputeRecordSha256(bytes);

            MeshRecordResult rec;
            try {
                rec = ParseMeshRecord(dat, id, recordSha);
                switch (rec.Status) {
                    case "ok":
                        pass++;
                        break;
                    case "parse-error":
                        parseErr++;
                        failures.Add(rec);
                        break;
                    case "missing":
                        fail++;
                        failures.Add(rec);
                        break;
                    default:
                        fail++;
                        failures.Add(rec);
                        break;
                }
            } catch (Exception ex) {
                rec = MakeParseErrorRecord(id, recordSha, ex.Message);
                parseErr++;
                failures.Add(rec);
            }
            perRecord.Add(rec);
        }

        // Per-chunk progress.json. Includes ALL per-record entries — the
        // sweep orchestrator (W4.E, sibling agent) parses this for resume
        // bookkeeping. Cap failure detail for the in-memory return
        // (≤32); full detail always lands on disk.
        if (!string.IsNullOrEmpty(progressPath)) {
            WriteProgressJson(progressPath, chunkLabel, startId, endId, sha, perRecord);
        }

        return new MeshChunkResult(
            ChunkLabel: chunkLabel,
            DatPath: resolved,
            DatSha256: sha,
            StartId: startId,
            EndId: endId,
            RecordCount: ids.Count,
            PassCount: pass,
            FailCount: fail + parseErr,
            CachedCount: 0,    // resumed-record count: 0 on a live parse; whole-chunk on resume (handled above). No per-record cache exists.
            ParseErrorCount: parseErr,
            CacheRoot: effCacheRoot,
            ProgressJsonPath: progressPath,
            Failures: failures.Take(32).ToList(),
            Source: $"MeshVsObjExportChunk via DatReaderWriter on {Path.GetFileName(resolved)} (sha {sha[..12]}…); contract per acclient.c::CGfxObj::*");
    }

    // ─────────────────────────────────────────────────────────────────
    //  env-cell-vs-setup-model-chunk
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Sweeps the half-open ID range <c>[startId, endId)</c> across the
    /// cell DAT, parsing every EnvCell (suffix in <c>[0x0001, 0xFFFD]</c>,
    /// any non-portal high-byte prefix) via the Chorizite DRW oracle.
    /// Counts portals / surfaces / visible-cells / restrictions / stabs;
    /// captures the cell's <c>.Id</c> + position + flags. Result is the
    /// chunk roll-up matching <see cref="MeshChunkResult"/>'s shape.
    ///
    /// <para>
    /// <c>visibleCells[]</c> ordering drift on <c>0x72040335</c> (per
    /// W2.D) is COUNTED here via <see cref="EnvCellChunkResult.KnownDriftCount"/>
    /// — but NOT classified as FAIL. The validator does the actual diff
    /// against the Rust side. This chunk command just emits the
    /// Chorizite-side topology snapshot for that downstream diff.
    /// </para>
    ///
    /// <para>
    /// Fast-mode: when <paramref name="fastMode"/> is true and
    /// <paramref name="fastModeIds"/> is supplied (e.g. Academy 568
    /// EnvCells from LB 0x8602), only those IDs are walked. The
    /// validator's fast-mode shipping default is Academy because it has
    /// the highest cell density per LB in the canonical retail data.
    /// </para>
    /// </summary>
    public EnvCellChunkResult EnvCellVsSetupModelChunk(
        uint startId, uint endId,
        string? datPath, string? cacheRoot,
        bool fastMode,
        IReadOnlyList<uint>? fastModeIds = null) {

        var resolved = ResolveDatPathForType(datPath, typeof(DRW.DBObjs.EnvCell));
        var sha = ComputeDatSha256(resolved);
        var effCacheRoot = string.IsNullOrWhiteSpace(cacheRoot) ? DefaultEnvCacheRoot : cacheRoot!;
        var hasCache = !string.IsNullOrWhiteSpace(effCacheRoot);
        if (hasCache) Directory.CreateDirectory(effCacheRoot);

        using var dat = new DRW.DatDatabase(o => {
            o.FilePath = resolved;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Upfront;
        });

        var ids = new List<uint>();
        if (fastMode && fastModeIds != null && fastModeIds.Count > 0) {
            ids.AddRange(fastModeIds.Where(IsEnvCellId).Distinct().OrderBy(x => x));
        } else {
            foreach (var id in EnumerateIdsInRange(dat, startId, endId)) {
                if (IsEnvCellId(id)) ids.Add(id);
            }
        }

        // Modder-DAT pre-flight.
        var modderId = FindModderIdAmongIds(ids);
        if (modderId.HasValue) {
            throw new InvalidOperationException(
                $"Modder-range ID detected: 0x{modderId.Value:X8}. Refusing to parse from non-base DAT bundle.");
        }

        // Fast-mode resume key must depend on the actual id SET, not just
        // its count — a different set of the same count must never collide
        // with a prior run's cached results (F70).
        var fastSig = (fastMode && fastModeIds != null && fastModeIds.Count > 0)
            ? $"-ids{ComputeFastModeIdsHash(ids)}"
            : "";
        var chunkLabel = $"envcell-{startId:X8}-{endId:X8}{(fastMode ? "-fast" : "")}{fastSig}";
        var progressPath = hasCache
            ? Path.Combine(effCacheRoot, $"progress-{chunkLabel}.json")
            : "";

        // Resume-from-progress: if the same chunk + DAT sha was sealed
        // by a previous run, return the rolled-up counts without
        // re-parsing. The progress.json is the source of truth for
        // resumability; resume is all-or-nothing at the chunk level
        // (there is no per-record sha-cache).
        if (!string.IsNullOrEmpty(progressPath) && File.Exists(progressPath)) {
            var resumeOpt = TryResumeEnvCellChunk(progressPath, sha, ids.Count);
            if (resumeOpt is EnvCellChunkResult resumed) {
                return resumed with {
                    ChunkLabel = chunkLabel,
                    DatPath = resolved,
                    StartId = startId,
                    EndId = endId,
                    CacheRoot = effCacheRoot,
                    ProgressJsonPath = progressPath,
                    Source = $"EnvCellVsSetupModelChunk RESUMED from {progressPath}",
                };
            }
        }

        var failures = new List<MeshRecordResult>();
        var perRecord = new List<MeshRecordResult>(ids.Count);
        int pass = 0, fail = 0, parseErr = 0, drift = 0;

        foreach (var id in ids) {
            var bytes = TryReadRecordBytes(dat, id);
            if (bytes == null) {
                var miss = MakeMissingRecord(id, "EnvCell not present in DAT");
                perRecord.Add(miss);
                fail++;
                failures.Add(miss);
                continue;
            }
            var recordSha = ComputeRecordSha256(bytes);

            MeshRecordResult rec;
            try {
                rec = ParseEnvCellRecord(dat, id, recordSha);
                switch (rec.Status) {
                    case "ok":
                        pass++;
                        break;
                    case "parse-error":
                        parseErr++;
                        failures.Add(rec);
                        break;
                    case "missing":
                        fail++;
                        failures.Add(rec);
                        break;
                    default:
                        fail++;
                        failures.Add(rec);
                        break;
                }
                if (KnownEnvCellDriftIds.Contains(id)) drift++;
            } catch (Exception ex) {
                rec = MakeParseErrorRecord(id, recordSha, ex.Message);
                parseErr++;
                failures.Add(rec);
            }
            perRecord.Add(rec);
        }

        if (!string.IsNullOrEmpty(progressPath)) {
            WriteProgressJson(progressPath, chunkLabel, startId, endId, sha, perRecord, drift);
        }

        return new EnvCellChunkResult(
            ChunkLabel: chunkLabel,
            DatPath: resolved,
            DatSha256: sha,
            StartId: startId,
            EndId: endId,
            RecordCount: ids.Count,
            PassCount: pass,
            FailCount: fail + parseErr,
            CachedCount: 0,    // resumed-record count: 0 on a live parse; whole-chunk on resume (handled above). No per-record cache exists.
            ParseErrorCount: parseErr,
            KnownDriftCount: drift,
            CacheRoot: effCacheRoot,
            ProgressJsonPath: progressPath,
            Failures: failures.Take(32).ToList(),
            Source: $"EnvCellVsSetupModelChunk via DatReaderWriter on {Path.GetFileName(resolved)} (sha {sha[..12]}…); contract per acclient.c::CEnvCell::*");
    }

    // ─────────────────────────────────────────────────────────────────
    //  Per-record parse helpers
    // ─────────────────────────────────────────────────────────────────

    private static MeshRecordResult ParseMeshRecord(DRW.DatDatabase dat, uint id, string sha) {
        byte prefix = (byte)(id >> 24);
        if (prefix == 0x01) return ParseGfxObjRecord(dat, id, sha);
        if (prefix == 0x02) return ParseSetupRecord(dat, id, sha);
        return MakeParseErrorRecord(id, sha,
            $"Prefix 0x{prefix:X2} is neither GfxObj (0x01) nor Setup (0x02).");
    }

    private static MeshRecordResult ParseGfxObjRecord(DRW.DatDatabase dat, uint id, string sha) {
        if (!dat.TryGet<DRW.DBObjs.GfxObj>(id, out var gfx) || gfx == null) {
            return new MeshRecordResult(
                IdHex: $"0x{id:X8}", Id: id, TypeName: "GfxObj", RecordSha256: sha,
                Status: "missing",
                Surfaces: 0, Vertices: 0, Polygons: 0, PhysicsPolygons: 0,
                HasDrawingBsp: false, HasPhysicsBsp: false, HasDidDegrade: false,
                SetupPartCount: null, PlacementFrameCount: null,
                CylSphereCount: null, SphereCount: null, LightCount: null,
                HoldingLocationCount: null, ConnectionPointCount: null,
                PortalCount: null, VisibleCellCount: null, EnvSurfaceCount: null,
                StaticObjectCount: null, RestrictionCount: null, StabCount: null,
                EnvCellId: null,
                FailureReason: "DRW TryGet<GfxObj> returned false");
        }
        int verts = SafeCount(gfx.VertexArray?.Vertices);
        return new MeshRecordResult(
            IdHex: $"0x{id:X8}", Id: id, TypeName: "GfxObj", RecordSha256: sha,
            Status: "ok",
            Surfaces: SafeCount(gfx.Surfaces),
            Vertices: verts,
            Polygons: SafeCount(gfx.Polygons),
            PhysicsPolygons: SafeCount(gfx.PhysicsPolygons),
            HasDrawingBsp: gfx.DrawingBSP != null,
            HasPhysicsBsp: gfx.PhysicsBSP != null,
            HasDidDegrade: ReadGfxDidDegrade(gfx).HasValue,
            SetupPartCount: null, PlacementFrameCount: null,
            CylSphereCount: null, SphereCount: null, LightCount: null,
            HoldingLocationCount: null, ConnectionPointCount: null,
            PortalCount: null, VisibleCellCount: null, EnvSurfaceCount: null,
            StaticObjectCount: null, RestrictionCount: null, StabCount: null,
            EnvCellId: null,
            FailureReason: null);
    }

    private static MeshRecordResult ParseSetupRecord(DRW.DatDatabase dat, uint id, string sha) {
        if (!dat.TryGet<DRW.DBObjs.Setup>(id, out var setup) || setup == null) {
            return new MeshRecordResult(
                IdHex: $"0x{id:X8}", Id: id, TypeName: "Setup", RecordSha256: sha,
                Status: "missing",
                Surfaces: 0, Vertices: 0, Polygons: 0, PhysicsPolygons: 0,
                HasDrawingBsp: false, HasPhysicsBsp: false, HasDidDegrade: false,
                SetupPartCount: 0, PlacementFrameCount: 0,
                CylSphereCount: 0, SphereCount: 0, LightCount: 0,
                HoldingLocationCount: 0, ConnectionPointCount: 0,
                PortalCount: null, VisibleCellCount: null, EnvSurfaceCount: null,
                StaticObjectCount: null, RestrictionCount: null, StabCount: null,
                EnvCellId: null,
                FailureReason: "DRW TryGet<Setup> returned false");
        }
        // Setup carries no surfaces/vertices/polygons directly — those
        // live in its part GfxObjs. The "counts" we record here are the
        // Setup's own topology: parts, placement frames, spheres, lights.
        return new MeshRecordResult(
            IdHex: $"0x{id:X8}", Id: id, TypeName: "Setup", RecordSha256: sha,
            Status: "ok",
            Surfaces: 0, Vertices: 0, Polygons: 0, PhysicsPolygons: 0,
            HasDrawingBsp: false, HasPhysicsBsp: false, HasDidDegrade: false,
            SetupPartCount: SafeCount(setup.Parts),
            PlacementFrameCount: SafeCount(setup.PlacementFrames),
            CylSphereCount: SafeCount(setup.CylSpheres),
            SphereCount: SafeCount(setup.Spheres),
            LightCount: SafeCount(setup.Lights),
            HoldingLocationCount: SafeCount(setup.HoldingLocations),
            ConnectionPointCount: SafeCount(setup.ConnectionPoints),
            PortalCount: null, VisibleCellCount: null, EnvSurfaceCount: null,
            StaticObjectCount: null, RestrictionCount: null, StabCount: null,
            EnvCellId: null,
            FailureReason: null);
    }

    private static MeshRecordResult ParseEnvCellRecord(DRW.DatDatabase dat, uint id, string sha) {
        if (!dat.TryGet<DRW.DBObjs.EnvCell>(id, out var cell) || cell == null) {
            return new MeshRecordResult(
                IdHex: $"0x{id:X8}", Id: id, TypeName: "EnvCell", RecordSha256: sha,
                Status: "missing",
                Surfaces: 0, Vertices: 0, Polygons: 0, PhysicsPolygons: 0,
                HasDrawingBsp: false, HasPhysicsBsp: false, HasDidDegrade: false,
                SetupPartCount: null, PlacementFrameCount: null,
                CylSphereCount: null, SphereCount: null, LightCount: null,
                HoldingLocationCount: null, ConnectionPointCount: null,
                PortalCount: 0, VisibleCellCount: 0, EnvSurfaceCount: 0,
                StaticObjectCount: 0, RestrictionCount: 0, StabCount: 0,
                EnvCellId: null,
                FailureReason: "DRW TryGet<EnvCell> returned false");
        }
        return new MeshRecordResult(
            IdHex: $"0x{id:X8}", Id: id, TypeName: "EnvCell", RecordSha256: sha,
            Status: "ok",
            Surfaces: 0, Vertices: 0, Polygons: 0, PhysicsPolygons: 0,
            HasDrawingBsp: false, HasPhysicsBsp: false, HasDidDegrade: false,
            SetupPartCount: null, PlacementFrameCount: null,
            CylSphereCount: null, SphereCount: null, LightCount: null,
            HoldingLocationCount: null, ConnectionPointCount: null,
            PortalCount: ReadEnvCellCount(cell, "CellPortals", "Portals"),
            VisibleCellCount: ReadEnvCellCount(cell, "VisibleCells"),
            EnvSurfaceCount: ReadEnvCellCount(cell, "Surfaces"),
            StaticObjectCount: ReadEnvCellCount(cell, "StaticObjects", "StaticObjs", "StaticObjectsList"),
            RestrictionCount: ReadEnvCellCount(cell, "RestrictionObj", "Restrictions"),
            StabCount: ReadEnvCellCount(cell, "Stabs"),
            EnvCellId: ReadUintField(cell, "Id") ?? id,
            FailureReason: null);
    }

    // ─────────────────────────────────────────────────────────────────
    //  Reflection helpers — DRW source-gen exposes fields, not props
    // ─────────────────────────────────────────────────────────────────

    private static int SafeCount(object? obj) {
        if (obj == null) return 0;
        if (obj is ICollection coll) return coll.Count;
        if (obj is IEnumerable enu) {
            int n = 0;
            foreach (var _ in enu) n++;
            return n;
        }
        return 0;
    }

    /// <summary>
    /// Read an <see cref="ICollection"/>-like field/property by name with
    /// a fallback list (mirrors <see cref="GetPortalsList"/> from
    /// <c>CommandEngine.CellPortalGraph.cs</c>). Returns the Count, or
    /// 0 if the member is missing or null.
    /// </summary>
    private static int ReadEnvCellCount(object envCell, params string[] memberNames) {
        var t = envCell.GetType();
        foreach (var name in memberNames) {
            var field = t.GetField(name);
            if (field != null) {
                var v = field.GetValue(envCell);
                if (v != null) return SafeCount(v);
            }
            var prop = t.GetProperty(name);
            if (prop != null) {
                var v = prop.GetValue(envCell);
                if (v != null) return SafeCount(v);
            }
        }
        return 0;
    }

    /// <summary>
    /// Read a uint-typed field/property by name. Returns null if absent
    /// or non-uint.
    /// </summary>
    private static uint? ReadUintField(object obj, string name) {
        var t = obj.GetType();
        var field = t.GetField(name);
        object? v = field != null
            ? field.GetValue(obj)
            : t.GetProperty(name)?.GetValue(obj);
        if (v == null) return null;
        try { return Convert.ToUInt32(v); } catch { return null; }
    }

    /// <summary>
    /// Read the GfxObj's <c>DidDegrade</c> (LOD chain entry) if present.
    /// DRW exposes this as a uint? (or 0 = none); we treat 0 as absent
    /// to match the holtburger-dat <see cref="ulong"/>-wrapped Option.
    /// </summary>
    private static uint? ReadGfxDidDegrade(DRW.DBObjs.GfxObj gfx) {
        var t = gfx.GetType();
        var member = (object?)t.GetField("DegradeId") ?? t.GetField("DidDegrade")
                    ?? (object?)t.GetProperty("DegradeId") ?? t.GetProperty("DidDegrade");
        if (member == null) return null;
        object? raw = member switch {
            FieldInfo f => f.GetValue(gfx),
            PropertyInfo p => p.GetValue(gfx),
            _ => null,
        };
        if (raw == null) return null;
        try {
            uint v = Convert.ToUInt32(raw);
            return v == 0u ? null : v;
        } catch {
            return null;
        }
    }

    /// <summary>
    /// True for cell-DAT IDs whose suffix is in <c>[0x0001, 0xFFFD]</c>
    /// (excluding 0xFFFF0001 iteration metadata + LandBlock 0xFFFF +
    /// LandBlockInfo 0xFFFE). Matches the cell-DAT discrimination logic
    /// in <c>CommandEngine.DatParity.cs</c>.
    /// </summary>
    private static bool IsEnvCellId(uint id) {
        if (id == 0xFFFF0001u) return false;
        var suffix = id & 0xFFFFu;
        return suffix >= 0x0001u && suffix <= 0xFFFDu;
    }

    /// <summary>
    /// Walk DRW's BTree for any record IDs in <c>[start, end)</c>. Uses
    /// reflection onto the public <c>Tree</c> field on
    /// <see cref="DRW.DatDatabase"/> per the pattern in
    /// <c>CommandEngine.DatParity.cs::EnumerateIdsForType</c>.
    /// </summary>
    private static IEnumerable<uint> EnumerateIdsInRange(DRW.DatDatabase dat, uint start, uint end) {
        var treeField = typeof(DRW.DatDatabase).GetField("Tree",
            BindingFlags.Public | BindingFlags.Instance)
            ?? throw new InvalidOperationException(
                "Reflection probe failed: DRW.DatDatabase.Tree field not found — DRW API drift. " +
                "Refusing to degrade to an empty id sweep.");
        var tree = treeField.GetValue(dat)
            ?? throw new InvalidOperationException(
                "Reflection probe failed: DRW.DatDatabase.Tree is null. " +
                "Refusing to degrade to an empty id sweep.");
        var getFilesInRange = tree.GetType().GetMethods()
            .FirstOrDefault(m => m.Name == "GetFilesInRange" && m.GetParameters().Length == 2)
            ?? throw new InvalidOperationException(
                $"Reflection probe failed: {tree.GetType().FullName}.GetFilesInRange(2-arg) not found — DRW API drift. " +
                "Refusing to degrade to an empty id sweep.");
        // GetFilesInRange is inclusive on both ends; our caller's
        // semantics are half-open [start, end). Pass end-1 to mirror.
        uint inclusiveEnd = end == 0 ? 0 : (end - 1);
        var entries = getFilesInRange.Invoke(tree, new object[] { start, inclusiveEnd });
        if (entries == null) yield break;
        PropertyInfo? idProp = null;
        foreach (var entry in (IEnumerable)entries) {
            idProp ??= entry.GetType().GetProperty("Id") ?? throw new InvalidOperationException(
                "DatBTreeFile lacks .Id property — DRW API drift.");
            uint id = Convert.ToUInt32(idProp.GetValue(entry) ?? 0u);
            if (id >= start && id < end) yield return id;
        }
    }

    /// <summary>
    /// Read the raw (decompressed) record bytes via DRW's
    /// <c>TryGetFileBytes(uint, out byte[], bool autoDecompress=true)</c>.
    /// Returns null only when the record is genuinely absent. Bytes are
    /// post-decompression — same shape the holtburger-dat Rust parser
    /// sees through <c>DatDatabase.get_file</c>; hashing these gives us
    /// a stable cross-port sha for the cache key.
    /// </summary>
    private static byte[]? TryReadRecordBytes(DRW.DatDatabase dat, uint id) {
        // TryGetFileBytes(uint, out byte[], bool) — canonical public API
        // per DRW DatDatabase.cs:141-160. Find by signature: 3-arg, second
        // is byref byte[], third is bool default-true.
        var mi = typeof(DRW.DatDatabase).GetMethods()
            .FirstOrDefault(m => m.Name == "TryGetFileBytes"
                && m.GetParameters().Length == 3
                && m.GetParameters()[1].ParameterType.IsByRef
                && m.GetParameters()[1].ParameterType.GetElementType() == typeof(byte[]))
            ?? throw new InvalidOperationException(
                "Reflection probe failed: DRW.DatDatabase.TryGetFileBytes(uint, out byte[], bool) not found — DRW API drift. " +
                "Refusing to degrade to an all-missing sweep.");
        var args = new object?[] { id, null, true };
        bool ok;
        try {
            ok = (bool)(mi.Invoke(dat, args) ?? false);
        } catch {
            return null;
        }
        if (!ok || args[1] == null) return null;
        return args[1] as byte[];
    }

    /// <summary>
    /// 12-char hex digest over the SORTED, distinct fast-mode id set. Folded
    /// into the chunk label so a fast-mode resume key never collides with a
    /// prior run that passed a DIFFERENT id set of the same COUNT (F70).
    /// </summary>
    private static string ComputeFastModeIdsHash(IReadOnlyList<uint> ids) {
        var sorted = ids.Distinct().OrderBy(x => x).ToList();
        var buf = new byte[sorted.Count * 4];
        for (int i = 0; i < sorted.Count; i++)
            BitConverter.GetBytes(sorted[i]).CopyTo(buf, i * 4);
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(buf);
        return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant()[..12];
    }

    private static string ComputeRecordSha256(byte[] bytes) {
        using var sha = SHA256.Create();
        var hash = sha.ComputeHash(bytes);
        // Full 64-char lowercase hex of the sha256 over the record's
        // decompressed bytes — the in-payload per-record identifier.
        return BitConverter.ToString(hash).Replace("-", "").ToLowerInvariant();
    }

    private static MeshRecordResult MakeCachedRecord(uint id, string sha) {
        byte prefix = (byte)(id >> 24);
        string typeName = prefix == 0x01 ? "GfxObj"
                        : prefix == 0x02 ? "Setup"
                        : "EnvCell";
        return new MeshRecordResult(
            IdHex: $"0x{id:X8}", Id: id, TypeName: typeName, RecordSha256: sha,
            Status: "cached",
            Surfaces: 0, Vertices: 0, Polygons: 0, PhysicsPolygons: 0,
            HasDrawingBsp: false, HasPhysicsBsp: false, HasDidDegrade: false,
            SetupPartCount: null, PlacementFrameCount: null,
            CylSphereCount: null, SphereCount: null, LightCount: null,
            HoldingLocationCount: null, ConnectionPointCount: null,
            PortalCount: null, VisibleCellCount: null, EnvSurfaceCount: null,
            StaticObjectCount: null, RestrictionCount: null, StabCount: null,
            EnvCellId: null,
            FailureReason: null);
    }

    private static MeshRecordResult MakeMissingRecord(uint id, string reason) {
        byte prefix = (byte)(id >> 24);
        string typeName = prefix == 0x01 ? "GfxObj"
                        : prefix == 0x02 ? "Setup"
                        : "EnvCell";
        return new MeshRecordResult(
            IdHex: $"0x{id:X8}", Id: id, TypeName: typeName, RecordSha256: "",
            Status: "missing",
            Surfaces: 0, Vertices: 0, Polygons: 0, PhysicsPolygons: 0,
            HasDrawingBsp: false, HasPhysicsBsp: false, HasDidDegrade: false,
            SetupPartCount: null, PlacementFrameCount: null,
            CylSphereCount: null, SphereCount: null, LightCount: null,
            HoldingLocationCount: null, ConnectionPointCount: null,
            PortalCount: null, VisibleCellCount: null, EnvSurfaceCount: null,
            StaticObjectCount: null, RestrictionCount: null, StabCount: null,
            EnvCellId: null,
            FailureReason: reason);
    }

    private static MeshRecordResult MakeParseErrorRecord(uint id, string sha, string reason) {
        byte prefix = (byte)(id >> 24);
        string typeName = prefix == 0x01 ? "GfxObj"
                        : prefix == 0x02 ? "Setup"
                        : "EnvCell";
        return new MeshRecordResult(
            IdHex: $"0x{id:X8}", Id: id, TypeName: typeName, RecordSha256: sha,
            Status: "parse-error",
            Surfaces: 0, Vertices: 0, Polygons: 0, PhysicsPolygons: 0,
            HasDrawingBsp: false, HasPhysicsBsp: false, HasDidDegrade: false,
            SetupPartCount: null, PlacementFrameCount: null,
            CylSphereCount: null, SphereCount: null, LightCount: null,
            HoldingLocationCount: null, ConnectionPointCount: null,
            PortalCount: null, VisibleCellCount: null, EnvSurfaceCount: null,
            StaticObjectCount: null, RestrictionCount: null, StabCount: null,
            EnvCellId: null,
            FailureReason: reason);
    }

    // ─────────────────────────────────────────────────────────────────
    //  Resume + progress-json I/O
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Inspect a previously-written progress.json. If its <c>datSha256</c>
    /// matches the current DAT sha AND its <c>recordCount</c> matches the
    /// requested chunk record count, parse the roll-up + return a
    /// freshly-shaped <see cref="MeshChunkResult"/> with the cached pass/
    /// fail/parse-error totals. Returns null when the file is missing,
    /// malformed, or stale (chunk record count drift = re-parse).
    /// </summary>
    private static MeshChunkResult? TryResumeChunk(string progressPath, string datSha, int expectedRecordCount) {
        try {
            var jsonText = File.ReadAllText(progressPath);
            var node = JsonNode.Parse(jsonText);
            if (node == null) return null;
            var prevSha = node["datSha256"]?.GetValue<string>();
            if (prevSha != datSha) return null;
            var prevRecordCount = node["recordCount"]?.GetValue<int>() ?? -1;
            if (prevRecordCount != expectedRecordCount) return null;
            var stat = node["statusHistogram"];
            if (stat == null) return null;
            int pass = stat["ok"]?.GetValue<int>() ?? 0;
            int parseErr = stat["parseError"]?.GetValue<int>() ?? 0;
            int missing = stat["missing"]?.GetValue<int>() ?? 0;
            int other = stat["other"]?.GetValue<int>() ?? 0;
            int fail = missing + other;
            var failures = new List<MeshRecordResult>();
            var sampleArr = node["failureSample"]?.AsArray();
            if (sampleArr != null) {
                foreach (var rec in sampleArr) {
                    if (rec == null) continue;
                    if (failures.Count < 32) failures.Add(ResumeFailureFromNode(rec));
                }
            }
            return new MeshChunkResult(
                ChunkLabel: "",
                DatPath: "",
                DatSha256: datSha,
                StartId: 0,
                EndId: 0,
                RecordCount: prevRecordCount,
                PassCount: pass,
                FailCount: fail + parseErr,
                CachedCount: prevRecordCount,    // entire chunk = cached on resume
                ParseErrorCount: parseErr,
                CacheRoot: "",
                ProgressJsonPath: progressPath,
                Failures: failures,
                Source: $"RESUMED from {progressPath}");
        } catch {
            return null;
        }
    }

    /// <summary>EnvCell variant of <see cref="TryResumeChunk"/> — same
    /// contract, but resumes into <see cref="EnvCellChunkResult"/> and
    /// counts <c>0x72040335</c>-style known-drift hits.</summary>
    private static EnvCellChunkResult? TryResumeEnvCellChunk(string progressPath, string datSha, int expectedRecordCount) {
        try {
            var jsonText = File.ReadAllText(progressPath);
            var node = JsonNode.Parse(jsonText);
            if (node == null) return null;
            var prevSha = node["datSha256"]?.GetValue<string>();
            if (prevSha != datSha) return null;
            var prevRecordCount = node["recordCount"]?.GetValue<int>() ?? -1;
            if (prevRecordCount != expectedRecordCount) return null;
            var stat = node["statusHistogram"];
            if (stat == null) return null;
            int pass = stat["ok"]?.GetValue<int>() ?? 0;
            int parseErr = stat["parseError"]?.GetValue<int>() ?? 0;
            int missing = stat["missing"]?.GetValue<int>() ?? 0;
            int other = stat["other"]?.GetValue<int>() ?? 0;
            int fail = missing + other;
            // Drift count is persisted alongside (compact form).
            int drift = node["knownDriftCount"]?.GetValue<int>() ?? 0;
            var failures = new List<MeshRecordResult>();
            var sampleArr = node["failureSample"]?.AsArray();
            if (sampleArr != null) {
                foreach (var rec in sampleArr) {
                    if (rec == null) continue;
                    if (failures.Count < 32) failures.Add(ResumeFailureFromNode(rec));
                }
            }
            return new EnvCellChunkResult(
                ChunkLabel: "",
                DatPath: "",
                DatSha256: datSha,
                StartId: 0,
                EndId: 0,
                RecordCount: prevRecordCount,
                PassCount: pass,
                FailCount: fail + parseErr,
                CachedCount: prevRecordCount,
                ParseErrorCount: parseErr,
                KnownDriftCount: drift,
                CacheRoot: "",
                ProgressJsonPath: progressPath,
                Failures: failures,
                Source: $"RESUMED from {progressPath}");
        } catch {
            return null;
        }
    }

    private static MeshRecordResult ResumeFailureFromNode(JsonNode node) {
        var idHex = node["idHex"]?.GetValue<string>() ?? "0x00000000";
        var status = node["status"]?.GetValue<string>() ?? "unknown";
        var typeName = node["typeName"]?.GetValue<string>() ?? "Unknown";
        var failureReason = node["failureReason"]?.GetValue<string>();
        uint id = 0;
        if (idHex.StartsWith("0x"))
            uint.TryParse(idHex.Substring(2), System.Globalization.NumberStyles.HexNumber, null, out id);
        return new MeshRecordResult(
            IdHex: idHex, Id: id, TypeName: typeName, RecordSha256: "",
            Status: status,
            Surfaces: 0, Vertices: 0, Polygons: 0, PhysicsPolygons: 0,
            HasDrawingBsp: false, HasPhysicsBsp: false, HasDidDegrade: false,
            SetupPartCount: null, PlacementFrameCount: null,
            CylSphereCount: null, SphereCount: null, LightCount: null,
            HoldingLocationCount: null, ConnectionPointCount: null,
            PortalCount: null, VisibleCellCount: null, EnvSurfaceCount: null,
            StaticObjectCount: null, RestrictionCount: null, StabCount: null,
            EnvCellId: null,
            FailureReason: failureReason);
    }

    /// <summary>
    /// Per-chunk progress JSON — orchestrator (W4.E) parses this for
    /// resume bookkeeping. Format is COMPACT: just aggregate counts +
    /// a status-histogram + the ≤32-entry failure sample. We do NOT
    /// emit per-record entries here: at full-DAT scale (734,976
    /// EnvCells × ~600 bytes/entry ≈ 432 MB) the file blows out the
    /// resume code's working set. The chunk progress.json is the
    /// resume-skip predicate; there is no per-record sha-cache.
    ///
    /// Written atomically (write-to-tmp, rename) so a SIGKILL
    /// mid-write doesn't corrupt the resume cache.
    /// </summary>
    private static void WriteProgressJson(
        string path, string chunkLabel, uint start, uint end, string datSha,
        IReadOnlyList<MeshRecordResult> perRecord,
        int driftCount = 0) {
        int okCount = 0, parseErrCount = 0, missingCount = 0, otherCount = 0;
        var failureSample = new List<MeshRecordResult>(32);
        var typeNameHist = new Dictionary<string, int>();
        foreach (var r in perRecord) {
            switch (r.Status) {
                case "ok":
                case "cached":
                    okCount++;
                    break;
                case "parse-error":
                    parseErrCount++;
                    if (failureSample.Count < 32) failureSample.Add(r);
                    break;
                case "missing":
                    missingCount++;
                    if (failureSample.Count < 32) failureSample.Add(r);
                    break;
                default:
                    otherCount++;
                    if (failureSample.Count < 32) failureSample.Add(r);
                    break;
            }
            if (!typeNameHist.ContainsKey(r.TypeName)) typeNameHist[r.TypeName] = 0;
            typeNameHist[r.TypeName] = typeNameHist[r.TypeName] + 1;
        }
        var doc = new {
            chunkLabel,
            startId = $"0x{start:X8}",
            endId = $"0x{end:X8}",
            datSha256 = datSha,
            recordCount = perRecord.Count,
            knownDriftCount = driftCount,
            generatedAtUtc = DateTime.UtcNow.ToString("o"),
            statusHistogram = new {
                ok = okCount,
                parseError = parseErrCount,
                missing = missingCount,
                other = otherCount,
            },
            typeHistogram = typeNameHist,
            failureSample = failureSample.Select(r => new {
                idHex = r.IdHex,
                typeName = r.TypeName,
                status = r.Status,
                failureReason = r.FailureReason,
            }),
        };
        // Atomic write: tmp + rename. Protects against SIGKILL mid-write.
        var tmp = path + ".tmp";
        File.WriteAllText(tmp, JsonSerializer.Serialize(doc, MeshJsonOpts));
        try { File.Move(tmp, path, overwrite: true); }
        catch (Exception) { try { File.Delete(tmp); } catch { } }
    }

    private static readonly JsonSerializerOptions MeshJsonOpts = new() {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.Never,
        WriteIndented = false,
    };
}
