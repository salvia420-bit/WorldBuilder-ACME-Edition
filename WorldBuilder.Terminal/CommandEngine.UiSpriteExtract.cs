using System;
using System.Buffers.Binary;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Security.Cryptography;
using System.Text;
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
/// Wave-1 UI port — extract retail-AC UI textures + layout trees from the
/// base DATs so the holtburger-web client can do a 1:1 UI port instead of
/// the current stylized approximation.
///
/// Two commands:
///
///   - <c>chorizite-dump-layout-tree</c> — open
///     <c>client_local_English.dat</c> via <see cref="DRW.DatCollection"/>
///     (the DatCollection wiring is load-bearing: <c>LayoutDesc</c>
///     elements carry <see cref="DRW.Types.StateDesc"/> trees of
///     <see cref="DRW.Types.BaseProperty"/> records, and
///     <c>BaseProperty.UnpackGeneric</c> reaches through
///     <c>reader.Database.DatCollection.Portal.MasterProperty</c> to
///     resolve property keys; a bare <c>LocalDatabase</c> would throw on
///     the first non-empty StateDesc). Walk the tree recursively, emit a
///     JSON record per <see cref="DRW.Types.ElementDesc"/>, and surface
///     every <c>0x06xxxxxx</c> RenderSurface DID seen anywhere in the
///     tree as <c>allImageDids</c> at top level — that list is the input
///     for command 2.
///
///   - <c>chorizite-extract-ui-textures</c> — open
///     <c>client_portal.dat</c>, look up each DID as a
///     <see cref="DRW.DBObjs.RenderSurface"/>, decode to RGBA8 via the
///     same per-PixelFormat switch <c>CommandEngine.TextureParity</c>
///     already uses, and write one PNG per DID to <c>outDir</c>. Records
///     a per-DID status manifest (<c>INDEX.json</c>) covering
///     <c>width / height / sha256 / status</c>; on decode failure logs
///     the error and continues with the next DID.
///
/// Both commands default to base DATs under
/// <c>~/ac_base_dats/</c> per [[feedback_base_dats_only_for_bake]] and
/// emit large intermediate JSON to
/// <c>/mnt/wbterminal1/tmp/claude-scratch/ui-port-wave1/</c> per
/// [[feedback_use_external_drives_for_scratch]] when the caller passes
/// an absolute <c>outPath</c> there; the small PNG artefacts (~100 KB
/// total expected for Wave 1) land under the holtburger-web tree at
/// <c>data/ui-sprites/</c>.
///
/// Source precedence for the decode switch: this command crib's its
/// per-PixelFormat decoder from
/// <see cref="CommandEngine.TextureParity"/>'s <c>DecodeRenderSurfaceToRgba8</c>,
/// which in turn mirrors
/// <c>DatReaderWriter.Extensions.DBObjs.RenderSurfaceExtensions.ToRgba8</c>
/// — the canonical Chorizite-side reference. We re-host the switch
/// here (rather than calling the existing helper) so this partial owns
/// the lifetime of its <see cref="DRW.DatCollection"/> + palette cache
/// without crossing the TextureParity command surface, but the byte
/// outputs are identical for every shared PixelFormat (verified by the
/// Wave-4 texture-parity sweep against 6,152 surfaces).
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────
    //  Result records
    // ─────────────────────────────────────────────────────────────────

    public sealed record UiLayoutDumpResult(
        string LayoutIdHex,
        uint LayoutId,
        uint Width,
        uint Height,
        int ElementCount,
        int ImageDidCount,
        IReadOnlyList<string> AllImageDids,
        IReadOnlyList<UiLayoutElementRecord> Elements,
        string DatPath,
        string OutPath);

    public sealed record UiLayoutElementRecord(
        string ElementIdHex,
        uint ElementId,
        // Best-effort symbolic name from the retail AcClient.UIElementId enum
        // (1,765 entries, e.g. "RootRadar_Field"). Null when resolveSymbols is
        // off OR when the ID isn't in the retail enum (custom server layouts,
        // post-classic-era IDs) — caller still has ElementIdHex either way.
        string? ElementIdName,
        uint ReadOrder,
        uint Type,
        string? ParentElementIdHex,
        string DefaultState,
        UiLayoutStateDescRecord? StateDesc,
        IReadOnlyDictionary<string, UiLayoutStateDescRecord> States,
        IReadOnlyList<string> ImageDids,         // 0x06xxxxxx DIDs seen anywhere on this element
        IReadOnlyList<UiLayoutElementRecord> Children);

    public sealed record UiLayoutStateDescRecord(
        uint StateId,
        // Best-effort symbolic name from DRW.Enums.UIStateId (generated from
        // dats.xml prefix 2322, ~80 entries — Normal / Highlight / Closed /
        // Open / heritage names like Aluvian etc.). Null when resolveSymbols
        // is off OR when the ID isn't in the enum.
        string? StateIdName,
        bool PassToChildren,
        string IncorporationFlagsHex,
        // Bit-expanded mirror of IncorporationFlagsHex, in the shape ac.yotes.fan
        // shows it (one entry per set bit). Null when resolveSymbols is off so
        // existing dumps stay byte-stable.
        IReadOnlyList<UiIncorporationFlagRecord>? IncorporationFlags,
        uint? X, uint? Y, uint? Width, uint? Height, uint? ZLevel,
        uint? LeftEdge, uint? TopEdge, uint? RightEdge, uint? BottomEdge,
        // Flattened scalar dump of the StateDesc.Properties dict.
        // Each entry: {key:"0xKEY", type:"DataId|Integer|...", value: …, isImageDid: bool}.
        IReadOnlyList<UiPropertyRecord> Properties,
        IReadOnlyList<UiMediaRecord> Media);

    public sealed record UiIncorporationFlagRecord(
        string BitHex,    // e.g. "0x02"
        string Name);     // e.g. "X" (canonical DRW.Enums.IncorporationFlags name)

    public sealed record UiPropertyRecord(
        string KeyHex,
        uint Key,
        string Type,
        object? Value,
        bool IsImageDid,
        string? FieldName);     // best-effort symbolic name from MasterProperty.EnumMapper, or null.

    public sealed record UiMediaRecord(
        string MediaType,
        IReadOnlyDictionary<string, object?> Fields,
        IReadOnlyList<string> ImageDids);

    public sealed record UiTextureExtractResult(
        string OutDir,
        string DatPath,
        int RequestedCount,
        int DistinctCount,
        int PngCount,
        int FailCount,
        IReadOnlyList<UiTextureRecord> Records,
        string IndexJsonPath);

    public sealed record UiTextureRecord(
        string DidHex,
        uint Did,
        int Width,                              // effective (decoded payload) dims
        int Height,
        string? Sha256,
        string Status,                          // "PASS" / "FAIL"
        string Source,                          // datPath basename
        string? PngPath,
        string? PixelFormat,
        string? FailureReason,
        int HeaderWidth = 0,                    // RenderSurface header dims (may differ for JPEG)
        int HeaderHeight = 0);

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-dump-layout-tree
    // ─────────────────────────────────────────────────────────────────

    public UiLayoutDumpResult ChoriziteDumpLayoutTree(uint layoutId, string? outPath, string? datPath, bool resolveSymbols = false) {
        // Resolve to client_local_English.dat. We default to the LOCAL DAT
        // because LayoutDesc lives there (per dats.xml — LayoutDesc is on
        // the <dat name="local"> stanza, 0x21000000-0x21FFFFFF). The
        // caller can override datPath to a copy or an iteration build.
        var resolvedLocal = ResolveDatPathOrAlias(datPath, defaultAlias: "local");
        var datDir = Path.GetDirectoryName(resolvedLocal)!;

        // Open the FULL DAT COLLECTION so BaseProperty.UnpackGeneric can
        // resolve the portal MasterProperty (per
        // DatReaderWriter/Types/BaseProperty.cs:55-62 — UnpackGeneric
        // throws if reader.Database.DatCollection is null). The DRW
        // DatCollection ctor is (DatCollectionOptions) — no builder
        // overload — so we pre-populate the options object.
        //
        // HighResDatPath quirk: DatCollection unconditionally opens all 4
        // DAT files (portal + cell + local + highres) on construct.
        // Retail base installs ship a client_highres.dat, but
        // ~/ac_base_dats only carries the three primaries; we point
        // HighRes at the portal DAT so the collection opens cleanly.
        // The portal-then-highres fallback in DatCollection.TryGet falls
        // through gracefully because the file IDs are identical — every
        // record we read is also resolvable from the primary portal
        // handle, so the duplicate open is a no-op data-wise.
        var resolvedPortalForCol = ResolveDatPathOrAlias(null, defaultAlias: "portal");
        var collectionOpts = new DRW.Options.DatCollectionOptions {
            DatDirectory = datDir,
            AccessType = DRW.Options.DatAccessType.Read,
            // Allow overrides — e.g. caller might pass a non-canonical
            // local DAT under datPath while the portal still lives in the
            // standard ac_base_dats location.
            LocalDatPath = resolvedLocal,
            PortalDatPath = resolvedPortalForCol,
            HighResDatPath = resolvedPortalForCol,
        };
        using var collection = new DRW.DatCollection(collectionOpts);

        if (!collection.TryGet<DRW.DBObjs.LayoutDesc>(layoutId, out var layout) || layout == null) {
            throw new InvalidOperationException(
                $"LayoutDesc 0x{layoutId:X8} not found in {resolvedLocal}.");
        }

        // Build a symbolic-name lookup from the portal's MasterProperty if
        // we can. Stored as MasterPropertyId → readable name, best-effort.
        var masterPropertyNames = TryBuildMasterPropertyNameIndex(collection);

        var seenImageDids = new SortedSet<uint>();

        // Walk the element forest.
        var rootElements = new List<UiLayoutElementRecord>();
        foreach (var kvp in layout.Elements.OrderBy(e => e.Value.ReadOrder).ThenBy(e => e.Key)) {
            rootElements.Add(BuildElementRecord(
                element: kvp.Value,
                parentId: null,
                seenImageDids: seenImageDids,
                masterPropertyNames: masterPropertyNames,
                resolveSymbols: resolveSymbols));
        }

        // Count elements transitively (sanity for the smoke test).
        int totalElements = 0;
        void CountTree(IReadOnlyList<UiLayoutElementRecord> nodes) {
            foreach (var n in nodes) {
                totalElements++;
                CountTree(n.Children);
            }
        }
        CountTree(rootElements);

        var allImageDids = seenImageDids.Select(d => $"0x{d:X8}").ToList();
        var resultBody = new UiLayoutDumpResult(
            LayoutIdHex: $"0x{layoutId:X8}",
            LayoutId: layoutId,
            Width: layout.Width,
            Height: layout.Height,
            ElementCount: totalElements,
            ImageDidCount: allImageDids.Count,
            AllImageDids: allImageDids,
            Elements: rootElements,
            DatPath: resolvedLocal,
            OutPath: outPath ?? "");

        if (!string.IsNullOrWhiteSpace(outPath)) {
            var outDir = Path.GetDirectoryName(outPath);
            if (!string.IsNullOrEmpty(outDir) && !Directory.Exists(outDir)) {
                Directory.CreateDirectory(outDir);
            }
            // camelCase property names so the JS plugins that consume this
            // (inventory.js / spellbook.js / etc.) get the same shape they
            // already use throughout the codebase. The JsonCommandProcessor
            // wrapper around this call already serializes anonymous types in
            // camelCase via its own options — aligning the file output here
            // keeps the two paths consistent. Dictionary keys (e.g. the
            // States dict keyed by UIStateId enum names like "MeleeCombat")
            // stay as their canonical retail names because we don't set
            // DictionaryKeyPolicy — those are domain values, not field
            // names, and lowercasing them would drift from retail.
            File.WriteAllText(outPath,
                JsonSerializer.Serialize(resultBody, new JsonSerializerOptions {
                    WriteIndented = true,
                    PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
                    Encoder = System.Text.Encodings.Web.JavaScriptEncoder
                        .UnsafeRelaxedJsonEscaping
                }));
        }
        return resultBody;
    }

    /// <summary>
    /// Walks one ElementDesc into a UiLayoutElementRecord. Recurses into
    /// the Children dictionary; collects DIDs into the shared
    /// <paramref name="seenImageDids"/> set.
    /// </summary>
    private UiLayoutElementRecord BuildElementRecord(
        DRW.Types.ElementDesc element,
        uint? parentId,
        SortedSet<uint> seenImageDids,
        IReadOnlyDictionary<uint, string> masterPropertyNames,
        bool resolveSymbols) {
        var elementImageDids = new SortedSet<uint>();

        UiLayoutStateDescRecord? defaultStateRecord = null;
        var allStateRecords = new Dictionary<string, UiLayoutStateDescRecord>(StringComparer.Ordinal);

        // ElementDesc carries its own scalar layout-rectangle fields
        // (X/Y/Width/Height/ZLevel + LeftEdge/TopEdge/RightEdge/BottomEdge);
        // the StateDesc field (singular) is the "default" overlay applied
        // when an element has no explicit DefaultState match. The dict
        // States is keyed by UIStateId and is what changes when an
        // element transitions between hover / pressed / etc.
        defaultStateRecord = BuildStateDescRecord(
            stateDesc: element.StateDesc,
            elementRectFallback: element,
            elementImageDids: elementImageDids,
            masterPropertyNames: masterPropertyNames,
            resolveSymbols: resolveSymbols);

        if (element.States != null) {
            foreach (var kvp in element.States) {
                var name = Enum.IsDefined(kvp.Key) ? kvp.Key.ToString() : $"0x{(uint)kvp.Key:X8}";
                var rec = BuildStateDescRecord(
                    stateDesc: kvp.Value,
                    elementRectFallback: element,
                    elementImageDids: elementImageDids,
                    masterPropertyNames: masterPropertyNames,
                    resolveSymbols: resolveSymbols);
                allStateRecords[name] = rec;
            }
        }

        // Walk children — order by ReadOrder for stable, retail-shape output.
        var childRecords = new List<UiLayoutElementRecord>();
        if (element.Children != null) {
            foreach (var kvp in element.Children.OrderBy(e => e.Value.ReadOrder).ThenBy(e => e.Key)) {
                childRecords.Add(BuildElementRecord(
                    element: kvp.Value,
                    parentId: element.ElementId,
                    seenImageDids: seenImageDids,
                    masterPropertyNames: masterPropertyNames,
                    resolveSymbols: resolveSymbols));
            }
        }

        // Fold this element's DIDs into the top-level set.
        foreach (var d in elementImageDids) seenImageDids.Add(d);

        return new UiLayoutElementRecord(
            ElementIdHex: $"0x{element.ElementId:X8}",
            ElementId: element.ElementId,
            ElementIdName: resolveSymbols ? TryResolveUiElementIdName(element.ElementId) : null,
            ReadOrder: element.ReadOrder,
            Type: element.Type,
            ParentElementIdHex: parentId.HasValue ? $"0x{parentId.Value:X8}" : null,
            DefaultState: Enum.IsDefined(element.DefaultState) ? element.DefaultState.ToString() : $"0x{(uint)element.DefaultState:X8}",
            StateDesc: defaultStateRecord,
            States: allStateRecords,
            ImageDids: elementImageDids.Select(d => $"0x{d:X8}").ToList(),
            Children: childRecords);
    }

    private UiLayoutStateDescRecord BuildStateDescRecord(
        DRW.Types.StateDesc stateDesc,
        DRW.Types.ElementDesc elementRectFallback,
        SortedSet<uint> elementImageDids,
        IReadOnlyDictionary<uint, string> masterPropertyNames,
        bool resolveSymbols) {

        // Properties — iterate the (uint → BaseProperty) dict and emit
        // a typed scalar record per entry. Detect DIDs in the
        // 0x06000000-0x06FFFFFF range from EVERY property type (the
        // typical retail location is a DataIdBaseProperty.Value, but
        // a few StateDescs use ColorBaseProperty etc. — we surface any
        // uint-shaped field that falls in the image-DID window so the
        // caller can grep without missing oddly-typed references).
        var propRecords = new List<UiPropertyRecord>();
        if (stateDesc.Properties != null) {
            foreach (var kvp in stateDesc.Properties.OrderBy(p => p.Key)) {
                var key = kvp.Key;
                var prop = kvp.Value;
                masterPropertyNames.TryGetValue(prop.MasterPropertyId, out var fieldName);
                var record = BuildPropertyRecord(key, prop, fieldName);
                propRecords.Add(record);
                if (record.IsImageDid && record.Value is uint didValue) {
                    elementImageDids.Add(didValue);
                }
            }
        }

        var mediaRecords = new List<UiMediaRecord>();
        if (stateDesc.Media != null) {
            foreach (var media in stateDesc.Media) {
                var rec = BuildMediaRecord(media);
                mediaRecords.Add(rec);
                foreach (var d in rec.ImageDids) {
                    if (d.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                        && uint.TryParse(d.Substring(2),
                            System.Globalization.NumberStyles.HexNumber,
                            System.Globalization.CultureInfo.InvariantCulture,
                            out var didValue)) {
                        elementImageDids.Add(didValue);
                    }
                }
            }
        }

        // Inflate IncorporationFlags-gated rect fields from the ElementDesc.
        // The flags live on the StateDesc; if a flag bit is set, the
        // corresponding rect scalar on the element's mask-map output
        // (X/Y/Width/Height/ZLevel) is meaningful.
        var flagsUint = (uint)stateDesc.IncorporationFlags;
        // IncorporationFlags canonical bit values per dats.xml enum (prefix 2298):
        //   PassToChildren = 0x01, X = 0x02, Y = 0x04, Width = 0x08,
        //   Height = 0x10, ZLevel = 0x20.
        // The ElementDesc maskmap at dats.xml line 3489 only names the masks
        // — bit values live on the enum itself, NOT the maskmap. Earlier
        // versions of this file used 0x01..0x10 (one bit off) which silently
        // mislabeled element.X as Y, Y as Width, etc., and never surfaced
        // ZLevel. ac.yotes.fan uses the same bits as below.
        bool HasFlag(uint mask) => (flagsUint & mask) == mask;

        return new UiLayoutStateDescRecord(
            StateId: stateDesc.StateId,
            StateIdName: resolveSymbols ? TryResolveUiStateIdName(stateDesc.StateId) : null,
            PassToChildren: stateDesc.PassToChildren,
            IncorporationFlagsHex: $"0x{flagsUint:X8}",
            IncorporationFlags: resolveSymbols ? ExpandIncorporationFlags(flagsUint) : null,
            X:        HasFlag(0x02u) ? elementRectFallback.X : (uint?)null,
            Y:        HasFlag(0x04u) ? elementRectFallback.Y : (uint?)null,
            Width:    HasFlag(0x08u) ? elementRectFallback.Width : (uint?)null,
            Height:   HasFlag(0x10u) ? elementRectFallback.Height : (uint?)null,
            ZLevel:   HasFlag(0x20u) ? elementRectFallback.ZLevel : (uint?)null,
            LeftEdge:   elementRectFallback.LeftEdge,
            TopEdge:    elementRectFallback.TopEdge,
            RightEdge:  elementRectFallback.RightEdge,
            BottomEdge: elementRectFallback.BottomEdge,
            Properties: propRecords,
            Media: mediaRecords);
    }

    /// <summary>
    /// Build a UiPropertyRecord for one BaseProperty. Reflects over the
    /// concrete subclass's <c>Value</c> field — we already know the
    /// shapes from <c>BaseProperty.UnpackInstanceFromType</c> in
    /// DRW/Types/BaseProperty.cs:70-120 (DataId/Integer/Float/Bool/Enum/
    /// Struct/Array/Vector/Color/Bitfield32/Bitfield64/InstanceId/
    /// StringInfo), but reflection keeps us forward-compatible with any
    /// new property types DRW adds.
    /// </summary>
    private static UiPropertyRecord BuildPropertyRecord(uint key, DRW.Types.BaseProperty prop, string? fieldName) {
        string typeName = prop.GetType().Name;
        // Strip the "BaseProperty" suffix for cleaner JSON.
        if (typeName.EndsWith("BaseProperty")) {
            typeName = typeName.Substring(0, typeName.Length - "BaseProperty".Length);
        }
        object? value = null;
        var valueField = prop.GetType().GetField("Value");
        if (valueField != null) {
            value = valueField.GetValue(prop);
        }
        bool isImageDid = false;
        uint? maybeDid = ExtractMaybeUint(value);
        if (maybeDid.HasValue && IsImageDid(maybeDid.Value)) {
            isImageDid = true;
            value = maybeDid.Value;  // canonicalize as uint for the JSON.
        } else {
            value = NormalizeJsonValue(value);
        }
        return new UiPropertyRecord(
            KeyHex: $"0x{key:X8}",
            Key: key,
            Type: typeName,
            Value: value,
            IsImageDid: isImageDid,
            FieldName: fieldName);
    }

    /// <summary>
    /// Reflect over a MediaDesc subclass instance — name + every
    /// non-base field — and collect DID-shaped fields into the per-media
    /// image-did set. ImageMediaDesc (Type=Image, field File) is the
    /// canonical hit; Cursor/Alpha/Animation/Sound are the other types
    /// that may carry a DAT-ID. Animation carries a <c>List&lt;uint&gt;
    /// Frames</c> — we walk every enumerable field recursively to
    /// surface DID-shaped scalars inside lists too.
    /// </summary>
    private static UiMediaRecord BuildMediaRecord(DRW.Types.MediaDesc media) {
        var mediaTypeName = media.GetType().Name;
        if (mediaTypeName.StartsWith("MediaDesc")) {
            mediaTypeName = mediaTypeName.Substring("MediaDesc".Length);
        }
        var fields = new Dictionary<string, object?>(StringComparer.Ordinal);
        var dids = new SortedSet<uint>();
        foreach (var f in media.GetType().GetFields(BindingFlags.Public | BindingFlags.Instance)) {
            // Skip the base-class Type field — it's already conveyed as MediaType.
            if (f.Name == "Type" && f.DeclaringType == typeof(DRW.Types.MediaDesc)) continue;
            var v = f.GetValue(media);
            CollectImageDidsFromValue(v, dids);
            fields[f.Name] = NormalizeJsonValue(v);
        }
        return new UiMediaRecord(
            MediaType: mediaTypeName,
            Fields: fields,
            ImageDids: dids.Select(d => $"0x{d:X8}").ToList());
    }

    /// <summary>Walk a value recursively, draining any DID-shaped scalars
    /// (including those inside <see cref="IEnumerable"/> fields like
    /// MediaDescAnimation.Frames) into the per-element/per-media
    /// image-did set. Bounded depth via the implicit recursion limit
    /// (DRW types are flat; recursion is at most 2 levels deep).</summary>
    private static void CollectImageDidsFromValue(object? v, SortedSet<uint> sink) {
        if (v == null) return;
        var maybe = ExtractMaybeUint(v);
        if (maybe.HasValue) {
            if (IsImageDid(maybe.Value)) sink.Add(maybe.Value);
            return;
        }
        // Drill into enumerables (List<uint>, arrays, etc.) but skip
        // strings (which are IEnumerable<char> in .NET).
        if (v is string) return;
        if (v is IEnumerable enumerable) {
            foreach (var item in enumerable) CollectImageDidsFromValue(item, sink);
        }
    }

    /// <summary>True if the value falls in the RenderSurface DAT range
    /// (Texture/0x06xxxxxx). Excludes 0x06000000 itself because that
    /// boundary marker is unused, but otherwise covers the full 16M
    /// retail range.</summary>
    private static bool IsImageDid(uint v) => v >= 0x06000001u && v <= 0x06FFFFFFu;

    // ─── Symbol resolvers (opt-in via resolveSymbols=true) ───────────────
    //
    // Lazily-built reverse maps for the three enum families
    // chorizite-dump-layout-tree can resolve. Each map is keyed by the raw
    // uint value and yields the canonical enum-name string; lookups
    // miss-and-return-null for IDs not present in the retail enum, which
    // happens for custom-server layouts and any post-classic-era content
    // additions. The hex form is always available on the sibling field
    // (ElementIdHex, IncorporationFlagsHex), so the dump remains accurate
    // whether or not a symbol resolves.

    private static IReadOnlyDictionary<uint, string>? _uiElementIdNames;
    private static IReadOnlyDictionary<uint, string>? _uiStateIdNames;

    private static IReadOnlyDictionary<uint, string> GetUiElementIdNames() {
        if (_uiElementIdNames != null) return _uiElementIdNames;
        var d = new Dictionary<uint, string>();
        foreach (var v in Enum.GetValues<AcClient.UIElementId>()) {
            // Duplicate underlying values would collide here — the retail
            // enum is unique on the value side, so a last-write-wins is
            // safe; using TryAdd documents the intent.
            d.TryAdd((uint)v, v.ToString());
        }
        _uiElementIdNames = d;
        return d;
    }

    private static IReadOnlyDictionary<uint, string> GetUiStateIdNames() {
        if (_uiStateIdNames != null) return _uiStateIdNames;
        var d = new Dictionary<uint, string>();
        foreach (var v in Enum.GetValues<DRW.Enums.UIStateId>()) {
            d.TryAdd((uint)v, v.ToString());
        }
        _uiStateIdNames = d;
        return d;
    }

    private static string? TryResolveUiElementIdName(uint id) {
        return GetUiElementIdNames().TryGetValue(id, out var n) ? n : null;
    }

    private static string? TryResolveUiStateIdName(uint id) {
        return GetUiStateIdNames().TryGetValue(id, out var n) ? n : null;
    }

    /// <summary>Bit-expand a packed IncorporationFlags uint into one record
    /// per set bit (yotes-fan-style). Iterates the generated DRW enum so
    /// we stay aligned with dats.xml without hardcoding bit values here.
    /// Returns an empty list when no bits are set (e.g. flags=0x0).</summary>
    private static IReadOnlyList<UiIncorporationFlagRecord> ExpandIncorporationFlags(uint flags) {
        var result = new List<UiIncorporationFlagRecord>();
        foreach (var v in Enum.GetValues<DRW.Enums.IncorporationFlags>()) {
            var bit = (uint)v;
            if (bit == 0) continue;           // skip "None"
            if ((flags & bit) == bit) {
                result.Add(new UiIncorporationFlagRecord(
                    BitHex: $"0x{bit:X2}",
                    Name: v.ToString()));
            }
        }
        return result;
    }

    /// <summary>Extract a single uint from an arbitrary scalar value if
    /// possible. Returns null for non-numeric or composite types.</summary>
    private static uint? ExtractMaybeUint(object? v) {
        if (v == null) return null;
        return v switch {
            uint u => u,
            int i when i >= 0 => (uint)i,
            ulong ul when ul <= uint.MaxValue => (uint)ul,
            long lng when lng >= 0 && lng <= uint.MaxValue => (uint)lng,
            _ => null,
        };
    }

    /// <summary>Recursively transform a value into a JSON-serializable
    /// form (collapsing PStringBase wrappers, enum names, structs to dicts).
    /// Defensive against composite Property types (Struct, Array) so the
    /// dump remains lossless without dragging in cycles.</summary>
    private static object? NormalizeJsonValue(object? v) {
        if (v == null) return null;
        switch (v) {
            case string s: return s;
            case bool b: return b;
            case sbyte or byte or short or ushort or int or uint or long or ulong: return v;
            case float f: return f;
            case double d: return d;
            case Enum e: return new Dictionary<string, object> {
                ["name"] = e.ToString(),
                ["value"] = Convert.ToInt64(e),
            };
            case DRW.Types.ColorARGB c: return new {
                a = c.Alpha, r = c.Red, g = c.Green, b = c.Blue,
                hex = $"#{c.Red:X2}{c.Green:X2}{c.Blue:X2}{c.Alpha:X2}",
            };
            case System.Numerics.Vector3 vec: return new { x = vec.X, y = vec.Y, z = vec.Z };
            case IDictionary dict: {
                var outDict = new Dictionary<string, object?>(StringComparer.Ordinal);
                foreach (DictionaryEntry kv in dict) {
                    outDict[Convert.ToString(kv.Key) ?? ""] = NormalizeJsonValue(kv.Value);
                }
                return outDict;
            }
            case IEnumerable<object> seq: return seq.Select(NormalizeJsonValue).ToList();
            case IEnumerable list when v is not string: {
                var outList = new List<object?>();
                foreach (var item in list) outList.Add(NormalizeJsonValue(item));
                return outList;
            }
        }
        // PStringBase<T> with a .Value property
        var pStrType = v.GetType();
        if (pStrType.IsGenericType && pStrType.GetGenericTypeDefinition().Name.StartsWith("PStringBase")) {
            var valProp = pStrType.GetProperty("Value");
            if (valProp != null) return valProp.GetValue(v);
        }
        // Sub-property: StructBaseProperty / ArrayBaseProperty / etc.
        if (v is DRW.Types.BaseProperty subProp) {
            return BuildPropertyRecord(0, subProp, fieldName: null);
        }
        // Fallback — flatten all public instance fields/props to a dict.
        var t = v.GetType();
        if (!t.IsPrimitive && !t.IsEnum) {
            var result = new Dictionary<string, object?>(StringComparer.Ordinal);
            foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance)) {
                result[f.Name] = NormalizeJsonValue(f.GetValue(v));
            }
            return result;
        }
        return v.ToString();
    }

    /// <summary>
    /// Best-effort: pull the symbolic name table from the portal's
    /// MasterProperty record so we can label each property by its
    /// human-readable field name (e.g. <c>BackgroundImage</c>). Returns
    /// an empty dict when the MasterProperty's <c>EnumMapper</c> shape
    /// doesn't carry a name table — the dump still works, we just lose
    /// the symbolic-name annotation.
    /// </summary>
    private static IReadOnlyDictionary<uint, string> TryBuildMasterPropertyNameIndex(DRW.DatCollection collection) {
        try {
            var mp = collection.Portal?.MasterProperty;
            if (mp == null) return new Dictionary<uint, string>();
            // The MasterProperty has an EnumMapper member that maps
            // string-hash → name (for property keys), but the shape
            // varies between DRW versions. Reflect defensively.
            var enumMapperField = mp.GetType().GetField("EnumMapper",
                BindingFlags.Public | BindingFlags.Instance);
            if (enumMapperField == null) return new Dictionary<uint, string>();
            var enumMapper = enumMapperField.GetValue(mp);
            if (enumMapper == null) return new Dictionary<uint, string>();
            // EnumMapperData → IDToStringMap (Dictionary<uint,string>)
            var idToStr = enumMapper.GetType().GetField("IDToStringMap",
                BindingFlags.Public | BindingFlags.Instance);
            if (idToStr != null) {
                if (idToStr.GetValue(enumMapper) is IDictionary dict) {
                    var result = new Dictionary<uint, string>();
                    foreach (DictionaryEntry kv in dict) {
                        if (kv.Key is uint k) {
                            result[k] = Convert.ToString(kv.Value) ?? "";
                        } else if (uint.TryParse(Convert.ToString(kv.Key), out var pk)) {
                            result[pk] = Convert.ToString(kv.Value) ?? "";
                        }
                    }
                    return result;
                }
            }
            return new Dictionary<uint, string>();
        } catch {
            // Best-effort; absence of names is non-fatal.
            return new Dictionary<uint, string>();
        }
    }

    // ─────────────────────────────────────────────────────────────────
    //  chorizite-extract-ui-textures
    // ─────────────────────────────────────────────────────────────────

    public UiTextureExtractResult ChoriziteExtractUiTextures(
        IReadOnlyList<uint> dids,
        string outDir,
        string? datPath) {
        if (dids == null || dids.Count == 0) {
            throw new ArgumentException("dids array is required and must be non-empty.");
        }
        var resolvedPortal = ResolveDatPathOrAlias(datPath, defaultAlias: "portal");

        Directory.CreateDirectory(outDir);

        // Open the full DatCollection — needed because some RenderSurface
        // formats (P8 / INDEX16) reach back through the palette chain
        // which lives in the same portal DAT. The collection wiring is
        // also defensive for any LayoutDesc-referenced DIDs that resolve
        // through the portal-side MasterProperty. DRW DatCollection ctor
        // is (DatCollectionOptions) only — see ChoriziteDumpLayoutTree
        // for the same trick. The HighResDatPath = portal trick mirrors
        // the layout-tree command's collection wiring; without it
        // DatCollection.ctor errors out because retail base installs
        // ship a client_highres.dat we don't have under ac_base_dats.
        var datDir = Path.GetDirectoryName(resolvedPortal)!;
        var collectionOpts = new DRW.Options.DatCollectionOptions {
            DatDirectory = datDir,
            AccessType = DRW.Options.DatAccessType.Read,
            PortalDatPath = resolvedPortal,
            HighResDatPath = resolvedPortal,
        };
        using var collection = new DRW.DatCollection(collectionOpts);
        var datBasename = Path.GetFileName(resolvedPortal);

        var paletteCache = new Dictionary<uint, DRW.DBObjs.Palette>();
        var records = new List<UiTextureRecord>(dids.Count);
        int pass = 0, fail = 0;

        foreach (var did in dids.Distinct()) {
            var didHex = $"0x{did:X8}";
            var pngPath = Path.Combine(outDir, $"{didHex}.png");
            UiTextureRecord rec;
            try {
                if (!collection.Portal.TryGet<DRW.DBObjs.RenderSurface>(did, out var rs) || rs == null) {
                    rec = new UiTextureRecord(didHex, did, 0, 0, null, "FAIL",
                        Source: datBasename, PngPath: null, PixelFormat: null,
                        FailureReason: $"RenderSurface 0x{did:X8} not present in {datBasename}");
                } else {
                    string format = rs.Format.ToString();
                    byte[] rgba = DecodeUiRenderSurfaceToRgba8(
                        rs, collection.Portal, paletteCache,
                        out int decodedWidth, out int decodedHeight);
                    EmitPngFile(pngPath, rgba, decodedWidth, decodedHeight);
                    var sha = Sha256HexBytes(rgba);
                    rec = new UiTextureRecord(didHex, did, decodedWidth, decodedHeight, sha, "PASS",
                        Source: datBasename, PngPath: pngPath, PixelFormat: format,
                        FailureReason: null,
                        HeaderWidth: rs.Width, HeaderHeight: rs.Height);
                }
            } catch (Exception ex) {
                rec = new UiTextureRecord(didHex, did, 0, 0, null, "FAIL",
                    Source: datBasename, PngPath: null, PixelFormat: null,
                    FailureReason: ex.Message);
            }
            if (rec.Status == "PASS") pass++; else fail++;
            records.Add(rec);
        }

        // Write INDEX.json — { "0x06xxxxxx": { width, height, sha256, source, status, pixelFormat } }.
        var indexJsonPath = Path.Combine(outDir, "INDEX.json");
        var indexBody = new Dictionary<string, object>(StringComparer.Ordinal);
        foreach (var r in records.OrderBy(r => r.Did)) {
            indexBody[r.DidHex] = new {
                width = r.Width,
                height = r.Height,
                headerWidth = r.HeaderWidth,
                headerHeight = r.HeaderHeight,
                sha256 = r.Sha256,
                source = r.Source,
                status = r.Status,
                pixelFormat = r.PixelFormat,
                failureReason = r.FailureReason,
            };
        }
        File.WriteAllText(indexJsonPath,
            JsonSerializer.Serialize(new {
                generatedBy = "WorldBuilder.Terminal chorizite-extract-ui-textures",
                datPath = resolvedPortal,
                count = records.Count,
                passCount = pass,
                failCount = fail,
                records = indexBody,
            }, new JsonSerializerOptions { WriteIndented = true }));

        return new UiTextureExtractResult(
            OutDir: outDir,
            DatPath: resolvedPortal,
            RequestedCount: dids.Count,
            DistinctCount: records.Count,
            PngCount: pass,
            FailCount: fail,
            Records: records,
            IndexJsonPath: indexJsonPath);
    }

    // ─────────────────────────────────────────────────────────────────
    //  Decode helpers — re-hosted from CommandEngine.TextureParity
    //  for the same per-PixelFormat switch.
    //  Verified byte-identical for the formats Wave-4 already certified
    //  (6,152 surfaces). See class docstring for the source-precedence
    //  argument; the version here owns its own palette cache + uses
    //  a PortalDatabase handle directly so DecodeOneSurface's threading
    //  invariants in TextureParity aren't crossed.
    // ─────────────────────────────────────────────────────────────────

    private static byte[] DecodeUiRenderSurfaceToRgba8(
        DRW.DBObjs.RenderSurface rs,
        DRW.PortalDatabase portal,
        Dictionary<uint, DRW.DBObjs.Palette> paletteCache,
        out int decodedWidth,
        out int decodedHeight) {
        int width = rs.Width;
        int height = rs.Height;
        byte[] src = rs.SourceData;
        byte[] outp = new byte[width * height * 4];

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
                var pal = ResolveUiPalette(portal, rs.DefaultPaletteId, paletteCache);
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int s = y * width + x;
                    int d = s * 4;
                    var c = pal.Colors[src[s]];
                    outp[d + 0] = c.Red;
                    outp[d + 1] = c.Green;
                    outp[d + 2] = c.Blue;
                    outp[d + 3] = c.Alpha;
                }
                break;
            }
            case DRW.Enums.PixelFormat.PFID_INDEX16: {
                var pal = ResolveUiPalette(portal, rs.DefaultPaletteId, paletteCache);
                for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++) {
                    int s = (y * width + x) * 2;
                    int d = (y * width + x) * 4;
                    int palIndex = BinaryPrimitives.ReadInt16LittleEndian(
                        src.AsSpan(s, 2));
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
                var fmt = rs.Format switch {
                    // Bc1WithAlpha, NOT Bc1 — see RenderSurfaceExtensions.ToRgba8.
                    // DXT1's c0 <= c1 blocks are punch-through: index 3 is
                    // transparent. Bc1 (opaque) renders those texels solid black.
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

    private static DRW.DBObjs.Palette ResolveUiPalette(
        DRW.PortalDatabase portal, uint paletteId,
        Dictionary<uint, DRW.DBObjs.Palette> cache) {
        if (cache.TryGetValue(paletteId, out var hit)) return hit;
        if (!portal.TryGet<DRW.DBObjs.Palette>(paletteId, out var pal) || pal == null) {
            throw new InvalidOperationException(
                $"Palette 0x{paletteId:X8} not found in portal DAT.");
        }
        if (cache.Count < 512) cache[paletteId] = pal;
        return pal;
    }

    private static void EmitPngFile(string outPath, byte[] rgba, int width, int height) {
        if (width <= 0 || height <= 0 || rgba.Length == 0) {
            throw new InvalidOperationException(
                $"Refusing to write zero-byte PNG: {width}x{height}");
        }
        using var img = Image.LoadPixelData<Rgba32>(rgba, width, height);
        using var fs = File.Create(outPath);
        img.SaveAsPng(fs, new PngEncoder { CompressionLevel = PngCompressionLevel.BestCompression });
    }

    private static string Sha256HexBytes(byte[] bytes) {
        var hash = SHA256.HashData(bytes);
        var sb = new StringBuilder(hash.Length * 2);
        foreach (var b in hash) sb.Append(b.ToString("x2"));
        return sb.ToString();
    }

    // ─────────────────────────────────────────────────────────────────
    //  DAT-path resolution — accepts caller-supplied absolute path or
    //  any of the existing aliases (portal/local/cell). Defaults per
    //  command via <paramref name="defaultAlias"/>. Mirrors the
    //  CommandEngine.DatParity.cs::ResolveDatPathPermissive pattern but
    //  without requiring the DBObj type-prefix table.
    // ─────────────────────────────────────────────────────────────────

    private static string ResolveDatPathOrAlias(string? datPath, string defaultAlias) {
        if (string.IsNullOrWhiteSpace(datPath)) {
            return ResolveAlias(defaultAlias);
        }
        var trimmed = datPath.Trim();
        // Aliases: caller might pass "portal" / "local" / "cell".
        var lower = trimmed.ToLowerInvariant();
        if (lower == "portal" || lower == "client_portal" || lower == "client_portal.dat") {
            return ResolveAlias("portal");
        }
        if (lower == "local" || lower == "client_local"
            || lower == "client_local_english" || lower == "client_local_english.dat") {
            return ResolveAlias("local");
        }
        if (lower == "cell" || lower == "client_cell" || lower == "client_cell_1"
            || lower == "client_cell_1.dat") {
            return ResolveAlias("cell");
        }
        if (!File.Exists(trimmed)) {
            throw new FileNotFoundException($"datPath not found: {trimmed}");
        }
        return trimmed;
    }

    private static string ResolveAlias(string alias) {
        var baseDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "ac_base_dats");
        string fname = alias.ToLowerInvariant() switch {
            "portal" => "client_portal.dat",
            "local" => "client_local_English.dat",
            "cell" => "client_cell_1.dat",
            _ => throw new ArgumentException(
                $"Unknown alias '{alias}'. Expected portal|local|cell.")
        };
        var p = Path.Combine(baseDir, fname);
        if (!File.Exists(p)) {
            throw new FileNotFoundException(
                $"Base DAT '{fname}' not found at {p}; populate ~/ac_base_dats per [[feedback_base_dats_only_for_bake]].");
        }
        return p;
    }
}
