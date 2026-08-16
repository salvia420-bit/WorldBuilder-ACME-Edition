using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using DRW = DatReaderWriter;

namespace WorldBuilder.Terminal;

/// <summary>
/// environment-clone + envcell-retarget — the environment-VARIANT write pair
/// (dungeon-relief lane, HANDOFF-env-variant-design-2026-08-16). One shared
/// prefab Environment renders under many texture sets (each EnvCell maps
/// surface indices through its OWN surface array), so relief appended to the
/// shared record mismatches most cells' albedo. The fix: clone the Environment
/// to a free id per texture-cluster (this file), append that cluster's honest
/// per-texture relief to the clone (environment-append-geometry), then
/// retarget the cluster's EnvCells at the clone (this file).
///
/// Invariants:
///   * clone copies the record VERBATIM (same CellStructs — physics polys,
///     Portals and all BSPs identical), so a retargeted cell's collision is
///     byte-equivalent and stays in lockstep with an ACE server that adopts
///     the same dats;
///   * retarget is an in-place u16 rewrite (EnvironmentId; record size is
///     unchanged) — the cell dat grows zero bytes, only the b-tree churns;
///   * both commands refuse writes under ~/ac_base_dats (GuardWritableDatCopy).
/// </summary>
public partial class CommandEngine {

    // Environment id space is 16-bit (0x0D000000–0x0D00FFFF).
    const uint EnvIdFirst = 0x0D000000u;
    const uint EnvIdLast = 0x0D00FFFFu;

    public sealed record EnvironmentCloneSpec(uint SourceId, uint NewId);

    public sealed record EnvironmentCloneResult(
        string DatPath, bool DryRun, int RequestedCount, int ClonedCount, int FailCount,
        List<Dictionary<string, object?>> Records);

    public EnvironmentCloneResult EnvironmentClone(
        string datPath, IReadOnlyList<EnvironmentCloneSpec> clones, bool dryRun) {

        if (clones == null || clones.Count == 0)
            throw new ArgumentException("No clones given — pass 'clones' [{sourceIdHex,newIdHex}] or top-level sourceIdHex/newIdHex.");
        var resolved = GuardWritableDatCopy(datPath);

        using var portal = new DRW.PortalDatabase(resolved,
            dryRun ? DRW.Options.DatAccessType.Read : DRW.Options.DatAccessType.ReadWrite);

        var records = new List<Dictionary<string, object?>>();
        var claimed = new HashSet<uint>();   // new ids taken earlier in this batch
        int cloned = 0, failed = 0;

        foreach (var spec in clones) {
            var rec = new Dictionary<string, object?> {
                ["sourceIdHex"] = $"0x{spec.SourceId:X8}",
                ["newIdHex"] = $"0x{spec.NewId:X8}",
            };
            try {
                if (spec.SourceId < EnvIdFirst || spec.SourceId > EnvIdLast)
                    throw new ArgumentException($"sourceIdHex 0x{spec.SourceId:X8} is not an Environment id (0x0D000000–0x0D00FFFF).");
                if (spec.NewId < EnvIdFirst || spec.NewId > EnvIdLast)
                    throw new ArgumentException($"newIdHex 0x{spec.NewId:X8} is not an Environment id (0x0D000000–0x0D00FFFF).");
                if (spec.NewId == spec.SourceId)
                    throw new ArgumentException("newIdHex equals sourceIdHex.");
                if (portal.Tree.TryGetFile(spec.NewId, out _) || !claimed.Add(spec.NewId))
                    throw new InvalidOperationException($"newIdHex 0x{spec.NewId:X8} already exists — variant ids must be minted from free space.");
                if (!portal.TryGet<DRW.DBObjs.Environment>(spec.SourceId, out var env) || env == null)
                    throw new InvalidOperationException($"Environment 0x{spec.SourceId:X8} not found in {Path.GetFileName(resolved)}.");

                rec["cellStructs"] = env.Cells.Count;
                if (!dryRun) {
                    env.Id = spec.NewId;
                    var result = portal.TryWriteFile(env);
                    if (!result.Success)
                        throw new InvalidOperationException($"TryWriteFile failed: {result.Error}");
                }
                rec["ok"] = true;
                cloned++;
            } catch (Exception ex) {
                rec["ok"] = false;
                rec["error"] = ex.Message;
                failed++;
            }
            records.Add(rec);
        }

        return new EnvironmentCloneResult(resolved, dryRun, clones.Count, cloned, failed, records);
    }

    public sealed record EnvCellRetargetSpec(uint CellId, ushort EnvironmentId, ushort? CellStructure);

    public sealed record EnvCellRetargetResult(
        string DatPath, bool DryRun, int RequestedCount, int RetargetedCount,
        int UnchangedCount, int FailCount, List<Dictionary<string, object?>> FailRecords);

