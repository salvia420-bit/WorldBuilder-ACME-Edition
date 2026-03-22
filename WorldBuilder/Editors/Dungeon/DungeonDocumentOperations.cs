using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Editors.Dungeon {
    /// <summary>
    /// Document lifecycle operations for the dungeon editor.
    /// This class is the planned extraction target for operations currently in DungeonEditorViewModel:
    /// - OpenLandblock / LoadDungeon
    /// - NewDungeon / EnsureDocument
    /// - SaveDungeon
    /// - GenerateDungeon
    /// - StartFromTemplate / CopyTemplateToLandblock
    /// - AnalyzeRooms
    /// 
    /// The extraction is deferred to avoid breaking changes to the ViewModel's
    /// relay commands and UI bindings. Callers should begin routing new document
    /// operations through this class.
    /// </summary>
    public class DungeonDocumentOperations {
        private readonly DungeonEditingContext _ctx;
        private readonly DungeonDialogService _dialogs;

        public DungeonDocumentOperations(DungeonEditingContext ctx, DungeonDialogService dialogs) {
            _ctx = ctx;
            _dialogs = dialogs;
        }
    }
}
