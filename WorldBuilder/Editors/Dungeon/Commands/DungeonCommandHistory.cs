using System;
using System.Collections.Generic;
using WorldBuilder.Shared.Documents;

namespace WorldBuilder.Editors.Dungeon {
    public class DungeonCommandHistory {
        private readonly Stack<IDungeonCommand> _undoStack = new();
        private readonly Stack<IDungeonCommand> _redoStack = new();

        public bool CanUndo => _undoStack.Count > 0;
        public bool CanRedo => _redoStack.Count > 0;
        public string? LastCommandDescription => _undoStack.Count > 0 ? _undoStack.Peek().Description : null;

        public int HistoryLimit { get; set; } = 50;

        public event EventHandler? Changed;

        public void Execute(IDungeonCommand command, DungeonDocument document) {
            command.Execute(document);
            _undoStack.Push(command);
            _redoStack.Clear();

            if (HistoryLimit > 0 && _undoStack.Count > HistoryLimit) {
                var temp = new Stack<IDungeonCommand>();
                int keep = HistoryLimit;
                while (keep-- > 0 && _undoStack.Count > 0) temp.Push(_undoStack.Pop());
                _undoStack.Clear();
                while (temp.Count > 0) _undoStack.Push(temp.Pop());
            }

            Changed?.Invoke(this, EventArgs.Empty);
        }

        /// <summary>
        /// Record an already-executed command for undo/redo without calling Execute again.
        /// </summary>
        public void Record(IDungeonCommand command) {
            _undoStack.Push(command);
            _redoStack.Clear();
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void Undo(DungeonDocument document) {
            if (_undoStack.Count == 0) return;
            var command = _undoStack.Pop();
            command.Undo(document);
            _redoStack.Push(command);
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void Redo(DungeonDocument document) {
            if (_redoStack.Count == 0) return;
            var command = _redoStack.Pop();
            command.Execute(document);
            _undoStack.Push(command);
            Changed?.Invoke(this, EventArgs.Empty);
        }

        public void Clear() {
            _undoStack.Clear();
            _redoStack.Clear();
            Changed?.Invoke(this, EventArgs.Empty);
        }
    }
}
