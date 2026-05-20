using System;
using System.Collections;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using DRW = DatReaderWriter;

namespace WorldBuilder.Terminal;

/// <summary>
/// Wave 5.A — Cell-portal graph sweep + PVS visibility snapshot.
///
/// See <c>docs/diagnostic-toolset-plan-2026-05-19.md</c> §3 row 12 and §6
/// Wave 5 W5.A. Sibling to <c>CommandEngine.DatParity.cs</c> (W2.A/B/D) and
/// <c>CommandEngine.PhysicsParity.cs</c> (W3.A/B/F). Provides two commands:
///
///   - <c>cell-portal-graph-sweep &lt;lbIds&gt;</c> — for a list of
///     landblock-high IDs (e.g. <c>0xA9B40000</c>, <c>0x86020000</c>),
///     resolves every EnvCell via Chorizite.DatReaderWriter, builds the
///     cell-portal graph (cell → portal → other_cell), and reports orphans
///     and asymmetric portals.
///
///   - <c>pvs-visibility-snapshot &lt;cellId&gt; [bfsDepth=1]</c> — returns
///     the BFS-N visible set rooted at a cell, per retail's
///     <c>CCellPortal::*</c> / <c>CEnvCell::recursively_get_object</c> walk
///     in <c>~/ac-headers/acclient.c:349403-349486</c>. The dat already
///     ships an in-record <c>VisibleCells</c> array that retail bakes from
///     this walk at compile time; the snapshot returns BOTH the live BFS-N
///     result AND the dat's precomputed visibleCells so the validator can
///     compare them.
///
/// Symmetry contract (per <c>acclient.c::CCellPortal::UnPack</c> +
/// <c>CCellPortal::Pack</c> at <c>~/ac-headers/acclient.c:362347-362403</c>):
/// every directed edge <c>(A, polyA) → (B, polyB)</c> must have a matching
/// reverse edge <c>(B, polyB) → (A, polyA)</c>. A's <c>OtherCellId =
/// block_mask | wire_u16</c> where <c>block_mask</c> is the LB high word
/// (Pack drops the high word, Unpack ORs it back). Documented exception
/// (allowlisted, not failed): the <c>0xFFFE</c> sentinel — a poly with no
/// other-cell (set when CCellPortal::Pack sees <c>other_cell_id == -1</c>;
/// the bit is the <c>PortalFlags 0x04</c> mask). DRW stores these as
/// <c>OtherCellId == 0xFFFE</c> in its u16 wire round-trip.
///
/// Source-of-truth precedence per
/// <see cref="StringBaseConverterFactory"/>'s sibling note in
/// <c>CommandEngine.DatParity.cs</c>: when Chorizite/DRW disagrees with
/// <c>~/ac-headers/acclient.c</c>, acclient.c wins. The portal-flags 0x04
/// "no-other-cell" sentinel maps to DRW's <c>PortalFlags.NoOtherCell</c>
/// (renamed in DRW; bit value is identical).
/// </summary>
public partial class CommandEngine {

    // ─────────────────────────────────────────────────────────────────
    //  Result records
    // ─────────────────────────────────────────────────────────────────

    public sealed record CellPortalSweepResult(
        string DatPath,
        string DatSha256,
        int LbCount,
        int EnvCellCount,
        int PortalCount,
        int OrphanedCellCount,
        int AsymmetricPortalCount,
        IReadOnlyList<CellPortalLbReport> PerLb,
        string Source);

    public sealed record CellPortalLbReport(
        string LbHex,
        uint LbHigh,
        int CellCount,
        int PortalCount,
        int OrphanedCellCount,
        int AsymmetricPortalCount,
        IReadOnlyList<string> OrphanedCells,
        IReadOnlyList<AsymmetricEdgeReport> AsymmetricPortals);

    public sealed record AsymmetricEdgeReport(
        string FromCellHex,
        string ToCellHex,
        ushort PolyId,
        ushort OtherPortalId,
        string Reason);

    public sealed record PvsSnapshotResult(
        string CellHex,
        uint CellId,
        int BfsDepth,
        int LiveVisibleCount,
        int DatVisibleCount,
        IReadOnlyList<string> LiveVisibleCells,
        IReadOnlyList<string> DatVisibleCells,
        IReadOnlyList<string> OnlyInLive,
        IReadOnlyList<string> OnlyInDat,
        string Source);

