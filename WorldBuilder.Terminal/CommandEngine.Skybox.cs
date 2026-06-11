using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using DRW = DatReaderWriter;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave 5.B — Skybox / atmosphere parity (Region 0x13 + DayGroup uniforms).
///
/// See <c>docs/diagnostic-toolset-plan-2026-05-19.md</c> §3 row 13 and §6
/// Wave 5 W5.B. Sibling to the cell-portal-graph (W5.A) and diag-run-all
/// (W5.C) command surfaces; same pattern as the earlier diagnostic
/// partials.
///
/// Commands in this file:
///
///   - <c>region-skybox-snapshot &lt;gameTimeSec&gt;</c> — bake the
///     canonical sky composition for a given game-time. Returns the 5
///     DayGroup uniforms (Sky-Top / Sky-Bottom / Sun-Position / Ambient
///     / Fog) plus the active SkyObjects + weather (DayGroup name).
///     Inputs sourced from Region <c>0x13000000</c> "Dereth"
///     (<c>client_portal.dat</c>), parsed via Chorizite.DatReaderWriter.
///
///   - <c>region-day-night-curve [--hours N]</c> — emit the full 24-hour
///     curve of the 5 DayGroup uniforms at N samples (default 24, one
///     per hour). Determinism testing: same Region DAT + same
///     game-time-sec → byte-identical uniforms.
///
/// Contract (per [`skybox-parity-method.md`](../docs/skybox-parity-method.md)):
///   For every sampled game-time, the C# canonical snapshot must agree
///   with the JS-side <c>CloudVolume</c> SkyState→uniform mapping
///   within 1e-4 on every f32 component of the 5 uniforms.
///
/// Source-of-truth precedence per
/// [[feedback_three_source_cross_reference]]: ACE's
/// <c>SkyDesc.cs</c> + <c>SkyTimeOfDay.cs</c> + retail
/// <c>acclient.c</c> <c>CSkyDesc</c> own the math; Chorizite's
/// <c>DatReaderWriter.DBObjs.Region</c> + <c>SkyDesc</c> own the wire
/// shape. The JS-side <c>scene3d/cloud_volume.js</c> is the SUBJECT
/// under test, not the oracle.
///
/// Integrity discipline per [[feedback_base_dats_only_for_bake]]: this
/// command only reads from base DATs. The Region record itself is at
/// <c>0x13000000</c>; that is the canonical Dereth Region ID, not a
/// modder ID.
/// </summary>
public partial class CommandEngine {

    /// <summary>
    /// Time anchor for the AC in-world clock — Unix seconds at
    /// <c>1999-11-02 00:00:00 UTC</c> (AC's real launch date). Mirrors
    /// <c>holtburger-world::sky::AC_LAUNCH_UNIX_EPOCH</c> +
    /// <c>project_holtburger_skybox_done_2026-05-11</c>. Don't refactor —
    /// any change shifts every player to a different DayGroup every
    /// real day.
    /// </summary>
    public const double SkyboxAcLaunchUnixEpoch = 941_500_800.0;

    /// <summary>
    /// LCG multiplier for <c>CSkyDesc::CalcPresentDayGroup</c>. Verbatim
    /// from <c>PhatSDK/SkyDesc.cpp:52-71</c> +
    /// <c>~/ac-headers/acclient.c::CSkyDesc::CalcPresentDayGroup</c>.
    /// </summary>
    private const uint SkyboxLcgMultiplier = 1_782_775_218u;

    /// <summary>
    /// LCG addend for <c>CSkyDesc::CalcPresentDayGroup</c>.
    /// </summary>
    private const uint SkyboxLcgAddend = 1_967_253_934u;

    /// <summary>
    /// Inverse of 2^32 — converts the LCG output to a <c>[0, 1)</c>
    /// fraction. Same magic constant as PhatSDK + retail acclient.c.
    /// </summary>
    private const double SkyboxInvU32Max = 2.3283064e-10;

    /// <summary>
    /// Canonical Dereth Region DBObj ID (file ID, NOT the 1-indexed
    /// region_number). See <c>project_holtburger_skybox_done_2026-05-11</c>
    /// "Region file ID is the namespace prefix, not prefix + 1".
    /// </summary>
    public const uint SkyboxDerethRegionId = 0x13000000u;

    /// <summary>
    /// Result shape for <c>region-skybox-snapshot</c>. Carries the 5
    /// DayGroup uniforms (cloud_volume.js's Clouds-C contract), the
    /// visible SkyObject list, and the active DayGroup name (the
    /// "weather state name" per [[project_holtburger_skybox_properties_flags]]).
    /// </summary>
    public sealed record SkyboxSnapshotResult(
        double GameTimeSec,
        float NormalizedDayPosition,
        uint DayGroupIndex,
        string DayGroupName,
        DayGroupUniforms Uniforms,
        SkyStateRaw RawSkyState,
        IReadOnlyList<SkyObjectRefSnapshot> ActiveSkyObjects,
        string WeatherStateName,
        string DatPath,
        string DatSha256,
        string Source);

