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
//! Residual: the walk loop re-hydrates, then the caller re-walks against the
//! live source. An eviction landing in that window yields an incomplete
//! decode. It poisons nothing, and the starved-retry ladders re-bake — but
//! those caps are finite (3), so an aggressive budget can in principle spend
//! them. Under the pure LRU ([`ShardCache::new`] alone) this stays open; the
//! soft cap below closes it by construction (a record the walk just hydrated
//! is younger than the time floor). The default budget is still unbounded and
//! the budget an explicit host opt-in until the owed ABAB picks a number.
//!
//! # Soft cap (streaming-residency-2)
//!
//! [`ShardCache::with_soft_cap`] arms the policy `manifest_source` installs
//! (after WebAC `packages/renderer/src/dat/streaming/DatStore.ts`
//! `evictIfOverCap`, AGPL-3.0):
//!
//! - **Time floor.** An entry read or landed less than `min_age_ms` ago is
//!   never evicted. When every evictable entry is that young the cache runs
//!   over budget until they age, so a budget only has to exceed the last
//!   ~minute of working set, not one prefetch round's.
//! - **Low-water trim.** Eviction starts only when resident bytes exceed the
//!   budget and then trims to `low_water × budget` in ONE pass, instead of one
//!   victim per over-budget insert.
//! - **Ordered recency index.** A `BTreeMap<tick, key>` beside the map makes a
//!   pass O(evicted · log n). The old per-victim `min_by_key` scan over the
//!   whole map is gone; the tests pin the index against it on random traces.
//!
//! The clock is the owner's (`set_now_ms`), so native tests drive it
//! deterministically. [`ShardCache::new`] alone keeps the pre-streaming-
//! residency-2 policy exactly (no floor, trim to budget).
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

// The owner (`manifest_source`) is wasm-only; natively only the tests below
// reach this module.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

use std::collections::{BTreeMap, HashMap, HashSet};
use std::hash::Hash;
use std::sync::Arc;

/// streaming-residency-2: default time floor (ms) for [`ShardCache::with_soft_cap`].
/// WebAC's `DEFAULT_MIN_RESIDENT_AGE_MS`; here it only has to outlast the walk
/// → re-hydrate → re-walk window, which it does by orders of magnitude.
pub(crate) const DEFAULT_MIN_AGE_MS: f64 = 120_000.0;

/// streaming-residency-2: an over-budget pass trims to this fraction of the
/// budget (WebAC's `EVICT_TO_FRACTION`) — hysteresis, one batch per crossing.
pub(crate) const LOW_WATER_FRACTION: f64 = 0.85;

/// One resident record plus its LRU stamps.
struct Entry {
    bytes: Arc<Vec<u8>>,
    /// Recency tick. Unique per entry (every op bumps `ShardCache::tick`
    /// before stamping), so it doubles as this entry's key in `order`.
    last_use: u64,
    /// The cache clock at the last use; read only by the time floor.
    last_use_ms: f64,
}

/// LRU-by-bytes record cache. `budget == usize::MAX` (the default) makes this
/// behaviourally identical to the unbounded `HashMap` it replaces: the eviction
/// loop's `total_bytes > budget` test can never fire.
pub(crate) struct ShardCache<K: Eq + Hash + Clone> {
    map: HashMap<K, Entry>,
    /// Recency index, oldest first: `last_use` tick → key. Eviction walks it
    /// from the front. `None` at the unbounded budget — that cache can never
    /// evict, so it does not pay to keep an index nothing would read.
    order: Option<BTreeMap<u64, K>>,
    /// Keys inserted during the current prefetch round; exempt from eviction
    /// until [`Self::end_round`]. Empty outside a round.
    protected: HashSet<K>,
    total_bytes: usize,
    budget: usize,
    tick: u64,
    evictions: u64,
    evicted_bytes: u64,
    /// Time floor: an entry used less than this long ago is never evicted.
    /// 0 = no floor (the [`Self::new`] default).
    min_age_ms: f64,
    /// Trim target as a fraction of `budget`. 1.0 = trim exactly to budget
    /// (the [`Self::new`] default).
    low_water: f64,
    /// The cache clock (ms), advanced by the owner via [`Self::set_now_ms`].
    now_ms: f64,
    /// Eviction passes that removed at least one entry.
    trims: u64,
    /// Eviction passes that stopped at the time floor with the cache still
    /// above its trim target — the soft cap running over.
    floor_holds: u64,
}