    // ─────────────────────────────────────────────────────────────────
    //  cell-portal-graph-sweep
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// For each landblock in <paramref name="lbIds"/>, enumerate every
    /// EnvCell record under that LB via Chorizite.DatReaderWriter, build
    /// the cell-portal graph, and report orphans + asymmetric portals.
    ///
    /// <para>
    /// <paramref name="lbIds"/> entries can be:
    /// - Full LB IDs with low word ignored (e.g. <c>0xA9B40000</c>, <c>0xA9B4FFFF</c>) —
    ///   both forms normalize to the LB-high 0xA9B40000.
    /// - Just the LB-high uint (e.g. <c>0x86020000</c>).
    /// </para>
    ///
    /// <para>
    /// For each LB, the sweep:
    /// 1. Walks <c>client_cell_1.dat</c>'s BTree for IDs in
    ///    <c>[lbHigh | 0x0100, lbHigh | 0xFFFD]</c>.
    /// 2. Parses each as <see cref="DRW.DBObjs.EnvCell"/>.
    /// 3. For each portal in each cell, validates: (a) the
    ///    <c>OtherCellId</c> resolves to a known cell ID in the LB
    ///    (the wire stores low-16 of the cell ID; we widen with the LB high
    ///    word per <c>CCellPortal::UnPack</c>); (b) the target cell has a
    ///    matching reverse portal at index <c>OtherPortalId</c>.
    /// 4. Orphans = cells with no incoming portal references AND no
    ///    outgoing portals (the rare case — a single floating cell).
    ///    Cells with outgoing portals but no incoming are legitimate
    ///    leaf/entrance cells (e.g. a dungeon entry).
    /// </para>
    ///
    /// <para>
    /// The 0xFFFE no-other-cell sentinel (<c>PortalFlags.NoOtherCell</c>,
    /// bit 0x04) is allowlisted: such portals are NOT counted toward the
    /// asymmetry budget. See <c>acclient.c:362361-362362</c>:
    /// <c>if (this->other_cell_id == -1) v3 |= 4u;</c>.
    /// </para>
    /// </summary>
    public CellPortalSweepResult CellPortalGraphSweep(string? datPath, IReadOnlyList<uint> lbIds) {
        if (lbIds == null || lbIds.Count == 0)
            throw new ArgumentException("lbIds must contain at least one LB-high uint");

        var resolved = ResolveDatPathForType(datPath, typeof(DRW.DBObjs.EnvCell));
        var sha = ComputeDatSha256(resolved);

        using var dat = new DRW.DatDatabase(o => {
            o.FilePath = resolved;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Upfront;
        });

        var lbReports = new List<CellPortalLbReport>();
        int totalCells = 0, totalPortals = 0, totalOrphans = 0, totalAsym = 0;

        foreach (var rawLb in lbIds) {
            uint lbHigh = rawLb & 0xFFFF_0000u;
            ushort lbWord = (ushort)(lbHigh >> 16);

            // Walk all EnvCells in this LB. EnvCells live in
            // [lbHigh | 0x0100, lbHigh | 0xFFFD] per the AC convention.
            // LandBlockInfo is at lbHigh | 0xFFFE; LandBlock at lbHigh | 0xFFFF.
            var cells = new Dictionary<uint, DRW.DBObjs.EnvCell>();
            uint rangeStart = lbHigh | 0x0001u;
            uint rangeEnd   = lbHigh | 0xFFFDu;
            foreach (var id in EnumerateEnvCellIdsInRange(dat, rangeStart, rangeEnd)) {
                if (dat.TryGet<DRW.DBObjs.EnvCell>(id, out var cell) && cell != null) {
                    cells[id] = cell;
                }
            }

            int lbPortalCount = 0;
            int lbAsymCount = 0;
            var orphans = new List<string>();
            var asym = new List<AsymmetricEdgeReport>();
            var refCount = new Dictionary<uint, int>();
            foreach (var cellId in cells.Keys) refCount[cellId] = 0;

            // First pass: count portals, register references.
            foreach (var (cellId, cell) in cells) {
                var portals = GetPortalsList(cell);
                if (portals == null) continue;
                for (int i = 0; i < portals.Count; i++) {
                    var p = portals[i];
                    lbPortalCount++;
                    var (flags, otherCellWord, otherPortalId, polyId) = ReadPortalTuple(p);

                    // Sentinel (0x04 / NoOtherCell): no-other-cell exit portal.
                    // Documented allowlist; doesn't count toward asymmetry.
                    if ((flags & 0x04) != 0) continue;
                    // DRW also stores some sentinels as OtherCellId=0xFFFE.
                    if (otherCellWord == 0xFFFE) continue;

                    uint otherCellId = lbHigh | (uint)otherCellWord;
                    if (otherCellId == cellId) {
                        // Self-loop is malformed but rare. Treat as asymmetric.
                        asym.Add(new AsymmetricEdgeReport(
                            FromCellHex: $"0x{cellId:X8}",
                            ToCellHex: $"0x{otherCellId:X8}",
                            PolyId: polyId,
                            OtherPortalId: otherPortalId,
                            Reason: "self-loop"));
                        lbAsymCount++;
                        continue;
                    }
                    // Register the reference (incoming for otherCellId).
                    if (refCount.ContainsKey(otherCellId))
                        refCount[otherCellId] = refCount[otherCellId] + 1;
                }
            }

            // Second pass: per-edge symmetry check.
            foreach (var (cellId, cell) in cells) {
                var portals = GetPortalsList(cell);
                if (portals == null) continue;
                for (int i = 0; i < portals.Count; i++) {
                    var p = portals[i];
                    var (flags, otherCellWord, otherPortalId, polyId) = ReadPortalTuple(p);
                    if ((flags & 0x04) != 0) continue;        // allowlist
                    if (otherCellWord == 0xFFFE) continue;     // sentinel
                    if ((short)otherPortalId < 0) continue;    // -1 sentinel for unbound
                    uint otherCellId = lbHigh | (uint)otherCellWord;
                    if (otherCellId == cellId) continue;
                    if (!cells.TryGetValue(otherCellId, out var otherCell)) {
                        // Cross-LB portal: target is in another landblock.
                        // Common in outdoor LB stitching; do NOT count as
                        // asymmetric for the within-LB sweep.
                        continue;
                    }
                    var otherPortals = GetPortalsList(otherCell);
                    if (otherPortals == null || otherPortalId >= otherPortals.Count) {
                        asym.Add(new AsymmetricEdgeReport(
                            FromCellHex: $"0x{cellId:X8}",
                            ToCellHex: $"0x{otherCellId:X8}",
                            PolyId: polyId,
                            OtherPortalId: otherPortalId,
                            Reason: $"otherPortalId={otherPortalId} out of range (other has {otherPortals?.Count ?? 0})"));
                        lbAsymCount++;
                        continue;
                    }
                    var reverse = otherPortals[otherPortalId];
                    var (rFlags, rOtherWord, rOtherPortalId, rPolyId) = ReadPortalTuple(reverse);
                    uint rOtherCellId = lbHigh | (uint)rOtherWord;
                    if (rOtherCellId != cellId) {
                        asym.Add(new AsymmetricEdgeReport(
                            FromCellHex: $"0x{cellId:X8}",
                            ToCellHex: $"0x{otherCellId:X8}",
                            PolyId: polyId,
                            OtherPortalId: otherPortalId,
                            Reason: $"reverse portal target=0x{rOtherCellId:X8} (expected 0x{cellId:X8})"));
                        lbAsymCount++;
                        continue;
                    }
                    if (rOtherPortalId != i) {
                        asym.Add(new AsymmetricEdgeReport(
                            FromCellHex: $"0x{cellId:X8}",
                            ToCellHex: $"0x{otherCellId:X8}",
                            PolyId: polyId,
                            OtherPortalId: otherPortalId,
                            Reason: $"reverse portal otherPortalId={rOtherPortalId} (expected {i})"));
                        lbAsymCount++;
                        continue;
                    }
                }
            }

            // Orphans: cells with 0 outgoing AND 0 incoming portals.
            int lbOrphans = 0;
            foreach (var (cellId, cell) in cells) {
                var portals = GetPortalsList(cell);
                int outgoing = portals?.Count ?? 0;
                int incoming = refCount.TryGetValue(cellId, out var rc) ? rc : 0;
                if (outgoing == 0 && incoming == 0) {
                    orphans.Add($"0x{cellId:X8}");
                    lbOrphans++;
                }
            }

            lbReports.Add(new CellPortalLbReport(
                LbHex: $"0x{lbHigh:X8}",
                LbHigh: lbHigh,
                CellCount: cells.Count,
                PortalCount: lbPortalCount,
                OrphanedCellCount: lbOrphans,
                AsymmetricPortalCount: lbAsymCount,
                OrphanedCells: orphans,
                AsymmetricPortals: asym));

            totalCells += cells.Count;
            totalPortals += lbPortalCount;
            totalOrphans += lbOrphans;
            totalAsym += lbAsymCount;
        }

        return new CellPortalSweepResult(
            DatPath: resolved,
            DatSha256: sha,
            LbCount: lbReports.Count,
            EnvCellCount: totalCells,
            PortalCount: totalPortals,
            OrphanedCellCount: totalOrphans,
            AsymmetricPortalCount: totalAsym,
            PerLb: lbReports,
            Source: $"CellPortalGraphSweep via DatReaderWriter on {Path.GetFileName(resolved)} (sha {sha[..12]}…); contract per acclient.c:362347-362403");
    }

