using DatReaderWriter.Enums;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Text;
using System.Threading.Tasks;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Terrain;

namespace WorldBuilder.Editors.Landscape.Commands {
    public class PaintCommand : TerrainVertexChangeCommand {
        private readonly byte _terrainType;

        public PaintCommand(TerrainEditingContext context, TerrainTextureType terrainType, Vector3 centerPosition, float brushRadius) : base(context) {
            _terrainType = (byte)terrainType;
            CollectChanges(centerPosition, brushRadius);
        }

        public PaintCommand(TerrainEditingContext context, TerrainTextureType terrainType, Dictionary<ushort, List<(int VertexIndex, byte OriginalType, byte NewType)>> changes) : base(context) {
            _terrainType = (byte)terrainType;
            _changesPreApplied = true;
            foreach (var kvp in changes) {
                _changes[kvp.Key] = kvp.Value;
            }
        }

        public override string Description => $"Paint {Enum.GetName(typeof(TerrainTextureType), _terrainType)}";
        public override TerrainField Field => TerrainField.Type;

        protected override byte GetEntryValue(TerrainEntry entry) => entry.Type;
        protected override TerrainEntry SetEntryValue(TerrainEntry entry, byte value) => entry with { Type = value };

        private void CollectChanges(Vector3 position, float brushRadius) {
            var affected = GetAffectedVertices(position, brushRadius, _context);
            var landblockDataCache = new Dictionary<ushort, TerrainEntry[]>();

            foreach (var (lbId, vIndex, _) in affected) {
                if (!_changes.TryGetValue(lbId, out var list)) {
                    list = new List<(int, byte, byte)>();
                    _changes[lbId] = list;
                }

                if (list.Any(c => c.VertexIndex == vIndex)) continue;

                if (!landblockDataCache.TryGetValue(lbId, out var data)) {
                    data = _context.TerrainSystem.GetLandblockTerrain(lbId);
                    if (data == null) continue;
                    landblockDataCache[lbId] = data;
                }

                byte original = data[vIndex].Type;
                if (original == _terrainType) continue;
                list.Add((vIndex, original, _terrainType));
            }
        }

        /// <summary>
        /// Gets all terrain vertices within a world-space rectangle (min/max XY).
        /// Delegates to TerrainAlgorithms in the shared layer.
        /// </summary>
        public static List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetVerticesInRect(
            float minX, float minY, float maxX, float maxY, TerrainEditingContext context) {
            return TerrainAlgorithms.GetVerticesInRect(minX, minY, maxX, maxY,
                (x, y) => context.GetHeightAtPosition(x, y));
        }

        /// <summary>
        /// Gets all terrain vertices within a circular brush radius.
        /// Delegates to TerrainAlgorithms in the shared layer.
        /// </summary>
        public static List<(ushort LandblockId, int VertexIndex, Vector3 Position)> GetAffectedVertices(
            Vector3 position, float radius, TerrainEditingContext context) {
            return TerrainAlgorithms.GetAffectedVertices(position, radius,
                (x, y) => context.GetHeightAtPosition(x, y));
        }
    }
}
