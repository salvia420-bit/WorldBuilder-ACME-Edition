using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using DatReaderWriter.DBObjs;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  O7: Layout viewer / overlay
    // ─────────────────────────────────────────────────────────────────

    private LayoutDatDocument GetLayoutDoc() {
        return _projectManager.CurrentProject!.DocumentManager
            .GetOrCreateDocumentAsync<LayoutDatDocument>(LayoutDatDocument.DocumentId)
            .GetAwaiter().GetResult()
            ?? throw new InvalidOperationException("Could not load LayoutDatDocument.");
    }

    public LayoutListResult LayoutList(bool overlayOnly) {
        RequireProject();
        var doc = GetLayoutDoc();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        IEnumerable<uint> ids;
        if (overlayOnly) {
            // Reflection-free reach via TryGetLayout: probe each id we have stored.
            // The doc's _data.Entries is private, but HasStoredLayout gives us the predicate.
            // For a list we go through dats and filter.
            ids = dats.Dats.GetAllIdsOfType<LayoutDesc>().Where(doc.HasStoredLayout);
        } else {
            ids = dats.Dats.GetAllIdsOfType<LayoutDesc>();
        }

        var rows = ids
            .OrderBy(id => id)
            .Select(id => new LayoutListRow($"0x{id:X8}", doc.HasStoredLayout(id)))
            .ToList();
        return new LayoutListResult(rows.Count, rows);
    }

    public LayoutGetResult LayoutGet(uint layoutId) {
        RequireProject();
        var doc = GetLayoutDoc();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;

        bool hasOverlay = doc.HasStoredLayout(layoutId);
        LayoutDesc? layout = null;

        if (hasOverlay && doc.TryGetLayout(layoutId, out var fromOverlay)) {
            layout = fromOverlay;
        } else if (dats.TryGet<LayoutDesc>(layoutId, out var fromDat)) {
            layout = fromDat;
        }

        if (layout == null)
            throw new InvalidOperationException($"LayoutDesc 0x{layoutId:X8} not found in DAT or overlay.");

        return new LayoutGetResult(true, $"0x{layoutId:X8}", hasOverlay, layout);
    }

    public LayoutSaveResult LayoutSave(uint layoutId, string jsonPath) {
        RequireProject();
        if (!File.Exists(jsonPath))
            throw new FileNotFoundException($"JSON file not found: {jsonPath}", jsonPath);

        var json = File.ReadAllText(jsonPath);
        var layout = JsonSerializer.Deserialize<LayoutDesc>(json, JsonOpts.CaseInsensitive)
            ?? throw new InvalidOperationException("Failed to deserialize LayoutDesc from JSON.");

        var doc = GetLayoutDoc();
        doc.SetLayout(layoutId, layout);
        return new LayoutSaveResult(true, $"0x{layoutId:X8}");
    }

    public LayoutDeleteOverlayResult LayoutDeleteOverlay(uint layoutId) {
        RequireProject();
        var doc = GetLayoutDoc();
        bool existed = doc.HasStoredLayout(layoutId);
        if (existed) doc.RemoveLayout(layoutId);
        return new LayoutDeleteOverlayResult(existed, $"0x{layoutId:X8}");
    }
}