    /// <summary>
    /// Enumerate EnvCell IDs in <paramref name="dat"/> within the
    /// half-open range <c>[start, end]</c> by reflecting onto DRW's
    /// public <c>Tree.GetFilesInRange(uint, uint)</c>. Mirrors the cell-DAT
    /// walk pattern from <c>CommandEngine.DatParity.cs:354-403</c>; we
    /// can't go through <c>GetAllIdsOfType&lt;EnvCell&gt;</c> directly
    /// because we want a sub-LB range, not the whole DAT.
    /// </summary>
    private static IEnumerable<uint> EnumerateEnvCellIdsInRange(DRW.DatDatabase dat, uint rangeStart, uint rangeEnd) {
        var treeField = typeof(DRW.DatDatabase).GetField("Tree",
            BindingFlags.Public | BindingFlags.Instance);
        if (treeField == null) yield break;
        var tree = treeField.GetValue(dat);
        if (tree == null) yield break;
        var getFilesInRange = tree.GetType().GetMethods()
            .FirstOrDefault(m => m.Name == "GetFilesInRange" && m.GetParameters().Length == 2);
        if (getFilesInRange == null) yield break;
        var entries = getFilesInRange.Invoke(tree, new object[] { rangeStart, rangeEnd });
        if (entries == null) yield break;
        PropertyInfo? idProp = null;
        foreach (var entry in (IEnumerable)entries) {
            idProp ??= entry.GetType().GetProperty("Id") ?? throw new InvalidOperationException(
                "DatBTreeFile lacks .Id property — DRW API drift.");
            uint id = Convert.ToUInt32(idProp.GetValue(entry) ?? 0u);
            var suffix = id & 0xFFFFu;
            // Skip LandBlock (0xFFFF) + LandBlockInfo (0xFFFE) + iteration metadata.
            if (suffix >= 0x0100u && suffix <= 0xFFFDu) yield return id;
        }
    }

