using System.Text.Json.Nodes;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib.Validation;

namespace WorldBuilder.Terminal;

/// <summary>
/// Stage / validate / commit-or-rollback wrapper around the existing JSON command surface.
///
/// Composes other commands rather than introducing a parallel mutation alphabet: each op
/// in a transact body re-enters <see cref="JsonCommandProcessor.DispatchInternal"/>. Failure
/// (op throws, op returns success:false, or post-batch validation reports an error) restores
/// the in-memory document projections snapshotted before the batch ran. The DocumentManager
/// flush channel is unaffected — we restore via <see cref="BaseDocument.LoadFromProjection"/>
/// and then call <see cref="BaseDocument.ForceSave"/> so the restored state lands as the last
/// queued update for each touched document.
///
/// v1 invariants (documented in the plan):
///   • The stdin loop is single-threaded; only one transact runs at a time.
///   • DocumentManager batch flushes are NOT paused mid-transaction. Intermediate dirty state
///     may briefly hit SQLite; the post-rollback ForceSave overwrites it on the next batch.
///   • Nesting is rejected — a transact op inside a transact body is refused.
/// </summary>
internal sealed class TransactionEngine {
    // Commands explicitly safe to run inside a transact. Anything else is rejected.
    private static readonly HashSet<string> AllowedOps = new(StringComparer.OrdinalIgnoreCase) {
        "set-landblock-heightmap", "set-landblock-terrain",
        "import-heightmap",
        "bulk-place-objects",
        "add-object", "remove-object", "move-object", "rotate-object",
        "clear-objects",
        "raise", "lower", "smooth", "set-height", "paint", "fill",
        "road", "paste-stamp",
        "generate-dungeon",
        // F215: placement-add-outdoor / -add-dungeon / -remove are NOT transactable. They have no
        // snapshot-scope coverage (Project.OutdoorInstancePlacements is not a Document, and the
        // placement-targeted dungeon doc is not snapshotted), AND the outdoor variants call
        // project.Save() mid-batch — writing the project file to disk immediately — so a later op
        // failing would report rolled-back while the placement persists in memory AND on disk. Until
        // they have real commit-or-undo coverage they stay OFF the allow-list to keep the transact
        // "never half-applied" contract honest. (Re-add here once snapshot coverage + deferred-Save
        // land — see F215.)
    };

    // Ops that mutate the singleton TerrainDocument ("terrain").
    private static readonly HashSet<string> TerrainSingletonOps = new(StringComparer.OrdinalIgnoreCase) {
        "set-landblock-heightmap", "set-landblock-terrain",
        "import-heightmap",
        "raise", "lower", "smooth", "set-height", "paint", "fill",
        "road", "paste-stamp",
    };

    // Ops that target a specific LandblockDocument identified by lbX/lbY in args.
    private static readonly HashSet<string> LandblockTargetedOps = new(StringComparer.OrdinalIgnoreCase) {
        "bulk-place-objects",
        "add-object", "remove-object", "move-object", "rotate-object",
        "clear-objects",
    };

    // Ops that may create or mutate a DungeonDocument identified by lbX/lbY.
    private static readonly HashSet<string> DungeonTargetedOps = new(StringComparer.OrdinalIgnoreCase) {
        "generate-dungeon",
    };

    // paste-stamp can mutate multiple LandblockDocuments not declared in args. We conservatively
    // snapshot every existing LandblockDocument in ActiveDocs at the start of the batch, and
    // record any new LandblockDocuments that appear after the op runs as created-by-transact.
    private static readonly HashSet<string> WideLandblockOps = new(StringComparer.OrdinalIgnoreCase) {
        "paste-stamp",
    };

    private readonly JsonCommandProcessor _processor;
    private readonly HeadlessProjectManager _projectManager;

