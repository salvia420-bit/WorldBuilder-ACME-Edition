using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading.Tasks;
using DatReaderWriter.DBObjs;
using MySqlConnector;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.AceDb;

namespace WorldBuilder.Terminal;

public partial class CommandEngine {
    // ─────────────────────────────────────────────────────────────────
    //  O3: ACE DB Spell CRUD + project SpellDbDocument overlay
    // ─────────────────────────────────────────────────────────────────

    private const uint SpellTableId = 0x0E00000E;

    private SpellDbDocument GetSpellDbDoc() {
        return _projectManager.CurrentProject!.DocumentManager
            .GetOrCreateDocumentAsync<SpellDbDocument>(SpellDbDocument.DocumentId)
            .GetAwaiter().GetResult()
            ?? throw new InvalidOperationException("Could not load SpellDbDocument.");
    }

    public async Task<SpellListResult> SpellListAsync(int limit, string source) {
        RequireProject();
        var rows = new List<SpellListRow>();
        bool fromDb = source.Equals("db", StringComparison.OrdinalIgnoreCase);

        if (fromDb) {
            var settings = _projectManager.CurrentProject!.AceDb;
            if (settings == null || string.IsNullOrEmpty(settings.Host))
                throw new InvalidOperationException("ACE DB is not configured. Run 'ace-db connect' first.");

            await using var conn = new MySqlConnection(settings.ConnectionString);
            await conn.OpenAsync();
            await using var cmd = new MySqlCommand(
                $"SELECT id, name FROM spell ORDER BY id DESC LIMIT {Math.Max(1, limit)}", conn);
            await using var reader = await cmd.ExecuteReaderAsync();
            while (await reader.ReadAsync()) {
                uint sid = reader.GetUInt32(0);
                string? name = reader.IsDBNull(1) ? null : reader.GetString(1);
                rows.Add(new SpellListRow(
                    SpellId: $"0x{sid:X8}",
                    Name: name,
                    HasOverlay: false));
            }

            // Mark which ones also have a project overlay.
            var overlayDoc = GetSpellDbDoc();
            for (int i = 0; i < rows.Count; i++) {
                if (overlayDoc.TryGet(uint.Parse(rows[i].SpellId[2..], System.Globalization.NumberStyles.HexNumber), out _)) {
                    rows[i] = rows[i] with { HasOverlay = true };
                }
            }
        } else {
            var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
            if (!dats.TryGet<SpellTable>(SpellTableId, out var table) || table == null)
                throw new InvalidOperationException("SpellTable 0x0E00000E not present in DAT.");

            var doc = GetSpellDbDoc();
            rows = table.Spells.OrderByDescending(kv => kv.Key)
                .Take(Math.Max(1, limit))
                .Select(kv => new SpellListRow(
                    SpellId: $"0x{kv.Key:X8}",
                    Name: kv.Value?.Name,
                    HasOverlay: doc.TryGet(kv.Key, out _)))
                .ToList();
        }

        return new SpellListResult(rows.Count, source.ToLowerInvariant(), rows);
    }

    public async Task<SpellGetResult> SpellGetAsync(uint id) {
        RequireProject();
        var doc = GetSpellDbDoc();

        // Project overlay wins.
        if (doc.TryGet(id, out var overlay) && overlay != null) {
            return new SpellGetResult(true, $"0x{id:X8}", "overlay", overlay);
        }

        // ace-db is optional; only read from it when configured.
        var settings = _projectManager.CurrentProject!.AceDb;
        if (settings != null && !string.IsNullOrEmpty(settings.Host)) {
            using var connector = new AceDbConnector(settings);
            var fromDb = await connector.GetSpellAsync(id);
            if (fromDb != null)
                return new SpellGetResult(true, $"0x{id:X8}", "db", fromDb);
        }

        throw new InvalidOperationException($"Spell 0x{id:X8} not found in project overlay or ACE DB.");
    }

    public async Task<SpellSaveResult> SpellSaveAsync(uint id, string? jsonPath) {
        RequireProject();
        if (string.IsNullOrEmpty(jsonPath))
            throw new ArgumentException("--from-json <path> is required for spell save.");
        if (!File.Exists(jsonPath))
            throw new FileNotFoundException($"JSON file not found: {jsonPath}", jsonPath);

        var spell = JsonSerializer.Deserialize<SpellRecord>(
            File.ReadAllText(jsonPath), JsonOpts.CaseInsensitive)
            ?? throw new InvalidOperationException("Failed to deserialize SpellRecord from JSON.");

        spell.Id = id;
        spell.LastModified = DateTime.UtcNow;

        // Always update the project overlay.
        var doc = GetSpellDbDoc();
        doc.Set(id, spell);

        // If ace-db is connected, also push to MySQL.
        bool savedToDb = false;
        var settings = _projectManager.CurrentProject!.AceDb;
        if (settings != null && !string.IsNullOrEmpty(settings.Host)) {
            using var connector = new AceDbConnector(settings);
            savedToDb = await connector.SaveSpellAsync(spell);
        }

        return new SpellSaveResult(true, $"0x{id:X8}", true, savedToDb);
    }

    public async Task<SpellCopyResult> SpellCopyAsync(uint fromId, uint? newId) {
        RequireProject();

        // Source: prefer overlay, fall back to db, fall back to dat-side.
        var get = await SpellGetAsync(fromId);
        var source = get.Spell;

        uint resolvedNewId = newId ?? AllocateNextSpellId();
        var clone = source.CloneWithNewId(resolvedNewId);
        clone.LastModified = DateTime.UtcNow;

        var doc = GetSpellDbDoc();
        doc.Set(resolvedNewId, clone);

        bool savedToDb = false;
        var settings = _projectManager.CurrentProject!.AceDb;
        if (settings != null && !string.IsNullOrEmpty(settings.Host)) {
            using var connector = new AceDbConnector(settings);
            savedToDb = await connector.SaveSpellAsync(clone);
        }

        return new SpellCopyResult(true, $"0x{fromId:X8}", $"0x{resolvedNewId:X8}", true, savedToDb);
    }

    public async Task<SpellDeleteResult> SpellDeleteAsync(uint id) {
        RequireProject();
        var doc = GetSpellDbDoc();
        doc.Remove(id);

        bool deletedFromDb = false;
        var settings = _projectManager.CurrentProject!.AceDb;
        if (settings != null && !string.IsNullOrEmpty(settings.Host)) {
            using var connector = new AceDbConnector(settings);
            try {
                var rows = await connector.ExecuteSqlAsync($"DELETE FROM spell WHERE id = {id}");
                deletedFromDb = rows > 0;
            }
            catch (MySqlException) {
                deletedFromDb = false;
            }
        }

        return new SpellDeleteResult(true, $"0x{id:X8}", true, deletedFromDb);
    }

    private uint AllocateNextSpellId() {
        var doc = GetSpellDbDoc();
        var dats = _projectManager.CurrentProject!.DocumentManager.Dats;
        uint maxFromOverlay = doc.GetIds().DefaultIfEmpty(0u).Max();
        uint maxFromDat = 0;
        if (dats.TryGet<SpellTable>(SpellTableId, out var table) && table != null && table.Spells.Count > 0) {
            maxFromDat = table.Spells.Keys.Max();
        }
        return Math.Max(maxFromOverlay, maxFromDat) + 1;
    }
}