    /// <summary>
    /// The 5 canonical DayGroup uniforms that cloud_volume.js's Clouds-C
    /// path produces from a SkyState. All are 0..1 normalised RGB or
    /// scalar f32. See <c>project_holtburger_clouds_c_done_2026-05-15</c>.
    /// </summary>
    public sealed record DayGroupUniforms(
        float[] SkyTop,        // uAmbientColor — ambient/sky color RGB (Vec3)
        float[] SkyBottom,     // uHorizonColor — fog/horizon color RGB (Vec3)
        float[] SunPosition,   // sunDirection — unit Vec3 from heading+pitch
        float Ambient,         // uSunIntensity — sun intensity scalar
        float Fog);            // uFogDensity — derived from fogMin/fogMax

    /// <summary>
    /// The raw SkyState the JS side ingests (verbatim from
    /// <c>SkyEvalState.evaluate</c>). Surfaces all 12 lerped fields so the
    /// validator can also assert on the source AND the uniform mapping
    /// independently — if drift surfaces, the report distinguishes
    /// "wrong source data" from "wrong uniform projection".
    /// </summary>
    public sealed record SkyStateRaw(
        uint DirColorArgb,
        float DirBright,
        float DirHeading,
        float DirPitch,
        uint AmbColorArgb,
        float AmbBright,
        uint FogColorArgb,
        float FogMin,
        float FogMax,
        uint WorldFog,
        float TimeOfDayNormalized,
        uint DayGroupIndex);

    /// <summary>
    /// One row per visible SkyObject in the active DayGroup, per
    /// [[project_holtburger_sky_k3_k4_k5_done_2026-05-16]] sun /
    /// moons / stars list + the cloud band per
    /// [[project_holtburger_skybox_properties_flags]].
    /// </summary>
    public sealed record SkyObjectRefSnapshot(
        uint Did,
        float Brightness,
        float Alpha,
        uint PropertyFlags,
        float BeginTime,
        float EndTime,
        float BeginAngleDeg,
        float EndAngleDeg,
        bool Visible);

    /// <summary>
    /// One row per sampled game-time for <c>region-day-night-curve</c>.
    /// Identical shape to <see cref="SkyboxSnapshotResult"/> but the
    /// command returns N of them (one per sample).
    /// </summary>
    public sealed record SkyboxDayNightCurveResult(
        string DatPath,
        string DatSha256,
        int Hours,
        double DayLengthSeconds,
        IReadOnlyList<SkyboxSnapshotResult> Samples,
        string Source);

    // ─────────────────────────────────────────────────────────────────
    //  region-skybox-snapshot
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Bake the canonical sky composition for a given game-time-sec
    /// (seconds since <see cref="SkyboxAcLaunchUnixEpoch"/>).
    ///
    /// Determinism: same Region DAT + same gameTimeSec → byte-identical
    /// uniforms (modulo IEEE 754 nondeterminism, which on the x64 .NET
    /// runtime we use here is suppressed at compile time).
    /// </summary>
    public SkyboxSnapshotResult RegionSkyboxSnapshot(double gameTimeSec, string? datPath) {
        var (region, regionType, resolvedPath, sha) = LoadRegion(datPath);
        return BuildSnapshotForGameTimeSec(region, regionType, resolvedPath, sha, gameTimeSec);
    }

    // ─────────────────────────────────────────────────────────────────
    //  region-day-night-curve
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Emit the full 24-hour curve of all 5 DayGroup uniforms at
    /// <paramref name="hours"/> samples (default 24, one per hour). The
    /// sample times are <c>k * (dayLength / hours)</c> for
    /// <c>k = 0..hours-1</c>. <paramref name="hours"/> must be ≥ 1.
    /// </summary>
    public SkyboxDayNightCurveResult RegionDayNightCurve(int hours, string? datPath) {
        if (hours < 1) hours = 24;
        var (region, regionType, resolvedPath, sha) = LoadRegion(datPath);
        var gameTime = GetFieldValue(region, regionType, "GameTime")
            ?? throw new InvalidOperationException("Region.GameTime is null");
        var gameTimeType = gameTime.GetType();
        var dayLength = ToSingle(GetFieldValue(gameTime, gameTimeType, "DayLength") ?? 7620f);
        if (dayLength <= 0) dayLength = 7620f;
        var samples = new List<SkyboxSnapshotResult>(hours);
        for (int i = 0; i < hours; i++) {
            double gameTimeSec = (double)i * (double)dayLength / (double)hours;
            samples.Add(BuildSnapshotForGameTimeSec(region, regionType, resolvedPath, sha, gameTimeSec));
        }
        return new SkyboxDayNightCurveResult(
            DatPath: resolvedPath,
            DatSha256: sha,
            Hours: hours,
            DayLengthSeconds: dayLength,
            Samples: samples,
            Source: "ChoriziteDatReaderWriter.DBObjs.Region(0x13000000) + AC SkyDesc::CalcPresentDayGroup port");
    }