    // ── Snapshot retention (powers transact-diff). ──────────────────────
    // Committed transactions retain pre+post projections in an LRU. Failed
    // transactions get a lightweight marker in a separate bounded set so
    // transact-diff can return a precise error code instead of TXDIFF-EXPIRED.
    // We distinguish two failure kinds:
    //   • Rejected — the batch was refused before any op ran (bad allow-list,
    //     bad validate shape, no project loaded). No snapshot was ever taken.
    //   • RolledBack — ops staged but a failure triggered restore of the
    //     pre-state snapshot. State was actually unwound.
    // Different signals to the agent: rejected means "fix your request",
    // rolled-back means "your batch was rejected mid-flight".
    private readonly int _retentionCount;
    private readonly long _retentionMemCapBytes;
    private readonly Dictionary<Guid, LinkedListNode<TransactSnapshotEntry>> _snapshotIndex = new();
    private readonly LinkedList<TransactSnapshotEntry> _snapshotOrder = new();
    private long _snapshotBytesUsed;

    private const int FailureMarkerCap = 256;
    private readonly Dictionary<Guid, FailureKind> _failureMarkers = new();
    private readonly Queue<Guid> _failureOrder = new();

    private enum FailureKind { Rejected, RolledBack }

    public TransactionEngine(JsonCommandProcessor processor, HeadlessProjectManager projectManager,
            int retentionCount = 32, int retentionMemCapMb = 256) {
        _processor = processor;
        _projectManager = projectManager;
        _retentionCount = Math.Max(1, retentionCount);
        _retentionMemCapBytes = Math.Max(1, (long)retentionMemCapMb) * 1024L * 1024L;
    }

