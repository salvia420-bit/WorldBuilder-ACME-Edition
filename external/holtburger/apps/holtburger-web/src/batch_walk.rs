//! A0 hardening (`?interiorStabBatch`, 2026-10-09) — the batch-mode
//! discovery loop, target-agnostic so its round logic is unit-tested natively.
//!
//! `prefetch::run_walk_loop` (the loop every keyed walk uses) STOPS discovering
//! once a round still has failed keys after its 3 tries: it `break`s and
//! returns `Ok(())`. For a per-record walk that is the right failure mode, but
//! the interior stab batch walks ~170 Setups at once — one persistently failing
//! record anywhere in the landblock (a catalog-backed 404, a hash mismatch)
//! stopped discovery for ALL of them and silently dropped the whole build back
//! to the slow per-stab path (review-AB.md, "A0's batched walk is
//! best-effort").
//!
//! [`run_batch_walk`] is the same discovery/prefetch round structure with one
//! difference: after a round's last try, the keys that still failed are
//! EXCLUDED from every later round and discovery CONTINUES with whatever else
//! the walk can now reach. The terminators are unchanged in kind:
//!
//! * a discovery round with nothing (non-excluded) missing → done;
//! * the stall guard — the same miss set twice in a row means the prefetch
//!   resolved nothing (keys absent from the manifest);
//! * a hard cap of [`BATCH_WALK_MAX_ROUNDS`] discovery rounds (the same 8 as
//!   `run_walk_loop`).
//!
//! It never fails: the caller gets [`BatchWalkStats`] (rounds, keys fetched,
//! keys failed, why it ended) and decides. The I/O is injected — `discover`
//! runs one synchronous walk and returns its misses, `prefetch` fetches one
//! round — so the wasm wrapper (`prefetch::ensure_walk_prefetched_keyed_batch`)
//! binds them to `RecordingSource` + `ManifestResourceSource::prefetch[_urgent]`
//! and the tests below bind them to an in-memory store.

use std::collections::HashSet;
use std::future::Future;

/// Owned `(namespace, file_id)` record key — the shape `RecordingSource`
/// reports misses in.
pub(crate) type OwnedKey = (String, u32);

/// Discovery-round cap, the same 8 as `prefetch::run_walk_loop`.
pub(crate) const BATCH_WALK_MAX_ROUNDS: u32 = 8;

/// Attempts per prefetch round (1 + 2 retries), the same 3 as
/// `prefetch::PREFETCH_ROUND_TRIES`.
pub(crate) const BATCH_WALK_ROUND_TRIES: u32 = 3;

/// Why a batch walk stopped.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum BatchWalkEnd {
    /// The last discovery round found nothing missing: every record the walk
    /// reads is resident.
    Complete,
    /// The only records still missing are ones that failed all their tries
    /// (excluded).
    OnlyFailedLeft,
    /// The stall guard: the same (non-excluded) miss set came back twice, i.e.
    /// the prefetch resolved nothing — records the manifest does not serve.
    Stalled,
    /// [`BATCH_WALK_MAX_ROUNDS`] discovery rounds were spent and records were
    /// still missing.
    RoundCap,
}

/// What one batch walk did. `Copy` + `Clone` so a `Shared` dedup future can
/// hand the same stats to every concurrent waiter.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct BatchWalkStats {
    /// Prefetch rounds issued (the initial-keys round included; retries of a
    /// round are not extra rounds). 0 = nothing was missing.
    pub rounds: u32,
    /// Keys those rounds requested that did not end failed (a key the catalog
    /// does not list resolves silently and is counted here too).
    pub fetched: u32,
    /// Distinct keys that failed all their tries and were excluded.
    pub failed: u32,
    /// Why the walk stopped.
    pub end: BatchWalkEnd,
}

impl BatchWalkStats {
    /// True when re-running the walk's reads now gives the same answer as any
    /// later re-run: nothing failed, and the walk stopped because nothing was
    /// missing or because what is missing is permanently absent. Only then may
    /// a caller memoise results derived from these records (the interior stab
    /// memo in `fetch_env_cells_in_landblock`).
    pub(crate) fn settled(&self) -> bool {
        self.failed == 0 && matches!(self.end, BatchWalkEnd::Complete | BatchWalkEnd::Stalled)
    }