    /// <summary>
    /// Reflect <c>EnvCell.CellPortals</c> as an <see cref="IList"/>. DRW's
    /// source-gen emits this as a public FIELD (not a property), so we
    /// check fields before falling back to properties. Returns null only
    /// when the member is genuinely absent (which would be DRW API drift).
    /// </summary>
    private static IList? GetPortalsList(object envCell) {
        var t = envCell.GetType();
        var field = t.GetField("CellPortals") ?? t.GetField("Portals");
        if (field != null) return field.GetValue(envCell) as IList;
        var prop = t.GetProperty("CellPortals") ?? t.GetProperty("Portals");
        if (prop == null) return null;
        return prop.GetValue(envCell) as IList;
    }

    /// <summary>
    /// Reflect <c>EnvCell.VisibleCells</c> as a sequence of <c>ushort</c>
    /// low-16 cell IDs. Like <see cref="GetPortalsList"/>, DRW exposes
    /// this as a public field, not property.
    /// </summary>
    private static IEnumerable? GetVisibleCellsList(object envCell) {
        var t = envCell.GetType();
        var field = t.GetField("VisibleCells");
        if (field != null) return field.GetValue(envCell) as IEnumerable;
        var prop = t.GetProperty("VisibleCells");
        return prop?.GetValue(envCell) as IEnumerable;
    }