    // ─────────────────────────────────────────────────────────────────
    //  Internals — Region loader + game-time eval
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Load Region <c>0x13000000</c> via the standard DRW
    /// <c>TryGet&lt;Region&gt;</c> path. Reflection-driven so we don't
    /// require a direct ProjectReference to the generated DBObj types;
    /// matches the convention in <c>CommandEngine.DatParity.cs</c>.
    /// </summary>
    private (object Region, Type RegionType, string ResolvedPath, string Sha256) LoadRegion(string? datPath) {
        var idx = GetDBObjTypeIndex();
        if (!idx.TryGetValue("Region", out var regionType)) {
            throw new InvalidOperationException(
                "Could not locate DatReaderWriter.DBObjs.Region in vendored assembly.");
        }
        var resolved = ResolveDatPathForType(datPath, regionType);
        var sha = ComputeDatSha256(resolved);
        var dat = new DRW.DatDatabase(o => {
            o.FilePath = resolved;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Never;
        });
        try {
            var tryGet = typeof(DRW.DatDatabase)
                .GetMethods()
                .FirstOrDefault(m => m.Name == "TryGet"
                    && m.IsGenericMethodDefinition
                    && m.GetParameters().Length == 2)
                ?? throw new InvalidOperationException(
                    "DatDatabase.TryGet<T>(id, out T) not found on vendored assembly.");
            var tryGetGeneric = tryGet.MakeGenericMethod(regionType);
            var args = new object?[] { SkyboxDerethRegionId, null };
            bool ok = (bool)(tryGetGeneric.Invoke(dat, args) ?? false);
            if (!ok || args[1] == null) {
                throw new InvalidOperationException(
                    $"DatDatabase.TryGet<Region>(0x{SkyboxDerethRegionId:X8}, out region) returned false. " +
                    $"Verify {resolved} is the canonical base DAT.");
            }
            return (args[1]!, regionType, resolved, sha);
        } finally {
            dat.Dispose();
        }
    }

    /// <summary>
    /// The hot path: given a parsed Region, a real-time elapsed seconds
    /// since AC launch (which is what "gameTimeSec" semantically is —
    /// AC's wall-clock derivation collapses to this), produce the
    /// canonical sky snapshot.
    ///
    /// Math is a verbatim port of:
    /// - <c>holtburger-world/src/sky.rs::SkyEvalState::evaluate</c>
    /// - <c>holtburger-world/src/sky.rs::evaluate_lighting</c>
    /// - <c>holtburger-world/src/sky.rs::find_keyframe_pair</c>
    /// - <c>holtburger-world/src/sky.rs::lerp_sky_time</c>
    /// - <c>holtburger-world/src/sky.rs::lerp_argb</c>
    /// - <c>holtburger-world/src/sky.rs::calc_present_day_group</c>
    /// </summary>
    private SkyboxSnapshotResult BuildSnapshotForGameTimeSec(
        object region, Type regionType, string datPath, string sha, double gameTimeSec) {
        var gameTime = GetFieldValue(region, regionType, "GameTime")
            ?? throw new InvalidOperationException("Region.GameTime is null");
        var skyInfo = GetFieldValue(region, regionType, "SkyInfo")
            ?? throw new InvalidOperationException("Region.SkyInfo is null — Region missing PartsMask & HasSkyInfo.");
        var gtType = gameTime.GetType();
        var skyDescType = skyInfo.GetType();

        var dayLength = ToSingle(GetFieldValue(gameTime, gtType, "DayLength"));
        var daysPerYear = ToUInt32(GetFieldValue(gameTime, gtType, "DaysPerYear"));
        var zeroYear = ToUInt32(GetFieldValue(gameTime, gtType, "ZeroYear"));
        var zeroTimeOfYear = ToDouble(GetFieldValue(gameTime, gtType, "ZeroTimeOfYear"));
        if (dayLength <= 0) dayLength = 7620f;
        if (daysPerYear == 0) daysPerYear = 360;

