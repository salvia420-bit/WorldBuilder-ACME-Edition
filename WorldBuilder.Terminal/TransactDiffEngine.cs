using System.Numerics;
using Microsoft.Extensions.Logging.Abstractions;
using SkiaSharp;
using WorldBuilder.Shared.Documents;
using WorldBuilder.Shared.Lib;
using WorldBuilder.Shared.Lib.Validation;

namespace WorldBuilder.Terminal;

/// <summary>
/// Read-only diff over a committed transaction's pre/post projections.
///
/// The action loop's missing piece: render-preview / describe-landblock /
/// compare-to-retail all describe *current state*. transact-diff describes
/// the *change* a batch produced. We don't introduce a new observation
/// primitive — we compose the existing ones onto the journal that transact
/// already produces, hydrating ephemeral documents from the snapshot bytes
/// retained by <see cref="TransactionEngine"/>.
///
/// Identity stays in the documents; diffs are always derived. Nothing is
/// stored on disk.
/// </summary>
internal sealed class TransactDiffEngine {
    private readonly TransactionEngine _txEngine;
    private readonly CommandEngine _cmd;

    private const float MoveMatchMaxDistance = 50f;     // beyond this, treat as remove+add rather than move
    private const float MoveExactEpsilonSq = 1e-6f;     // (distance < 0.001m)² → "unchanged"