impl<K: Eq + Hash + Clone> ShardCache<K> {
    /// `budget` is in bytes of resident record payload (the `Arc` header and
    /// the `HashMap`'s own overhead are not counted — the number is the same
    /// one `cached_shard_bytes` has always reported, so budgets stay
    /// comparable with the S1/S2 measurements).
    pub(crate) fn new(budget: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: if budget == usize::MAX {
                None
            } else {
                Some(BTreeMap::new())
            },
            protected: HashSet::new(),
            total_bytes: 0,
            budget,
            tick: 0,
            evictions: 0,
            evicted_bytes: 0,
            min_age_ms: 0.0,
            low_water: 1.0,
            now_ms: 0.0,
            trims: 0,
            floor_holds: 0,
        }
    }

    /// streaming-residency-2: arm the soft cap (module doc). `min_age_ms` ≤ 0
    /// or non-finite → no floor; `low_water` outside (0, 1) → trim to budget.
    /// Inert at the unbounded budget.
    pub(crate) fn with_soft_cap(mut self, min_age_ms: f64, low_water: f64) -> Self {
        self.min_age_ms = if min_age_ms.is_finite() && min_age_ms > 0.0 {
            min_age_ms
        } else {
            0.0
        };
        self.low_water = if low_water.is_finite() && low_water > 0.0 && low_water < 1.0 {
            low_water
        } else {
            1.0
        };
        self
    }

    /// True when eviction can consult the clock (bounded budget, non-zero
    /// floor). The owner skips its clock read otherwise, so the unbounded
    /// default's read path makes no extra JS call.
    pub(crate) fn time_floor_active(&self) -> bool {
        self.order.is_some() && self.min_age_ms > 0.0
    }

    /// Advance the cache clock. A backwards or non-finite value is ignored, so
    /// recency order and clock order always agree — which is what lets the
    /// eviction walk stop at the first entry younger than the floor.
    pub(crate) fn set_now_ms(&mut self, now_ms: f64) {
        if now_ms.is_finite() && now_ms > self.now_ms {
            self.now_ms = now_ms;
        }
    }

    /// Stamp `key` as used now and move it to the back of the recency index.
    /// Bumps `tick` even on a miss (the pre-index behaviour, kept exact).
    fn touch(&mut self, key: &K) -> Option<&Entry> {
        self.tick += 1;
        let tick = self.tick;
        let entry = self.map.get_mut(key)?;
        let prev = std::mem::replace(&mut entry.last_use, tick);
        entry.last_use_ms = self.now_ms;
        if let Some(order) = self.order.as_mut()
            && let Some(k) = order.remove(&prev)
        {
            // Re-keyed by moving the stored key — no clone on the read path.
            order.insert(tick, k);
        }
        Some(&*entry)
    }

    /// Shared-ownership read; counts as a use (recency bump).
    pub(crate) fn get(&mut self, key: &K) -> Option<Arc<Vec<u8>>> {
        self.touch(key).map(|e| Arc::clone(&e.bytes))
    }

    /// Presence probe that also counts as a use. `prefetch_impl` step A calls
    /// this: "already cached, skip the fetch" is exactly a use of the record,
    /// and NOT bumping it there would let the LRU evict the very records a
    /// walk round just decided it still needs.
    pub(crate) fn contains_touch(&mut self, key: &K) -> bool {
        self.touch(key).is_some()
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
        let tick = self.tick;
        let len = bytes.len();
        let prev = self.map.insert(
            key.clone(),
            Entry {
                bytes,
                last_use: tick,
                last_use_ms: self.now_ms,
            },
        );
        if let Some(old) = prev {
            self.total_bytes -= old.bytes.len();
            if let Some(order) = self.order.as_mut() {
                order.remove(&old.last_use);
            }
        }
        self.total_bytes += len;
        if let Some(order) = self.order.as_mut() {
            order.insert(tick, key.clone());
        }
        self.protected.insert(key.clone());
        self.evict_to_budget(Some(&key));
    }

    /// Over budget → evict least-recently-used entries, oldest first, down to
    /// the trim target (`low_water × budget`) in ONE pass. `exempt` is the key
    /// that must never be the victim of its own insert; protected entries are
    /// skipped. The walk stops at the first evictable entry younger than the
    /// time floor: the index is in clock order, so every later one is younger.
    fn evict_to_budget(&mut self, exempt: Option<&K>) {
        if self.total_bytes <= self.budget {
            return;
        }
        // Unbounded (no index): unreachable, `total_bytes` cannot exceed MAX.
        let Some(order) = self.order.as_ref() else {
            return;
        };
        let target = if self.low_water >= 1.0 {
            self.budget
        } else {
            (self.budget as f64 * self.low_water) as usize
        };
        let floor = self.min_age_ms > 0.0;
        let cutoff = self.now_ms - self.min_age_ms;
        let mut remaining = self.total_bytes;
        let mut victims: Vec<u64> = Vec::new();
        let mut held = false;
        for (&tick, k) in order.iter() {
            if remaining <= target {
                break;
            }
            if Some(k) == exempt || self.protected.contains(k) {
                continue;
            }
            let Some(e) = self.map.get(k) else {
                continue;
            };
            if floor && e.last_use_ms > cutoff {
                held = true;
                break;
            }
            remaining -= e.bytes.len();
            victims.push(tick);
        }
        if held {
            self.floor_holds += 1;
        }
        // Nothing evictable (everything protected / exempt / too young): run
        // over budget rather than break the round's contract or the floor.
        if victims.is_empty() {
            return;
        }
        self.trims += 1;
        for tick in victims {
            let Some(k) = self.order.as_mut().and_then(|o| o.remove(&tick)) else {
                continue;
            };
            if let Some(e) = self.map.remove(&k) {
                let n = e.bytes.len();
                self.total_bytes -= n;
                self.evictions += 1;
                self.evicted_bytes += n as u64;
                // `e.bytes` (an `Arc`) drops here. If a consumer is still
                // holding a clone from `get_file_shared`, the record's bytes
                // stay alive for that consumer and are freed when IT drops —
                // the cache has only released its own claim. See module doc §1.
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

    /// The armed time floor (ms); 0 = none.
    pub(crate) fn min_age_ms(&self) -> f64 {
        self.min_age_ms
    }

    /// Eviction passes that removed at least one entry.
    pub(crate) fn trims(&self) -> u64 {
        self.trims
    }

    /// Eviction passes the time floor stopped while still above target.
    pub(crate) fn floor_holds(&self) -> u64 {
        self.floor_holds
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

    // ---- streaming-residency-2: recency index + soft cap ----

    #[test]
    fn time_floor_keeps_recent_entries_even_over_budget() {
        let mut c: ShardCache<K> = ShardCache::new(300).with_soft_cap(120_000.0, 0.85);
        assert!(c.time_floor_active());
        c.set_now_ms(1_000.0);
        for i in 1..=3u32 {
            c.insert(k(i), rec(100));
        }
        c.end_round();

        // 30 s later the walk lands three more: 600 > 300, but every entry was
        // used less than 120 s ago, so the cap runs over instead of evicting.
        c.set_now_ms(31_000.0);
        for i in 4..=6u32 {
            c.insert(k(i), rec(100));
        }
        c.end_round();
        assert_eq!(c.evictions(), 0, "nothing is old enough to evict");
        assert_eq!(c.total_bytes(), 600, "the cap is soft");
        assert!(c.floor_holds() > 0, "the floor stopped the pass");

        // A read refreshes 1's age.
        c.set_now_ms(100_000.0);
        assert!(c.get(&k(1)).is_some());

        // At 125 s only 2 and 3 (last used at 1 s) are past the floor. 4..6
        // (31 s) and 1 (read at 100 s) are not, so the pass stops after 2, 3
        // even though 500 is still above the 255 target.
        c.set_now_ms(125_000.0);
        c.insert(k(7), rec(100));
        c.end_round();
        assert_eq!(c.evictions(), 2);
        assert!(c.peek_len(&k(2)).is_none() && c.peek_len(&k(3)).is_none());
        for i in [1u32, 4, 5, 6, 7] {
            assert!(c.peek_len(&k(i)).is_some(), "{i} is younger than the floor");
        }
        assert_eq!(c.total_bytes(), 500);

        // Once everything has aged, a plain end_round trims to <= 255,
        // oldest-by-recency first: 4, 5, 6 go; 1 (re-read) and 7 stay.
        c.set_now_ms(1_000_000.0);
        c.end_round();
        assert_eq!(c.total_bytes(), 200);
        assert!(c.peek_len(&k(1)).is_some() && c.peek_len(&k(7)).is_some());
        assert_eq!(c.total_bytes(), c.audit_bytes());
    }

    #[test]
    fn over_budget_insert_trims_to_low_water_in_one_pass() {
        let mut c: ShardCache<K> = ShardCache::new(1000).with_soft_cap(120_000.0, 0.85);
        c.set_now_ms(1_000.0);
        for i in 1..=10u32 {
            c.insert(k(i), rec(100));
        }
        c.end_round();
        assert_eq!(c.evictions(), 0, "exactly at budget is not over it");

        // Everything ages past the floor; ONE over-budget insert trims
        // 1100 → <= 850 in a single pass: the counter jumps by the batch.
        c.set_now_ms(500_000.0);
        c.insert(k(11), rec(100));
        assert_eq!(c.trims(), 1, "one pass");
        assert_eq!(c.evictions(), 3, "1, 2, 3 in that pass");
        assert_eq!(c.total_bytes(), 800);
        assert!(c.total_bytes() <= (1000.0 * LOW_WATER_FRACTION) as usize);
        for i in 1..=3u32 {
            assert!(c.peek_len(&k(i)).is_none());
        }

        // Hysteresis: the next two inserts only refill to the budget, so no
        // further pass runs (the old policy evicted one victim per insert).
        c.insert(k(12), rec(100));
        c.insert(k(13), rec(100));
        assert_eq!((c.trims(), c.evictions()), (1, 3));
        assert_eq!(c.total_bytes(), 1000);

        // Crossing again: one more batch of three (4, 5, 6).
        c.insert(k(14), rec(100));
        assert_eq!((c.trims(), c.evictions()), (2, 6));
        assert_eq!(c.total_bytes(), 800);
        assert_eq!(c.total_bytes(), c.audit_bytes());
    }

    #[test]
    fn soft_cap_keeps_round_protection() {
        // Even with every entry far past the floor, a round never evicts its
        // own inserts; the trailing trim then goes to the low-water mark.
        let mut c: ShardCache<K> = ShardCache::new(300).with_soft_cap(120_000.0, 0.85);
        c.set_now_ms(1_000.0);
        c.begin_round();
        for i in 1..=5u32 {
            c.insert(k(i), rec(100));
            assert_eq!(c.len(), i as usize, "no mid-round eviction");
        }
        c.set_now_ms(1_000_000.0);
        c.insert(k(6), rec(100));
        assert_eq!(c.evictions(), 0);
        c.end_round();
        assert_eq!(c.total_bytes(), 200, "600 → <= 255 removes four");
        assert_eq!(c.evictions(), 4);
        assert!(c.peek_len(&k(5)).is_some() && c.peek_len(&k(6)).is_some());
        assert_eq!(c.total_bytes(), c.audit_bytes());
    }

    #[test]
    fn clock_is_monotone() {
        let mut c: ShardCache<K> = ShardCache::new(100).with_soft_cap(1_000.0, 0.85);
        c.set_now_ms(5_000.0);
        c.set_now_ms(4_000.0); // a wall-clock step back: ignored
        c.set_now_ms(f64::NAN);
        assert_eq!(c.now_ms, 5_000.0);
        c.insert(k(1), rec(100));
        c.end_round();
        c.set_now_ms(5_500.0);
        c.insert(k(2), rec(100));
        c.end_round();
        assert!(c.peek_len(&k(1)).is_some(), "1 is only 500 ms old");
        assert_eq!(c.total_bytes(), 200);
    }

    #[test]
    fn soft_cap_inputs_are_sanitised() {
        let c: ShardCache<K> = ShardCache::new(300);
        assert_eq!((c.min_age_ms, c.low_water), (0.0, 1.0), "new() = the pure LRU");
        assert!(!c.time_floor_active());
        let c: ShardCache<K> = ShardCache::new(300).with_soft_cap(f64::NAN, 1.5);
        assert_eq!((c.min_age_ms, c.low_water), (0.0, 1.0));
        let c: ShardCache<K> = ShardCache::new(300).with_soft_cap(-5.0, 0.0);
        assert_eq!((c.min_age_ms, c.low_water), (0.0, 1.0));
        assert!(!c.time_floor_active(), "min age 0 = no floor, no clock reads");
        let c: ShardCache<K> =
            ShardCache::new(300).with_soft_cap(DEFAULT_MIN_AGE_MS, LOW_WATER_FRACTION);
        assert_eq!((c.min_age_ms(), c.low_water), (120_000.0, 0.85));
    }

    #[test]
    fn unbounded_budget_keeps_no_index_and_needs_no_clock() {
        // The shipped default: the soft cap is configured but inert. No index
        // is maintained, the owner never reads the clock, nothing evicts.
        let mut c: ShardCache<K> =
            ShardCache::new(usize::MAX).with_soft_cap(DEFAULT_MIN_AGE_MS, LOW_WATER_FRACTION);
        assert!(c.order.is_none(), "no recency index at the unbounded budget");
        assert!(!c.time_floor_active());
        for i in 0..200u32 {
            c.insert(k(i), rec(1024));
            assert!(c.get(&k(i)).is_some());
            assert!(c.contains_touch(&k(i)));
        }
        c.set_now_ms(1e12);
        c.end_round();
        assert_eq!(c.len(), 200);
        assert_eq!(c.total_bytes(), 200 * 1024);
        assert_eq!((c.evictions(), c.trims(), c.floor_holds()), (0, 0, 0));
        assert_eq!(c.total_bytes(), c.audit_bytes());
    }

    /// Deterministic xorshift64* — this crate has no `rand` dev-dependency.
    struct Rng(u64);
    impl Rng {
        fn next_u64(&mut self) -> u64 {
            let mut x = self.0;
            x ^= x >> 12;
            x ^= x << 25;
            x ^= x >> 27;
            self.0 = x;
            x.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: u64) -> u64 {
            self.next_u64() % n
        }
    }

    /// The pre-streaming-residency-2 eviction loop verbatim (one full-map
    /// `min_by_key` scan per victim), extended with the floor and low-water
    /// target exactly as the module doc defines them. The ordered index must
    /// pick the same victims, in the same order, on any trace.
    struct Reference {
        /// key → (len, last_use tick, last_use_ms)
        map: HashMap<K, (usize, u64, f64)>,
        protected: HashSet<K>,
        total: usize,
        budget: usize,
        tick: u64,
        now_ms: f64,
        min_age_ms: f64,
        low_water: f64,
        evictions: u64,
        evicted_bytes: u64,
    }

    impl Reference {
        fn new(budget: usize, min_age_ms: f64, low_water: f64) -> Self {
            Self {
                map: HashMap::new(),
                protected: HashSet::new(),
                total: 0,
                budget,
                tick: 0,
                now_ms: 0.0,
                min_age_ms,
                low_water,
                evictions: 0,
                evicted_bytes: 0,
            }
        }

        fn touch(&mut self, key: &K) -> bool {
            self.tick += 1;
            let (tick, now) = (self.tick, self.now_ms);
            match self.map.get_mut(key) {
                Some(e) => {
                    e.1 = tick;
                    e.2 = now;
                    true
                }
                None => false,
            }
        }

        fn insert(&mut self, key: K, len: usize) {
            self.tick += 1;
            if let Some(old) = self.map.insert(key.clone(), (len, self.tick, self.now_ms)) {
                self.total -= old.0;
            }
            self.total += len;
            self.protected.insert(key.clone());
            self.evict(Some(&key));
        }

        fn begin_round(&mut self) {
            self.protected.clear();
        }

        fn end_round(&mut self) {
            self.protected.clear();
            self.evict(None);
        }

        fn evict(&mut self, exempt: Option<&K>) {
            if self.total <= self.budget {
                return;
            }
            let target = if self.low_water >= 1.0 {
                self.budget
            } else {
                (self.budget as f64 * self.low_water) as usize
            };
            while self.total > target {
                let victim = self
                    .map
                    .iter()
                    .filter(|(k, _)| Some(*k) != exempt)
                    .filter(|(k, _)| !self.protected.contains(*k))
                    .min_by_key(|(_, e)| e.1)
                    .map(|(k, e)| (k.clone(), *e));
                match victim {
                    Some((_, e))
                        if self.min_age_ms > 0.0 && e.2 > self.now_ms - self.min_age_ms =>
                    {
                        break;
                    }
                    Some((key, e)) => {
                        self.map.remove(&key);
                        self.total -= e.0;
                        self.evictions += 1;
                        self.evicted_bytes += e.0 as u64;
                    }
                    None => break,
                }
            }
        }
    }

    fn resident_ids<V>(map: &HashMap<K, V>) -> Vec<u32> {
        let mut ids: Vec<u32> = map.keys().map(|k| k.1).collect();
        ids.sort_unstable();
        ids
    }

    /// Drive one seeded random op trace through `c` and the reference and
    /// compare the resident set and every counter after each op. Returns
    /// `(evictions, floor_holds)` so callers can prove the trace exercised
    /// the paths it claims to.
    fn parity_trace(seed: u64, mut c: ShardCache<K>, mut r: Reference) -> (u64, u64) {
        let mut rng = Rng(seed);
        let mut now = 0.0f64;
        for step in 0..4000 {
            let id = rng.below(48) as u32;
            match rng.below(100) {
                0..=34 => {
                    let len = 1 + rng.below(120) as usize;
                    c.insert(k(id), rec(len));
                    r.insert(k(id), len);
                }
                35..=59 => assert_eq!(c.get(&k(id)).is_some(), r.touch(&k(id)), "step {step}: get"),
                60..=74 => assert_eq!(
                    c.contains_touch(&k(id)),
                    r.touch(&k(id)),
                    "step {step}: contains_touch"
                ),
                75..=79 => {
                    c.begin_round();
                    r.begin_round();
                }
                80..=84 => {
                    c.end_round();
                    r.end_round();
                }
                _ => {
                    now += rng.below(40_000) as f64;
                    c.set_now_ms(now);
                    r.now_ms = now;
                }
            }
            assert_eq!(resident_ids(&c.map), resident_ids(&r.map), "step {step}: resident set");
            assert_eq!(c.total_bytes(), r.total, "step {step}: bytes");
            assert_eq!(c.evictions(), r.evictions, "step {step}: evictions");
            assert_eq!(c.evicted_bytes(), r.evicted_bytes, "step {step}: evicted bytes");
            if let Some(order) = &c.order {
                assert_eq!(order.len(), c.map.len(), "step {step}: index covers the map");
            }
        }
        assert_eq!(c.total_bytes(), c.audit_bytes());
        (c.evictions(), c.floor_holds())
    }

    #[test]
    fn ordered_index_matches_min_by_key_reference_pure_lru() {
        // `new()` alone: no floor, trim to budget — the pre-index policy.
        for (seed, budget) in [(1u64, 600usize), (7, 1500), (0x5eed, 300), (99, 2000)] {
            let (evictions, holds) =
                parity_trace(seed, ShardCache::new(budget), Reference::new(budget, 0.0, 1.0));
            assert!(evictions > 0, "seed {seed}: the trace must evict");
            assert_eq!(holds, 0, "seed {seed}: no floor, no holds");
        }
    }

    #[test]
    fn ordered_index_matches_min_by_key_reference_soft_cap() {
        for (seed, budget) in [(3u64, 600usize), (11, 1500), (0xbeef, 300), (2024, 2000)] {
            let (evictions, holds) = parity_trace(
                seed,
                ShardCache::new(budget).with_soft_cap(60_000.0, LOW_WATER_FRACTION),
                Reference::new(budget, 60_000.0, LOW_WATER_FRACTION),
            );
            assert!(evictions > 0, "seed {seed}: the trace must evict");
            assert!(holds > 0, "seed {seed}: the trace must hit the floor");
        }
    }
}