    /// Combine the stats of concurrent sub-walks (`?interiorStabChunk`) into
    /// the one the build logs and gates its memo on: rounds / fetched / failed
    /// are SUMMED, and `end` is the worst sub-walk's (Complete < Stalled <
    /// OnlyFailedLeft < RoundCap), so the merged stats are `settled()` exactly
    /// when EVERY sub-walk is. No sub-walks = nothing was missing (Complete).
    pub(crate) fn merge_all(parts: &[BatchWalkStats]) -> BatchWalkStats {
        fn rank(end: BatchWalkEnd) -> u8 {
            match end {
                BatchWalkEnd::Complete => 0,
                BatchWalkEnd::Stalled => 1,
                BatchWalkEnd::OnlyFailedLeft => 2,
                BatchWalkEnd::RoundCap => 3,
            }
        }
        let mut out = BatchWalkStats {
            rounds: 0,
            fetched: 0,
            failed: 0,
            end: BatchWalkEnd::Complete,
        };
        for p in parts {
            out.rounds += p.rounds;
            out.fetched += p.fetched;
            out.failed += p.failed;
            if rank(p.end) > rank(out.end) {
                out.end = p.end;
            }
        }
        out
    }
}

// ---------------------------------------------------------------------------
// 2026-10-09 follow-up (Workstream B, the walk-window long tasks): sub-walks and
// discovery pacing. On the 1070 academy profile (acad-diagF) every main-thread
// long task of the walk window (50-72 ms) was a wasm future poll: one results
// message from the shard-fetch worker resolves many fetches, and every walk
// whose round just completed runs its next SYNCHRONOUS discovery round inside
// that same task (wasm-bindgen-futures drains its whole queue per microtask
// checkpoint) — the stab batch's discovery over all ~200 interior statics, the
// entity rigs' `triangulate_setup_model_per_part` walks, … back to back.
// ---------------------------------------------------------------------------

/// `?interiorStabChunk` default: at most this many stabs per sub-walk
/// (academy 0x8602: 200 stabs → 5 sub-walks of 40).
pub(crate) const INTERIOR_STAB_CHUNK_DEFAULT: usize = 40;
/// Bounds for an explicit `?interiorStabChunk=N`.
pub(crate) const INTERIOR_STAB_CHUNK_MIN: usize = 8;
pub(crate) const INTERIOR_STAB_CHUNK_MAX: usize = 4096;

/// Parse `?interiorStabChunk`. DEFAULT-ON: absent (or `on`, or garbage) →
/// `Some(INTERIOR_STAB_CHUNK_DEFAULT)`; `off|0|false|no` → `None` (ONE stab
/// walk — the pre-follow-up `?interiorStabBatch` behaviour, same key); a
/// positive integer N → `Some(N)` clamped to
/// [`INTERIOR_STAB_CHUNK_MIN`]..=[`INTERIOR_STAB_CHUNK_MAX`]. The first
/// occurrence wins (as `URLSearchParams.get`); case-insensitive.
pub(crate) fn parse_interior_stab_chunk_flag(search: &str) -> Option<usize> {
    let trimmed = search.strip_prefix('?').unwrap_or(search);
    let Some(v) = trimmed
        .split('&')
        .find_map(|kv| kv.strip_prefix("interiorStabChunk="))
    else {
        return Some(INTERIOR_STAB_CHUNK_DEFAULT);
    };
    let v = v.trim().to_ascii_lowercase();
    match v.as_str() {
        "off" | "0" | "false" | "no" => None,
        other => match other.parse::<usize>() {
            Ok(n) => Some(n.clamp(INTERIOR_STAB_CHUNK_MIN, INTERIOR_STAB_CHUNK_MAX)),
            Err(_) => Some(INTERIOR_STAB_CHUNK_DEFAULT),
        },
    }
}

/// Parse `?walkPace`. DEFAULT-ON; `off|0|false|no` disables (the same grammar
/// as `?interiorStabBatch`). ON: the legacy discovery loop
/// (`prefetch::run_walk_loop`) hands the event loop one turn before every
/// discovery round that follows a prefetch round — on the MAIN thread only,
/// never while the document is hidden.
pub(crate) fn parse_walk_pace_flag(search: &str) -> bool {
    let trimmed = search.strip_prefix('?').unwrap_or(search);
    !trimmed.split('&').any(|kv| {
        matches!(
            kv,
            "walkPace=off" | "walkPace=0" | "walkPace=false" | "walkPace=no"
        )
    })
}

