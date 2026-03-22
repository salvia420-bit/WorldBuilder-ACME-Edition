using DatReaderWriter.Enums;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Terrain;

namespace WorldBuilder.Editors.Landscape.Commands {
    public class FillCommand : TerrainVertexChangeCommand {
        private readonly TerrainRaycast.TerrainRaycastHit _hitResult;
        private readonly byte _newType;

        public FillCommand(TerrainEditingContext context, TerrainRaycast.TerrainRaycastHit hitResult, TerrainTextureType newType) : base(context) {
            _hitResult = hitResult;
            _newType = (byte)newType;
            CollectChanges();
        }

        public override string Description => $"Bucket fill with {Enum.GetName(typeof(TerrainTextureType), _newType)}";
        public override TerrainField Field => TerrainField.Type;

        protected override byte GetEntryValue(TerrainEntry entry) => entry.Type;
        protected override TerrainEntry SetEntryValue(TerrainEntry entry, byte value) => entry with { Type = value };

        private void CollectChanges() {
            var vertices = FloodFillVertices(_context.TerrainSystem, _hitResult, _newType, null);
            foreach (var (lbID, index, oldType) in vertices) {
                if (!_changes.TryGetValue(lbID, out var list)) {
                    list = new List<(int, byte, byte)>();
                    _changes[lbID] = list;
                }
                list.Add((index, oldType, _newType));
            }
        }

        /// <summary>
        /// Performs a read-only flood fill from the hit vertex, collecting all contiguous
        /// vertices with the same texture type. Delegates to TerrainAlgorithms.FloodFill.
        /// </summary>
        public static List<(ushort LbID, int VertexIndex, byte OldType)> FloodFillVertices(
            TerrainSystem terrainSystem,
            TerrainRaycast.TerrainRaycastHit hitResult,
            byte newType,
            HashSet<ushort>? allowedLandblocks = null) {

            return TerrainAlgorithms.FloodFill(
                hitResult.LandblockX,
                hitResult.LandblockY,
                (uint)hitResult.CellX,
                (uint)hitResult.CellY,
                newType,
                lbId => terrainSystem.GetLandblockTerrain(lbId),
                allowedLandblocks);
        }
    }
}