        // Treat the supplied gameTimeSec as "seconds since AC_LAUNCH_UNIX_EPOCH"
        // — i.e. the same f64 that flows through Rust's `world_time_seconds`.
        // Fold `zero_time_of_year` exactly like the Rust port does:
        //   world_seconds = gameTimeSec + zero_time_of_year
        double worldSeconds = gameTimeSec + zeroTimeOfYear;
        double dayLengthD = (double)dayLength;
        long worldDay = (long)Math.Floor(worldSeconds / dayLengthD);
        // rem_euclid (handles negative day offsets cleanly)
        double rem = worldSeconds - (double)worldDay * dayLengthD;
        if (rem < 0) rem += dayLengthD;
        float timeOfDayNormalized = (float)(rem / dayLengthD);
        long dpyI64 = Math.Max(1, (long)daysPerYear);
        long dayInYear;
        long yearOffset;
        {
            // signed Euclidean div/rem
            long r = worldDay % dpyI64;
            if (r < 0) r += dpyI64;
            dayInYear = r;
            yearOffset = (worldDay - r) / dpyI64;
        }
        uint day = (uint)dayInYear;
        uint year = (uint)((long)zeroYear + yearOffset);

        // DayGroups list
        var dayGroupsList = GetFieldValue(skyInfo, skyDescType, "DayGroups")
            ?? throw new InvalidOperationException("Region.SkyInfo.DayGroups is null");
        var dayGroups = ToListOfObject(dayGroupsList);
        uint dayGroupIndex = CalcPresentDayGroup(day, year, daysPerYear, (uint)dayGroups.Count);
        var dayGroup = dayGroups[(int)dayGroupIndex];
        var dgType = dayGroup.GetType();

        // DayGroup name — strip the AC1LegacyPStringBase wrapper
        string dayGroupName = ExtractPString(GetFieldValue(dayGroup, dgType, "DayName"));

        // SkyTimeOfDay keyframes
        var skyTimeList = GetFieldValue(dayGroup, dgType, "SkyTime")
            ?? throw new InvalidOperationException("DayGroup.SkyTime is null");
        var skyTimes = ToListOfObject(skyTimeList);

        var (kfA, kfB, kfU) = FindKeyframePair(skyTimes, timeOfDayNormalized);

        // Lerp SkyTimeOfDay → SkyStateRaw
        var raw = LerpSkyTime(kfA, kfB, kfU, dayGroupIndex, timeOfDayNormalized);

        // 5 DayGroup uniforms (cloud_volume.js Clouds-C contract).
        var uniforms = ProjectToDayGroupUniforms(raw);

        // SkyObjects — surface the visible ones for the report. We don't
        // need to interpolate their SkyObjectReplace bracket here (that's a
        // distinct invariant tested elsewhere); we just enumerate the
        // active DayGroup's roster with current visibility.
        var skyObjectsList = GetFieldValue(dayGroup, dgType, "SkyObjects")
            ?? throw new InvalidOperationException("DayGroup.SkyObjects is null");
        var activeObjects = new List<SkyObjectRefSnapshot>();
        foreach (var skyObj in ToListOfObject(skyObjectsList)) {
            var soType = skyObj.GetType();
            var beginTime = ToSingle(GetFieldValue(skyObj, soType, "BeginTime"));
            var endTime = ToSingle(GetFieldValue(skyObj, soType, "EndTime"));
            var beginAngle = ToSingle(GetFieldValue(skyObj, soType, "BeginAngle"));
            var endAngle = ToSingle(GetFieldValue(skyObj, soType, "EndAngle"));
            var properties = ToUInt32(GetFieldValue(skyObj, soType, "Properties"));
            // QualifiedDataId<T> → Id getter (preferred) or .Value (DRW
            // sometimes wraps the value differently across versions).
            uint did = ExtractQualifiedDataId(GetFieldValue(skyObj, soType, "DefaultGfxObjectId"));
            bool alwaysVisible = beginTime == endTime;
            bool visible = alwaysVisible || (beginTime <= timeOfDayNormalized && timeOfDayNormalized < endTime);
            activeObjects.Add(new SkyObjectRefSnapshot(
                Did: did,
                Brightness: 1.0f, // SkyObject base brightness is not stored — replaces drive it
                Alpha: 1.0f,
                PropertyFlags: properties,
                BeginTime: beginTime,
                EndTime: endTime,
                BeginAngleDeg: beginAngle,
                EndAngleDeg: endAngle,
                Visible: visible));
        }

        return new SkyboxSnapshotResult(
            GameTimeSec: gameTimeSec,
            NormalizedDayPosition: timeOfDayNormalized,
            DayGroupIndex: dayGroupIndex,
            DayGroupName: dayGroupName,
            Uniforms: uniforms,
            RawSkyState: raw,
            ActiveSkyObjects: activeObjects,
            WeatherStateName: dayGroupName,
            DatPath: datPath,
            DatSha256: sha,
            Source: "Chorizite.DatReaderWriter.Region(0x13000000) + AC SkyDesc port");
    }