    /// <summary>
    /// Extract a portal tuple <c>(flags, otherCellId, otherPortalId, polyId)</c>
    /// from a DRW <c>CellPortal</c> struct/class instance. Uses reflection
    /// so we don't have to import the type and pick up DRW assembly-load
    /// surprises.
    ///
    /// <para>
    /// Per <c>~/ac-headers/acclient.c:362347-362403</c>:
    /// </para>
    /// <list type="bullet">
    /// <item><c>flags</c>: bit 0 = exact_match, bit 1 = !portal_side (NOT inverted at pack time),
    /// bit 2 = no-other-cell sentinel. DRW exposes these as the
    /// <c>PortalFlags</c> enum on <c>CellPortal.Flags</c>.</item>
    /// <item><c>polyId</c>: index of the portal polygon in the CellStructure.</item>
    /// <item><c>otherCellId</c>: low 16 bits of the linked cell's full ID
    /// (high word = parent LB).</item>
    /// <item><c>otherPortalId</c>: zero-based index of the matching portal
    /// in the linked cell. -1 means "no reverse portal known" (rare;
    /// happens during dynamic linking, not in baked retail DATs).</item>
    /// </list>
    /// </summary>
    private static (uint flags, ushort otherCell, ushort otherPortalId, ushort polyId) ReadPortalTuple(object portal) {
        var t = portal.GetType();
        uint flagsVal = 0;
        var raw = ReadMember(portal, t, "Flags");
        if (raw != null) flagsVal = Convert.ToUInt32(raw);
        ushort otherCell = (ushort)Convert.ToUInt32(ReadMember(portal, t, "OtherCellId") ?? (object)(ushort)0);
        // OtherPortalId can be -1 (short) in DRW; convert via int first.
        var opIdRaw = ReadMember(portal, t, "OtherPortalId");
        ushort otherPortalId;
        if (opIdRaw is short s) otherPortalId = unchecked((ushort)s);
        else if (opIdRaw is int i) otherPortalId = unchecked((ushort)i);
        else if (opIdRaw is ushort us) otherPortalId = us;
        else otherPortalId = (ushort)Convert.ToInt32(opIdRaw ?? 0);
        ushort polyId = (ushort)Convert.ToUInt32(ReadMember(portal, t, "PolygonId") ?? (object)(ushort)0);
        return (flagsVal, otherCell, otherPortalId, polyId);
    }

    /// <summary>
    /// DRW exposes most of its DBObj/struct shapes as PUBLIC FIELDS (not
    /// properties), per the source-gen template. Look up a member by name
    /// preferring fields, falling back to properties for older shapes
    /// or types where source-gen emits a property.
    /// </summary>
    private static object? ReadMember(object instance, Type t, string name) {
        var f = t.GetField(name);
        if (f != null) return f.GetValue(instance);
        var p = t.GetProperty(name);
        return p?.GetValue(instance);
    }

    // ─────────────────────────────────────────────────────────────────
    //  pvs-visibility-snapshot
    // ─────────────────────────────────────────────────────────────────

