using System;
using System.Collections.Generic;
using System.Linq;
using System.Numerics;

namespace WorldBuilder.Editors.Dungeon {

    /// <summary>
    /// Pre-built index mapping each portal face to the rooms proven to connect there
    /// in real dungeons. Built from the 31K adjacency edges at startup.
    /// </summary>
    public class PortalCompatibilityIndex {
        private readonly Dictionary<(ushort envId, ushort cs, ushort polyId), List<CompatibleRoom>> _index = new();

        public static PortalCompatibilityIndex Build(DungeonKnowledgeBase kb) {
            var idx = new PortalCompatibilityIndex();
            if (kb.Edges == null) return idx;

            foreach (var edge in kb.Edges) {
                var keyA = (edge.EnvIdA, edge.CellStructA, edge.PolyIdA);
                var keyB = (edge.EnvIdB, edge.CellStructB, edge.PolyIdB);
                var relOffset = new Vector3(edge.RelOffsetX, edge.RelOffsetY, edge.RelOffsetZ);
                var relRot = new Quaternion(edge.RelRotX, edge.RelRotY, edge.RelRotZ, edge.RelRotW);

                idx.Add(keyA, new CompatibleRoom {
                    EnvId = edge.EnvIdB, CellStruct = edge.CellStructB, PolyId = edge.PolyIdB,
                    Count = edge.Count, RelOffset = relOffset, RelRot = relRot
                });

                var invRot = Quaternion.Conjugate(relRot);
                idx.Add(keyB, new CompatibleRoom {
                    EnvId = edge.EnvIdA, CellStruct = edge.CellStructA, PolyId = edge.PolyIdA,
                    Count = edge.Count,
                    RelOffset = Vector3.Transform(-relOffset, invRot),
                    RelRot = invRot
                });
            }

            Console.WriteLine($"[PortalIndex] Built index: {idx._index.Count} unique portal faces, {kb.Edges.Count} edges");
            return idx;
        }

        private void Add((ushort, ushort, ushort) key, CompatibleRoom room) {
            if (!_index.TryGetValue(key, out var list)) {
                list = new List<CompatibleRoom>();
                _index[key] = list;
            }
            list.Add(room);
        }

        /// <summary>Get all rooms proven to connect at this portal face, sorted by usage count.</summary>
        public List<CompatibleRoom> GetCompatible(ushort envId, ushort cellStruct, ushort polyId) {
            return _index.TryGetValue((envId, cellStruct, polyId), out var list)
                ? list.OrderByDescending(r => r.Count).ToList()
                : new List<CompatibleRoom>();
        }

        /// <summary>Check if a specific room type appears as compatible for a portal.</summary>
        public CompatibleRoom? FindMatch(ushort portalEnvId, ushort portalCS, ushort portalPolyId,
            ushort roomEnvId, ushort roomCS) {
            if (!_index.TryGetValue((portalEnvId, portalCS, portalPolyId), out var list)) return null;
            return list.FirstOrDefault(r => r.EnvId == roomEnvId && r.CellStruct == roomCS);
        }

        /// <summary>Get all unique (envId, cellStruct) room types compatible with a portal.</summary>
        public HashSet<(ushort envId, ushort cs)> GetCompatibleRoomTypes(ushort envId, ushort cellStruct, ushort polyId) {
            if (!_index.TryGetValue((envId, cellStruct, polyId), out var list))
                return new HashSet<(ushort, ushort)>();
            return list.Select(r => (r.EnvId, r.CellStruct)).ToHashSet();
        }

        /// <summary>Get all unique room types compatible with ANY of the given portal faces.</summary>
        public HashSet<(ushort envId, ushort cs)> GetCompatibleRoomTypesForAny(
            IEnumerable<(ushort envId, ushort cs, ushort polyId)> portals) {
            var result = new HashSet<(ushort, ushort)>();
            foreach (var p in portals) {
                if (_index.TryGetValue(p, out var list)) {
                    foreach (var r in list)
                        result.Add((r.EnvId, r.CellStruct));
                }
            }
            return result;
        }

        public int PortalFaceCount => _index.Count;
    }
}
