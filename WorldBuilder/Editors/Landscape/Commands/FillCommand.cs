using DatReaderWriter.Enums;
using Microsoft.Extensions.DependencyInjection;
using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Services;

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
            var terrainService = _context.TerrainSystem.Services.GetRequiredService<ITerrainService>();
            var vertices = terrainService.FloodFillVertices(
                _context.TerrainSystem.TerrainDoc, _context.TerrainSystem.DocumentManager,
                _hitResult.LandblockX, _hitResult.LandblockY, (uint)_hitResult.CellX, (uint)_hitResult.CellY,
                _newType, null);

            foreach (var (lbID, index, oldType) in vertices) {
                if (!_changes.TryGetValue(lbID, out var list)) {
                    list = new List<(int, byte, byte)>();
                    _changes[lbID] = list;
                }
                list.Add((index, oldType, _newType));
            }
        }

    }
}