/// Split the (sorted, deduplicated) stab ids into `ceil(len / max)` balanced
/// sub-walks of at most `max` ids each, in order (sizes differ by at most one,
/// larger first). Deterministic for the same ids, so two concurrent builds of
/// one landblock compute identical chunks and latch onto the same sub-walks.
pub(crate) fn chunk_ids(ids: &[u32], max: usize) -> Vec<Vec<u32>> {
    let max = max.max(1);
    if ids.is_empty() {
        return Vec::new();
    }
    let n = ids.len().div_ceil(max);
    let base = ids.len() / n;
    let extra = ids.len() % n;
    let mut out = Vec::with_capacity(n);
    let mut at = 0;
    for i in 0..n {
        let len = base + usize::from(i < extra);
        out.push(ids[at..at + len].to_vec());
        at += len;
    }
    out
}

/// One failed prefetch round. `failed: Some(keys)` = exactly these keys did
/// not land (the R-9 per-key tolerant round, `PrefetchError::PartialRound`);
/// `None` = the round failed as a whole (a catalog fetch/parse error, or a v1
/// source), so every key of the round counts as failed.
#[derive(Debug, Clone)]
pub(crate) struct RoundFailure {
    pub failed: Option<Vec<OwnedKey>>,
    pub detail: String,
}

/// Run the batch-mode discovery loop. See the module docs.
///
/// * `initial` — keys to prefetch before the first discovery round (may be
///   empty; the interior stab batch passes none, so the stab tops are simply
///   the first round's misses and get the same retry/exclusion treatment).
/// * `discover` — one synchronous walk; returns the keys it missed.
/// * `prefetch` — fetch one round of keys.
/// * `warn` — receives one line per failed attempt (the wasm side logs it).
///
/// Unpaced: [`run_batch_walk_paced`] with a pace that never waits — every
/// discovery round runs in the same task as the prefetch completion before it
/// (the `?interiorStabBatch` behaviour; `?interiorStabChunk=off` and the
/// per-stab fallback walks).
pub(crate) async fn run_batch_walk<D, P, Fut, W>(
    initial: Vec<OwnedKey>,
    discover: D,
    prefetch: P,
    warn: W,
) -> BatchWalkStats
where
    D: FnMut() -> Vec<OwnedKey>,
    P: FnMut(Vec<OwnedKey>) -> Fut,
    Fut: Future<Output = Result<(), RoundFailure>>,
    W: FnMut(String),
{
    run_batch_walk_paced(initial, discover, prefetch, || std::future::ready(()), warn).await
}

