using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text.Json;
using SixLabors.ImageSharp;
using SixLabors.ImageSharp.PixelFormats;
using SixLabors.ImageSharp.Formats.Png;
using BCnEncoder.Decoder;
using BCnEncoder.ImageSharp;
using BCnEncoder.Shared;
using DRW = DatReaderWriter;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave 4 W4.A + W4.B — Surface chain + RenderSurface texture decode parity.
///
/// See <c>docs/diagnostic-toolset-plan-2026-05-19.md</c> §3 row 10 and §6
/// Wave 4 (W4.A + W4.B). Sibling to <c>CommandEngine.DatParity.cs</c> (W2),
/// <c>CommandEngine.MotionParity.cs</c> (W3.C), and
/// <c>CommandEngine.CellPortalGraph.cs</c> (W5.A). Provides two commands:
///
///   - <c>chorizite-decode-surface-chunk &lt;startId&gt; &lt;endId&gt;</c>
///     — for every Surface in the half-open range, invoke Chorizite's
///     Surface (0x08……) → SurfaceTexture (0x05……) → RenderSurface (0x06……
///     or 0x07……) chain via DatReaderWriter.Extensions' format-decode
///     switch; emit PNG bytes + sha256 per record plus a chunk-level
///     <c>progress.json</c>. Returns one <see cref="TextureRecordResult"/>
///     per record processed in the range.
///
///   - <c>chorizite-decode-texture-chain-chunk &lt;startId&gt; &lt;endId&gt;</c>
///     — same iterator and same decode path as decode-surface-chunk; the
///     only difference is the echoed <c>command</c> string and a distinct
///     <c>texchain_</c> progress-sidecar prefix so the two commands do not
///     clobber each other's progress.json. The per-record chain shape
///     (solid vs textured, Palette branch vs ClipMap branch) is emitted by
///     both commands via <see cref="TextureRecordResult.ChainKind"/>.
///
/// Contract (per <c>docs/texture-parity-method.md</c>):
///   For every Surface in the portal DAT (~6,152 records), the Chorizite
///   chain produces a deterministic RGBA8 buffer. The cache is sha256-keyed
///   by the raw Surface bytes — re-runs against the same base DATs only
///   re-decode records whose <c>surface_sha256</c> changed (zero, given the
///   immutable-base-DAT discipline per [[feedback_base_dats_only_for_bake]]).
///
/// Source-of-truth precedence per [[feedback_dat_parser_mislabels.md]]:
/// when DRW labels disagree with <c>~/ac-headers/acclient.c</c>,
/// acclient.c wins. The PixelFormat decode switch below mirrors
/// <c>DatReaderWriter.Extensions.DBObjs.RenderSurfaceExtensions.ToRgba8</c>
/// — the canonical Chorizite-side reference — with palette resolution
/// reworked to use a read-only <see cref="DRW.DatDatabase"/> handle
/// (the DRW.Extensions ToRgba8 helper takes a <c>DatEasyWriter</c> which
/// requires <c>DatAccessType.ReadWrite</c>; we never mutate, so we open
/// the DAT read-only and resolve palettes ourselves).
///
/// Cache layout (per plan §6 Wave 4 — "sha-keyed result cache"):
///
///   /mnt/wbterminal1/holtburger-validator-fixtures/wave4/
///     surface/<surface_sha>.json   — TextureRecordResult per surface
///     png/<surface_sha>.png        — decoded RGBA8 PNG bytes
///     progress/<chunk_label>.json  — per-chunk progress sidecar
///
/// External scratch only per [[feedback_use_external_drives_for_scratch]]:
/// the root disk is at 94% as of 2026-05-20; the cache must live under
/// <c>/mnt/wbterminal1/</c>.
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────
    //  Result records
    // ─────────────────────────────────────────────────────────────────

    public sealed record TextureChunkResult(
        string ChunkLabel,
        uint StartId,
        uint EndId,
        int RecordCount,
        int PassCount,
        int FailCount,
        int CachedCount,
        string ProgressJsonPath,
        string CacheRoot,
        string DatPath,
        string DatSha256,
        IReadOnlyList<TextureRecordResult> Records,
        IReadOnlyList<TextureRecordResult> Failures,
        string Source);

    /// <summary>
    /// Per-Surface texture decode result. <see cref="Status"/> is one of
    /// <c>PASS</c> (decoded + sha computed), <c>CACHED</c> (sha-key hit;
    /// returned from cache without re-decoding), <c>FAIL</c> (decode threw
    /// or palette lookup failed — <see cref="FailureReason"/> populated),
    /// or <c>EMPTY</c> (Surface.Type is Base1Solid with ColorValue=0; no
    /// pixel data to compare). <see cref="MeanRgba"/> is the 4-channel
    /// mean over the decoded pixels — the textured-mean reduction the
    /// JS material decoder uses as a tint fallback.
    /// </summary>
    public sealed record TextureRecordResult(
        string IdHex,
        uint Id,
        string SurfaceSha256,
        string? PixelSha256,
        int Width,
        int Height,
        string Status,
        float[]? MeanRgba,
        string? ChainKind,      // "solid", "textured/palette", "textured/clipmap", "textured/direct"
        uint? SurfaceTextureId,
        uint? RenderSurfaceId,
        uint? PaletteId,
        string? PixelFormat,
        string? FailureReason);

    // Two-level cache: in-process dictionary (process lifetime; ~6,152
    // Surfaces × ~200 bytes each = under 2 MB) + on-disk sha-keyed JSON.
    private static readonly Dictionary<string, TextureRecordResult> _textureCacheRam = new();
    private static readonly object _textureCacheLock = new();

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-decode-surface-chunk
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Decode every Surface in the half-open range <c>[startId, endId)</c>
    /// via Chorizite's DBObj chain + RenderSurfaceExtensions-equivalent
    /// format decode. Emits PNG + sha256 per record into the sha-keyed
    /// on-disk cache.
    /// </summary>
    public TextureChunkResult ChoriziteDecodeSurfaceChunk(
        uint startId, uint endId,
        string? datPath, string? cacheRoot, bool fastMode, bool emitPng) {
        return DecodeChunkCore(
            startId, endId, datPath, cacheRoot, fastMode, emitPng,
            command: "chorizite-decode-surface-chunk",
            recordChainDetails: false);
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-decode-texture-chain-chunk
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Alias of <see cref="ChoriziteDecodeSurfaceChunk"/> over the identical
    /// decode path; differs only in the echoed command string and a distinct
    /// <c>texchain_</c> progress-sidecar prefix. The per-record chain shape
    /// (solid vs textured, palette branch vs clipmap branch) is emitted by
    /// both via <see cref="TextureRecordResult.ChainKind"/>.
    /// </summary>
    public TextureChunkResult ChoriziteDecodeTextureChainChunk(
        uint startId, uint endId,
        string? datPath, string? cacheRoot, bool fastMode, bool emitPng) {
        return DecodeChunkCore(
            startId, endId, datPath, cacheRoot, fastMode, emitPng,
            command: "chorizite-decode-texture-chain-chunk",
            recordChainDetails: true);
    }

    // ─────────────────────────────────────────────────────────────────
    //  Internals
    // ─────────────────────────────────────────────────────────────────

    private const uint SurfaceFirstId = 0x08000000u;
    private const uint SurfaceLastIdExclusive = 0x08010000u;

    private static IReadOnlyList<uint> ResolveFastModeIds(DRW.DatDatabase dat) {
        // Walk the portal DAT for every Surface ID and sample 81 evenly by stride.
        var allIds = new List<uint>();
        var idx = GetDBObjTypeIndex();
        if (!idx.TryGetValue("Surface", out var surfaceType)) {
            return Array.Empty<uint>();
        }
        foreach (var id in EnumerateIdsForType(dat, surfaceType)) {
            allIds.Add(id);
        }
        if (allIds.Count <= 81) return allIds;
        var stride = allIds.Count / 81;
        var picks = new List<uint>(81);
        for (int i = 0; i < 81 && i * stride < allIds.Count; i++) {
            picks.Add(allIds[i * stride]);
        }
        return picks;
    }

    private TextureChunkResult DecodeChunkCore(
        uint startId, uint endId,
        string? datPath, string? cacheRoot, bool fastMode, bool emitPng,
        string command, bool recordChainDetails) {

        if (startId >= endId) {
            throw new ArgumentException(
                $"startId (0x{startId:X8}) must be < endId (0x{endId:X8})");
        }

        var idx = GetDBObjTypeIndex();
        if (!idx.TryGetValue("Surface", out var surfaceType)
            || !idx.TryGetValue("SurfaceTexture", out var surfaceTextureType)
            || !idx.TryGetValue("RenderSurface", out var renderSurfaceType)
            || !idx.TryGetValue("Palette", out var paletteType)) {
            throw new InvalidOperationException(
                "DBObj index missing Surface/SurfaceTexture/RenderSurface/Palette — DRW API drift.");
        }

        var resolvedDat = ResolveDatPathForType(datPath, surfaceType);
        var datSha = ComputeDatSha256(resolvedDat);
        var resolvedCache = ResolveCacheRoot(cacheRoot);
        EnsureCacheDirs(resolvedCache, emitPng);

        // Optionally narrow to the fast-mode subset.
        IReadOnlyList<uint>? fastModeIds = null;
        if (fastMode) {
            using var datForSubset = new DRW.DatDatabase(o => {
                o.FilePath = resolvedDat;
                o.AccessType = DRW.Options.DatAccessType.Read;
                o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Upfront;
            });
            fastModeIds = ResolveFastModeIds(datForSubset);
        }

        using var dat = new DRW.DatDatabase(o => {
            o.FilePath = resolvedDat;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Upfront;
        });

        var enumerated = EnumerateIdsForType(dat, surfaceType)
            .Where(id => id >= startId && id < endId);
        if (fastModeIds != null) {
            var set = new HashSet<uint>(fastModeIds);
            enumerated = enumerated.Where(set.Contains);
        }
        var ids = enumerated.ToList();
        ids.Sort();

        // Pre-flight modder-DAT guard per [[feedback_base_dats_only_for_bake]].
        var modder = FindModderIdAmongIds(ids);
        if (modder != null) {
            throw new InvalidOperationException(
                $"Surface ID 0x{modder:X8} is in the 0x__FFxxxx modder range. " +
                $"Validator runs against base DATs only.");
        }

        // Palette cache — many Surfaces share the same default Palette
        // (e.g. 0x04000000 family). Per-process LRU at <=512 entries.
        var paletteCache = new Dictionary<uint, DRW.DBObjs.Palette>();

        var results = new List<TextureRecordResult>(ids.Count);
        var failures = new List<TextureRecordResult>();
        int passCount = 0, failCount = 0, cachedCount = 0;

        foreach (var id in ids) {
            var result = DecodeOneSurface(
                dat, id, surfaceType, surfaceTextureType, renderSurfaceType, paletteType,
                paletteCache, resolvedCache, emitPng, recordChainDetails);
            results.Add(result);
            switch (result.Status) {
                case "PASS": passCount++; break;
                case "CACHED": cachedCount++; break;
                case "EMPTY": passCount++; break; // EMPTY counts as PASS.
                case "FAIL":
                    failCount++;
                    failures.Add(result);
                    break;
            }
        }

        // Persist progress sidecar.
        var labelPrefix = recordChainDetails ? "texchain" : "surface";
        var chunkLabel = $"{labelPrefix}_{startId:X8}_{endId:X8}" + (fastMode ? "_fast" : "");
        var progressDir = Path.Combine(resolvedCache, "progress");
        Directory.CreateDirectory(progressDir);
        var progressPath = Path.Combine(progressDir, chunkLabel + ".json");
        var progress = new {
            command,
            chunkLabel,
            startId = $"0x{startId:X8}",
            endId = $"0x{endId:X8}",
            datPath = resolvedDat,
            datSha256 = datSha,
            fastMode,
            recordCount = results.Count,
            passCount,
            failCount,
            cachedCount,
            generatedAt = DateTime.UtcNow.ToString("o"),
            failureIds = failures.Select(f => f.IdHex).ToArray(),
        };
        File.WriteAllText(progressPath, JsonSerializer.Serialize(progress,
            new JsonSerializerOptions { WriteIndented = true }));

        return new TextureChunkResult(
            ChunkLabel: chunkLabel,
            StartId: startId,
            EndId: endId,
            RecordCount: results.Count,
            PassCount: passCount,
            FailCount: failCount,
            CachedCount: cachedCount,
            ProgressJsonPath: progressPath,
            CacheRoot: resolvedCache,
            DatPath: resolvedDat,
            DatSha256: datSha,
            Records: results,
            Failures: failures,
            Source: $"DatReaderWriter.DBObjs.Surface chain via TryGet<T> on {resolvedDat}");
    }

    private TextureRecordResult DecodeOneSurface(
        DRW.DatDatabase dat, uint id,
        Type surfaceType, Type surfaceTextureType, Type renderSurfaceType, Type paletteType,
        Dictionary<uint, DRW.DBObjs.Palette> paletteCache,
        string cacheRoot, bool emitPng, bool recordChainDetails) {

        var idHex = $"0x{id:X8}";

        // Step 1 — Sha256 the raw Surface bytes for the cache key.
        byte[] surfaceBytes;
        try {
            surfaceBytes = ReadRawRecordBytes(dat, id);
        } catch (Exception ex) {
            return Fail(idHex, id, "", $"Read raw Surface bytes: {ex.Message}");
        }
        var surfaceSha = Sha256Hex(surfaceBytes);

        // Step 2 — Cache hit?
        lock (_textureCacheLock) {
            if (_textureCacheRam.TryGetValue(surfaceSha, out var ramHit)) {
                return ramHit with { IdHex = idHex, Id = id, Status = "CACHED" };
            }
        }
        var diskCachePath = SurfaceCachePath(cacheRoot, surfaceSha);
        if (File.Exists(diskCachePath)) {
            try {
                var cached = JsonSerializer.Deserialize<TextureRecordResult>(
                    File.ReadAllText(diskCachePath));
                if (cached != null) {
                    lock (_textureCacheLock) { _textureCacheRam[surfaceSha] = cached; }
                    return cached with { IdHex = idHex, Id = id, Status = "CACHED" };
                }
            } catch {
                // Corrupted cache file → treat as miss; will be overwritten.
            }
        }

        // Step 3 — Parse the Surface via Chorizite TryGet<T>.
        DRW.DBObjs.Surface? surface;
        try {
            surface = TryGetGeneric<DRW.DBObjs.Surface>(dat, id);
        } catch (Exception ex) {
            return Fail(idHex, id, surfaceSha, $"TryGet<Surface>: {ex.Message}");
        }
        if (surface == null) {
            return Fail(idHex, id, surfaceSha, "Surface not present in DAT.");
        }

        // Solid-colour branch: no pixel data to compare beyond ARGB.
        if (surface.ColorValue != null
            || (surface.Type & DRW.Enums.SurfaceType.Base1Solid) != 0) {
            var c = surface.ColorValue;
            float a = c?.Alpha / 255f ?? 0f, r = c?.Red / 255f ?? 0f,
                  g = c?.Green / 255f ?? 0f, b = c?.Blue / 255f ?? 0f;
            // 1x1 representation: synthesized pixel for sha key.
            var argbPixel = new byte[] {
                c?.Red ?? 0, c?.Green ?? 0, c?.Blue ?? 0, c?.Alpha ?? 0
            };
            var pixelSha = Sha256Hex(argbPixel);
            if (emitPng) EmitPng(cacheRoot, surfaceSha, argbPixel, 1, 1);
            bool isEmpty = (c?.Red ?? 0) == 0 && (c?.Green ?? 0) == 0
                && (c?.Blue ?? 0) == 0 && (c?.Alpha ?? 0) == 0;
            var solid = new TextureRecordResult(
                IdHex: idHex, Id: id,
                SurfaceSha256: surfaceSha,
                PixelSha256: pixelSha,
                Width: 1, Height: 1,
                Status: isEmpty ? "EMPTY" : "PASS",
                MeanRgba: new[] { r, g, b, a },
                ChainKind: "solid",
                SurfaceTextureId: null,
                RenderSurfaceId: null,
                PaletteId: null,
                PixelFormat: "synth/argb",
                FailureReason: null);
            PersistCache(cacheRoot, surface: solid, sha: surfaceSha);
            return solid;
        }

        // Textured branch.
        uint stId = surface.OrigTextureId;
        uint origPaletteId = surface.OrigPaletteId;
        if (stId == 0) {
            return Fail(idHex, id, surfaceSha, "Surface has neither solid colour nor textureId.");
        }
        DRW.DBObjs.SurfaceTexture? st;
        try {
            st = TryGetGeneric<DRW.DBObjs.SurfaceTexture>(dat, stId);
        } catch (Exception ex) {
            return Fail(idHex, id, surfaceSha, $"TryGet<SurfaceTexture> 0x{stId:X8}: {ex.Message}");
        }
        if (st == null || st.Textures == null || st.Textures.Count == 0) {
            return Fail(idHex, id, surfaceSha, $"SurfaceTexture 0x{stId:X8} has no RenderSurface ids.");
        }
        // Pick the highest-resolution RenderSurface (last entry, matches
        // the Rust path in fetch_surface_pixels_impl which uses
        // surf_tex.highest_res() = textures.last).
        uint rsId = st.Textures[^1];

        DRW.DBObjs.RenderSurface? rs;
        try {
            rs = TryGetGeneric<DRW.DBObjs.RenderSurface>(dat, rsId);
        } catch (Exception ex) {
            return Fail(idHex, id, surfaceSha, $"TryGet<RenderSurface> 0x{rsId:X8}: {ex.Message}");
        }
        if (rs == null) {
            return Fail(idHex, id, surfaceSha, $"RenderSurface 0x{rsId:X8} not present.");
        }

        // Decode RGBA8.
        byte[] rgba;
        string format = rs.Format.ToString();
        uint? paletteIdUsed = null;
        string chainKind = "textured/direct";
        // Effective (decoded payload) dims — for JPEG these can differ from
        // rs.Width/rs.Height (header dims), so the PNG and the Width/Height
        // fields must track the real payload the pixel sha/mean came from.
        int decodedWidth = rs.Width, decodedHeight = rs.Height;
        try {
            rgba = DecodeRenderSurfaceToRgba8(rs, dat, paletteCache, paletteType,
                clipMap: (surface.Type & DRW.Enums.SurfaceType.Base1ClipMap) != 0,
                out paletteIdUsed, out chainKind,
                out decodedWidth, out decodedHeight);
        } catch (Exception ex) {
            return Fail(idHex, id, surfaceSha,
                $"DecodeRenderSurfaceToRgba8 {format} {rs.Width}x{rs.Height}: {ex.Message}");
        }

        var pixelShaT = Sha256Hex(rgba);
        var mean = ComputeMeanRgba(rgba);

        if (emitPng) EmitPng(cacheRoot, surfaceSha, rgba, decodedWidth, decodedHeight);

        var passResult = new TextureRecordResult(
            IdHex: idHex, Id: id,
            SurfaceSha256: surfaceSha,
            PixelSha256: pixelShaT,
            Width: decodedWidth, Height: decodedHeight,
            Status: "PASS",
            MeanRgba: mean,
            ChainKind: chainKind,
            SurfaceTextureId: stId,
            RenderSurfaceId: rsId,
            PaletteId: paletteIdUsed ?? (origPaletteId != 0 ? origPaletteId : (uint?)null),
            PixelFormat: format,
            FailureReason: null);
        PersistCache(cacheRoot, surface: passResult, sha: surfaceSha);
        return passResult;
    }

    private static TextureRecordResult Fail(string idHex, uint id, string surfaceSha, string reason) {
        return new TextureRecordResult(
            IdHex: idHex, Id: id,
            SurfaceSha256: surfaceSha,
            PixelSha256: null,
            Width: 0, Height: 0,
            Status: "FAIL",
            MeanRgba: null,
            ChainKind: null,
            SurfaceTextureId: null,
            RenderSurfaceId: null,
            PaletteId: null,
            PixelFormat: null,
            FailureReason: reason);
    }

    /// <summary>
    /// Generic TryGet<T>(id, out T) caller via reflection — same pattern
    /// as <c>CommandEngine.DatParity.cs::ChoriziteParseDatRecord</c>.
    /// Returns null if not present.
    /// </summary>
    private static T? TryGetGeneric<T>(DRW.DatDatabase dat, uint id) where T : class {
        var tryGet = typeof(DRW.DatDatabase)
            .GetMethods()
            .First(m => m.Name == "TryGet"
                && m.IsGenericMethodDefinition
                && m.GetParameters().Length == 2)
            .MakeGenericMethod(typeof(T));
        var args = new object?[] { id, null };
        var ok = (bool)(tryGet.Invoke(dat, args) ?? false);
        if (!ok) return null;
        return args[1] as T;
    }

    /// <summary>
    /// Read the raw, post-decompression record bytes for SHA-256 keying.
    /// Uses DRW's public <c>DatDatabase.TryGetFileBytes(uint, out byte[],
    /// bool autoDecompress = true)</c> — see DatDatabase.cs:143. We always
    /// auto-decompress because the on-disk compression scheme isn't stable
    /// across re-bakes (it depends on the LZ window state), but the
    /// decompressed payload is the canonical retail wire format.
    /// </summary>
    private static byte[] ReadRawRecordBytes(DRW.DatDatabase dat, uint id) {
        // Pick the (uint, out byte[], bool) overload — the one that returns
        // a fresh array, not the ref-byte[] / Span-based ones.
        var method = typeof(DRW.DatDatabase).GetMethods()
            .FirstOrDefault(m => m.Name == "TryGetFileBytes"
                && m.GetParameters().Length == 3
                && m.GetParameters()[0].ParameterType == typeof(uint)
                && m.GetParameters()[1].ParameterType == typeof(byte[]).MakeByRefType()
                && m.GetParameters()[2].ParameterType == typeof(bool))
            ?? throw new InvalidOperationException(
                "DRW DatDatabase.TryGetFileBytes(uint, out byte[], bool) not found");
        var args = new object?[] { id, null, true };
        var ok = (bool)(method.Invoke(dat, args) ?? false);
        if (!ok || args[1] == null) {
            throw new FileNotFoundException($"DAT record 0x{id:X8} not present.");
        }
        return (byte[])args[1]!;
    }

    /// <summary>
    /// Mirror of <c>DatReaderWriter.Extensions.DBObjs.RenderSurfaceExtensions.ToRgba8</c>
    /// — same pixel-format switch, but resolves palettes via a read-only
    /// <see cref="DRW.DatDatabase"/> so we don't have to open the DAT for
    /// write (which is what <c>DatEasyWriter</c> requires). Output is
    /// width × height × 4 bytes in RGBA byte order.
    /// </summary>
    private static byte[] DecodeRenderSurfaceToRgba8(
        DRW.DBObjs.RenderSurface rs, DRW.DatDatabase dat,
        Dictionary<uint, DRW.DBObjs.Palette> paletteCache, Type paletteType,
        bool clipMap,
        out uint? paletteIdUsed, out string chainKind,
        out int decodedWidth, out int decodedHeight) {
        int width = rs.Width;
        int height = rs.Height;
        byte[] src = rs.SourceData;
        byte[] outp = new byte[width * height * 4];
        paletteIdUsed = null;
        chainKind = "textured/direct";

        switch (rs.Format) {
            case DRW.Enums.PixelFormat.PFID_CUSTOM_RAW_JPEG: {
                using var stream = new MemoryStream(src);
                using var img = Image.Load<Rgba32>(stream);
                width = img.Width; height = img.Height;
                outp = new byte[width * height * 4];
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int idx = (y * width + x) * 4;
                    var p = img[x, y];
                    outp[idx + 0] = p.R;
                    outp[idx + 1] = p.G;
                    outp[idx + 2] = p.B;
                    outp[idx + 3] = p.A;
                }
                break;
            }
            case DRW.Enums.PixelFormat.PFID_R8G8B8: {
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int s = (y * width + x) * 3;
                    int d = (y * width + x) * 4;
                    outp[d + 0] = src[s + 2]; // R
                    outp[d + 1] = src[s + 1]; // G
                    outp[d + 2] = src[s + 0]; // B
                    outp[d + 3] = 255;
                }
                break;
            }
            case DRW.Enums.PixelFormat.PFID_CUSTOM_LSCAPE_R8G8B8: {
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int s = (y * width + x) * 3;
                    int d = (y * width + x) * 4;
                    outp[d + 0] = src[s + 0]; // R
                    outp[d + 1] = src[s + 1]; // G
                    outp[d + 2] = src[s + 2]; // B
                    outp[d + 3] = 255;
                }
                break;
            }
            case DRW.Enums.PixelFormat.PFID_A8R8G8B8: {
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int s = (y * width + x) * 4;
                    int d = s;
                    outp[d + 0] = src[s + 2];
                    outp[d + 1] = src[s + 1];
                    outp[d + 2] = src[s + 0];
                    outp[d + 3] = src[s + 3];
                }
                break;
            }
            case DRW.Enums.PixelFormat.PFID_A8:
            case DRW.Enums.PixelFormat.PFID_CUSTOM_LSCAPE_ALPHA: {
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int s = y * width + x;
                    int d = s * 4;
                    byte grey = src[s];
                    outp[d + 0] = grey; outp[d + 1] = grey;
                    outp[d + 2] = grey; outp[d + 3] = 255;
                }
                break;
            }
            case DRW.Enums.PixelFormat.PFID_P8: {
                var pal = ResolvePalette(dat, rs.DefaultPaletteId, paletteCache);
                paletteIdUsed = rs.DefaultPaletteId;
                chainKind = "textured/palette";
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int s = y * width + x;
                    int d = s * 4;
                    // Retail ImgTex::CopyIntoData (acclient.c:365980) — clip range.
                    if (clipMap && src[s] < 8) continue;
                    var c = pal.Colors[src[s]];
                    outp[d + 0] = c.Red;
                    outp[d + 1] = c.Green;
                    outp[d + 2] = c.Blue;
                    outp[d + 3] = c.Alpha;
                }
                break;
            }
            case DRW.Enums.PixelFormat.PFID_INDEX16: {
                var pal = ResolvePalette(dat, rs.DefaultPaletteId, paletteCache);
                paletteIdUsed = rs.DefaultPaletteId;
                chainKind = "textured/palette";
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int s = (y * width + x) * 2;
                    int d = (y * width + x) * 4;
                    int palIndex = BinaryPrimitives.ReadUInt16LittleEndian(
                        src.AsSpan(s, 2));
                    // Retail ImgTex::CopyIntoData (acclient.c:365959) — clip range.
                    if (clipMap && palIndex < 8) continue;
                    var c = pal.Colors[palIndex];
                    outp[d + 0] = c.Red;
                    outp[d + 1] = c.Green;
                    outp[d + 2] = c.Blue;
                    outp[d + 3] = c.Alpha;
                }
                break;
            }
            case DRW.Enums.PixelFormat.PFID_R5G6B5: {
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int s = (y * width + x) * 2;
                    int d = (y * width + x) * 4;
                    ushort v = BinaryPrimitives.ReadUInt16LittleEndian(src.AsSpan(s, 2));
                    outp[d + 0] = (byte)(((v >> 11) & 0x1F) << 3);
                    outp[d + 1] = (byte)(((v >> 5) & 0x3F) << 2);
                    outp[d + 2] = (byte)((v & 0x1F) << 3);
                    outp[d + 3] = 255;
                }
                break;
            }
            case DRW.Enums.PixelFormat.PFID_A4R4G4B4: {
                chainKind = "textured/clipmap";
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int s = (y * width + x) * 2;
                    int d = (y * width + x) * 4;
                    ushort v = BinaryPrimitives.ReadUInt16LittleEndian(src.AsSpan(s, 2));
                    outp[d + 0] = (byte)(((v >> 8) & 0xF) * 17);
                    outp[d + 1] = (byte)(((v >> 4) & 0xF) * 17);
                    outp[d + 2] = (byte)((v & 0xF) * 17);
                    outp[d + 3] = (byte)(((v >> 12) & 0xF) * 17);
                }
                break;
            }
            case DRW.Enums.PixelFormat.PFID_DXT1:
            case DRW.Enums.PixelFormat.PFID_DXT3:
            case DRW.Enums.PixelFormat.PFID_DXT5: {
                chainKind = "textured/clipmap";
                var fmt = rs.Format switch {
                    // Bc1WithAlpha, NOT Bc1 — see RenderSurfaceExtensions.ToRgba8.
                    // Doubly load-bearing here: this decoder is the reference the
                    // parity check compares the client against, so decoding
                    // punch-through as opaque black made a correct client look
                    // wrong (or, worse, matched a client with the same bug).
                    DRW.Enums.PixelFormat.PFID_DXT1 => CompressionFormat.Bc1WithAlpha,
                    DRW.Enums.PixelFormat.PFID_DXT3 => CompressionFormat.Bc2,
                    DRW.Enums.PixelFormat.PFID_DXT5 => CompressionFormat.Bc3,
                    _ => throw new InvalidOperationException("unreachable"),
                };
                var decoder = new BcDecoder();
                using var decoded = decoder.DecodeRawToImageRgba32(src, width, height, fmt);
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int d = (y * width + x) * 4;
                    var p = decoded[x, y];
                    outp[d + 0] = p.R;
                    outp[d + 1] = p.G;
                    outp[d + 2] = p.B;
                    outp[d + 3] = p.A;
                }
                break;
            }
            default:
                throw new NotImplementedException(
                    $"Unsupported PixelFormat: {rs.Format}");
        }

        decodedWidth = width;
        decodedHeight = height;
        return outp;
    }

    private static DRW.DBObjs.Palette ResolvePalette(
        DRW.DatDatabase dat, uint paletteId,
        Dictionary<uint, DRW.DBObjs.Palette> cache) {
        if (cache.TryGetValue(paletteId, out var hit)) return hit;
        var pal = TryGetGeneric<DRW.DBObjs.Palette>(dat, paletteId)
            ?? throw new InvalidOperationException(
                $"Palette 0x{paletteId:X8} not found in DAT.");
        if (cache.Count < 512) cache[paletteId] = pal;
        return pal;
    }

    private static float[] ComputeMeanRgba(byte[] rgba) {
        if (rgba.Length == 0) return new float[] { 0, 0, 0, 0 };
        long sR = 0, sG = 0, sB = 0, sA = 0;
        int n = rgba.Length / 4;
        for (int i = 0; i < n; i++) {
            sR += rgba[i * 4 + 0];
            sG += rgba[i * 4 + 1];
            sB += rgba[i * 4 + 2];
            sA += rgba[i * 4 + 3];
        }
        return new[] {
            (float)sR / (255f * n),
            (float)sG / (255f * n),
            (float)sB / (255f * n),
            (float)sA / (255f * n),
        };
    }

    private static string Sha256Hex(byte[] bytes) {
        var hash = SHA256.HashData(bytes);
        var sb = new System.Text.StringBuilder(hash.Length * 2);
        foreach (var b in hash) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    private static string ResolveCacheRoot(string? cacheRoot) {
        if (!string.IsNullOrWhiteSpace(cacheRoot)) return cacheRoot;
        // Default to /mnt/wbterminal1 per [[feedback_use_external_drives_for_scratch]].
        var def = "/mnt/wbterminal1/holtburger-validator-fixtures/wave4";
        if (Directory.Exists("/mnt/wbterminal1")) return def;
        // Fall-back: env-driven, then /tmp.
        var envOverride = Environment.GetEnvironmentVariable("WAVE4_CACHE_ROOT");
        if (!string.IsNullOrEmpty(envOverride)) return envOverride;
        return Path.Combine(Path.GetTempPath(), "holtburger-wave4");
    }

    private static void EnsureCacheDirs(string root, bool emitPng) {
        Directory.CreateDirectory(Path.Combine(root, "surface"));
        if (emitPng) Directory.CreateDirectory(Path.Combine(root, "png"));
        Directory.CreateDirectory(Path.Combine(root, "progress"));
    }

    private static string SurfaceCachePath(string root, string surfaceSha) =>
        Path.Combine(root, "surface", surfaceSha + ".json");

    private static string PngPath(string root, string surfaceSha) =>
        Path.Combine(root, "png", surfaceSha + ".png");

    private static void PersistCache(string root, TextureRecordResult surface, string sha) {
        lock (_textureCacheLock) { _textureCacheRam[sha] = surface; }
        try {
            File.WriteAllText(
                SurfaceCachePath(root, sha),
                JsonSerializer.Serialize(surface,
                    new JsonSerializerOptions { WriteIndented = false }));
        } catch (IOException) {
            // Cache write is best-effort; don't fail the validator on this.
        }
    }

    private static void EmitPng(string root, string surfaceSha, byte[] rgba, int width, int height) {
        if (width <= 0 || height <= 0 || rgba.Length == 0) return;
        try {
            using var img = Image.LoadPixelData<Rgba32>(rgba, width, height);
            using var fs = File.Create(PngPath(root, surfaceSha));
            img.SaveAsPng(fs, new PngEncoder { CompressionLevel = PngCompressionLevel.BestSpeed });
        } catch (Exception) {
            // PNG emit is best-effort; reports still carry the sha256.
        }
    }
}