    /// <summary>
    /// Verbatim port of <c>SkyDesc::CalcPresentDayGroup</c> from
    /// <c>PhatSDK/SkyDesc.cpp:52-71</c>. C# unsigned arithmetic mirrors
    /// the C++ <c>unsigned int</c> wrap. Multiply by <see cref="SkyboxInvU32Max"/>
    /// to map LCG output into <c>[0, 1)</c>, then by <c>num_groups</c>.
    /// </summary>
    public static uint CalcPresentDayGroup(uint day, uint year, uint daysPerYear, uint numGroups) {
        if (numGroups == 0) return 0;
        uint key = unchecked(day + daysPerYear * year);
        uint hashed = unchecked(SkyboxLcgMultiplier * key - SkyboxLcgAddend);
        double fraction = (double)hashed * SkyboxInvU32Max;
        uint idx = (uint)Math.Floor(fraction * (double)numGroups);
        return idx < numGroups ? idx : numGroups - 1;
    }

    /// <summary>
    /// Locate the two surrounding SkyTimeOfDay keyframes for a given
    /// normalized time-of-day. Verbatim port of
    /// <c>sky.rs::find_keyframe_pair</c>. Handles midnight wrap.
    /// </summary>
    private static (object A, object B, float U) FindKeyframePair(List<object> skyTime, float t) {
        if (skyTime.Count == 0) throw new InvalidOperationException("DayGroup has no SkyTimeOfDay keyframes");
        if (skyTime.Count == 1) return (skyTime[0], skyTime[0], 0f);

        float BeginOf(object kf) => ToSingle(GetFieldValue(kf, kf.GetType(), "Begin"));

        for (int i = 0; i < skyTime.Count; i++) {
            if (BeginOf(skyTime[i]) > t) {
                if (i == 0) {
                    // Wrap from last → first
                    var a = skyTime[^1];
                    var b = skyTime[0];
                    float aBegin = BeginOf(a);
                    float bBegin = BeginOf(b);
                    float span = (bBegin + 1f) - aBegin;
                    if (span <= 0) return (a, b, 0f);
                    float tWrap = (t < aBegin) ? t + 1f : t;
                    float u = Math.Clamp((tWrap - aBegin) / span, 0f, 1f);
                    return (a, b, u);
                } else {
                    var a = skyTime[i - 1];
                    var b = skyTime[i];
                    float aBegin = BeginOf(a);
                    float bBegin = BeginOf(b);
                    float span = bBegin - aBegin;
                    if (span <= 0) return (a, b, 0f);
                    float u = Math.Clamp((t - aBegin) / span, 0f, 1f);
                    return (a, b, u);
                }
            }
        }
        // t past every keyframe — wrap last → first.
        {
            var a = skyTime[^1];
            var b = skyTime[0];
            float aBegin = BeginOf(a);
            float bBegin = BeginOf(b);
            float span = (bBegin + 1f) - aBegin;
            if (span <= 0) return (a, b, 0f);
            float u = Math.Clamp((t - aBegin) / span, 0f, 1f);
            return (a, b, u);
        }
    }