/// [`run_batch_walk`] with a `pace` hook, awaited before every discovery round
/// that FOLLOWS a prefetch round (never before the very first discovery, which
/// runs in the caller's own turn). The `?interiorStabChunk` sub-walks bind it
/// to one event-loop turn on the main thread, so a sub-walk's next synchronous
/// discovery runs in its own task instead of inside whatever task delivered
/// the round's last body (where every other walk woken by the same delivery
/// would run its discovery too). Round structure, retries, exclusion, stall
/// guard and cap are exactly [`run_batch_walk`]'s.
pub(crate) async fn run_batch_walk_paced<D, P, Fut, Y, YFut, W>(
    initial: Vec<OwnedKey>,
    mut discover: D,
    mut prefetch: P,
    mut pace: Y,
    mut warn: W,
) -> BatchWalkStats
where
    D: FnMut() -> Vec<OwnedKey>,
    P: FnMut(Vec<OwnedKey>) -> Fut,
    Fut: Future<Output = Result<(), RoundFailure>>,
    Y: FnMut() -> YFut,
    YFut: Future<Output = ()>,
    W: FnMut(String),
{
    let mut stats = BatchWalkStats {
        rounds: 0,
        fetched: 0,
        failed: 0,
        end: BatchWalkEnd::Complete,
    };
    let mut excluded: HashSet<OwnedKey> = HashSet::new();
    let mut pending: Option<Vec<OwnedKey>> = if initial.is_empty() {
        None
    } else {
        let mut keys = initial;
        keys.sort();
        keys.dedup();
        Some(keys)
    };
    let mut prev_misses: Vec<OwnedKey> = Vec::new();
    let mut discovery_rounds: u32 = 0;
    loop {
        let keys = match pending.take() {
            Some(keys) => keys,
            None => {
                // Pace only a discovery that follows a prefetch round (the
                // first discovery of a walk without initial keys does not).
                if stats.rounds > 0 {
                    pace().await;
                }
                let raw = discover();
                let raw_empty = raw.is_empty();
                let mut misses: Vec<OwnedKey> =
                    raw.into_iter().filter(|k| !excluded.contains(k)).collect();
                misses.sort();
                misses.dedup();
                if misses.is_empty() {
                    stats.end = if raw_empty {
                        BatchWalkEnd::Complete
                    } else {
                        BatchWalkEnd::OnlyFailedLeft
                    };
                    return stats;
                }
                if misses == prev_misses {
                    stats.end = BatchWalkEnd::Stalled;
                    return stats;
                }
                if discovery_rounds >= BATCH_WALK_MAX_ROUNDS {
                    stats.end = BatchWalkEnd::RoundCap;
                    return stats;
                }
                discovery_rounds += 1;
                prev_misses = misses.clone();
                misses
            }
        };
        stats.rounds += 1;
        let requested = keys.len() as u32;
        // Retry the round up to BATCH_WALK_ROUND_TRIES times. A retry asks
        // only for what did not land (a whole-round failure asks for all of it
        // again); the source's own step A skips anything already cached.
        let mut outstanding: Vec<OwnedKey> = keys;
        let mut last_failure: Option<Vec<OwnedKey>> = None;
        for attempt in 1..=BATCH_WALK_ROUND_TRIES {
            match prefetch(outstanding.clone()).await {
                Ok(()) => {
                    last_failure = None;
                    break;
                }
                Err(f) => {
                    let mut failed_keys = match f.failed {
                        Some(list) => list,
                        None => outstanding.clone(),
                    };
                    failed_keys.sort();
                    failed_keys.dedup();
                    if attempt < BATCH_WALK_ROUND_TRIES {
                        warn(format!(
                            "prefetch round failed (attempt {attempt}/{BATCH_WALK_ROUND_TRIES}, retrying {} key(s)): {}",
                            failed_keys.len(),
                            f.detail
                        ));
                    } else {
                        warn(format!(
                            "prefetch round failed after {BATCH_WALK_ROUND_TRIES} attempts: excluding {} key(s), discovery continues: {}",
                            failed_keys.len(),
                            f.detail
                        ));
                    }
                    outstanding = failed_keys.clone();
                    last_failure = Some(failed_keys);
                }
            }
        }
        match last_failure {
            None => stats.fetched += requested,
            Some(failed_keys) => {
                let failed_here = failed_keys.len() as u32;
                for k in failed_keys {
                    if excluded.insert(k) {
                        stats.failed += 1;
                    }
                }
                stats.fetched += requested.saturating_sub(failed_here);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    //! Self-contained: an in-memory "server" (every record the walk could ask
    //! for), an in-memory shard cache the walk reads through a real
    //! `RecordingSource`, and a prefetch that copies server → cache unless a
    //! key is scripted to fail. Records encode their children as LE u32 ids,
    //! so the walk is a plain graph traversal — the same shape as the
    //! Setup → GfxObj / MotionTable → Animation chain the stab batch walks.
    use super::*;
    use holtburger_dat::{DatError, FileMetadata, ResourceKey, ResourceSource, Result as DatResult};
    use holtburger_resource_http::RecordingSource;
    use std::collections::{HashMap, HashSet};
    use std::sync::Mutex;

    const NS: &str = "eor/portal";

    fn rec(children: &[u32]) -> Vec<u8> {
        children.iter().flat_map(|c| c.to_le_bytes()).collect()
    }

    /// The local shard cache the walk reads (what `ManifestResourceSource`
    /// serves after a prefetch).
    struct Cache {
        files: Mutex<HashMap<u32, Vec<u8>>>,
    }
    impl ResourceSource for Cache {
        fn get_file_by_key(&self, key: ResourceKey<'_>) -> DatResult<Vec<u8>> {
            self.files
                .lock()
                .unwrap()
                .get(&key.file_id)
                .cloned()
                .ok_or(DatError::NotFound(key.file_id))
        }
        fn get_metadata_by_key(&self, _key: ResourceKey<'_>) -> Option<FileMetadata> {
            None
        }
        fn has_namespace(&self, namespace: &str) -> bool {
            namespace == NS
        }
    }

    /// Depth-first walk from `roots`, reading every reachable record.
    fn walk(src: &dyn ResourceSource, roots: &[u32]) {
        let mut stack: Vec<u32> = roots.to_vec();
        let mut seen: HashSet<u32> = HashSet::new();
        while let Some(id) = stack.pop() {
            if !seen.insert(id) {
                continue;
            }
            if let Ok(bytes) = src.get_file_by_key(ResourceKey::new(NS, id)) {
                for c in bytes.chunks_exact(4) {
                    stack.push(u32::from_le_bytes([c[0], c[1], c[2], c[3]]));
                }
            }
        }
    }

    struct Rig {
        server: HashMap<u32, Vec<u8>>,
        cache: Cache,
        /// Keys that fail every attempt (`PartialRound`-style, per key).
        always_fail: HashSet<u32>,
        /// Fail the first N attempts of ANY round as a whole (`failed: None`).
        whole_round_failures: Mutex<u32>,
        /// Every key each prefetch attempt asked for, in order.
        attempts: Mutex<Vec<Vec<u32>>>,
    }

    impl Rig {
        fn new(graph: Vec<(u32, Vec<u32>)>) -> Self {
            Rig {
                server: graph.iter().map(|(id, ch)| (*id, rec(ch))).collect(),
                cache: Cache { files: Mutex::new(HashMap::new()) },
                always_fail: HashSet::new(),
                whole_round_failures: Mutex::new(0),
                attempts: Mutex::new(Vec::new()),
            }
        }

        async fn prefetch(&self, keys: Vec<OwnedKey>) -> Result<(), RoundFailure> {
            self.attempts
                .lock()
                .unwrap()
                .push(keys.iter().map(|(_, id)| *id).collect());
            {
                let mut whole = self.whole_round_failures.lock().unwrap();
                if *whole > 0 {
                    *whole -= 1;
                    return Err(RoundFailure { failed: None, detail: "catalog boom".into() });
                }
            }
            let mut failed = Vec::new();
            for (ns, id) in keys {
                if self.always_fail.contains(&id) {
                    failed.push((ns, id));
                    continue;
                }
                // Absent from the server = the catalog does not list it: the
                // round still succeeds, the key just never lands (the stall
                // guard's case).
                if let Some(bytes) = self.server.get(&id) {
                    self.cache.files.lock().unwrap().insert(id, bytes.clone());
                }
            }
            if failed.is_empty() {
                Ok(())
            } else {
                Err(RoundFailure { failed: Some(failed), detail: "shard 404".into() })
            }
        }

        async fn run(&self, roots: &[u32]) -> (BatchWalkStats, Vec<String>) {
            let mut warnings = Vec::new();
            let stats = run_batch_walk(
                Vec::new(),
                || {
                    let rs = RecordingSource::new(&self.cache);
                    walk(&rs, roots);
                    rs.take_misses()
                },
                |keys| self.prefetch(keys),
                |w| warnings.push(w),
            )
            .await;
            (stats, warnings)
        }

        fn cached(&self, id: u32) -> bool {
            self.cache.files.lock().unwrap().contains_key(&id)
        }

        fn attempts_for(&self, id: u32) -> usize {
            self.attempts.lock().unwrap().iter().filter(|a| a.contains(&id)).count()
        }
    }

    /// The load-bearing case: one record fails every try in round 1, and the
    /// walk STILL fetches everything reachable without it (the old loop broke
    /// out of discovery here, leaving B's child C — and every deeper record —
    /// unfetched).
    #[tokio::test]
    async fn failed_key_is_excluded_and_discovery_continues() {
        // Two Setups (1, 2). Setup 1's part 0x10 is the bad record; Setup 2's
        // part 0x20 leads to 0x21 (one more level, like MotionTable → Animation).
        let mut rig = Rig::new(vec![
            (1, vec![0x10]),
            (2, vec![0x20]),
            (0x10, vec![]),
            (0x20, vec![0x21]),
            (0x21, vec![]),
        ]);
        rig.always_fail.insert(0x10);
        let (stats, warnings) = rig.run(&[1, 2]).await;

        assert!(rig.cached(0x20) && rig.cached(0x21), "discovery continued past the failed round");
        assert!(!rig.cached(0x10));
        assert_eq!(rig.attempts_for(0x10), BATCH_WALK_ROUND_TRIES as usize, "3 tries, then excluded");
        assert_eq!(stats.failed, 1);
        assert_eq!(stats.end, BatchWalkEnd::OnlyFailedLeft);
        // Rounds: {1,2} → {0x10,0x20} (0x10 fails) → {0x21}; 0x10 never re-asked.
        assert_eq!(stats.rounds, 3);
        assert_eq!(stats.fetched, 2 + 1 + 1);
        assert!(!stats.settled(), "a failed key means results are not stable");
        assert_eq!(warnings.len(), BATCH_WALK_ROUND_TRIES as usize);
        assert!(warnings.last().unwrap().contains("discovery continues"));
    }

    /// Retries ask only for what did not land; a transient whole-round failure
    /// that clears on retry costs nothing and excludes nothing.
    #[tokio::test]
    async fn transient_whole_round_failure_is_retried_not_excluded() {
        let rig = Rig::new(vec![(1, vec![2]), (2, vec![])]);
        *rig.whole_round_failures.lock().unwrap() = 1;
        let (stats, warnings) = rig.run(&[1]).await;
        assert!(rig.cached(1) && rig.cached(2));
        assert_eq!(stats.failed, 0);
        assert_eq!(stats.end, BatchWalkEnd::Complete);
        assert_eq!(stats.rounds, 2);
        assert_eq!(stats.fetched, 2);
        assert!(stats.settled());
        assert_eq!(warnings.len(), 1);
    }

    /// A whole-round failure that never clears excludes every key of that
    /// round (it cannot say which ones failed) and still terminates.
    #[tokio::test]
    async fn persistent_whole_round_failure_excludes_the_round() {
        let rig = Rig::new(vec![(1, vec![2]), (2, vec![])]);
        *rig.whole_round_failures.lock().unwrap() = u32::MAX;
        let (stats, _) = rig.run(&[1]).await;
        assert_eq!(stats.rounds, 1);
        assert_eq!(stats.failed, 1);
        assert_eq!(stats.fetched, 0);
        assert_eq!(stats.end, BatchWalkEnd::OnlyFailedLeft);
    }

    /// The stall guard: a key the manifest does not serve resolves "Ok" but
    /// never lands; the identical miss set twice ends the walk.
    #[tokio::test]
    async fn absent_key_ends_on_the_stall_guard() {
        let rig = Rig::new(vec![(1, vec![2, 0x99]), (2, vec![])]); // 0x99 not on the server
        let (stats, _) = rig.run(&[1]).await;
        assert!(rig.cached(1) && rig.cached(2));
        assert_eq!(stats.end, BatchWalkEnd::Stalled);
        assert_eq!(stats.failed, 0);
        assert!(stats.settled(), "permanently absent is stable");
        // {1} → {2, 0x99} → {0x99} → stall on {0x99}.
        assert_eq!(stats.rounds, 3);
    }

    /// A chain deeper than the cap stops at BATCH_WALK_MAX_ROUNDS.
    #[tokio::test]
    async fn deep_chain_stops_at_the_round_cap() {
        let graph: Vec<(u32, Vec<u32>)> = (1..=20u32).map(|i| (i, vec![i + 1])).collect();
        let rig = Rig::new(graph);
        let (stats, _) = rig.run(&[1]).await;
        assert_eq!(stats.rounds, BATCH_WALK_MAX_ROUNDS);
        assert_eq!(stats.end, BatchWalkEnd::RoundCap);
        assert!(!stats.settled());
    }

    /// Initial keys are fetched first (one round), then discovery runs.
    #[tokio::test]
    async fn initial_keys_round_then_discovery() {
        let rig = Rig::new(vec![(1, vec![2]), (2, vec![])]);
        let stats = run_batch_walk(
            vec![(NS.to_string(), 1), (NS.to_string(), 1)],
            || {
                let rs = RecordingSource::new(&rig.cache);
                walk(&rs, &[1]);
                rs.take_misses()
            },
            |keys| rig.prefetch(keys),
            |_| {},
        )
        .await;
        assert_eq!(rig.attempts.lock().unwrap()[0], vec![1], "initial keys deduplicated");
        assert_eq!(stats.rounds, 2);
        assert_eq!(stats.end, BatchWalkEnd::Complete);
    }

    /// Nothing missing → no round at all.
    #[tokio::test]
    async fn all_resident_issues_no_round() {
        let rig = Rig::new(vec![(1, vec![])]);
        rig.cache.files.lock().unwrap().insert(1, rec(&[]));
        let (stats, _) = rig.run(&[1]).await;
        assert_eq!(stats.rounds, 0);
        assert_eq!(stats.end, BatchWalkEnd::Complete);
        assert!(rig.attempts.lock().unwrap().is_empty());
    }

    // ---- 2026-10-09 follow-up: pacing, sub-walks, flags ----------------------

    /// The pace hook runs before every discovery that follows a prefetch round
    /// and never before the first one; the walk itself is unchanged.
    #[tokio::test]
    async fn pace_runs_between_a_round_and_the_next_discovery() {
        let rig = Rig::new(vec![(1, vec![2]), (2, vec![3]), (3, vec![])]);
        let events: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
        let stats = run_batch_walk_paced(
            Vec::new(),
            || {
                events.lock().unwrap().push("discover");
                let rs = RecordingSource::new(&rig.cache);
                walk(&rs, &[1]);
                rs.take_misses()
            },
            |keys| {
                events.lock().unwrap().push("prefetch");
                rig.prefetch(keys)
            },
            || {
                events.lock().unwrap().push("pace");
                std::future::ready(())
            },
            |_| {},
        )
        .await;
        assert_eq!(stats.rounds, 3);
        assert_eq!(stats.end, BatchWalkEnd::Complete);
        assert_eq!(
            *events.lock().unwrap(),
            vec![
                "discover", "prefetch", "pace", "discover", "prefetch", "pace", "discover",
                "prefetch", "pace", "discover",
            ]
        );
    }

    /// With initial keys the first discovery already follows a round: paced.
    #[tokio::test]
    async fn pace_after_the_initial_round() {
        let rig = Rig::new(vec![(1, vec![])]);
        let paces = Mutex::new(0u32);
        let stats = run_batch_walk_paced(
            vec![(NS.to_string(), 1)],
            || {
                let rs = RecordingSource::new(&rig.cache);
                walk(&rs, &[1]);
                rs.take_misses()
            },
            |keys| rig.prefetch(keys),
            || {
                *paces.lock().unwrap() += 1;
                std::future::ready(())
            },
            |_| {},
        )
        .await;
        assert_eq!(stats.rounds, 1);
        assert_eq!(*paces.lock().unwrap(), 1);
    }

    /// Concurrent sub-walks over a split root set fetch exactly what the one
    /// walk fetches, and their merged stats settle exactly when every one does.
    #[tokio::test]
    async fn sub_walks_cover_the_single_walk_and_merge() {
        let graph = vec![
            (1, vec![0x10, 0x11]),
            (2, vec![0x11, 0x20]), // 0x11 shared across sub-walks
            (3, vec![0x30]),
            (4, vec![]),
            (0x10, vec![0x100]),
            (0x11, vec![]),
            (0x20, vec![]),
            (0x30, vec![0x300]),
            (0x100, vec![]),
            (0x300, vec![]),
        ];
        let single = Rig::new(graph.clone());
        let (one, _) = single.run(&[1, 2, 3, 4]).await;
        assert!(one.settled());

        let split = Rig::new(graph);
        let roots = [1u32, 2, 3, 4];
        let chunks = chunk_ids(&roots, 2);
        assert_eq!(chunks, vec![vec![1, 2], vec![3, 4]]);
        let walks = chunks.iter().map(|c| split.run(c));
        let parts: Vec<BatchWalkStats> =
            futures::future::join_all(walks).await.into_iter().map(|(s, _)| s).collect();
        let merged = BatchWalkStats::merge_all(&parts);
        let ids = [1u32, 2, 3, 4, 0x10, 0x11, 0x20, 0x30, 0x100, 0x300];
        for id in ids {
            assert_eq!(single.cached(id), split.cached(id), "0x{id:x}");
            assert!(split.cached(id), "0x{id:x} fetched by a sub-walk");
        }
        assert!(merged.settled());
        assert_eq!(merged.failed, 0);
        assert_eq!(merged.rounds, parts.iter().map(|p| p.rounds).sum::<u32>());
        assert_eq!(merged.fetched, parts.iter().map(|p| p.fetched).sum::<u32>());
    }

    #[test]
    fn merge_all_is_settled_only_when_every_part_is() {
        let s = |rounds, fetched, failed, end| BatchWalkStats { rounds, fetched, failed, end };
        let ok = s(2, 10, 0, BatchWalkEnd::Complete);
        let stalled = s(3, 4, 0, BatchWalkEnd::Stalled);
        let capped = s(8, 40, 0, BatchWalkEnd::RoundCap);
        let failed = s(3, 5, 1, BatchWalkEnd::OnlyFailedLeft);
        assert_eq!(BatchWalkStats::merge_all(&[]), s(0, 0, 0, BatchWalkEnd::Complete));
        assert!(BatchWalkStats::merge_all(&[]).settled(), "no stabs = nothing missing");
        let m = BatchWalkStats::merge_all(&[ok, stalled]);
        assert_eq!(m, s(5, 14, 0, BatchWalkEnd::Stalled));
        assert!(m.settled());
        let m = BatchWalkStats::merge_all(&[ok, capped, stalled]);
        assert_eq!(m.end, BatchWalkEnd::RoundCap);
        assert!(!m.settled(), "one capped sub-walk unsettles the build");
        let m = BatchWalkStats::merge_all(&[failed, ok]);
        assert_eq!((m.failed, m.end), (1, BatchWalkEnd::OnlyFailedLeft));
        assert!(!m.settled());
        // The merged answer equals "all settled" for every combination.
        let all = [ok, stalled, capped, failed];
        for a in all {
            for b in all {
                assert_eq!(
                    BatchWalkStats::merge_all(&[a, b]).settled(),
                    a.settled() && b.settled()
                );
            }
        }
    }

    #[test]
    fn chunk_ids_balanced_in_order_and_bounded() {
        let ids: Vec<u32> = (0..200).collect();
        let c = chunk_ids(&ids, 40);
        assert_eq!(c.len(), 5);
        assert!(c.iter().all(|x| x.len() == 40));
        let c = chunk_ids(&ids[..41], 40);
        assert_eq!(c.iter().map(Vec::len).collect::<Vec<_>>(), vec![21, 20], "balanced, not 40 + 1");
        for (n, max) in [(1usize, 40usize), (39, 40), (40, 40), (81, 40), (200, 48), (7, 1), (5, 0)] {
            let ids: Vec<u32> = (0..n as u32).collect();
            let c = chunk_ids(&ids, max);
            assert_eq!(c.concat(), ids, "n={n} max={max}: every id once, in order");
            assert!(c.iter().all(|x| !x.is_empty() && x.len() <= max.max(1)), "n={n} max={max}");
            let (lo, hi) = (c.iter().map(Vec::len).min().unwrap(), c.iter().map(Vec::len).max().unwrap());
            assert!(hi - lo <= 1, "n={n} max={max}: balanced");
        }
        assert!(chunk_ids(&[], 40).is_empty());
    }

    #[test]
    fn interior_stab_chunk_flag_grammar() {
        assert_eq!(parse_interior_stab_chunk_flag(""), Some(INTERIOR_STAB_CHUNK_DEFAULT));
        assert_eq!(parse_interior_stab_chunk_flag("?foo=bar"), Some(40));
        assert_eq!(parse_interior_stab_chunk_flag("?interiorStabChunk=on"), Some(40));
        assert_eq!(parse_interior_stab_chunk_flag("?interiorStabChunk=bogus"), Some(40));
        assert_eq!(parse_interior_stab_chunk_flag("?interiorStabChunk=32"), Some(32));
        assert_eq!(parse_interior_stab_chunk_flag("?a=1&interiorStabChunk=48&b=2"), Some(48));
        assert_eq!(parse_interior_stab_chunk_flag("?interiorStabChunk=1"), Some(INTERIOR_STAB_CHUNK_MIN));
        assert_eq!(parse_interior_stab_chunk_flag("?interiorStabChunk=999999"), Some(INTERIOR_STAB_CHUNK_MAX));
        for off in ["off", "0", "false", "no", "OFF", "No"] {
            assert_eq!(parse_interior_stab_chunk_flag(&format!("?interiorStabChunk={off}")), None, "{off}");
            assert_eq!(parse_interior_stab_chunk_flag(&format!("?x=1&interiorStabChunk={off}")), None, "{off}");
        }
        assert_eq!(
            parse_interior_stab_chunk_flag("?interiorStabChunk=off&interiorStabChunk=40"),
            None,
            "first occurrence wins (URLSearchParams.get)"
        );
    }

    #[test]
    fn walk_pace_flag_defaults_on_with_off_0_false_no_escape() {
        assert!(parse_walk_pace_flag(""));
        assert!(parse_walk_pace_flag("?foo=bar"));
        assert!(parse_walk_pace_flag("?walkPace=on"));
        assert!(parse_walk_pace_flag("?walkPace=1"));
        for off in ["off", "0", "false", "no"] {
            assert!(!parse_walk_pace_flag(&format!("?walkPace={off}")));
            assert!(!parse_walk_pace_flag(&format!("?a=b&walkPace={off}&c=d")));
        }
    }
}
