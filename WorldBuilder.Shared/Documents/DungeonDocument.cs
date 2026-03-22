using DatReaderWriter.DBObjs;
using DatReaderWriter.Enums;
using DatReaderWriter.Types;
using MemoryPack;
using Microsoft.Extensions.Logging;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Threading.Tasks;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Shared.Documents {

    [MemoryPackable]
    public partial class DungeonData {
        public ushort LandblockKey;
        public List<DungeonCellData> Cells = new();
    }

    [MemoryPackable]
    public partial class DungeonCellData {
        public ushort CellNumber;
        public ushort EnvironmentId;
        public ushort CellStructure;
        public Vector3 Origin;
        public Quaternion Orientation = Quaternion.Identity;
        public uint Flags;
        public uint RestrictionObj;
        public List<ushort> Surfaces = new();
        public List<DungeonCellPortalData> CellPortals = new();
        public List<ushort> VisibleCells = new();
        public List<DungeonStabData> StaticObjects = new();
    }

    [MemoryPackable]
    public partial class DungeonCellPortalData {
        public ushort OtherCellId;
        public ushort PolygonId;
        public ushort OtherPortalId;
        public ushort Flags;
    }

    [MemoryPackable]
    public partial class DungeonStabData {
        public uint Id;
        public Vector3 Origin;
        public Quaternion Orientation = Quaternion.Identity;
    }

    public partial class DungeonDocument : BaseDocument {
        public override string Type => nameof(DungeonDocument);

        [MemoryPackInclude]
        private DungeonData _data = new();

        public ushort LandblockKey {
            get => _data.LandblockKey;
            set => _data.LandblockKey = value;
        }

        public List<DungeonCellData> Cells => _data.Cells;

        private ushort _nextCellNumber = 0x0100;

        public DungeonDocument(ILogger logger) : base(logger) {
        }

        public void SetLandblockKey(ushort key) {
            _data.LandblockKey = key;
            Id = $"dungeon_{key:X4}";
        }

        protected override async Task<bool> InitInternal(IDatReaderWriter datreader, DocumentManager documentManager) {
            // Parse landblock key from document Id (format: "dungeon_XXXX")
            if (LandblockKey == 0 && Id.StartsWith("dungeon_")) {
                var hex = Id.Replace("dungeon_", "");
                if (ushort.TryParse(hex, System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var parsedKey)) {
                    _data.LandblockKey = parsedKey;
                }
            }

            if (Cells.Count == 0 && LandblockKey != 0) {
                LoadCellsFromDat(datreader);
            }
            if (Cells.Count > 0) {
                _nextCellNumber = (ushort)(Cells.Max(c => c.CellNumber) + 1);
            }
            ClearDirty();
            return true;
        }

        protected override byte[] SaveToProjectionInternal() {
            return MemoryPackSerializer.Serialize(_data);
        }

        protected override bool LoadFromProjectionInternal(byte[] projection) {
            try {
                _data = MemoryPackSerializer.Deserialize<DungeonData>(projection) ?? new();
            }
            catch (MemoryPack.MemoryPackSerializationException) {
                _logger.LogWarning("[DungeonDoc] Project cache has incompatible format (schema changed), will reload from DAT");
                _data = new();
            }
            if (Cells.Count > 0) {
                _nextCellNumber = (ushort)(Cells.Max(c => c.CellNumber) + 1);
            }
            return true;
        }

        protected override Task<bool> SaveToDatsInternal(IDatReaderWriter datwriter, int iteration = 0) {
            if (Cells.Count == 0) {
                _logger.LogWarning("[DungeonDoc] Nothing to export: dungeon has no cells");
                return Task.FromResult(true);
            }

            uint lbId = LandblockKey;
            uint lbEntryId = (lbId << 16) | 0xFFFF;
            uint lbiId = (lbId << 16) | 0xFFFE;

            // Step 1: Ensure a LandBlock (0xFFFF) terrain entry exists.
            // Existing outdoor landblocks already have one; empty ones need a stub.
            bool hasLandBlock = datwriter.TryGet<LandBlock>(lbEntryId, out _);
            if (!hasLandBlock) {
                var lb = new LandBlock { Id = lbEntryId };
                if (!datwriter.TrySave(lb, iteration)) {
                    _logger.LogError("[DungeonDoc] Failed to create LandBlock 0x{Id:X8}", lbEntryId);
                    return Task.FromResult(false);
                }
                _logger.LogInformation("[DungeonDoc] Created new LandBlock 0x{Id:X8} (dungeon-only landblock, no prior terrain)", lbEntryId);
            }

            // Step 2: Get or create LandBlockInfo (0xFFFE).
            // If it exists (landblock has buildings/objects), preserve them — only update NumCells.
            bool isNewLbi = !datwriter.TryGet<LandBlockInfo>(lbiId, out var lbi);
            if (isNewLbi) {
                lbi = new LandBlockInfo { Id = lbiId };
            }
            uint prevNumCells = lbi.NumCells;
            int existingBuildings = lbi.Buildings?.Count ?? 0;
            int existingObjects = lbi.Objects?.Count ?? 0;

            // Step 2.5: Auto-compute VisibleCells (stab lists) if any are empty
            bool anyEmpty = Cells.Any(c => c.VisibleCells.Count == 0);
            if (anyEmpty) {
                int updated = ComputeVisibleCells();
                _logger.LogInformation("[DungeonDoc] Auto-computed VisibleCells for {Updated}/{Total} cells before export", updated, Cells.Count);
            }

            // Step 3: Save all EnvCells
            var envCells = ToEnvCells(forDatExport: true);
            int saved = 0;
            foreach (var envCell in envCells) {
                if (!datwriter.TrySave(envCell, iteration)) {
                    _logger.LogError("[DungeonDoc] Failed to save EnvCell 0x{CellId:X8}", envCell.Id);
                    return Task.FromResult(false);
                }
                saved++;
            }

            // Step 4: Update NumCells on the LBI (preserves existing Buildings/Objects)
            var maxCellNum = Cells.Max(c => c.CellNumber);
            lbi.NumCells = (uint)(maxCellNum - 0x00FF);

            if (!datwriter.TrySave(lbi, iteration)) {
                _logger.LogError("[DungeonDoc] Failed to save LandBlockInfo 0x{InfoId:X8}", lbiId);
                return Task.FromResult(false);
            }

            _logger.LogInformation(
                "[DungeonDoc] Exported LB {LB:X4}: {Saved}/{Total} cells saved, " +
                "LBI 0x{LbiId:X8} (new={IsNew}, NumCells: {Prev}->{New}, buildings={Bldg}, objects={Obj}), " +
                "LandBlock 0x{LbId:X8} (existed={HasLB})",
                LandblockKey, saved, envCells.Count,
                lbiId, isNewLbi, prevNumCells, lbi.NumCells, existingBuildings, existingObjects,
                lbEntryId, hasLandBlock);

            // Verify: read back first cell and LBI to confirm persistence
            uint firstCellId = (lbId << 16) | 0x0100;
            bool cellOk = datwriter.TryGet<EnvCell>(firstCellId, out var verifyCell);
            bool lbiOk = datwriter.TryGet<LandBlockInfo>(lbiId, out var verifyLbi);
            _logger.LogInformation(
                "[DungeonDoc] Verify LB {LB:X4}: cell 0x{CellId:X8} exists={CellOk} (env=0x{Env:X4}), " +
                "LBI exists={LbiOk} (numCells={Num})",
                LandblockKey, firstCellId, cellOk,
                cellOk ? verifyCell!.EnvironmentId : 0,
                lbiOk,
                lbiOk ? verifyLbi!.NumCells : 0);

            return Task.FromResult(true);
        }

        /// <summary>
        /// Force reload all cells from the DAT file, discarding any in-memory edits.
        /// </summary>
        public void ReloadFromDat(IDatReaderWriter dats) {
            LoadCellsFromDat(dats);
            if (Cells.Count > 0)
                _nextCellNumber = (ushort)(Cells.Max(c => c.CellNumber) + 1);
            ClearDirty();
        }

        private void LoadCellsFromDat(IDatReaderWriter dats) {
            Cells.Clear();
            uint lbId = LandblockKey;
            uint lbiId = (lbId << 16) | 0xFFFE;

            if (!dats.TryGet<LandBlockInfo>(lbiId, out var lbi) || lbi.NumCells == 0)
                return;

            for (uint i = 0; i < lbi.NumCells; i++) {
                ushort cellNum = (ushort)(0x0100 + i);
                uint cellId = (lbId << 16) | cellNum;
                if (dats.TryGet<EnvCell>(cellId, out var envCell)) {
                    var origin = envCell.Position.Origin;
                    var dc = new DungeonCellData {
                        CellNumber = cellNum,
                        EnvironmentId = envCell.EnvironmentId,
                        CellStructure = envCell.CellStructure,
                        Origin = origin,
                        Orientation = envCell.Position.Orientation,
                        Flags = (uint)envCell.Flags,
                        RestrictionObj = envCell.RestrictionObj,
                    };
                    dc.Surfaces.AddRange(envCell.Surfaces);
                    if (envCell.CellPortals != null) {
                        foreach (var cp in envCell.CellPortals) {
                            dc.CellPortals.Add(new DungeonCellPortalData {
                                OtherCellId = cp.OtherCellId,
                                PolygonId = (ushort)cp.PolygonId,
                                OtherPortalId = (ushort)cp.OtherPortalId,
                                Flags = (ushort)cp.Flags
                            });
                        }
                    }
                    if (envCell.VisibleCells != null) dc.VisibleCells.AddRange(envCell.VisibleCells);
                    if (envCell.StaticObjects != null) {
                        foreach (var stab in envCell.StaticObjects) {
                            var stabOrigin = stab.Frame.Origin;
                            dc.StaticObjects.Add(new DungeonStabData {
                                Id = stab.Id,
                                Origin = stabOrigin,
                                Orientation = stab.Frame.Orientation
                            });
                        }
                    }
                    Cells.Add(dc);
                }
            }
        }

        public ushort AllocateCellNumber() {
            return _nextCellNumber++;
        }

        public ushort AddCell(ushort environmentId, ushort cellStructure, Vector3 origin, Quaternion orientation, List<ushort> surfaces) {
            var cellNum = AllocateCellNumber();
            var cell = new DungeonCellData {
                CellNumber = cellNum,
                EnvironmentId = environmentId,
                CellStructure = cellStructure,
                Origin = origin,
                Orientation = orientation,
            };
            cell.Surfaces.AddRange(surfaces);
            Cells.Add(cell);
            MarkDirty();
            return cellNum;
        }

        public void ConnectPortals(ushort cellNumA, ushort polyIdA, ushort cellNumB, ushort polyIdB) {
            var cellA = Cells.FirstOrDefault(c => c.CellNumber == cellNumA);
            var cellB = Cells.FirstOrDefault(c => c.CellNumber == cellNumB);
            if (cellA == null || cellB == null) return;

            cellA.CellPortals.Add(new DungeonCellPortalData {
                OtherCellId = cellNumB,
                PolygonId = polyIdA,
                OtherPortalId = polyIdB,
                Flags = 0
            });

            cellB.CellPortals.Add(new DungeonCellPortalData {
                OtherCellId = cellNumA,
                PolygonId = polyIdB,
                OtherPortalId = polyIdA,
                Flags = 0
            });
            MarkDirty();
        }

        public void RemoveCell(ushort cellNumber) {
            var cell = Cells.FirstOrDefault(c => c.CellNumber == cellNumber);
            if (cell == null) return;

            foreach (var other in Cells) {
                other.CellPortals.RemoveAll(cp => cp.OtherCellId == cellNumber);
            }

            Cells.Remove(cell);
            MarkDirty();
        }

        /// <summary>
        /// AC dungeon depth formula: world_z = -blockY * DungeonZScale + origin_z.
        /// High blockY pushes dungeons far underground (e.g. 0x01D9 -> ~-3000).
        /// Max safe depth is -255; we add this offset so exported dungeons stay above that.
        /// </summary>
        private const float DungeonZScale = 14f;
        private const float MaxDungeonDepth = -255f;

        /// <summary>Convert all document cells to EnvCell objects for rendering or DAT export.</summary>
        public List<EnvCell> ToEnvCells(bool forDatExport = false) {
            uint lbId = LandblockKey;
            var result = new List<EnvCell>();

            foreach (var dc in Cells) {
                uint fullCellId = (lbId << 16) | dc.CellNumber;
                var origin = dc.Origin;
                var envCell = new EnvCell {
                    Id = fullCellId,
                    EnvironmentId = dc.EnvironmentId,
                    CellStructure = dc.CellStructure,
                    Flags = (EnvCellFlags)dc.Flags,
                    RestrictionObj = dc.RestrictionObj,
                    Position = new Frame {
                        Origin = origin,
                        Orientation = dc.Orientation
                    }
                };

                envCell.Surfaces.AddRange(dc.Surfaces);
                foreach (var cp in dc.CellPortals) {
                    envCell.CellPortals.Add(new CellPortal {
                        OtherCellId = cp.OtherCellId,
                        PolygonId = cp.PolygonId,
                        OtherPortalId = cp.OtherPortalId,
                        Flags = (PortalFlags)cp.Flags
                    });
                }
                envCell.VisibleCells.AddRange(dc.VisibleCells);
                foreach (var stab in dc.StaticObjects) {
                    var stabOrigin = stab.Origin;
                    envCell.StaticObjects.Add(new Stab {
                        Id = stab.Id,
                        Frame = new Frame {
                            Origin = stabOrigin,
                            Orientation = stab.Orientation
                        }
                    });
                }

                if (dc.StaticObjects.Count > 0)
                    envCell.Flags |= EnvCellFlags.HasStaticObjs;
                else
                    envCell.Flags &= ~EnvCellFlags.HasStaticObjs;

                if (dc.RestrictionObj != 0)
                    envCell.Flags |= EnvCellFlags.HasRestrictionObj;
                else
                    envCell.Flags &= ~EnvCellFlags.HasRestrictionObj;

                result.Add(envCell);
            }

            return result;
        }

        /// <summary>
        /// Copy all cells from another dungeon document into this one.
        /// Renumbers cells sequentially starting from <paramref name="startCellNum"/>,
        /// remaps portal and visible-cell references, and preserves all other data.
        /// </summary>
        /// <param name="startCellNum">First cell number to use. Pass 0x0100 for empty landblocks,
        /// or a higher value to avoid overwriting existing building cells.</param>
        public void CopyFrom(DungeonDocument source, ushort startCellNum = 0x0100) {
            Cells.Clear();
            _nextCellNumber = startCellNum;

            var cellMap = new Dictionary<ushort, ushort>();
            ushort nextNum = startCellNum;
            foreach (var src in source.Cells) {
                cellMap[src.CellNumber] = nextNum++;
            }

            foreach (var src in source.Cells) {
                ushort newCellNum = cellMap[src.CellNumber];
                var dc = new DungeonCellData {
                    CellNumber = newCellNum,
                    EnvironmentId = src.EnvironmentId,
                    CellStructure = src.CellStructure,
                    Origin = src.Origin,
                    Orientation = src.Orientation,
                    Flags = src.Flags,
                    RestrictionObj = src.RestrictionObj,
                };
                dc.Surfaces.AddRange(src.Surfaces);
                foreach (var cp in src.CellPortals) {
                    ushort remappedOther = cp.OtherCellId;
                    if (cellMap.TryGetValue(cp.OtherCellId, out var mapped))
                        remappedOther = mapped;
                    dc.CellPortals.Add(new DungeonCellPortalData {
                        OtherCellId = remappedOther,
                        PolygonId = cp.PolygonId,
                        OtherPortalId = cp.OtherPortalId,
                        Flags = cp.Flags
                    });
                }
                foreach (var vc in src.VisibleCells) {
                    dc.VisibleCells.Add(cellMap.TryGetValue(vc, out var mappedVc) ? mappedVc : vc);
                }
                foreach (var stab in src.StaticObjects) {
                    dc.StaticObjects.Add(new DungeonStabData {
                        Id = stab.Id,
                        Origin = stab.Origin,
                        Orientation = stab.Orientation
                    });
                }
                Cells.Add(dc);
            }
            _nextCellNumber = nextNum;
            MarkDirty();
        }

        public enum ValidationSeverity { Info, Warning, Error }

        public record ValidationResult(ValidationSeverity Severity, string Message, ushort? CellNumber = null) {
            public string Icon => Severity switch {
                ValidationSeverity.Error => "[ERROR]",
                ValidationSeverity.Warning => "[WARN]",
                _ => "[INFO]"
            };
        }

        public List<string> Validate() {
            return ValidateComprehensive()
                .Where(r => r.Severity != ValidationSeverity.Info)
                .Select(r => r.Message)
                .ToList();
        }

        public List<ValidationResult> ValidateComprehensive() {
            var results = new List<ValidationResult>();
            if (Cells.Count == 0) {
                results.Add(new(ValidationSeverity.Warning, "Dungeon has no cells."));
                return results;
            }

            var cellNums = new HashSet<ushort>(Cells.Select(c => c.CellNumber));

            // Duplicate cell numbers
            var dupes = Cells.GroupBy(c => c.CellNumber).Where(g => g.Count() > 1);
            foreach (var dupe in dupes)
                results.Add(new(ValidationSeverity.Error,
                    $"Duplicate cell number 0x{dupe.Key:X4} ({dupe.Count()} cells)", dupe.Key));

            // Orphaned portal references
            foreach (var cell in Cells) {
                foreach (var portal in cell.CellPortals) {
                    if (portal.OtherCellId != 0 && portal.OtherCellId != 0xFFFF &&
                        !cellNums.Contains(portal.OtherCellId)) {
                        results.Add(new(ValidationSeverity.Error,
                            $"Cell 0x{cell.CellNumber:X4} portal references non-existent cell 0x{portal.OtherCellId:X4}",
                            cell.CellNumber));
                    }
                }
            }

            // One-way portals (A→B exists but B→A doesn't)
            foreach (var cell in Cells) {
                foreach (var portal in cell.CellPortals) {
                    var other = GetCell(portal.OtherCellId);
                    if (other != null && !other.CellPortals.Any(p => p.OtherCellId == cell.CellNumber)) {
                        results.Add(new(ValidationSeverity.Warning,
                            $"One-way portal: 0x{cell.CellNumber:X4} → 0x{portal.OtherCellId:X4} (no return link)",
                            cell.CellNumber));
                    }
                }
            }

            // Disconnected cells (unreachable from first cell)
            var visited = new HashSet<ushort>();
            var queue = new Queue<ushort>();
            var firstCell = Cells[0].CellNumber;
            queue.Enqueue(firstCell);
            visited.Add(firstCell);
            while (queue.Count > 0) {
                var current = queue.Dequeue();
                var cell = GetCell(current);
                if (cell == null) continue;
                foreach (var portal in cell.CellPortals) {
                    if (cellNums.Contains(portal.OtherCellId) && visited.Add(portal.OtherCellId))
                        queue.Enqueue(portal.OtherCellId);
                }
            }
            foreach (var cell in Cells) {
                if (!visited.Contains(cell.CellNumber))
                    results.Add(new(ValidationSeverity.Warning,
                        $"Cell 0x{cell.CellNumber:X4} is disconnected from the main dungeon (unreachable from 0x{firstCell:X4})",
                        cell.CellNumber));
            }

            // Missing surfaces
            foreach (var cell in Cells) {
                if (cell.Surfaces.Count == 0)
                    results.Add(new(ValidationSeverity.Warning,
                        $"Cell 0x{cell.CellNumber:X4} has no surfaces assigned (will be invisible in-game)",
                        cell.CellNumber));
            }

            // Empty VisibleCells
            int emptyStabs = Cells.Count(c => c.VisibleCells.Count == 0);
            if (emptyStabs > 0)
                results.Add(new(ValidationSeverity.Info,
                    $"{emptyStabs} cell(s) have empty VisibleCells — use Compute Visibility before export"));

            // Summary
            if (results.Count == 0)
                results.Add(new(ValidationSeverity.Info,
                    $"All {Cells.Count} cells passed validation."));

            return results;
        }

        /// <summary>
        /// Auto-fixes common issues: adds missing back-portals for one-way connections.
        /// Returns the number of fixes applied.
        /// </summary>
        public int AutoFixPortals() {
            int fixes = 0;
            foreach (var cell in Cells) {
                foreach (var portal in cell.CellPortals) {
                    var other = GetCell(portal.OtherCellId);
                    if (other != null && !other.CellPortals.Any(p => p.OtherCellId == cell.CellNumber)) {
                        other.CellPortals.Add(new DungeonCellPortalData {
                            OtherCellId = cell.CellNumber,
                            PolygonId = portal.OtherPortalId,
                            OtherPortalId = portal.PolygonId,
                            Flags = portal.Flags
                        });
                        fixes++;
                    }
                }
            }
            if (fixes > 0) MarkDirty();
            return fixes;
        }

        /// <summary>
        /// Computes VisibleCells (stab lists) for all cells via BFS through portal connections.
        /// The AC client uses these to know which cells to prefetch and keep loaded.
        /// Each cell's visible set includes itself plus all cells reachable within maxDepth portal hops.
        /// </summary>
        public int ComputeVisibleCells(int maxDepth = 3) {
            var adjacency = new Dictionary<ushort, List<ushort>>();
            foreach (var cell in Cells) {
                adjacency[cell.CellNumber] = cell.CellPortals
                    .Select(p => p.OtherCellId)
                    .Where(id => id != 0 && id != 0xFFFF && Cells.Any(c => c.CellNumber == id))
                    .ToList();
            }

            int totalUpdated = 0;
            foreach (var cell in Cells) {
                var visible = new HashSet<ushort> { cell.CellNumber };
                var frontier = new Queue<(ushort id, int depth)>();
                frontier.Enqueue((cell.CellNumber, 0));

                while (frontier.Count > 0) {
                    var (current, depth) = frontier.Dequeue();
                    if (depth >= maxDepth) continue;
                    if (!adjacency.TryGetValue(current, out var neighbors)) continue;

                    foreach (var neighbor in neighbors) {
                        if (visible.Add(neighbor)) {
                            frontier.Enqueue((neighbor, depth + 1));
                        }
                    }
                }

                var sorted = visible.OrderBy(x => x).ToList();
                if (!cell.VisibleCells.SequenceEqual(sorted)) {
                    cell.VisibleCells.Clear();
                    cell.VisibleCells.AddRange(sorted);
                    totalUpdated++;
                }
            }

            if (totalUpdated > 0) MarkDirty();
            return totalUpdated;
        }

        /// <summary>
        /// Recomputes PortalFlags for all cell portals from CellStruct geometry.
        /// The PortalSide flag (bit 1) indicates which half-space of the portal
        /// polygon plane is the cell interior. This must be correct for the AC client
        /// to traverse portals properly.
        /// </summary>
        public int RecomputePortalFlags(IDatReaderWriter dats) {
            int updated = 0;
            foreach (var cell in Cells) {
                uint envFileId = (uint)(cell.EnvironmentId | 0x0D000000);
                if (!dats.TryGet<DatReaderWriter.DBObjs.Environment>(envFileId, out var env)) continue;
                if (!env.Cells.TryGetValue(cell.CellStructure, out var cs)) continue;

                var centroid = Vector3.Zero;
                int vtxCount = cs.VertexArray.Vertices.Count;
                foreach (var vtx in cs.VertexArray.Vertices.Values)
                    centroid += vtx.Origin;
                if (vtxCount > 0) centroid /= vtxCount;

                foreach (var portal in cell.CellPortals) {
                    if (!cs.Polygons.TryGetValue(portal.PolygonId, out var poly)) continue;
                    if (poly.VertexIds.Count < 3) continue;

                    if (!cs.VertexArray.Vertices.TryGetValue((ushort)poly.VertexIds[0], out var v0)) continue;
                    if (!cs.VertexArray.Vertices.TryGetValue((ushort)poly.VertexIds[1], out var v1)) continue;
                    if (!cs.VertexArray.Vertices.TryGetValue((ushort)poly.VertexIds[2], out var v2)) continue;

                    var normal = Vector3.Normalize(Vector3.Cross(v1.Origin - v0.Origin, v2.Origin - v0.Origin));
                    float d = -Vector3.Dot(normal, v0.Origin);
                    float centroidDot = Vector3.Dot(normal, centroid) + d;

                    // AC client: PortalSide flag (0x0002) SET → portal_side=0 (interior on positive side)
                    //            PortalSide flag CLEAR        → portal_side=1 (interior on negative side)
                    ushort newFlags = (ushort)(portal.Flags & ~0x0002);
                    if (centroidDot >= 0)
                        newFlags |= 0x0002;

                    if (portal.Flags != newFlags) {
                        portal.Flags = newFlags;
                        updated++;
                    }
                }
            }
            if (updated > 0) MarkDirty();
            return updated;
        }

        public DungeonCellData? GetCell(ushort cellNumber) =>
            Cells.FirstOrDefault(c => c.CellNumber == cellNumber);
    }
}
