//! A15 §1 — byte-budgeted LRU for the `V2Source` shard record cache.
//!
//! # Why this exists
//!
//! `V2Source::shards` was a plain `HashMap<OwnedKey, Arc<Vec<u8>>>` with
//! `insert` / `get` / `len` and **no eviction path at all**. Every DAT record
//! the session ever touched stayed resident for the page lifetime, in EACH of
//! the two wasm instances (main thread + bake worker). The S1/S2 measurements
//! (commits 90fa3d12, 726daa39) confirmed it ratchets to ~58 MB main + ~21 MB
//! worker over four town hops and never falls — the dominant tracked RSS
//! ratchet, and the ceiling on what any bounded-decode work can win.
//!
//! [`ShardCache`] is that map plus a byte budget and LRU eviction. It is
//! target-agnostic (pure `std`) so the eviction logic is unit-testable
//! natively; `manifest_source.rs` (wasm-only) just holds one behind the same
//! `Arc<Mutex<…>>` it already had.
//!
//! # Eviction soundness
//!
//! Evicting is only safe because of two properties of the surrounding system:
//!
//! 1. **Outstanding readers are unaffected.** Values are `Arc<Vec<u8>>` (A15
//!    S2, 726daa39). Removing the map's `Arc` only drops one strong reference;
//!    any consumer that already called `get_file_shared` keeps its bytes alive
//!    until it drops its own clone. Eviction can therefore never invalidate a
//!    read in flight — it only gives up the *cache's* claim on the bytes.
//! 2. **A missing key is re-fetched, not memoised as absent.** A read miss
//!    surfaces as a transient `DatError::Other("record not prefetched")`, and
//!    the next prefetch round re-fetches it because `prefetch_impl` step A
//!    skips only keys **currently** in this map (the R-9 retry note at that
//!    step relies on the same property). Nothing in the pipeline may latch that
//!    error permanently:
//!    - Negative caches are gated exclusively on `V2Source::key_known_absent`
//!      (catalog-proven absence), which never consults this cache and stays
//!      `true` for an evicted-but-catalogued key → no poisoning. Memoising on a
//!      bare read `Err` was tried and removed as a bug (R-7 / A07-F1: a
//!      transient shard failure latched a surface grey for the session).
//!    - Positive memos (`MODEL_TRI_CACHE`, the surface memos) refuse to insert
//!      when the decode saw any miss (`misses == 0` gate), so a partial decode
//!      caused by an eviction cannot be cached.
//!    - The per-landblock "already baked" sets are marked only after the
//!      load-bearing fetches succeed, and un-mark + re-throw on a starved
//!      decode, so a degraded bake retries.
//!    - `RecordingSource` records a miss on BOTH `get_file_by_key` and
//!      `get_file_shared`, so an evicted key read through the shared path
//!      still feeds the iterative shard-discovery loop.
//!
//! Residual (documented, not fixed here): the walk loop re-hydrates, then the
//! caller re-walks against the live source. An eviction landing in that window
//! yields an incomplete decode. It poisons nothing, and the starved-retry
//! ladders re-bake — but those caps are finite (3), so an aggressive budget can
//! in principle spend them. That is one reason the default is unbounded and the
//! budget is an explicit host opt-in.
//!
//! # Round protection
//!
//! (A "round" is one locked insert batch in `prefetch_impl` step E — the mutex
//! is held across the whole batch with no `await` inside it, so rounds never
//! interleave even though several `prefetch` calls can be in flight.)
//!
//! A single `prefetch` round can insert more bytes than the whole budget. If
//! eviction were unrestricted, a large round would evict its own earlier
//! results before the caller ever read them, and the caller sees a miss for a
//! record `prefetch` just reported success for. So inserts made inside a round
//! ([`ShardCache::begin_round`] … [`ShardCache::end_round`]) are protected from
//! eviction for the duration of that round. When *everything* resident is
//! protected the cache deliberately runs over budget rather than break the
//! round's contract (same "no evictable victim → run over" stance as the app
//! crate's `ByteBudgetLru`).