    /// <summary>
    /// Lerp two SkyTimeOfDay keyframes at parameter <paramref name="u"/>.
    /// Verbatim port of <c>sky.rs::lerp_sky_time</c> + <c>lerp_argb</c>.
    /// </summary>
    private static SkyStateRaw LerpSkyTime(object a, object b, float u, uint dayGroupIndex, float timeOfDay) {
        u = Math.Clamp(u, 0f, 1f);
        var aType = a.GetType();
        var bType = b.GetType();
        float Lerp(float x, float y) => x + (y - x) * u;
        // Shortest-arc heading lerp — verbatim port of the FIXED
        // sky.rs::lerp_angle_radians (sky.rs:996-1004, fixed 2026-05-20):
        // normalize the inter-keyframe delta into (-180, 180] before
        // interpolating so the lerp picks the shorter arc around the unit
        // circle (period 360 — inputs are degrees). Reduces to plain
        // linear `a + delta*u` when |b - a| <= 180. Without this, keyframes
        // straddling the 0/360 wrap (dusk→midnight→dawn DayGroups) sweep
        // the long way around, up to ~180° off the runtime. DirPitch stays
        // plain linear (pitches never cross a boundary).
        float LerpHeading(float aHeading, float bHeading) {
            float delta = bHeading - aHeading;
            if (delta > 180f) delta -= 360f;
            else if (delta < -180f) delta += 360f;
            return aHeading + delta * u;
        }
        return new SkyStateRaw(
            DirColorArgb: LerpArgb(ExtractArgb(GetFieldValue(a, aType, "DirColor")),
                                   ExtractArgb(GetFieldValue(b, bType, "DirColor")), u),
            DirBright: Lerp(ToSingle(GetFieldValue(a, aType, "DirBright")),
                            ToSingle(GetFieldValue(b, bType, "DirBright"))),
            DirHeading: LerpHeading(ToSingle(GetFieldValue(a, aType, "DirHeading")),
                                    ToSingle(GetFieldValue(b, bType, "DirHeading"))),
            DirPitch: Lerp(ToSingle(GetFieldValue(a, aType, "DirPitch")),
                           ToSingle(GetFieldValue(b, bType, "DirPitch"))),
            AmbColorArgb: LerpArgb(ExtractArgb(GetFieldValue(a, aType, "AmbColor")),
                                   ExtractArgb(GetFieldValue(b, bType, "AmbColor")), u),
            AmbBright: Lerp(ToSingle(GetFieldValue(a, aType, "AmbBright")),
                            ToSingle(GetFieldValue(b, bType, "AmbBright"))),
            FogColorArgb: LerpArgb(ExtractArgb(GetFieldValue(a, aType, "WorldFogColor")),
                                   ExtractArgb(GetFieldValue(b, bType, "WorldFogColor")), u),
            FogMin: Lerp(ToSingle(GetFieldValue(a, aType, "MinWorldFog")),
                         ToSingle(GetFieldValue(b, bType, "MinWorldFog"))),
            FogMax: Lerp(ToSingle(GetFieldValue(a, aType, "MaxWorldFog")),
                         ToSingle(GetFieldValue(b, bType, "MaxWorldFog"))),
            // world_fog is a discrete enum; pass-through from `a` when
            // `u < 0.5`, else `b` (sky.rs:730).
            WorldFog: u < 0.5f
                ? ToUInt32(GetFieldValue(a, aType, "WorldFog"))
                : ToUInt32(GetFieldValue(b, bType, "WorldFog")),
            TimeOfDayNormalized: timeOfDay,
            DayGroupIndex: dayGroupIndex);
    }

    /// <summary>
    /// ARGB 0xAARRGGBB component-wise lerp. Verbatim port of
    /// <c>sky.rs::lerp_argb</c>. Decodes to <c>[A, R, G, B]</c> u8 quads,
    /// lerps each channel linearly, re-encodes with <c>.round()</c>.
    /// </summary>
    private static uint LerpArgb(uint a, uint b, float u) {
        u = Math.Clamp(u, 0f, 1f);
        float aa = (a >> 24) & 0xFFu;
        float ar = (a >> 16) & 0xFFu;
        float ag = (a >> 8) & 0xFFu;
        float ab = a & 0xFFu;
        float ba = (b >> 24) & 0xFFu;
        float br = (b >> 16) & 0xFFu;
        float bg = (b >> 8) & 0xFFu;
        float bb = b & 0xFFu;
        uint la = (uint)Math.Clamp((float)Math.Round(aa + (ba - aa) * u), 0f, 255f);
        uint lr = (uint)Math.Clamp((float)Math.Round(ar + (br - ar) * u), 0f, 255f);
        uint lg = (uint)Math.Clamp((float)Math.Round(ag + (bg - ag) * u), 0f, 255f);
        uint lb = (uint)Math.Clamp((float)Math.Round(ab + (bb - ab) * u), 0f, 255f);
        return (la << 24) | (lr << 16) | (lg << 8) | lb;
    }