    /// <summary>
    /// For a single cell, run a BFS-N visibility expansion (default N=1)
    /// rooted at that cell, and also return the dat's precomputed
    /// <c>VisibleCells</c> array. The validator uses the diff between the
    /// two to spot-check PVS correctness.
    ///
    /// <para>
    /// Cell IDs span LB boundaries — but the precomputed
    /// <c>VisibleCells</c> in a baked EnvCell record stores only the low
    /// 16 bits of each visible cell. We widen with the parent LB high
    /// word, same convention as <c>CellPortals.OtherCellId</c>.
    /// </para>
    ///
    /// <para>
    /// Retail's BFS at <c>acclient.c::CEnvCell::recursively_get_object</c>
    /// (line 349403) descends through every <c>CellPortal.GetOtherCell</c>
    /// recursively, gated by a <c>visited</c> set. The dat's
    /// <c>VisibleCells</c> array is the pre-baked transitive closure of
    /// that walk (depth-unlimited). Our BFS-N here is bounded so we can
    /// compare against runtime's <c>getRenderSet(N)</c>.
    /// </para>
    /// </summary>
    public PvsSnapshotResult PvsVisibilitySnapshot(string? datPath, uint cellId, int bfsDepth = 1) {
        if (bfsDepth < 0) throw new ArgumentException("bfsDepth must be >= 0");
        if (bfsDepth > 8) throw new ArgumentException("bfsDepth >8 is impractical (retail caps at ~6 typically)");

        var resolved = ResolveDatPathForType(datPath, typeof(DRW.DBObjs.EnvCell));

        using var dat = new DRW.DatDatabase(o => {
            o.FilePath = resolved;
            o.AccessType = DRW.Options.DatAccessType.Read;
            o.IndexCachingStrategy = DRW.Options.IndexCachingStrategy.Never;
        });

        if (!dat.TryGet<DRW.DBObjs.EnvCell>(cellId, out var rootCell) || rootCell == null) {
            return new PvsSnapshotResult(
                CellHex: $"0x{cellId:X8}",
                CellId: cellId,
                BfsDepth: bfsDepth,
                LiveVisibleCount: 0,
                DatVisibleCount: 0,
                LiveVisibleCells: Array.Empty<string>(),
                DatVisibleCells: Array.Empty<string>(),
                OnlyInLive: Array.Empty<string>(),
                OnlyInDat: Array.Empty<string>(),
                Source: $"PvsVisibilitySnapshot: cell 0x{cellId:X8} not found in {Path.GetFileName(resolved)}");
        }

        uint lbHigh = cellId & 0xFFFF_0000u;

        // BFS-N expansion via portals.
        var live = new HashSet<uint> { cellId };
        var frontier = new List<uint> { cellId };
        for (int depth = 1; depth <= bfsDepth; depth++) {
            var next = new List<uint>();
            foreach (var fc in frontier) {
                if (!dat.TryGet<DRW.DBObjs.EnvCell>(fc, out var frontierCell) || frontierCell == null) continue;
                var portals = GetPortalsList(frontierCell);
                if (portals == null) continue;
                foreach (var p in portals) {
                    var (flags, otherWord, _, _) = ReadPortalTuple(p);
                    if ((flags & 0x04) != 0) continue;
                    if (otherWord == 0xFFFE) continue;
                    uint other = lbHigh | (uint)otherWord;
                    if (live.Add(other)) next.Add(other);
                }
            }
            frontier = next;
            if (frontier.Count == 0) break;
        }

        // Dat's precomputed VisibleCells array on the root cell.
        var datVisible = new HashSet<uint>();
        var vc = GetVisibleCellsList(rootCell);
        if (vc != null) {
            foreach (var v in vc) {
                ushort word = (ushort)Convert.ToUInt32(v);
                if (word == 0xFFFE) continue;
                datVisible.Add(lbHigh | (uint)word);
            }
        }

        // The dat's precomputed visible set ALWAYS includes the root cell
        // implicitly (CEnvCell::IsVisible(self) = true). Add it explicitly
        // so the diff doesn't fire on a no-op.
        datVisible.Add(cellId);

        var liveSorted = live.OrderBy(x => x).Select(x => $"0x{x:X8}").ToList();
        var datSorted = datVisible.OrderBy(x => x).Select(x => $"0x{x:X8}").ToList();
        var onlyInLive = live.Except(datVisible).OrderBy(x => x).Select(x => $"0x{x:X8}").ToList();
        var onlyInDat  = datVisible.Except(live).OrderBy(x => x).Select(x => $"0x{x:X8}").ToList();

        return new PvsSnapshotResult(
            CellHex: $"0x{cellId:X8}",
            CellId: cellId,
            BfsDepth: bfsDepth,
            LiveVisibleCount: live.Count,
            DatVisibleCount: datVisible.Count,
            LiveVisibleCells: liveSorted,
            DatVisibleCells: datSorted,
            OnlyInLive: onlyInLive,
            OnlyInDat: onlyInDat,
            Source: $"BFS-{bfsDepth} on cell 0x{cellId:X8} per acclient.c:349403; dat-VisibleCells per CEnvCell.UnPack");
    }
}