use std::collections::{HashMap, HashSet};
use std::hash::Hash;
use std::sync::Arc;

/// One resident record plus its LRU stamp.
struct Entry {
    bytes: Arc<Vec<u8>>,
    last_use: u64,
}

/// LRU-by-bytes record cache. `budget == usize::MAX` (the default) makes this
/// behaviourally identical to the unbounded `HashMap` it replaces: the eviction
/// loop's `total_bytes > budget` test can never fire.
pub(crate) struct ShardCache<K: Eq + Hash + Clone> {
    map: HashMap<K, Entry>,
    /// Keys inserted during the current prefetch round; exempt from eviction
    /// until [`Self::end_round`]. Empty outside a round.
    protected: HashSet<K>,
    total_bytes: usize,
    budget: usize,
    tick: u64,
    evictions: u64,
    evicted_bytes: u64,
}

impl<K: Eq + Hash + Clone> ShardCache<K> {
    /// `budget` is in bytes of resident record payload (the `Arc` header and
    /// the `HashMap`'s own overhead are not counted — the number is the same
    /// one `cached_shard_bytes` has always reported, so budgets stay
    /// comparable with the S1/S2 measurements).
    pub(crate) fn new(budget: usize) -> Self {
        Self {
            map: HashMap::new(),
            protected: HashSet::new(),
            total_bytes: 0,
            budget,
            tick: 0,
            evictions: 0,
            evicted_bytes: 0,
        }
    }