    /// <summary>
    /// Project a SkyStateRaw onto the 5 DayGroup uniforms that
    /// <c>scene3d/cloud_volume.js</c> consumes (Clouds-C contract per
    /// <c>project_holtburger_clouds_c_done_2026-05-15</c>):
    ///
    ///   uAmbientColor  ← ambColorArgb (ARGB → 0..1 RGB Vec3)  [SkyTop]
    ///   uHorizonColor  ← fogColorArgb                         [SkyBottom]
    ///   sunDirection   ← from dirHeading + dirPitch           [SunPosition]
    ///   uSunIntensity  ← dirBright                            [Ambient]
    ///   uFogDensity    ← ln(2)/max(1,(fogMax-fogMin)*0.5)     [Fog]
    ///
    /// Naming maps to the brief's <c>Sky-Top / Sky-Bottom / Sun-Position
    /// / Ambient / Fog</c>. We label by their cloud_volume.js semantic
    /// (Sky-Top = AC ambient = upper hemisphere; Sky-Bottom = horizon).
    /// </summary>
    private static DayGroupUniforms ProjectToDayGroupUniforms(SkyStateRaw raw) {
        var skyTop = ArgbToRgb01(raw.AmbColorArgb);
        var skyBottom = ArgbToRgb01(raw.FogColorArgb);
        // AC convention (sun_direction.js:49 sunDirFromHeadingPitch):
        // headingDeg measured from +Y north CW, pitchDeg above horizon.
        //   three_x =  cos(pitch) * sin(heading)
        //   three_y =  sin(pitch)
        //   three_z = -cos(pitch) * cos(heading)
        // SkyState.dir_heading / dir_pitch carry DEGREES per Sky-C
        // (DAT-labeled-radians-but-actually-degrees calibration).
        double hRad = (double)raw.DirHeading * Math.PI / 180.0;
        double pRad = (double)raw.DirPitch * Math.PI / 180.0;
        double cp = Math.Cos(pRad);
        double sp = Math.Sin(pRad);
        float sx = (float)(cp * Math.Sin(hRad));
        float sy = (float)sp;
        float sz = (float)(-cp * Math.Cos(hRad));
        // uFogDensity derivation per cloud_volume.js Clouds-C table:
        // exponential fog density matches three.js linear Fog at midpoint.
        float fogSpan = (raw.FogMax - raw.FogMin) * 0.5f;
        float fogDenom = Math.Max(1f, fogSpan);
        float fog = (float)(Math.Log(2.0) / fogDenom);
        return new DayGroupUniforms(
            SkyTop: skyTop,
            SkyBottom: skyBottom,
            SunPosition: new[] { sx, sy, sz },
            Ambient: raw.DirBright,
            Fog: fog);
    }

    /// <summary>
    /// Decode 0xAARRGGBB → [R, G, B] in 0..1. Alpha is dropped. Matches
    /// cloud_volume.js's CloudVolume.tick (which uses (argb &gt;&gt; 16),
    /// (argb &gt;&gt; 8), argb &amp; 0xFF for R/G/B and divides by 255).
    /// </summary>
    private static float[] ArgbToRgb01(uint argb) {
        float r = ((argb >> 16) & 0xFFu) / 255f;
        float g = ((argb >> 8) & 0xFFu) / 255f;
        float b = (argb & 0xFFu) / 255f;
        return new[] { r, g, b };
    }

    // ─────────────────────────────────────────────────────────────────
    //  Reflection helpers
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// Cached reflection lookup: type → field name → FieldInfo. The
    /// region/SkyDesc/DayGroup/SkyTimeOfDay/SkyObject types are
    /// generated-code structs in DRW; we hit them by name (which the
    /// DRW XML doc confirms is stable: <c>DirColor / AmbColor /
    /// WorldFogColor / MinWorldFog / MaxWorldFog / WorldFog / Begin /
    /// DirBright / DirHeading / DirPitch / AmbBright / DayGroups /
    /// SkyTime / SkyObjects / DayName / DayLength / DaysPerYear /
    /// ZeroYear / ZeroTimeOfYear / BeginTime / EndTime / BeginAngle /
    /// EndAngle / Properties / DefaultGfxObjectId</c>).
    /// </summary>
    private static readonly Dictionary<(Type, string), FieldInfo?> _skyboxFieldCache = new();
    private static readonly object _skyboxFieldCacheLock = new();

    private static object? GetFieldValue(object instance, Type type, string fieldName) {
        FieldInfo? fi;
        lock (_skyboxFieldCacheLock) {
            if (!_skyboxFieldCache.TryGetValue((type, fieldName), out fi)) {
                fi = type.GetField(fieldName, BindingFlags.Public | BindingFlags.Instance);
                _skyboxFieldCache[(type, fieldName)] = fi;
            }
        }
        if (fi == null) {
            // Property fallback (Id, etc are properties on Region)
            var pi = type.GetProperty(fieldName, BindingFlags.Public | BindingFlags.Instance);
            return pi?.GetValue(instance);
        }
        return fi.GetValue(instance);
    }

    private static float ToSingle(object? v) {
        if (v == null) return 0f;
        return v switch {
            float f => f,
            double d => (float)d,
            int i => (float)i,
            uint u => (float)u,
            _ => Convert.ToSingle(v, System.Globalization.CultureInfo.InvariantCulture),
        };
    }

    private static double ToDouble(object? v) {
        if (v == null) return 0.0;
        return v switch {
            double d => d,
            float f => (double)f,
            int i => (double)i,
            uint u => (double)u,
            _ => Convert.ToDouble(v, System.Globalization.CultureInfo.InvariantCulture),
        };
    }

    private static uint ToUInt32(object? v) {
        if (v == null) return 0u;
        return v switch {
            uint u => u,
            int i => unchecked((uint)i),
            byte b => (uint)b,
            ushort us => (uint)us,
            short ss => unchecked((uint)ss),
            ulong ul => (uint)ul,
            _ => Convert.ToUInt32(v, System.Globalization.CultureInfo.InvariantCulture),
        };
    }

