using DatReaderWriter.Enums;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;
using System.Text;
using System.Threading.Tasks;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Services;

namespace WorldBuilder.Editors.Landscape.Commands {
    public class PaintCommand : TerrainVertexChangeCommand {
        private readonly byte _terrainType;

        public PaintCommand(TerrainEditingContext context, TerrainTextureType terrainType, Vector3 centerPosition, float brushRadius) : base(context) {
            _terrainType = (byte)terrainType;
            CollectChanges(centerPosition, brushRadius);
        }

        public PaintCommand(TerrainEditingContext context, TerrainTextureType terrainType, Dictionary<ushort, List<(int VertexIndex, byte OriginalType, byte NewType)>> changes) : base(context) {
            _terrainType = (byte)terrainType;
            foreach (var kvp in changes) {
                _changes[kvp.Key] = kvp.Value;
            }
        }

        public override string Description => $"Paint {Enum.GetName(typeof(TerrainTextureType), _terrainType)}";
        public override TerrainField Field => TerrainField.Type;

        protected override byte GetEntryValue(TerrainEntry entry) => entry.Type;
        protected override TerrainEntry SetEntryValue(TerrainEntry entry, byte value) => entry with { Type = value };

        private void CollectChanges(Vector3 position, float brushRadius) {
            var terrainService = _context.TerrainSystem.Services.GetRequiredService<ITerrainService>();
            var heightTable = _context.TerrainSystem.Region.LandDefs.LandHeightTable;
            var affected = terrainService.GetAffectedVertices(_context.TerrainSystem.TerrainDoc, _context.TerrainSystem.DocumentManager, heightTable, position, brushRadius);
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

    }
}