    /// Shared-ownership read; counts as a use (recency bump).
    pub(crate) fn get(&mut self, key: &K) -> Option<Arc<Vec<u8>>> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self.map.get_mut(key)?;
        entry.last_use = tick;
        Some(Arc::clone(&entry.bytes))
    }

    /// Presence probe that also counts as a use. `prefetch_impl` step A calls
    /// this: "already cached, skip the fetch" is exactly a use of the record,
    /// and NOT bumping it there would let the LRU evict the very records a
    /// walk round just decided it still needs.
    pub(crate) fn contains_touch(&mut self, key: &K) -> bool {
        self.tick += 1;
        let tick = self.tick;
        match self.map.get_mut(key) {
            Some(entry) => {
                entry.last_use = tick;
                true
            }
            None => false,
        }
    }

    /// Record length without a recency bump — for metadata-only peeks.
    pub(crate) fn peek_len(&self, key: &K) -> Option<usize> {
        self.map.get(key).map(|e| e.bytes.len())
    }

    /// Open a protected insert round. See the module doc.
    pub(crate) fn begin_round(&mut self) {
        self.protected.clear();
    }

    /// Close the round; everything it inserted becomes evictable again. The
    /// trailing over-budget trim is what actually enforces the budget when a
    /// single round exceeded it.
    pub(crate) fn end_round(&mut self) {
        self.protected.clear();
        self.evict_to_budget(None);
    }

    /// Insert a fetched record. Inside a round the key is protected from that
    /// round's own eviction pass; outside a round only the just-inserted key
    /// is exempt.
    pub(crate) fn insert(&mut self, key: K, bytes: Arc<Vec<u8>>) {
        self.tick += 1;
        let len = bytes.len();
        let prev = self.map.insert(
            key.clone(),
            Entry {
                bytes,
                last_use: self.tick,
            },
        );
        if let Some(old) = prev {
            self.total_bytes -= old.bytes.len();
        }
        self.total_bytes += len;
        self.protected.insert(key.clone());
        self.evict_to_budget(Some(&key));
    }

    /// Evict least-recently-used entries until back under budget. `exempt` is
    /// the key that must never be the victim of its own insert.
    fn evict_to_budget(&mut self, exempt: Option<&K>) {
        while self.total_bytes > self.budget {
            let victim = self
                .map
                .iter()
                .filter(|(k, _)| Some(*k) != exempt)
                .filter(|(k, _)| !self.protected.contains(*k))
                .min_by_key(|(_, e)| e.last_use)
                .map(|(k, _)| k.clone());
            match victim {
                Some(k) => {
                    if let Some(e) = self.map.remove(&k) {
                        let n = e.bytes.len();
                        self.total_bytes -= n;
                        self.evictions += 1;
                        self.evicted_bytes += n as u64;
                        // `e.bytes` (an `Arc`) drops here. If a consumer is
                        // still holding a clone from `get_file_shared`, the
                        // record's bytes stay alive for that consumer and are
                        // freed when IT drops — the cache has only released
                        // its own claim. See module doc §1.
                    }
                }
                // Everything resident is protected (or is the exempt key):
                // run over budget rather than break the round's contract.
                None => break,
            }
        }
    }

    pub(crate) fn len(&self) -> usize {
        self.map.len()
    }

    /// Resident record bytes — the `cached_shard_bytes` number. Maintained
    /// incrementally; [`Self::audit_bytes`] proves it never drifts.
    pub(crate) fn total_bytes(&self) -> usize {
        self.total_bytes
    }

    pub(crate) fn budget(&self) -> usize {
        self.budget
    }

    pub(crate) fn evictions(&self) -> u64 {
        self.evictions
    }

    pub(crate) fn evicted_bytes(&self) -> u64 {
        self.evicted_bytes
    }

    /// Ground truth recomputed from the map — used by tests (and available to
    /// a debug assert) to prove the running `total_bytes` counter is exact.
    #[cfg(test)]
    fn audit_bytes(&self) -> usize {
        self.map.values().map(|e| e.bytes.len()).sum()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    type K = (String, u32);

    fn k(id: u32) -> K {
        ("eor/portal".to_string(), id)
    }

    fn rec(n: usize) -> Arc<Vec<u8>> {
        Arc::new(vec![0u8; n])
    }

    #[test]
    fn unbounded_budget_never_evicts() {
        let mut c: ShardCache<K> = ShardCache::new(usize::MAX);
        for i in 0..200u32 {
            c.insert(k(i), rec(1024));
        }
        c.end_round();
        assert_eq!(c.len(), 200);
        assert_eq!(c.evictions(), 0);
        assert_eq!(c.total_bytes(), 200 * 1024);
        assert_eq!(c.total_bytes(), c.audit_bytes());
    }

    #[test]
    fn insert_over_budget_evicts_lru_first() {
        // Budget fits exactly three 100-byte records.
        let mut c: ShardCache<K> = ShardCache::new(300);
        c.insert(k(1), rec(100));
        c.insert(k(2), rec(100));
        c.insert(k(3), rec(100));
        c.end_round(); // close the round so these become evictable
        assert_eq!(c.evictions(), 0);

        // Touch 1 and 3, leaving 2 as the least-recently-used.
        assert!(c.get(&k(1)).is_some());
        assert!(c.get(&k(3)).is_some());

        c.insert(k(4), rec(100));
        c.end_round();

        assert_eq!(c.evictions(), 1, "exactly one victim needed");
        assert!(c.get(&k(2)).is_none(), "LRU victim (2) should be gone");
        assert!(c.get(&k(1)).is_some());
        assert!(c.get(&k(3)).is_some());
        assert!(c.get(&k(4)).is_some());
        assert_eq!(c.total_bytes(), 300);
        assert_eq!(c.total_bytes(), c.audit_bytes());
    }

    #[test]
    fn contains_touch_updates_recency() {
        let mut c: ShardCache<K> = ShardCache::new(300);
        c.insert(k(1), rec(100));
        c.insert(k(2), rec(100));
        c.insert(k(3), rec(100));
        c.end_round();

        // `contains_touch` (the prefetch step-A skip) must count as a use:
        // touch 1 and 2, so 3 becomes the victim.
        assert!(c.contains_touch(&k(1)));
        assert!(c.contains_touch(&k(2)));
        assert!(!c.contains_touch(&k(99)));

        c.insert(k(4), rec(100));
        c.end_round();
        assert!(c.peek_len(&k(3)).is_none(), "untouched 3 is the victim");
        assert!(c.peek_len(&k(1)).is_some());
        assert!(c.peek_len(&k(2)).is_some());
    }

    #[test]
    fn round_protects_its_own_inserts_then_trims_at_end() {
        // One round inserts 5×100 into a 300-byte budget. Nothing may be
        // evicted mid-round (the caller is about to read all five); the
        // trailing trim brings the cache back under budget.
        let mut c: ShardCache<K> = ShardCache::new(300);
        c.begin_round();
        for i in 1..=5u32 {
            c.insert(k(i), rec(100));
            assert_eq!(c.len(), i as usize, "no mid-round eviction");
        }
        assert_eq!(c.evictions(), 0);
        assert_eq!(c.total_bytes(), 500, "deliberately over budget mid-round");

        c.end_round();
        assert_eq!(c.total_bytes(), 300);
        assert_eq!(c.evictions(), 2);
        // Oldest two (1, 2) are the victims.
        assert!(c.peek_len(&k(1)).is_none());
        assert!(c.peek_len(&k(2)).is_none());
        assert!(c.peek_len(&k(5)).is_some());
        assert_eq!(c.total_bytes(), c.audit_bytes());
    }

    #[test]
    fn eviction_does_not_invalidate_outstanding_readers() {
        let mut c: ShardCache<K> = ShardCache::new(200);
        c.insert(k(1), Arc::new(vec![7u8; 100]));
        c.insert(k(2), rec(100));
        c.end_round();

        // A consumer takes a shared reference to record 1 …
        let held = c.get(&k(1)).expect("resident");
        assert_eq!(Arc::strong_count(&held), 2, "cache + consumer");

        // … then two more inserts evict BOTH resident records (1 is LRU-first
        // after the touch order, but the point is the held bytes survive).
        c.insert(k(3), rec(100));
        c.insert(k(4), rec(100));
        c.end_round();
        assert!(c.evictions() >= 2);
        assert!(c.peek_len(&k(1)).is_none(), "evicted from the cache");

        // The outstanding reader's bytes are intact and now solely owned.
        assert_eq!(held.len(), 100);
        assert!(held.iter().all(|&b| b == 7));
        assert_eq!(Arc::strong_count(&held), 1, "cache dropped its claim");
    }

    #[test]
    fn byte_accounting_exact_across_overwrite_and_eviction() {
        let mut c: ShardCache<K> = ShardCache::new(1000);
        c.insert(k(1), rec(100));
        c.insert(k(1), rec(250)); // overwrite: old bytes must be subtracted
        c.end_round();
        assert_eq!(c.len(), 1);
        assert_eq!(c.total_bytes(), 250);
        assert_eq!(c.total_bytes(), c.audit_bytes());

        for i in 2..=10u32 {
            c.insert(k(i), rec(120));
            c.end_round();
        }
        assert!(c.total_bytes() <= 1000);
        assert_eq!(c.total_bytes(), c.audit_bytes());
        assert_eq!(c.evicted_bytes() as usize + c.total_bytes(), 250 + 9 * 120);
    }

    #[test]
    fn evicted_key_can_be_reinserted() {
        // The re-fetch path: an evicted key reads as a miss, the next round
        // re-inserts it, and accounting stays exact.
        let mut c: ShardCache<K> = ShardCache::new(100);
        c.insert(k(1), rec(100));
        c.end_round();
        c.insert(k(2), rec(100));
        c.end_round();
        assert!(!c.contains_touch(&k(1)), "evicted → miss → re-fetch");

        c.insert(k(1), rec(100));
        c.end_round();
        assert!(c.contains_touch(&k(1)));
        assert_eq!(c.len(), 1);
        assert_eq!(c.total_bytes(), 100);
        assert_eq!(c.total_bytes(), c.audit_bytes());
    }
}