    /// <summary>
    /// DRW's <c>AC1LegacyPStringBase&lt;T&gt;</c> wraps a string under a
    /// <c>Value</c> property (the wire bytes are length-prefixed; the
    /// C# wrapper stashes the decoded string on .Value or .ToString()).
    /// </summary>
    private static string ExtractPString(object? v) {
        if (v == null) return string.Empty;
        var t = v.GetType();
        var prop = t.GetProperty("Value", BindingFlags.Public | BindingFlags.Instance);
        if (prop != null) {
            var s = prop.GetValue(v);
            if (s is string str) return str;
        }
        // Fallback: ToString — many wrappers override it.
        return v.ToString() ?? string.Empty;
    }

    /// <summary>
    /// DRW's <c>QualifiedDataId&lt;T&gt;</c> exposes its uint DID via a
    /// <c>DataId</c> property (confirmed against the v2.1.2 vendored
    /// assembly: <c>uint DataId { get; }</c>). Older DRW had this under
    /// <c>Id</c>; we fall back to that for forward-compat.
    /// </summary>
    private static uint ExtractQualifiedDataId(object? v) {
        if (v == null) return 0u;
        if (v is uint u) return u;
        var t = v.GetType();
        var dataIdProp = t.GetProperty("DataId", BindingFlags.Public | BindingFlags.Instance);
        if (dataIdProp != null) return ToUInt32(dataIdProp.GetValue(v));
        var idProp = t.GetProperty("Id", BindingFlags.Public | BindingFlags.Instance);
        if (idProp != null) return ToUInt32(idProp.GetValue(v));
        var valueProp = t.GetProperty("Value", BindingFlags.Public | BindingFlags.Instance);
        if (valueProp != null) return ToUInt32(valueProp.GetValue(v));
        return 0u;
    }

    /// <summary>
    /// DRW's <c>ColorARGB</c> is a struct with four public byte fields
    /// <c>Alpha</c>, <c>Red</c>, <c>Green</c>, <c>Blue</c> (confirmed
    /// against the v2.1.2 vendored assembly). Pack them into the
    /// canonical <c>0xAARRGGBB</c> u32 the JS and Rust ports both
    /// consume. <c>SkyTimeOfDay.DirColor / AmbColor / WorldFogColor</c>
    /// all land here; the wire bytes are little-endian
    /// (Blue/Green/Red/Alpha) per the schema, but the packed form is
    /// big-endian conventional ARGB.
    /// </summary>
    private static uint ExtractArgb(object? v) {
        if (v == null) return 0u;
        if (v is uint u) return u;
        var t = v.GetType();
        // The struct path (v2.1.2): Alpha/Red/Green/Blue public byte fields.
        var alphaField = t.GetField("Alpha", BindingFlags.Public | BindingFlags.Instance);
        var redField = t.GetField("Red", BindingFlags.Public | BindingFlags.Instance);
        var greenField = t.GetField("Green", BindingFlags.Public | BindingFlags.Instance);
        var blueField = t.GetField("Blue", BindingFlags.Public | BindingFlags.Instance);
        if (alphaField != null && redField != null && greenField != null && blueField != null) {
            uint a = (uint)(byte)(alphaField.GetValue(v) ?? (byte)0);
            uint r = (uint)(byte)(redField.GetValue(v) ?? (byte)0);
            uint g = (uint)(byte)(greenField.GetValue(v) ?? (byte)0);
            uint b = (uint)(byte)(blueField.GetValue(v) ?? (byte)0);
            return (a << 24) | (r << 16) | (g << 8) | b;
        }
        // Forward-compat fallbacks (Value property / field).
        var valueProp = t.GetProperty("Value", BindingFlags.Public | BindingFlags.Instance);
        if (valueProp != null) {
            var inner = valueProp.GetValue(v);
            if (inner != null) return ToUInt32(inner);
        }
        var valueField = t.GetField("Value", BindingFlags.Public | BindingFlags.Instance);
        if (valueField != null) {
            var inner = valueField.GetValue(v);
            if (inner != null) return ToUInt32(inner);
        }
        return 0u;
    }

    /// <summary>
    /// Coerce an enumerable (List&lt;T&gt; — DRW emits these for sub-records)
    /// to a List&lt;object&gt; we can drive with field-by-name.
    /// </summary>
    private static List<object> ToListOfObject(object? listObj) {
        var result = new List<object>();
        if (listObj == null) return result;
        if (listObj is System.Collections.IEnumerable enumerable) {
            foreach (var item in enumerable) {
                if (item != null) result.Add(item);
            }
        }
        return result;
    }
}