    public TransactResult Run(JsonArray ops, bool rollbackOnFail, JsonNode? validateNode) {
        var txId = Guid.NewGuid();
        var startedAt = DateTime.UtcNow;

        // ── Validate every op against the allow-list before mutating anything. ──
        // A single rejection aborts the whole batch with no side effects. We run this
        // before the project-loaded check so callers get the most specific error for
        // batches that are also broken (nested transact, unknown op, etc.).
        var preOpRejection = PreflightOps(ops);
        if (preOpRejection != null) {
            return RejectBatch(txId, startedAt, preOpRejection);
        }

        // Reject malformed `validate` parameters up-front so the agent learns the
        // expected shape instead of having an unknown mode silently treated as auto.
        var validateRejection = PreflightValidate(validateNode);
        if (validateRejection != null) {
            return RejectBatch(txId, startedAt, validateRejection);
        }

        if (_projectManager.CurrentProject == null) {
            return RejectBatch(txId, startedAt, "No project loaded — call 'load' before 'transact'.");
        }

        var dm = _projectManager.CurrentProject.DocumentManager;

        // ── Snapshot scope. ─────────────────────────────────────────────────
        var snapshots = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        var preexistingDocIds = new HashSet<string>(dm.ActiveDocs.Keys, StringComparer.Ordinal);
        var maybeCreatedIds = new HashSet<string>(StringComparer.Ordinal);
        var wideLandblockMode = ops.OfType<JsonNode>()
            .Any(o => WideLandblockOps.Contains(GetCommandName(o)));

        SnapshotScope(ops, dm, snapshots, maybeCreatedIds, wideLandblockMode);

        // F216: any doc materialized from storage during snapshot (existed-but-unloaded) is now in
        // ActiveDocs. It must NOT be misclassified as created-by-batch on commit/rollback — every doc
        // we captured a pre-state snapshot for already existed, so fold the snapshot keys into the
        // preexisting set (which was captured before SnapshotScope ran).
        preexistingDocIds.UnionWith(snapshots.Keys);

        // ── Run ops sequentially, halting on first failure. ─────────────────
        var outcomes = new List<TransactOpOutcome>(ops.Count);
        bool batchFailure = false;
        string failReason = "ok";
        var touchedLbKeys = new HashSet<ushort>();

        for (int i = 0; i < ops.Count; i++) {
            var opNode = ops[i];
            if (opNode == null) {
                outcomes.Add(new TransactOpOutcome(i, "<null>", false,
                    BuildErrorEnvelope("<null>", "Op is null"), "Op is null"));
                batchFailure = true;
                failReason = "op-threw";
                break;
            }

            var commandName = GetCommandName(opNode);
            // For generate-dungeon, force the inner op's `validate` flag false so the
            // engine doesn't double-validate (transact runs its own validation step).
            // We dispatch a clone so the caller's input JSON isn't side-effected — the
            // caller may inspect / re-send the same ops array elsewhere.
            JsonNode dispatchNode = opNode;
            if (commandName.Equals("generate-dungeon", StringComparison.OrdinalIgnoreCase)) {
                dispatchNode = JsonNode.Parse(opNode.ToJsonString())!;
                dispatchNode["validate"] = false;
            }

            // Seed touched-LB candidates from explicit args before the op runs.
            if (TryParseLbKeyFromArgs(opNode, out var preLbKey)) {
                touchedLbKeys.Add(preLbKey);
            }

            string responseJson;
            try {
                responseJson = _processor.DispatchInternal(commandName, dispatchNode);
            } catch (Exception ex) {
                outcomes.Add(new TransactOpOutcome(i, commandName, false,
                    BuildErrorEnvelope(commandName, ex.Message), ex.Message));
                batchFailure = true;
                failReason = "op-threw";
                break;
            }

            bool opOk = ResponseSaysSuccess(responseJson);
            outcomes.Add(new TransactOpOutcome(i, commandName, opOk, responseJson,
                opOk ? null : ExtractError(responseJson)));

            // Pull touched landblocks from the response so brush ops (smooth/raise/etc.)
            // can drive the validation scope even though they take world coords.
            CollectTouchedLbsFromResponse(responseJson, touchedLbKeys);

            if (!opOk) {
                batchFailure = true;
                failReason = "op-returned-failure";
                break;
            }
        }

        // ── Validation step. ────────────────────────────────────────────────
        List<ValidationReport>? validationReports = null;
        if (!batchFailure) {
            validationReports = RunValidation(validateNode, touchedLbKeys, dm);
            if (validationReports != null && validationReports.Any(r => r.ErrorCount > 0)) {
                batchFailure = true;
                failReason = "validation-failure";
            }
        }

        // ── Decide commit / rollback. ───────────────────────────────────────
        bool shouldRollback = batchFailure && rollbackOnFail;
        int opsApplied = outcomes.Count(o => o.Success);
        int opsRolledBack = shouldRollback ? opsApplied : 0;
        var documentsCreated = new List<string>();

        // Identify docs the batch created. Tracked dungeon docs are always candidates;
        // in wideLandblockMode (paste-stamp), any new landblock_* doc also counts.
        var createdNow = dm.ActiveDocs.Keys
            .Where(id => !preexistingDocIds.Contains(id) &&
                (maybeCreatedIds.Contains(id) ||
                 (wideLandblockMode && id.StartsWith("landblock_", StringComparison.Ordinal))))
            .ToList();

        if (shouldRollback) {
            // Restore pre-op projections (in-memory) and force a flush so SQLite catches up.
            foreach (var (docId, bytes) in snapshots) {
                if (dm.ActiveDocs.TryGetValue(docId, out var doc)) {
                    doc.LoadFromProjection(bytes);
                    doc.ForceSave();
                }
                // If the doc isn't in ActiveDocs anymore, there's nothing to restore in
                // memory; the snapshot was effectively orphaned.
            }
            // Delete any docs the batch created.
            foreach (var docId in createdNow) {
                if (dm.ActiveDocs.TryRemove(docId, out var doc)) {
                    doc.IsDirty = false;     // suppress any pending channel write
                }
                try {
                    dm.DocumentStorageService.DeleteDocumentAsync(docId).GetAwaiter().GetResult();
                } catch {
                    // Storage delete may fail if the doc was never persisted yet — ignore.
                }
            }
            RecordFailure(txId, FailureKind.RolledBack);
        } else {
            // Committed — record the docs the batch created so the journal is complete,
            // then promote the pre-snapshots to the retention LRU alongside fresh
            // post-snapshots so transact-diff can reconstruct the change later.
            documentsCreated.AddRange(createdNow);
            CapturePostStateAndRetain(txId, snapshots, createdNow, dm);
        }

        var finishedAt = DateTime.UtcNow;
        var status = shouldRollback ? "rolled-back" : "committed";
        // When rollback_on_fail is false but validation/op failed, status is still
        // "committed" (the user opted out of rollback) but Success reflects the failure.
        bool overallSuccess = !batchFailure;

        return new TransactResult(
            Success: overallSuccess,
            Status: status,
            Reason: batchFailure ? failReason : "ok",
            Ops: outcomes,
            Validation: validationReports,
            Journal: new TransactJournal(
                TransactionId: txId,
                StartedAt: startedAt,
                FinishedAt: finishedAt,
                DocumentsTouched: snapshots.Keys.ToList(),
                DocumentsCreated: documentsCreated,
                OpsApplied: opsApplied,
                OpsRolledBack: opsRolledBack));
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Preflight: reject the batch with a clear error if any op is unsafe.
    // ─────────────────────────────────────────────────────────────────────
    private static string? PreflightOps(JsonArray ops) {
        if (ops.Count == 0) return "ops array is empty";
        for (int i = 0; i < ops.Count; i++) {
            var node = ops[i];
            if (node == null) return $"ops[{i}] is null";
            var commandName = GetCommandName(node);
            if (string.IsNullOrWhiteSpace(commandName))
                return $"ops[{i}] is missing 'command'";
            if (commandName.Equals("transact", StringComparison.OrdinalIgnoreCase))
                return $"ops[{i}] is a nested transact (not supported in v1)";
            if (!AllowedOps.Contains(commandName))
                return $"ops[{i}] command '{commandName}' is not transactable";
            if (commandName.Equals("clear-objects", StringComparison.OrdinalIgnoreCase) &&
                TryReadBool(node["all"], out var clearAll) && clearAll) {
                return $"ops[{i}] clear-objects with all:true mutates every populated landblock and is not transactable";
            }
        }
        return null;
    }

    // Reject malformed `validate` parameters before mutating anything. The accepted
    // shapes are: omitted (defaults to auto), the strings "auto"/"all"/"none", or
    // an object with a `landblocks` array. Anything else used to fall through to
    // the auto path silently — surfacing the typo to the agent is more useful.
    private static string? PreflightValidate(JsonNode? validateNode) {
        if (validateNode == null) return null;
        var kind = validateNode.GetValueKind();
        if (kind == System.Text.Json.JsonValueKind.String) {
            string s;
            try { s = validateNode.GetValue<string>(); }
            catch { return "'validate' string could not be read"; }
            if (s.Equals("auto", StringComparison.OrdinalIgnoreCase)) return null;
            if (s.Equals("all",  StringComparison.OrdinalIgnoreCase)) return null;
            if (s.Equals("none", StringComparison.OrdinalIgnoreCase)) return null;
            return $"'validate' mode '{s}' is not recognized (expected: auto, all, none, or {{landblocks:[...]}})";
        }
        if (validateNode is JsonObject obj) {
            if (obj["landblocks"] is JsonArray) return null;
            return "'validate' object must contain a 'landblocks' array of hex LB ids";
        }
        return "'validate' must be a string (auto|all|none) or object {landblocks:[...]}";
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Snapshot scope inference. Captures projection bytes for documents the
    //  batch will mutate, before any op runs. paste-stamp triggers a wide
    //  LandblockDocument snapshot since it can mutate LBs not declared in args.
    // ─────────────────────────────────────────────────────────────────────
    private static void SnapshotScope(JsonArray ops, DocumentManager dm,
        Dictionary<string, byte[]> snapshots, HashSet<string> maybeCreatedIds, bool wideLandblockMode) {

        bool needsTerrain = false;
        var landblockKeys = new HashSet<ushort>();
        var dungeonKeys = new HashSet<ushort>();

        foreach (var node in ops.OfType<JsonNode>()) {
            var commandName = GetCommandName(node);
            if (TerrainSingletonOps.Contains(commandName)) needsTerrain = true;
            if (LandblockTargetedOps.Contains(commandName) && TryParseLbKeyFromArgs(node, out var lbKey)) {
                landblockKeys.Add(lbKey);
            }
            if (DungeonTargetedOps.Contains(commandName) && TryParseLbKeyFromArgs(node, out var dlbKey)) {
                dungeonKeys.Add(dlbKey);
            }
        }

        // 'terrain' is the singleton TerrainDocument — always present once a project is loaded, so the
        // in-memory snapshot is sufficient (no lazy-create case to distinguish).
        if (needsTerrain) TrySnapshot(dm, "terrain", snapshots);

        // F216: a landblock/dungeon doc that the batch targets but that is NOT in ActiveDocs would
        // otherwise be neither snapshotted (so rollback can't restore it) nor tracked as created (so
        // rollback can't delete it, and commit never journals it for tile invalidation / transact-diff).
        // For each such key, pre-materialize the doc and classify it:
        //   • existed in storage but was unloaded → snapshot it (rollback restores its pre-state)
        //   • brand new (no storage row) → record in maybeCreatedIds (rollback deletes, commit journals)
        foreach (var k in landblockKeys) {
            SnapshotOrTrackCreate(dm, $"landblock_{k:X4}", snapshots, maybeCreatedIds);
        }

        if (wideLandblockMode) {
            // Snapshot every LandblockDocument that's currently active. Any LB created
            // by paste-stamp during the batch becomes a "delete on rollback" candidate.
            foreach (var (id, doc) in dm.ActiveDocs) {
                if (id.StartsWith("landblock_", StringComparison.Ordinal) && !snapshots.ContainsKey(id)) {
                    snapshots[id] = doc.SaveToProjection();
                }
            }
        }

        foreach (var k in dungeonKeys) {
            SnapshotOrTrackCreate(dm, $"dungeon_{k:X4}", snapshots, maybeCreatedIds);
        }
    }

    private static void TrySnapshot(DocumentManager dm, string docId, Dictionary<string, byte[]> snapshots) {
        if (snapshots.ContainsKey(docId)) return;
        if (dm.ActiveDocs.TryGetValue(docId, out var doc)) {
            snapshots[docId] = doc.SaveToProjection();
        }
    }

    /// <summary>
    /// F216 — snapshot a targeted doc that may not be in ActiveDocs yet. If it's already active,
    /// snapshot its live state. Otherwise probe storage: a doc that EXISTS in storage but is unloaded
    /// is materialized + snapshotted (rollback restores it); a doc with NO storage row is treated as
    /// created-by-batch (recorded in <paramref name="maybeCreatedIds"/> so rollback deletes it and
    /// commit lists it in documentsCreated). Either way the journal sees the doc so tile invalidation
    /// and transact-diff have its pre/post bytes.
    /// </summary>
    private static void SnapshotOrTrackCreate(DocumentManager dm, string docId,
        Dictionary<string, byte[]> snapshots, HashSet<string> maybeCreatedIds) {
        if (snapshots.ContainsKey(docId) || maybeCreatedIds.Contains(docId)) return;

        if (dm.ActiveDocs.TryGetValue(docId, out var active)) {
            snapshots[docId] = active.SaveToProjection();
            return;
        }

        // Not loaded — does it exist on disk? The dispatch loop is single-threaded so blocking here
        // is safe. A storage lookup failure is treated as "brand new" (the conservative branch: the op
        // creates it, rollback deletes it) rather than silently dropping the doc from the journal.
        bool existsInStorage;
        try {
            existsInStorage = dm.DocumentStorageService.GetDocumentAsync(docId).GetAwaiter().GetResult() != null;
        } catch {
            existsInStorage = false;
        }

        if (existsInStorage) {
            // Existed-but-unloaded: materialize so we can snapshot the real pre-state for restore.
            var doc = docId.StartsWith("dungeon_", StringComparison.Ordinal)
                ? (BaseDocument?)dm.GetOrCreateDocumentAsync<DungeonDocument>(docId).GetAwaiter().GetResult()
                : dm.GetOrCreateDocumentAsync<LandblockDocument>(docId).GetAwaiter().GetResult();
            if (doc != null) {
                snapshots[docId] = doc.SaveToProjection();
                return;
            }
            // Materialization failed — fall through and track as created so rollback at least deletes
            // whatever the op produced rather than leaving an unjournaled mutation.
        }

        maybeCreatedIds.Add(docId);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Validation scope. "auto" = touched LBs from arg-derived + response-derived
    //  sets. Brush ops contribute via their `landblocks` response field.
    // ─────────────────────────────────────────────────────────────────────
    private List<ValidationReport>? RunValidation(JsonNode? validateNode, HashSet<ushort> touchedLbKeys, DocumentManager dm) {
        var mode = validateNode?.GetValueKind() == System.Text.Json.JsonValueKind.String
            ? validateNode!.GetValue<string>()
            : (validateNode == null ? "auto" : "<object>");

        var reports = new List<ValidationReport>();
        var engine = _processor.Engine;

        if (mode.Equals("none", StringComparison.OrdinalIgnoreCase)) {
            return reports;
        }

        if (mode.Equals("all", StringComparison.OrdinalIgnoreCase)) {
            foreach (var (id, _) in dm.ActiveDocs) {
                if (!id.StartsWith("landblock_", StringComparison.Ordinal)) continue;
                if (!ushort.TryParse(id.Substring("landblock_".Length),
                    System.Globalization.NumberStyles.HexNumber,
                    System.Globalization.CultureInfo.InvariantCulture, out var lbKey)) continue;
                uint lbX = (uint)((lbKey >> 8) & 0xFF);
                uint lbY = (uint)(lbKey & 0xFF);
                reports.Add(engine.ValidateAll(lbX, lbY));
            }
            return reports;
        }

        // Explicit landblock list
        if (validateNode is JsonObject obj && obj["landblocks"] is JsonArray lbArr) {
            foreach (var n in lbArr.OfType<JsonNode>()) {
                // GetValue<string>() throws on numeric/bool entries — skip those gracefully
                // rather than aborting the whole validation pass.
                if (n.GetValueKind() != System.Text.Json.JsonValueKind.String) continue;
                if (TryParseHexLbKey(n.GetValue<string>(), out var lbKey)) {
                    reports.Add(engine.ValidateAll((uint)((lbKey >> 8) & 0xFF), (uint)(lbKey & 0xFF)));
                }
            }
            return reports;
        }

        // Default: "auto" — touched LBs (validate-all) + LEFT/BOTTOM neighbors (terrain only).
        var validatedKeys = new HashSet<ushort>();
        foreach (var lbKey in touchedLbKeys) {
            uint lbX = (uint)((lbKey >> 8) & 0xFF);
            uint lbY = (uint)(lbKey & 0xFF);
            reports.Add(engine.ValidateAll(lbX, lbY));
            validatedKeys.Add(lbKey);
        }
        // F217: seam ownership is directional. CheckEdgeStitching only compares a validated LB's OWN
        // right edge (x=8) vs lbX+1 and top edge (y=8) vs lbY+1. The touched LB's own ValidateAll
        // already covers its right/top seams, so validating the right/top NEIGHBORS would re-check
        // seams the batch did not touch (contributing nothing) while MISSING the seam an edit to the
        // touched LB's x=0/y=0 edge breaks — that seam belongs to the LEFT (lbX-1) / BOTTOM (lbY-1)
        // neighbor, whose own right/top check covers the seam back to the touched LB. So validate the
        // LEFT and BOTTOM neighbors (skipping coords that underflow below 0).
        foreach (var lbKey in touchedLbKeys) {
            uint lbX = (uint)((lbKey >> 8) & 0xFF);
            uint lbY = (uint)(lbKey & 0xFF);
            foreach (var (nx, ny) in new (long, long)[] { (lbX - 1L, (long)lbY), ((long)lbX, lbY - 1L) }) {
                if (nx < 0 || ny < 0) continue;
                ushort neighborKey = (ushort)(((uint)nx << 8) | (uint)ny);
                if (validatedKeys.Contains(neighborKey)) continue;
                try {
                    reports.Add(engine.ValidateTerrain((uint)nx, (uint)ny));
                    // Track so a second touched LB sharing this neighbor doesn't re-validate it.
                    validatedKeys.Add(neighborKey);
                } catch {
                    // Neighbor may not have terrain data — skip silently.
                }
            }
        }
        return reports;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Helpers.
    // ─────────────────────────────────────────────────────────────────────
    private static string GetCommandName(JsonNode node) {
        return node["command"]?.GetValue<string>()?.Trim() ?? string.Empty;
    }

    private static bool TryParseLbKeyFromArgs(JsonNode node, out ushort lbKey) {
        lbKey = 0;
        var lbXNode = node["lbX"];
        var lbYNode = node["lbY"];
        if (lbXNode == null || lbYNode == null) return false;
        try {
            uint lbX = lbXNode.GetValue<uint>();
            uint lbY = lbYNode.GetValue<uint>();
            // Reject out-of-range coords rather than silently truncating into the
            // wrong landblock. AC LB coords are 0..255 inclusive on both axes.
            if (lbX > 0xFF || lbY > 0xFF) return false;
            lbKey = (ushort)((lbX << 8) | lbY);
            return true;
        } catch {
            return false;
        }
    }

    // Defensive bool reader — JsonNode.GetValue<bool>() throws NotSupportedException
    // on non-bool values, so we treat numeric/string truthy values as false here and
    // let validators upstream complain about the wrong type if they care.
    private static bool TryReadBool(JsonNode? node, out bool value) {
        value = false;
        if (node == null) return false;
        try {
            if (node.GetValueKind() == System.Text.Json.JsonValueKind.True) { value = true; return true; }
            if (node.GetValueKind() == System.Text.Json.JsonValueKind.False) { value = false; return true; }
        } catch { }
        return false;
    }

    private static bool TryParseHexLbKey(string s, out ushort lbKey) {
        lbKey = 0;
        if (string.IsNullOrEmpty(s)) return false;
        var trimmed = s.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? s.Substring(2) : s;
        return ushort.TryParse(trimmed,
            System.Globalization.NumberStyles.HexNumber,
            System.Globalization.CultureInfo.InvariantCulture, out lbKey);
    }

    private static bool ResponseSaysSuccess(string responseJson) {
        try {
            var n = JsonNode.Parse(responseJson);
            return n?["success"]?.GetValue<bool>() ?? false;
        } catch {
            return false;
        }
    }

    private static string? ExtractError(string responseJson) {
        try {
            var n = JsonNode.Parse(responseJson);
            return n?["error"]?.GetValue<string>();
        } catch {
            return null;
        }
    }

    private static void CollectTouchedLbsFromResponse(string responseJson, HashSet<ushort> touched) {
        JsonNode? n;
        try { n = JsonNode.Parse(responseJson); }
        catch { return; }
        if (n is null) return;

        // Per-item try/catch so a single non-string entry doesn't abort the rest of the
        // collection — earlier versions wrapped the whole block in one catch and lost
        // every subsequent landblock when one element was malformed.
        static void CollectArray(JsonArray? arr, HashSet<ushort> touched) {
            if (arr == null) return;
            foreach (var item in arr.OfType<JsonNode>()) {
                if (item.GetValueKind() != System.Text.Json.JsonValueKind.String) continue;
                try {
                    if (TryParseHexLbKey(item.GetValue<string>(), out var k)) touched.Add(k);
                } catch { }
            }
        }
        try { CollectArray(n["landblocks"] as JsonArray, touched); } catch { }
        try { CollectArray(n["affectedLandblocks"] as JsonArray, touched); } catch { }
        try {
            var single = n["landblock"];
            if (single != null && single.GetValueKind() == System.Text.Json.JsonValueKind.String &&
                TryParseHexLbKey(single.GetValue<string>(), out var k2)) {
                touched.Add(k2);
            }
        } catch { }
    }

    private static string BuildErrorEnvelope(string command, string error) {
        var obj = new JsonObject {
            ["success"] = false,
            ["command"] = command,
            ["error"] = error,
        };
        return obj.ToJsonString();
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Snapshot retention — internal LRU keyed by transaction id.
    //  Lookups feed transact-diff. The dispatch loop is single-threaded so
    //  the dictionary + linked list pair needs no locks.
    // ─────────────────────────────────────────────────────────────────────

    private void CapturePostStateAndRetain(Guid txId, Dictionary<string, byte[]> preSnapshots,
            List<string> createdNow, DocumentManager dm) {
        var preState = new Dictionary<string, byte[]>(preSnapshots, StringComparer.Ordinal);

        // Post-state covers every doc that had a pre-state plus any docs the batch
        // created. We snapshot post-state from the live ActiveDocs after commit;
        // a doc that's no longer active (rare in practice — commit doesn't delete)
        // is omitted from postState, signalling "removed" to the diff engine.
        var postState = new Dictionary<string, byte[]>(StringComparer.Ordinal);
        foreach (var docId in preState.Keys) {
            if (dm.ActiveDocs.TryGetValue(docId, out var doc)) {
                postState[docId] = doc.SaveToProjection();
            }
        }
        foreach (var docId in createdNow) {
            if (postState.ContainsKey(docId)) continue;
            if (dm.ActiveDocs.TryGetValue(docId, out var doc)) {
                postState[docId] = doc.SaveToProjection();
            }
        }

        long bytes = 0;
        foreach (var b in preState.Values) bytes += b.LongLength;
        foreach (var b in postState.Values) bytes += b.LongLength;

        var entry = new TransactSnapshotEntry(
            TxId: txId,
            CapturedAt: DateTime.UtcNow,
            PreState: preState,
            PostState: postState,
            DocumentsCreated: new HashSet<string>(createdNow, StringComparer.Ordinal),
            ApproxBytes: bytes);

        // Replace any existing entry with the same txId (txId is a fresh GUID per
        // Run() so collisions are theoretical, but the index must stay consistent).
        if (_snapshotIndex.TryGetValue(txId, out var existing)) {
            _snapshotBytesUsed -= existing.Value.ApproxBytes;
            _snapshotOrder.Remove(existing);
            _snapshotIndex.Remove(txId);
        }
        var node = _snapshotOrder.AddFirst(entry);
        _snapshotIndex[txId] = node;
        _snapshotBytesUsed += bytes;

        EvictUntilUnderLimits();
    }

    private void EvictUntilUnderLimits() {
        while (_snapshotIndex.Count > _retentionCount ||
               _snapshotBytesUsed > _retentionMemCapBytes) {
            var oldest = _snapshotOrder.Last;
            if (oldest == null) break;
            _snapshotOrder.RemoveLast();
            _snapshotIndex.Remove(oldest.Value.TxId);
            _snapshotBytesUsed -= oldest.Value.ApproxBytes;
        }
    }

    private void RecordFailure(Guid txId, FailureKind kind) {
        if (_failureMarkers.ContainsKey(txId)) return;
        _failureMarkers[txId] = kind;
        _failureOrder.Enqueue(txId);
        while (_failureOrder.Count > FailureMarkerCap) {
            var evicted = _failureOrder.Dequeue();
            _failureMarkers.Remove(evicted);
        }
    }

    // Build the result for a batch refused before any op ran. We record the txId
    // so a follow-up transact-diff can return TXDIFF-REJECTED instead of the
    // generic TXDIFF-EXPIRED. Status is "rejected" rather than "rolled-back"
    // because nothing was actually unwound — there were no snapshots to restore.
    private TransactResult RejectBatch(Guid txId, DateTime startedAt, string error) {
        RecordFailure(txId, FailureKind.Rejected);
        return new TransactResult(
            Success: false, Status: "rejected", Reason: "rejected",
            Ops: new List<TransactOpOutcome>(),
            Validation: null,
            Journal: new TransactJournal(txId, startedAt, DateTime.UtcNow,
                new List<string>(), new List<string>(), 0, 0),
            Error: error);
    }

    public TransactSnapshotLookup Lookup(Guid txId) {
        if (_snapshotIndex.TryGetValue(txId, out var node)) {
            // Bump to head — a successful diff read counts as access for LRU.
            _snapshotOrder.Remove(node);
            _snapshotOrder.AddFirst(node);
            return new TransactSnapshotLookup(TransactSnapshotStatus.Available, node.Value);
        }
        if (_failureMarkers.TryGetValue(txId, out var kind)) {
            return new TransactSnapshotLookup(
                kind == FailureKind.Rejected
                    ? TransactSnapshotStatus.Rejected
                    : TransactSnapshotStatus.RolledBack,
                null);
        }
        return new TransactSnapshotLookup(TransactSnapshotStatus.Expired, null);
    }
}

internal enum TransactSnapshotStatus {
    Available,
    Rejected,
    RolledBack,
    Expired,
}

internal sealed record TransactSnapshotLookup(
    TransactSnapshotStatus Status,
    TransactSnapshotEntry? Entry);

internal sealed record TransactSnapshotEntry(
    Guid TxId,
    DateTime CapturedAt,
    Dictionary<string, byte[]> PreState,
    Dictionary<string, byte[]> PostState,
    HashSet<string> DocumentsCreated,
    long ApproxBytes);
