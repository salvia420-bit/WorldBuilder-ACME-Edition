using System.Numerics;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Editors.Dungeon {
    public class AddStaticObjectCommand : IDungeonCommand {
        private readonly ushort _cellNum;
        private readonly uint _objectId;
        private readonly Vector3 _origin;
        private readonly Quaternion _orientation;

        public string Description => "Place Object";

        public AddStaticObjectCommand(ushort cellNum, uint objectId, Vector3 origin, Quaternion orientation) {
            _cellNum = cellNum;
            _objectId = objectId;
            _origin = origin;
            _orientation = orientation;
        }

        public void Execute(DungeonDocument document) {
            var cell = document.GetCell(_cellNum);
            if (cell == null) return;
            cell.StaticObjects.Add(new DungeonStabData {
                Id = _objectId,
                Origin = _origin,
                Orientation = _orientation
            });
        }

        public void Undo(DungeonDocument document) {
            var cell = document.GetCell(_cellNum);
            if (cell == null || cell.StaticObjects.Count == 0) return;
            var last = cell.StaticObjects[^1];
            if (last.Id == _objectId)
                cell.StaticObjects.RemoveAt(cell.StaticObjects.Count - 1);
        }
    }
}