    public TransactDiffEngine(TransactionEngine txEngine, CommandEngine cmd) {
        _txEngine = txEngine;
        _cmd = cmd;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Top-level entry.
    // ─────────────────────────────────────────────────────────────────────

    public TransactDiffResult Run(Guid txId, bool render, string renderMode,
            HashSet<ushort>? lbFilter, int resolution, string? outPath) {
        var lookup = _txEngine.Lookup(txId);
        if (lookup.Status == TransactSnapshotStatus.Rejected) {
            return Failure(txId, "TXDIFF-REJECTED",
                "Transaction was rejected before any op ran — no diff is retained for it.");
        }
        if (lookup.Status == TransactSnapshotStatus.RolledBack) {
            return Failure(txId, "TXDIFF-ROLLED-BACK",
                "Transaction was rolled back — no diff is retained for it.");
        }
        if (lookup.Status == TransactSnapshotStatus.Expired) {
            return Failure(txId, "TXDIFF-EXPIRED",
                "Transaction snapshot has expired from the retention LRU.");
        }
        var entry = lookup.Entry!;

        var touchedLbKeys = ExtractLandblockKeys(entry);
        bool terrainTouched = entry.PreState.ContainsKey("terrain")
            || entry.PostState.ContainsKey("terrain")
            || entry.DocumentsCreated.Contains("terrain");

        // Filter to caller's requested LBs if any.
        if (lbFilter != null && lbFilter.Count > 0) {
            touchedLbKeys.IntersectWith(lbFilter);
        }

        var perLb = new List<TransactDiffPerLandblock>();
        int objAdded = 0, objRemoved = 0, objMoved = 0;
        int strAdded = 0, strRemoved = 0;
        int valErr = 0, valWarn = 0, valInfo = 0;
        int spAdded = 0, spRemoved = 0;
        int poiAdded = 0, poiRemoved = 0;
        bool biomeShift = false, roadShift = false, cliffShift = false;

        // Walk the touched LBs and compute structured diffs. Validation and
        // describer state both depend on swapping live docs to pre-state and
        // back, so we batch the swap by LB to minimise overhead — one swap
        // per LB covers both pre-validation and pre-describe.
        foreach (var lbKey in touchedLbKeys.OrderBy(k => k)) {
            var per = BuildPerLandblockDiff(lbKey, entry);
            if (per == null) continue;
            perLb.Add(per);

            objAdded += per.Objects.Added.Count;
            objRemoved += per.Objects.Removed.Count;
            objMoved += per.Moves.Moved.Count;
            strAdded += per.Structures.Added.Count;
            strRemoved += per.Structures.Removed.Count;
            valErr  += CountSeverity(per.Validation.Added, "error")  - CountSeverity(per.Validation.Removed, "error");
            valWarn += CountSeverity(per.Validation.Added, "warning") - CountSeverity(per.Validation.Removed, "warning");
            valInfo += CountSeverity(per.Validation.Added, "info")    - CountSeverity(per.Validation.Removed, "info");
            spAdded += per.Spawns.Added.Count; spRemoved += per.Spawns.Removed.Count;
            poiAdded += per.Pois.Added.Count;  poiRemoved += per.Pois.Removed.Count;

            if (!Equals(per.Categorical.BiomeBefore, per.Categorical.BiomeAfter)) biomeShift = true;
            if (per.Categorical.RoadBefore != per.Categorical.RoadAfter) roadShift = true;
            if (per.Categorical.CliffsBefore != per.Categorical.CliffsAfter) cliffShift = true;
        }

        // Terrain-only fallback. If the batch only touched the terrain doc
        // (no specific landblocks), enumerating per-LB across all 256² LBs
        // is too noisy — the spec calls for a histogram-style summary
        // covering biome distribution and per-vertex change counts.
        TransactDiffTerrainSummary? terrainSummary = null;
        if (terrainTouched && touchedLbKeys.Count == 0) {
            terrainSummary = BuildTerrainOnlySummary(entry);
        }

        var summary = new TransactDiffSummary(
            DocumentsTouched: entry.PreState.Count + entry.DocumentsCreated.Count,
            ObjectsAdded: objAdded, ObjectsRemoved: objRemoved, ObjectsMoved: objMoved,
            StructuresAdded: strAdded, StructuresRemoved: strRemoved,
            ValidationErrorsDelta: valErr, ValidationWarningsDelta: valWarn, ValidationInfoDelta: valInfo,
            SpawnsAdded: spAdded, SpawnsRemoved: spRemoved,
            PoisAdded: poiAdded, PoisRemoved: poiRemoved,
            BiomeShift: biomeShift, RoadShift: roadShift, CliffShift: cliffShift);

        TransactDiffVisual? visual = null;
        if (render) {
            visual = RenderVisual(entry, perLb, renderMode, resolution, terrainTouched, touchedLbKeys, outPath);
        }

        return new TransactDiffResult(
            Success: true,
            TxId: txId,
            ErrorCode: null,
            Error: null,
            Summary: summary,
            PerLandblock: perLb,
            TerrainSummary: terrainSummary,
            Visual: visual);
    }

    private static TransactDiffResult Failure(Guid txId, string errorCode, string error) =>
        new(Success: false, TxId: txId, ErrorCode: errorCode, Error: error,
            Summary: null, PerLandblock: null, TerrainSummary: null, Visual: null);

    // ─────────────────────────────────────────────────────────────────────
    //  Per-landblock diff.
    //
    //  We hydrate ephemeral pre/post LandblockDocuments + TerrainDocument so
    //  the describer can run unchanged against snapshot bytes. Validation
    //  needs a different path because ValidationEngine reads from the live
    //  ActiveDocs; we cover it by swapping the live doc's projection bytes
    //  to pre-state, validating, and restoring. The dispatch loop is single-
    //  threaded so the swap is safe against other dispatch reads — but the
    //  DocumentManager batch flusher runs on a background thread, so the
    //  swap+restore re-marks the doc dirty so that the next batch flush
    //  re-persists post-state and doesn't leave pre-bytes in storage.
    // ─────────────────────────────────────────────────────────────────────

    private TransactDiffPerLandblock? BuildPerLandblockDiff(ushort lbKey,
            TransactSnapshotEntry entry) {
        uint lbX = (uint)((lbKey >> 8) & 0xFF);
        uint lbY = (uint)(lbKey & 0xFF);
        string docId = $"landblock_{lbKey:X4}";
        bool createdByBatch = entry.DocumentsCreated.Contains(docId);

        entry.PreState.TryGetValue(docId, out var preLbBytes);
        entry.PostState.TryGetValue(docId, out var postLbBytes);

        // LB doc unchanged but in-scope only via terrain or dungeon: fall back
        // to live LB so the describer reports the LB's actual current static
        // objects on both sides (yielding zero object/structure diff for the
        // LB) instead of an empty doc that would invent phantom "removed"
        // entries on the post side or vice versa.
        bool lbDocUntouched = preLbBytes == null && postLbBytes == null && !createdByBatch;
        var preLbDoc = lbDocUntouched
            ? CloneLiveLandblockDoc(docId, lbKey)
            : HydrateLandblockDoc(preLbBytes, lbKey);
        var postLbDoc = lbDocUntouched
            ? CloneLiveLandblockDoc(docId, lbKey)
            : HydrateLandblockDoc(postLbBytes, lbKey);

        // Terrain: pre-state from snapshot if terrain was touched, else live.
        TerrainDocument preTerrain = HydrateTerrainDoc(
            entry.PreState.TryGetValue("terrain", out var preT) ? preT : null);
        TerrainDocument postTerrain = HydrateTerrainDoc(
            entry.PostState.TryGetValue("terrain", out var postT) ? postT : null);

        // Dungeon: optional. The diff for dungeon docs is intentionally
        // shallow in v1 — we describe the LB body (which includes interior
        // cell counts) but don't enumerate cell-level changes.
        string dungeonDocId = $"dungeon_{lbKey:X4}";
        DungeonDocument? preDungeon = null, postDungeon = null;
        if (entry.PreState.TryGetValue(dungeonDocId, out var preDB))
            preDungeon = HydrateDungeonDoc(preDB, lbKey);
        if (entry.PostState.TryGetValue(dungeonDocId, out var postDB))
            postDungeon = HydrateDungeonDoc(postDB, lbKey);

        // Run the describer against pre and post. Validation skipped here —
        // we compute it via swap-and-restore below.
        LandblockDescriber.LandblockDescriptionResult? preDesc = null, postDesc = null;
        try {
            preDesc = _cmd.DescribeLandblockFromDocs(lbX, lbY, preLbDoc, preTerrain, preDungeon, includeValidation: false);
        } catch (Exception ex) {
            Console.Error.WriteLine($"[TransactDiff] Pre-describe failed for 0x{lbKey:X4}: {ex.Message}");
        }
        try {
            postDesc = _cmd.DescribeLandblockFromDocs(lbX, lbY, postLbDoc, postTerrain, postDungeon, includeValidation: false);
        } catch (Exception ex) {
            Console.Error.WriteLine($"[TransactDiff] Post-describe failed for 0x{lbKey:X4}: {ex.Message}");
        }

        var preObjects = preLbDoc.GetStaticObjects().ToList();
        var postObjects = postLbDoc.GetStaticObjects().ToList();
        var (added, removed, moved, _) = DiffObjects(preObjects, postObjects);

        // Structure diff: derive from describer's StructureBlock list. A structure
        // is a unit of agent-relevant identity — its key for matching is (model,
        // origin) rather than the heavy describer block.
        var preStructures = preDesc?.Body.Structures ?? new List<LandblockDescriber.StructureBlock>();
        var postStructures = postDesc?.Body.Structures ?? new List<LandblockDescriber.StructureBlock>();
        var (sAdded, sRemoved) = DiffStructures(preStructures, postStructures);

        // Validation diff: run ValidateAll once against pre-state via live-doc
        // swap, then again against post-state (which is the live state). The
        // swap is bracketed by try/finally so any exception still restores
        // the live doc to its post-state. We pass the snapshot entry so the
        // swap can also stash terrain pre-bytes when terrain was touched —
        // otherwise the pre-validation runs against pre-LB + post-terrain and
        // the diff invents bogus TRN-edge regressions on every terrain edit.
        var (valAdded, valCleared) = DiffValidation(lbKey, preLbBytes, postLbBytes, createdByBatch, entry);

        // Spawns/POIs in the describer body come from gazetteers and don't
        // change during a transact, so the diff is empty in v1. We still
        // emit the keys for shape compatibility with the spec.
        var spawnsDiff = new DiffSet<TransactDiffSpawn>(new(), new());
        var poisDiff = new DiffSet<TransactDiffPoi>(new(), new());

        // Terrain categorical: read from describer's TerrainBlock + ContextBlock.
        var categorical = new TransactDiffCategorical(
            BiomeBefore: preDesc?.Context.Biome,
            BiomeAfter: postDesc?.Context.Biome,
            RoadBefore: preDesc?.Context.HasRoad ?? false,
            RoadAfter: postDesc?.Context.HasRoad ?? false,
            CliffsBefore: (int)(preDesc?.Terrain.CliffCount ?? 0),
            CliffsAfter: (int)(postDesc?.Terrain.CliffCount ?? 0));

        return new TransactDiffPerLandblock(
            LbX: lbX, LbY: lbY, LbHex: $"0x{lbKey:X4}",
            Objects: new DiffSet<TransactDiffObject>(added, removed),
            Moves: new TransactDiffMoves(moved),
            Structures: new DiffSet<TransactDiffStructure>(sAdded, sRemoved),
            Validation: new DiffSet<TransactDiffValidationEntry>(valAdded, valCleared),
            Spawns: spawnsDiff,
            Pois: poisDiff,
            Categorical: categorical,
            CreatedByBatch: createdByBatch);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Object matching.
    //
    //  Pass 1: exact matches (same model id, same exact origin) — unchanged.
    //  Pass 2: greedy nearest-neighbour move detection within
    //          MoveMatchMaxDistance — same model id, closest unmatched post.
    //  Pass 3: leftovers → removed/added.
    //
    //  N is small (typical < 200 per LB) so O(N²) is fine and avoids the
    //  complexity of Hungarian matching for a v1 that has to ship.
    // ─────────────────────────────────────────────────────────────────────

    private (List<TransactDiffObject> Added, List<TransactDiffObject> Removed,
             List<TransactDiffMove> Moved, int Unchanged)
            DiffObjects(IList<StaticObject> pre, IList<StaticObject> post) {
        var preMatched = new bool[pre.Count];
        var postMatched = new bool[post.Count];
        int unchanged = 0;
        var moved = new List<TransactDiffMove>();

        // Pass 1: exact match.
        for (int i = 0; i < pre.Count; i++) {
            for (int j = 0; j < post.Count; j++) {
                if (postMatched[j]) continue;
                if (pre[i].Id != post[j].Id) continue;
                if (Vector3.DistanceSquared(pre[i].Origin, post[j].Origin) <= MoveExactEpsilonSq) {
                    preMatched[i] = true;
                    postMatched[j] = true;
                    unchanged++;
                    break;
                }
            }
        }

        // Pass 2: nearest-neighbour moves within max distance.
        for (int i = 0; i < pre.Count; i++) {
            if (preMatched[i]) continue;
            int bestJ = -1;
            float bestDsq = float.MaxValue;
            for (int j = 0; j < post.Count; j++) {
                if (postMatched[j]) continue;
                if (pre[i].Id != post[j].Id) continue;
                float d = Vector3.DistanceSquared(pre[i].Origin, post[j].Origin);
                if (d < bestDsq) { bestDsq = d; bestJ = j; }
            }
            if (bestJ >= 0 && bestDsq <= MoveMatchMaxDistance * MoveMatchMaxDistance) {
                preMatched[i] = true;
                postMatched[bestJ] = true;
                var from = pre[i].Origin;
                var to = post[bestJ].Origin;
                double deltaXY = Math.Sqrt((to.X - from.X) * (to.X - from.X) +
                                            (to.Y - from.Y) * (to.Y - from.Y));
                double deltaZ = Math.Abs(to.Z - from.Z);
                var ontology = _cmd.Ontology.GetEntry(pre[i].Id);
                moved.Add(new TransactDiffMove(
                    Wcid: ontology?.WeenieClassId,
                    Model: $"0x{pre[i].Id:X8}",
                    From: from, To: to,
                    DeltaXY: deltaXY, DeltaZ: deltaZ));
            }
        }

        var removed = new List<TransactDiffObject>();
        for (int i = 0; i < pre.Count; i++) {
            if (preMatched[i]) continue;
            removed.Add(BuildDiffObject(pre[i]));
        }
        var added = new List<TransactDiffObject>();
        for (int j = 0; j < post.Count; j++) {
            if (postMatched[j]) continue;
            added.Add(BuildDiffObject(post[j]));
        }
        return (added, removed, moved, unchanged);
    }

    private TransactDiffObject BuildDiffObject(StaticObject obj) {
        var entry = _cmd.Ontology.GetEntry(obj.Id);
        var tags = new List<string>(2);
        if (!string.IsNullOrEmpty(entry?.Category)) tags.Add(entry!.Category!);
        if (!string.IsNullOrEmpty(entry?.Architecture)) tags.Add(entry!.Architecture!);
        return new TransactDiffObject(
            Wcid: entry?.WeenieClassId,
            Model: $"0x{obj.Id:X8}",
            Position: obj.Origin,
            Ontology: tags.ToArray());
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Structure matching: by (model, origin within 1m).
    // ─────────────────────────────────────────────────────────────────────

    private static (List<TransactDiffStructure> Added, List<TransactDiffStructure> Removed)
            DiffStructures(List<LandblockDescriber.StructureBlock> pre,
                           List<LandblockDescriber.StructureBlock> post) {
        var preMatched = new bool[pre.Count];
        var postMatched = new bool[post.Count];
        for (int i = 0; i < pre.Count; i++) {
            // Don't match two structures with no model id at all — Ordinal
            // equality of two nulls would happily collapse unrelated structures
            // together. A structure without a model is unmatchable identity.
            if (string.IsNullOrEmpty(pre[i].ModelId)) continue;
            for (int j = 0; j < post.Count; j++) {
                if (postMatched[j]) continue;
                if (string.IsNullOrEmpty(post[j].ModelId)) continue;
                if (!string.Equals(pre[i].ModelId, post[j].ModelId, StringComparison.Ordinal)) continue;
                if (Vector3.DistanceSquared(pre[i].Origin, post[j].Origin) <= 1f) {
                    preMatched[i] = true;
                    postMatched[j] = true;
                    break;
                }
            }
        }
        var added = new List<TransactDiffStructure>();
        var removed = new List<TransactDiffStructure>();
        for (int i = 0; i < pre.Count; i++) {
            if (preMatched[i]) continue;
            removed.Add(new TransactDiffStructure(pre[i].ModelId, pre[i].Origin,
                pre[i].Architecture, pre[i].FootprintShape));
        }
        for (int j = 0; j < post.Count; j++) {
            if (postMatched[j]) continue;
            added.Add(new TransactDiffStructure(post[j].ModelId, post[j].Origin,
                post[j].Architecture, post[j].FootprintShape));
        }
        return (added, removed);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Validation diff via live-doc swap.
    //
    //  We compute pre-state validation by temporarily loading the snapshot's
    //  pre-bytes into the LIVE landblock document, running ValidateAll, then
    //  restoring the post-bytes. This works because the dispatch loop is
    //  single-threaded (no concurrent reader will see the half-state) and
    //  the alternative — running a parallel ValidationEngine against
    //  ephemeral docs — would require duplicating the engine's wiring.
    //
    //  When the LB was created by the batch the pre-state has no LB doc, so
    //  pre-validation is empty by definition; everything in post is "added".
    // ─────────────────────────────────────────────────────────────────────

    private (List<TransactDiffValidationEntry> Added, List<TransactDiffValidationEntry> Cleared)
            DiffValidation(ushort lbKey, byte[]? preLbBytes, byte[]? postLbBytes,
                           bool createdByBatch, TransactSnapshotEntry entry) {
        uint lbX = (uint)((lbKey >> 8) & 0xFF);
        uint lbY = (uint)(lbKey & 0xFF);
        var added = new List<TransactDiffValidationEntry>();
        var cleared = new List<TransactDiffValidationEntry>();

        bool terrainPreAvailable = entry.PreState.ContainsKey("terrain");
        // If neither the LB doc nor terrain changed, pre and post validation
        // would produce the same diagnostics by definition — skip the swap and
        // the post run entirely. (LB might be in scope only via dungeon doc.)
        if (!createdByBatch && preLbBytes == null && !terrainPreAvailable) {
            return (added, cleared);
        }

        ValidationReport? postReport = null;
        try { postReport = _cmd.ValidateAll(lbX, lbY); }
        catch (Exception ex) {
            Console.Error.WriteLine($"[TransactDiff] Post-validate failed for 0x{lbKey:X4}: {ex.Message}");
        }

        ValidationReport? preReport = null;
        if (createdByBatch) {
            // LB didn't exist before the batch — pre-validation is empty by
            // definition, so every post diagnostic is "added".
        } else {
            byte[]? preTerrainBytes = terrainPreAvailable ? entry.PreState["terrain"] : null;
            preReport = ValidatePreStateViaSwap(lbKey, lbX, lbY, preLbBytes, preTerrainBytes);
        }

        var preDiags = preReport?.Diagnostics
            .Select(d => (Code: d.Code, Sev: d.Severity.ToString().ToLowerInvariant(),
                          Msg: d.Message, Ctx: d.Context))
            .ToHashSet() ?? new HashSet<(string, string, string, string?)>();
        var postDiags = postReport?.Diagnostics
            .Select(d => (Code: d.Code, Sev: d.Severity.ToString().ToLowerInvariant(),
                          Msg: d.Message, Ctx: d.Context))
            .ToHashSet() ?? new HashSet<(string, string, string, string?)>();

        foreach (var d in postDiags) {
            if (!preDiags.Contains(d))
                added.Add(new TransactDiffValidationEntry(d.Code, d.Sev, d.Msg, d.Ctx));
        }
        foreach (var d in preDiags) {
            if (!postDiags.Contains(d))
                cleared.Add(new TransactDiffValidationEntry(d.Code, d.Sev, d.Msg, d.Ctx));
        }
        return (added, cleared);
    }

    // Swap LB and (optionally) terrain to pre-state, run ValidateAll, restore.
    // preLbBytes==null is allowed — happens when the LB doc itself wasn't
    // touched but terrain was; only the terrain doc gets swapped in that case.
    private ValidationReport? ValidatePreStateViaSwap(ushort lbKey, uint lbX, uint lbY,
            byte[]? preLbBytes, byte[]? preTerrainBytes) {
        var dm = _cmd.ProjectManager.CurrentProject?.DocumentManager;
        if (dm == null) return null;
        string lbDocId = $"landblock_{lbKey:X4}";

        // Capture current live bytes ourselves rather than trusting the
        // snapshot's PostState[id] — if any later operation mutated the live
        // doc since commit we want to restore to *current* live, not the
        // historical post-snapshot.
        BaseDocument? liveLb = null;
        byte[]? currentLiveLb = null;
        if (preLbBytes != null && dm.ActiveDocs.TryGetValue(lbDocId, out var lbDoc)) {
            liveLb = lbDoc;
            currentLiveLb = lbDoc.SaveToProjection();
        }

        BaseDocument? liveTerrain = null;
        byte[]? currentLiveTerrain = null;
        if (preTerrainBytes != null && dm.ActiveDocs.TryGetValue("terrain", out var terrainDoc)) {
            liveTerrain = terrainDoc;
            currentLiveTerrain = terrainDoc.SaveToProjection();
        }

        // Bail if we can't actually do the swap — ValidateAll would report
        // post-state, which is misleading as a "pre" report.
        if (liveLb == null && liveTerrain == null) return null;

        try {
            if (liveLb != null) liveLb.LoadFromProjection(preLbBytes!);
            if (liveTerrain != null) liveTerrain.LoadFromProjection(preTerrainBytes!);
            return _cmd.ValidateAll(lbX, lbY);
        } catch (Exception ex) {
            Console.Error.WriteLine($"[TransactDiff] Pre-validate swap failed for 0x{lbKey:X4}: {ex.Message}");
            return null;
        } finally {
            // Always restore — even if validation threw mid-swap. ForceSave
            // re-queues the doc with post-state on the DocumentManager batch
            // channel, so a flusher that picked up an in-flight pre-state
            // write is overwritten by the canonical post-state on the next
            // 2-second batch.
            if (liveLb != null && currentLiveLb != null) {
                try { liveLb.LoadFromProjection(currentLiveLb); } catch { }
                try { liveLb.ForceSave(); } catch { }
            }
            if (liveTerrain != null && currentLiveTerrain != null) {
                try { liveTerrain.LoadFromProjection(currentLiveTerrain); } catch { }
                try { liveTerrain.ForceSave(); } catch { }
            }
        }
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Terrain-only summary. Triggered when the batch touched only the
    //  terrain doc (no specific landblock_X), where a per-LB enumeration
    //  would span all 256² LBs.
    // ─────────────────────────────────────────────────────────────────────

    private TransactDiffTerrainSummary? BuildTerrainOnlySummary(TransactSnapshotEntry entry) {
        if (!entry.PreState.TryGetValue("terrain", out var preBytes)) return null;
        if (!entry.PostState.TryGetValue("terrain", out var postBytes)) return null;
        var pre = HydrateTerrainDoc(preBytes);
        var post = HydrateTerrainDoc(postBytes);

        var biomeBefore = new Dictionary<int, int>();
        var biomeAfter = new Dictionary<int, int>();
        int hChanged = 0, tChanged = 0, rChanged = 0;
        for (uint x = 0; x < 256; x++) {
            for (uint y = 0; y < 256; y++) {
                ushort key = (ushort)((x << 8) | y);
                var preLb = pre.GetLandblockInternal(key);
                var postLb = post.GetLandblockInternal(key);
                if (preLb == null && postLb == null) continue;
                int n = (preLb?.Length ?? 0);
                if ((postLb?.Length ?? 0) > n) n = postLb!.Length;
                for (int i = 0; i < n; i++) {
                    var pe = preLb != null && i < preLb.Length ? preLb[i] : default;
                    var po = postLb != null && i < postLb.Length ? postLb[i] : default;
                    biomeBefore.TryGetValue(pe.Type, out var bc); biomeBefore[pe.Type] = bc + 1;
                    biomeAfter.TryGetValue(po.Type, out var ac); biomeAfter[po.Type] = ac + 1;
                    if (pe.Height != po.Height) hChanged++;
                    if (pe.Type != po.Type) tChanged++;
                    if (pe.Road != po.Road) rChanged++;
                }
            }
        }
        return new TransactDiffTerrainSummary(biomeBefore, biomeAfter, hChanged, tChanged, rChanged);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Visual diff. Renders the after-state (or before+after for side-by-
    //  side) using RenderPreviewRenderer fed from projection-hydrated docs,
    //  then composites a diff overlay using the shape/sizing helpers
    //  RenderPreviewRenderer exposes for reuse.
    // ─────────────────────────────────────────────────────────────────────

    private TransactDiffVisual? RenderVisual(TransactSnapshotEntry entry,
            List<TransactDiffPerLandblock> perLb, string mode, int resolution,
            bool terrainTouched, HashSet<ushort> touchedLbKeys, string? outPath) {
        // Terrain-only batch with no caller-specified lbs → no visual to draw.
        if (terrainTouched && touchedLbKeys.Count == 0) {
            return new TransactDiffVisual(
                Mode: mode, PngBytes: null, Width: 0, Height: 0,
                Note: "terrain-only batch — no landblocks specified; visual diff omitted",
                OutPath: null);
        }
        if (perLb.Count == 0) {
            return new TransactDiffVisual(
                Mode: mode, PngBytes: null, Width: 0, Height: 0,
                Note: "nothing to render — no landblocks were touched in scope",
                OutPath: null);
        }

        // Bounding box → center + radius.
        int minX = perLb.Min(p => (int)p.LbX);
        int maxX = perLb.Max(p => (int)p.LbX);
        int minY = perLb.Min(p => (int)p.LbY);
        int maxY = perLb.Max(p => (int)p.LbY);
        uint centerLbX = (uint)((minX + maxX) / 2);
        uint centerLbY = (uint)((minY + maxY) / 2);
        int radius = Math.Max(1, Math.Max(maxX - (int)centerLbX, maxY - (int)centerLbY) + 1);
        radius = Math.Min(16, radius);
        int gridSize = 2 * radius + 1;
        int lbPx = Math.Max(8, resolution / gridSize);
        int finalRes = lbPx * gridSize;

        bool sideBySide = string.Equals(mode, "side-by-side", StringComparison.OrdinalIgnoreCase);

        // Build pre and post renderer inputs from snapshot bytes (with live
        // fallback for untouched LBs in scope).
        byte[]? PostFor(string id) => entry.PostState.TryGetValue(id, out var b) ? b : null;
        byte[]? PreFor(string id) => entry.PreState.TryGetValue(id, out var b) ? b : null;

        var preInput = BuildRendererInput(centerLbX, centerLbY, radius, gridSize, lbPx, finalRes,
            useLiveFallback: true, lbBytesFor: PreFor, terrainBytes: PreFor("terrain"));
        var postInput = BuildRendererInput(centerLbX, centerLbY, radius, gridSize, lbPx, finalRes,
            useLiveFallback: true, lbBytesFor: PostFor, terrainBytes: PostFor("terrain"));

        var afterOut = RenderPreviewRenderer.Render(postInput);
        byte[]? beforeBytes = sideBySide ? RenderPreviewRenderer.Render(preInput).PngBytes : null;

        // Composite the diff overlay onto the after image.
        var afterWithOverlay = ComposeOverlay(afterOut.PngBytes, postInput, perLb);

        byte[] finalPng;
        int outW, outH;
        if (sideBySide && beforeBytes != null) {
            (finalPng, outW, outH) = ComposeSideBySide(beforeBytes, afterWithOverlay, finalRes);
        } else {
            finalPng = afterWithOverlay;
            outW = finalRes;
            outH = finalRes;
        }

        if (!string.IsNullOrEmpty(outPath)) {
            try {
                var dir = Path.GetDirectoryName(outPath);
                if (!string.IsNullOrEmpty(dir) && !Directory.Exists(dir)) Directory.CreateDirectory(dir);
                File.WriteAllBytes(outPath, finalPng);
            } catch (Exception ex) {
                Console.Error.WriteLine($"[TransactDiff] Could not write visual to {outPath}: {ex.Message}");
                outPath = null;
            }
        }

        return new TransactDiffVisual(
            Mode: mode, PngBytes: finalPng, Width: outW, Height: outH,
            Note: null, OutPath: outPath);
    }

    private RenderPreviewRenderer.Input BuildRendererInput(
            uint centerLbX, uint centerLbY, int radius, int gridSize, int lbPx, int finalRes,
            bool useLiveFallback, Func<string, byte[]?> lbBytesFor, byte[]? terrainBytes) {
        var ht = _cmd.GetHeightTableForDiff();

        // Snapshot's terrain doc covers the whole world; either side may not
        // have one if the batch didn't touch terrain — fall back to live.
        TerrainDocument? terrainOverride = terrainBytes != null ? HydrateTerrainDoc(terrainBytes) : null;
        var liveDm = _cmd.ProjectManager.CurrentProject?.DocumentManager;
        var liveTerrain = liveDm != null && liveDm.ActiveDocs.TryGetValue("terrain", out var lt)
            ? lt as TerrainDocument
            : null;

        var terrainByCell = new Dictionary<(int col, int row), TerrainEntry[]?>();
        var objectsByCell = new Dictionary<(int col, int row), List<StaticObject>>();
        for (int row = 0; row < gridSize; row++) {
            for (int col = 0; col < gridSize; col++) {
                long absX = (long)centerLbX - radius + col;
                long absY = (long)centerLbY - radius + row;
                if (absX < 0 || absX > 255 || absY < 0 || absY > 255) {
                    terrainByCell[(col, row)] = null;
                    objectsByCell[(col, row)] = new List<StaticObject>();
                    continue;
                }
                ushort lbKey = (ushort)((absX << 8) | absY);
                string lbDocId = $"landblock_{lbKey:X4}";

                TerrainEntry[]? terrainData = terrainOverride?.GetLandblockInternal(lbKey)
                    ?? (useLiveFallback ? liveTerrain?.GetLandblockInternal(lbKey) : null);
                terrainByCell[(col, row)] = terrainData;

                List<StaticObject> objs;
                var lbBytes = lbBytesFor(lbDocId);
                if (lbBytes != null) {
                    objs = HydrateLandblockDoc(lbBytes, lbKey).GetStaticObjects().ToList();
                } else if (useLiveFallback && liveDm != null
                        && liveDm.ActiveDocs.TryGetValue(lbDocId, out var liveLb)
                        && liveLb is LandblockDocument liveLbDoc) {
                    objs = liveLbDoc.GetStaticObjects().ToList();
                } else {
                    objs = new List<StaticObject>();
                }
                objectsByCell[(col, row)] = objs;
            }
        }

        return new RenderPreviewRenderer.Input {
            CenterLbX = centerLbX,
            CenterLbY = centerLbY,
            Radius = radius,
            GridSize = gridSize,
            LbPx = lbPx,
            FinalRes = finalRes,
            Overlay = false,
            Terrain = terrainByCell,
            Objects = objectsByCell,
            HeightTable = ht,
            Ontology = id => _cmd.Ontology.GetEntry(id),
            PairingsGroupKey = _cmd.PairingsGroupKey,
            CliffThreshold = ValidationEngine.DefaultCliffThreshold,
        };
    }

    // Diff overlay palette. Spec-defined; intentionally NOT in the renderer
    // palette since these are diff signals layered on top of a normal map.
    private static readonly SKColor RemovedColor = new(0xE0, 0x35, 0x35, 0xE0);  // red
    private static readonly SKColor AddedColor   = new(0x35, 0xC8, 0x4F, 0xE0);  // green
    private static readonly SKColor MovedColor   = new(0xE6, 0xC8, 0x35, 0xE0);  // yellow
    private static readonly SKColor ValRegress   = new(0x6E, 0xC8, 0xE6, 0xE0);  // cyan
    private static readonly SKColor ValCleared   = new(0xC8, 0x4F, 0xC8, 0xE0);  // magenta

    private byte[] ComposeOverlay(byte[] basePng, RenderPreviewRenderer.Input input,
            List<TransactDiffPerLandblock> perLb) {
        using var baseBitmap = SKBitmap.Decode(basePng);
        using var canvas = new SKCanvas(baseBitmap);

        int W = input.FinalRes;
        int H = input.FinalRes;
        float worldOriginX = (float)((long)input.CenterLbX - input.Radius) * 192f;
        float worldOriginY = (float)((long)input.CenterLbY - input.Radius) * 192f;
        float worldSpanX = input.GridSize * 192f;
        float worldSpanY = input.GridSize * 192f;

        SKPoint WorldToPixel(Vector3 origin) {
            float wx = origin.X - worldOriginX;
            float wy = origin.Y - worldOriginY;
            return new SKPoint(wx / worldSpanX * W, (1f - wy / worldSpanY) * H);
        }

        // LB outlines for validation regression / cleared.
        using var regressStroke = new SKPaint {
            Color = ValRegress, IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = Math.Max(2f, input.LbPx / 60f),
        };
        using var clearedStroke = new SKPaint {
            Color = ValCleared, IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = Math.Max(2f, input.LbPx / 60f),
        };

        // Move-arrow stroke.
        using var moveArrow = new SKPaint {
            Color = MovedColor, IsAntialias = true, Style = SKPaintStyle.Stroke,
            StrokeWidth = Math.Max(1.2f, input.LbPx / 110f),
            StrokeCap = SKStrokeCap.Round,
        };

        foreach (var lb in perLb) {
            // LB-cell outline if validation regressed or cleared.
            int cliffsAddedToLb = lb.Validation.Added.Count;
            int cliffsClearedFromLb = lb.Validation.Removed.Count;
            if (cliffsAddedToLb > 0 || cliffsClearedFromLb > 0) {
                int col = (int)((long)lb.LbX - ((long)input.CenterLbX - input.Radius));
                int row = (int)((long)lb.LbY - ((long)input.CenterLbY - input.Radius));
                if (col >= 0 && row >= 0 && col < input.GridSize && row < input.GridSize) {
                    float x0 = col * input.LbPx;
                    float y0 = (input.GridSize - 1 - row) * input.LbPx;
                    var rect = new SKRect(x0, y0, x0 + input.LbPx, y0 + input.LbPx);
                    if (cliffsAddedToLb > 0) canvas.DrawRect(rect, regressStroke);
                    if (cliffsClearedFromLb > 0) canvas.DrawRect(rect, clearedStroke);
                }
            }

            foreach (var rem in lb.Objects.Removed) {
                var entry = LookupOntologyByModel(rem.Model);
                var shape = RenderPreviewRenderer.ResolveShapeForObject(entry);
                float size = RenderPreviewRenderer.ResolveSizePxForObject(entry, input.LbPx);
                var p = WorldToPixel(rem.Position);
                RenderPreviewRenderer.DrawObjectGlyphInColor(canvas, p.X, p.Y, size, shape, RemovedColor);
            }
            foreach (var add in lb.Objects.Added) {
                var entry = LookupOntologyByModel(add.Model);
                var shape = RenderPreviewRenderer.ResolveShapeForObject(entry);
                float size = RenderPreviewRenderer.ResolveSizePxForObject(entry, input.LbPx);
                var p = WorldToPixel(add.Position);
                RenderPreviewRenderer.DrawObjectGlyphInColor(canvas, p.X, p.Y, size, shape, AddedColor);
            }
            foreach (var mv in lb.Moves.Moved) {
                if (mv.DeltaXY < 0.1) continue;     // hide inert moves per spec
                var entry = LookupOntologyByModel(mv.Model);
                var shape = RenderPreviewRenderer.ResolveShapeForObject(entry);
                float size = RenderPreviewRenderer.ResolveSizePxForObject(entry, input.LbPx);
                var pFrom = WorldToPixel(mv.From);
                var pTo = WorldToPixel(mv.To);
                canvas.DrawLine(pFrom, pTo, moveArrow);
                RenderPreviewRenderer.DrawObjectGlyphInColor(canvas, pTo.X, pTo.Y, size, shape, MovedColor);
            }
        }

        using var img = SKImage.FromBitmap(baseBitmap);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        return data.ToArray();
    }

    private OntologyEntry? LookupOntologyByModel(string modelHex) {
        if (string.IsNullOrEmpty(modelHex)) return null;
        var s = modelHex.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? modelHex[2..] : modelHex;
        if (!uint.TryParse(s, System.Globalization.NumberStyles.HexNumber,
                System.Globalization.CultureInfo.InvariantCulture, out var id)) return null;
        return _cmd.Ontology.GetEntry(id);
    }

    private static (byte[] Png, int W, int H) ComposeSideBySide(byte[] beforePng, byte[] afterPng, int side) {
        using var beforeBmp = SKBitmap.Decode(beforePng);
        using var afterBmp = SKBitmap.Decode(afterPng);
        int gap = 4;
        int w = beforeBmp.Width + afterBmp.Width + gap;
        int h = Math.Max(beforeBmp.Height, afterBmp.Height);
        var info = new SKImageInfo(w, h, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var bitmap = new SKBitmap(info);
        using var canvas = new SKCanvas(bitmap);
        canvas.Clear(new SKColor(0x12, 0x12, 0x14));
        canvas.DrawBitmap(beforeBmp, 0, 0);
        canvas.DrawBitmap(afterBmp, beforeBmp.Width + gap, 0);
        using var sepPaint = new SKPaint {
            Color = new SKColor(0xE0, 0xE0, 0xE0, 0xC0),
            Style = SKPaintStyle.Fill,
        };
        canvas.DrawRect(beforeBmp.Width, 0, gap, h, sepPaint);
        using var img = SKImage.FromBitmap(bitmap);
        using var data = img.Encode(SKEncodedImageFormat.Png, 100);
        return (data.ToArray(), w, h);
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Hydration helpers — instantiate a doc from projection bytes. Uses
    //  NullLogger so no log noise leaks from the diff path.
    // ─────────────────────────────────────────────────────────────────────

    private static LandblockDocument HydrateLandblockDoc(byte[]? bytes, ushort lbKey) {
        var doc = new LandblockDocument(NullLogger.Instance) { Id = $"landblock_{lbKey:X4}" };
        if (bytes != null) doc.LoadFromProjection(bytes);
        return doc;
    }

    // Copy the live LB doc's bytes into an ephemeral clone so the describer
    // sees the actual current static-objects state for an LB that's in scope
    // only via terrain or dungeon (no LB-level snapshot bytes exist).
    private LandblockDocument CloneLiveLandblockDoc(string docId, ushort lbKey) {
        var liveDm = _cmd.ProjectManager.CurrentProject?.DocumentManager;
        if (liveDm != null && liveDm.ActiveDocs.TryGetValue(docId, out var live)
                && live is LandblockDocument liveLb) {
            return HydrateLandblockDoc(liveLb.SaveToProjection(), lbKey);
        }
        return HydrateLandblockDoc(null, lbKey);
    }

    private TerrainDocument HydrateTerrainDoc(byte[]? bytes) {
        // Fall back to the live terrain doc when the snapshot didn't touch it
        // — we still need a real document so the describer can read heights.
        if (bytes == null) {
            var liveDm = _cmd.ProjectManager.CurrentProject?.DocumentManager;
            if (liveDm != null && liveDm.ActiveDocs.TryGetValue("terrain", out var live)
                    && live is TerrainDocument liveT) {
                var copy = new TerrainDocument(NullLogger.Instance) { Id = "terrain" };
                copy.LoadFromProjection(liveT.SaveToProjection());
                return copy;
            }
            // Should not happen — a project with no terrain can't be described.
            return new TerrainDocument(NullLogger.Instance) { Id = "terrain" };
        }
        var doc = new TerrainDocument(NullLogger.Instance) { Id = "terrain" };
        doc.LoadFromProjection(bytes);
        return doc;
    }

    private static DungeonDocument HydrateDungeonDoc(byte[] bytes, ushort lbKey) {
        var doc = new DungeonDocument(NullLogger.Instance) { Id = $"dungeon_{lbKey:X4}" };
        doc.LoadFromProjection(bytes);
        return doc;
    }

    // ─────────────────────────────────────────────────────────────────────
    //  Misc helpers.
    // ─────────────────────────────────────────────────────────────────────

    private static HashSet<ushort> ExtractLandblockKeys(TransactSnapshotEntry entry) {
        var result = new HashSet<ushort>();
        foreach (var id in entry.PreState.Keys.Concat(entry.PostState.Keys).Concat(entry.DocumentsCreated)) {
            if (TryParseLbKeyFromDocId(id, out var key)) result.Add(key);
        }
        return result;
    }

    private static bool TryParseLbKeyFromDocId(string docId, out ushort lbKey) {
        lbKey = 0;
        if (docId.StartsWith("landblock_", StringComparison.Ordinal)) {
            return ushort.TryParse(docId.AsSpan("landblock_".Length),
                System.Globalization.NumberStyles.HexNumber,
                System.Globalization.CultureInfo.InvariantCulture, out lbKey);
        }
        if (docId.StartsWith("dungeon_", StringComparison.Ordinal)) {
            return ushort.TryParse(docId.AsSpan("dungeon_".Length),
                System.Globalization.NumberStyles.HexNumber,
                System.Globalization.CultureInfo.InvariantCulture, out lbKey);
        }
        return false;
    }

    private static int CountSeverity(IEnumerable<TransactDiffValidationEntry> entries, string severity) =>
        entries.Count(e => string.Equals(e.Severity, severity, StringComparison.OrdinalIgnoreCase));
}