    /// <summary>Batch-rewrite EnvCell.EnvironmentId (and optionally
    /// CellStructure) in a CELL-dat copy. With <paramref name="portalPath"/>
    /// given, each target (environment, cellStructure) is validated against
    /// that portal dat: the variant record must exist, hold the cellstruct,
    /// and every drawn polygon's PosSurface must stay inside the cell's own
    /// surface array — the check that catches a retarget at the WRONG variant.
    /// Only failures are returned per-record (batches run ~150k cells).</summary>
    public EnvCellRetargetResult EnvCellRetarget(
        string datPath, IReadOnlyList<EnvCellRetargetSpec> specs, string? portalPath, bool dryRun) {

        if (specs == null || specs.Count == 0)
            throw new ArgumentException("No retargets given — pass 'retargets' [{cellIdHex,environmentIdHex,cellStructure?}] or 'jsonlPath'.");
        var resolved = GuardWritableDatCopy(datPath);

        using var cellDb = new DRW.CellDatabase(resolved,
            dryRun ? DRW.Options.DatAccessType.Read : DRW.Options.DatAccessType.ReadWrite);
        using var portal = portalPath == null
            ? null : new DRW.PortalDatabase(Path.GetFullPath(portalPath), DRW.Options.DatAccessType.Read);

        // (envId16, cellStructure) -> max drawn PosSurface, or an error string.
        var envCheck = new Dictionary<(ushort, ushort), (int maxPos, string? error)>();
        (int maxPos, string? error) CheckEnv(ushort env16, ushort cs) {
            if (envCheck.TryGetValue((env16, cs), out var cached)) return cached;
            (int, string?) r;
            uint envFileId = EnvIdFirst | env16;
            if (!portal!.TryGet<DRW.DBObjs.Environment>(envFileId, out var env) || env == null)
                r = (0, $"Environment 0x{envFileId:X8} not found in portal dat");
            else if (!env.Cells.TryGetValue(cs, out var cellStruct) || cellStruct == null)
                r = (0, $"Environment 0x{envFileId:X8} has no CellStruct {cs}");
            else
                r = (cellStruct.Polygons.Count == 0 ? -1
                    : cellStruct.Polygons.Values.Max(p => (int)p.PosSurface), null);
            envCheck[(env16, cs)] = r;
            return r;
        }

        var fails = new List<Dictionary<string, object?>>();
        int retargeted = 0, unchanged = 0, failed = 0;
        const int MaxFailRecords = 100;

        foreach (var spec in specs) {
            try {
                if ((spec.CellId & 0xFFFF) is < 0x100 or > 0xFFFD)
                    throw new ArgumentException($"0x{spec.CellId:X8} is not an EnvCell id (cell part must be 0x0100–0xFFFD).");
                if (!cellDb.TryGet<DRW.DBObjs.EnvCell>(spec.CellId, out var cell) || cell == null)
                    throw new InvalidOperationException($"EnvCell 0x{spec.CellId:X8} not found in {Path.GetFileName(resolved)}.");

                var cs = spec.CellStructure ?? cell.CellStructure;
                if (portal != null) {
                    var (maxPos, error) = CheckEnv(spec.EnvironmentId, cs);
                    if (error != null)
                        throw new InvalidOperationException(error);
                    if (maxPos >= cell.Surfaces.Count)
                        throw new InvalidOperationException(
                            $"variant 0x{EnvIdFirst | spec.EnvironmentId:X8} cs {cs} uses surface index {maxPos} " +
                            $"but cell 0x{spec.CellId:X8} has only {cell.Surfaces.Count} surfaces — wrong variant for this cell.");
                }

                if (cell.EnvironmentId == spec.EnvironmentId && cell.CellStructure == cs) {
                    unchanged++;
                    continue;
                }
                if (!dryRun) {
                    cell.EnvironmentId = spec.EnvironmentId;
                    cell.CellStructure = cs;
                    var result = cellDb.TryWriteFile(cell);
                    if (!result.Success)
                        throw new InvalidOperationException($"TryWriteFile failed: {result.Error}");
                }
                retargeted++;
            } catch (Exception ex) {
                failed++;
                if (fails.Count < MaxFailRecords) {
                    fails.Add(new Dictionary<string, object?> {
                        ["cellIdHex"] = $"0x{spec.CellId:X8}",
                        ["environmentIdHex"] = $"0x{spec.EnvironmentId:X4}",
                        ["error"] = ex.Message,
                    });
                }
            }
        }

        return new EnvCellRetargetResult(
            resolved, dryRun, specs.Count, retargeted, unchanged, failed, fails);
    }
}
