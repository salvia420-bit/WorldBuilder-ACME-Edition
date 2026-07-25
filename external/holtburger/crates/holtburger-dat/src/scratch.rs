//! A15 §3a — `ScratchPool`: a Mutex-guarded pool of reusable f32 scratch
//! buffers.
//!
//! Motivation (see `docs/rynth-integration/DESIGN-A15-ab-2026-07-24.md` §1
//! sites B/C/K): the derivative passes in [`crate::normal_gen`] allocate
//! ~4 MiB of pure scratch per 512² surface and drop all of it on return.
//! Leasing the buffers instead makes the steady state ~0 fresh allocation.
//!
//! Why a `Mutex<Vec<ScratchBuf>>` and **not** a `thread_local!`:
//!
//! * `Mutex<Vec<…>>` is `Send + Sync` and `Vec<f32>` is `Send`, so a lease
//!   can cross a rayon `join`/`spawn` boundary. No `unsafe`, no `Rc`, no
//!   `!Send` field anywhere in this module.
//! * The lock is held **only** for the pop (lease) and the push (drop) —
//!   never across the compute, because the lease owns the buffer outright.
//! * Under an N-thread pool the pool naturally settles at ≤ N resident
//!   buffers with zero per-thread knowledge, and `cap` bounds it from
//!   above. A `thread_local!` would give exactly N with no cap.
//! * Poisoning is absorbed with `unwrap_or_else(|e| e.into_inner())` — a
//!   scratch pool protects no invariant, so a panic elsewhere must not
//!   turn every later lease into a second panic.
//!
//! **The hazard, written down:** a leased buffer still holds the previous
//! user's bytes. That is why the only way to get at the storage is
//! [`ScratchBuf::f32_zeroed`] (and its 3-slot sibling), which resize **and
//! zero**. There is deliberately no `&mut [f32]` accessor that skips the
//! fill. `scratch_lease_is_always_zeroed` gates this.

use std::sync::Mutex;

/// Which of a [`ScratchBuf`]'s three f32 slots to address.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Slot {
    A,
    B,
    C,
}

/// Three reusable `Vec<f32>` slots. Obtained from [`ScratchPool::lease`];
/// see [`ScratchBuf::f32_zeroed`] for the only access path.
#[derive(Debug, Default)]
pub struct ScratchBuf {
    f32a: Vec<f32>,
    f32b: Vec<f32>,
    f32c: Vec<f32>,
}

impl ScratchBuf {
    /// A standalone buffer, not attached to any pool. Useful for callers
    /// that only ever run one derivative pass (and for tests).
    pub fn new() -> Self {
        Self::default()
    }

    fn slot_mut(&mut self, which: Slot) -> &mut Vec<f32> {
        match which {
            Slot::A => &mut self.f32a,
            Slot::B => &mut self.f32b,
            Slot::C => &mut self.f32c,
        }
    }

    /// Resize-and-**zero** slot `which` to exactly `n` elements, returning
    /// it as a slice.
    ///
    /// Capacity is retained across calls (that is the whole point), but the
    /// contents are always freshly zeroed — a caller can never observe the
    /// previous lease's bytes.
    pub fn f32_zeroed(&mut self, which: Slot, n: usize) -> &mut [f32] {
        let v = self.slot_mut(which);
        zero_to_len(v, n);
        &mut v[..]
    }

    /// All three slots at once, each resized-and-zeroed.
    ///
    /// Same semantics as three [`Self::f32_zeroed`] calls; it exists only
    /// because the borrow checker cannot know that three `f32_zeroed`
    /// calls touched disjoint fields. The three slices are disjoint by
    /// construction (three distinct struct fields).
    pub fn f32_zeroed3(
        &mut self,
        na: usize,
        nb: usize,
        nc: usize,
    ) -> (&mut [f32], &mut [f32], &mut [f32]) {
        zero_to_len(&mut self.f32a, na);
        zero_to_len(&mut self.f32b, nb);
        zero_to_len(&mut self.f32c, nc);
        (&mut self.f32a[..], &mut self.f32b[..], &mut self.f32c[..])
    }

    /// Total elements currently retained across the three slots. Diagnostic
    /// only — used by the pool-behaviour tests.
    pub fn retained_capacity(&self) -> usize {
        self.f32a.capacity() + self.f32b.capacity() + self.f32c.capacity()
    }
}

/// Clear then refill with zeros, keeping the allocation.
///
/// `clear()` + `resize()` (rather than a bare `resize`) is what guarantees
/// **every** returned element is zero, not just the ones past the old
/// length. Skipping the clear is exactly the negative control for
/// `scratch_lease_is_always_zeroed`.
#[inline]
fn zero_to_len(v: &mut Vec<f32>, n: usize) {
    v.clear();
    v.resize(n, 0.0);
}

/// A bounded pool of [`ScratchBuf`]s.
///
/// `cap` bounds the number of buffers held **at rest**; it does not bound
/// how many leases are outstanding (a lease over an empty pool simply gets
/// a fresh buffer, and that buffer is dropped rather than pooled if the
/// pool is already full when it returns).
#[derive(Debug)]
pub struct ScratchPool {
    inner: Mutex<Vec<ScratchBuf>>,
    cap: usize,
}

impl ScratchPool {
    /// A pool retaining at most `cap` buffers at rest.
    pub fn new(cap: usize) -> Self {
        Self {
            inner: Mutex::new(Vec::new()),
            cap,
        }
    }

    /// Take a buffer from the pool, or make a fresh one if it is empty.
    ///
    /// The lock is held only for the `pop`.
    pub fn lease(&self) -> ScratchLease<'_> {
        let buf = {
            let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
            guard.pop()
        };
        ScratchLease {
            pool: self,
            buf: Some(buf.unwrap_or_default()),
        }
    }

    /// Buffers currently resting in the pool. Diagnostic / test hook.
    pub fn idle_len(&self) -> usize {
        let guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        guard.len()
    }

    /// The at-rest bound this pool was built with.
    pub fn cap(&self) -> usize {
        self.cap
    }

    fn give_back(&self, buf: ScratchBuf) {
        let mut guard = self.inner.lock().unwrap_or_else(|e| e.into_inner());
        if guard.len() < self.cap {
            guard.push(buf);
        }
        // else: over cap — drop it, releasing the memory.
    }
}

impl Default for ScratchPool {
    fn default() -> Self {
        Self::new(4)
    }
}

/// RAII handle to a leased [`ScratchBuf`]. Returns the buffer to the pool
/// on drop (if the pool is under `cap`), otherwise drops it.
///
/// A lease is meant to live on the caller's stack for the duration of one
/// call and never be stored globally, so it cannot leak across a pool
/// dispatch.
#[derive(Debug)]
pub struct ScratchLease<'p> {
    pool: &'p ScratchPool,
    buf: Option<ScratchBuf>,
}

impl ScratchLease<'_> {
    /// The leased buffer. Access to its storage is only via
    /// [`ScratchBuf::f32_zeroed`].
    pub fn buf_mut(&mut self) -> &mut ScratchBuf {
        self.buf
            .as_mut()
            .expect("ScratchLease buffer taken only in Drop")
    }
}

impl Drop for ScratchLease<'_> {
    fn drop(&mut self) {
        if let Some(buf) = self.buf.take() {
            self.pool.give_back(buf);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn f32_zeroed_returns_exact_length() {
        let mut b = ScratchBuf::new();
        assert_eq!(b.f32_zeroed(Slot::A, 0).len(), 0);
        assert_eq!(b.f32_zeroed(Slot::A, 7).len(), 7);
        assert_eq!(b.f32_zeroed(Slot::B, 300).len(), 300);
        assert_eq!(b.f32_zeroed(Slot::C, 1).len(), 1);
    }

    /// THE hygiene gate (design §3a): lease → dirty → drop → re-lease must
    /// hand back zeros, never the previous user's bytes.
    ///
    /// Negative control: make `zero_to_len` skip the `clear()` (a bare
    /// `resize`) and this test must fail on the dirtied values.
    #[test]
    fn scratch_lease_is_always_zeroed() {
        let pool = ScratchPool::new(2);

        // Lease 1 — dirty all three slots thoroughly.
        {
            let mut lease = pool.lease();
            let buf = lease.buf_mut();
            for (slot, fill) in [(Slot::A, 1.5f32), (Slot::B, -2.5), (Slot::C, 9.0)] {
                for v in buf.f32_zeroed(slot, 256).iter_mut() {
                    *v = fill;
                }
            }
        }
        assert_eq!(pool.idle_len(), 1, "dropped lease should return to pool");

        // Lease 2 — the SAME buffer comes back (capacity proves reuse) and
        // every element must read zero, at the same length and shorter.
        {
            let mut lease = pool.lease();
            let buf = lease.buf_mut();
            assert!(
                buf.retained_capacity() >= 3 * 256,
                "expected the pooled allocation to be reused, got capacity {}",
                buf.retained_capacity()
            );
            for slot in [Slot::A, Slot::B, Slot::C] {
                let s = buf.f32_zeroed(slot, 256);
                assert!(
                    s.iter().all(|&v| v == 0.0),
                    "stale bytes leaked through a re-lease in slot {slot:?}: {:?}",
                    &s[..8.min(s.len())]
                );
            }
            // Shorter request must also be fully zero (the tail of the old
            // contents must not be visible in the prefix).
            for slot in [Slot::A, Slot::B, Slot::C] {
                let s = buf.f32_zeroed(slot, 16);
                assert!(
                    s.iter().all(|&v| v == 0.0),
                    "stale bytes leaked on a shorter re-lease in slot {slot:?}"
                );
            }
        }
    }

    #[test]
    fn f32_zeroed3_is_zeroed_and_disjoint() {
        let mut b = ScratchBuf::new();
        {
            let (a, bb, c) = b.f32_zeroed3(4, 4, 4);
            a.fill(1.0);
            bb.fill(2.0);
            c.fill(3.0);
            assert_eq!(a, &[1.0, 1.0, 1.0, 1.0]);
            assert_eq!(bb, &[2.0, 2.0, 2.0, 2.0]);
            assert_eq!(c, &[3.0, 3.0, 3.0, 3.0]);
        }
        let (a, bb, c) = b.f32_zeroed3(4, 4, 4);
        assert!(a.iter().chain(bb.iter()).chain(c.iter()).all(|&v| v == 0.0));
    }

    /// Pool cap: at most `cap` buffers rest in the pool; overflow leases
    /// are dropped rather than pooled.
    #[test]
    fn pool_cap_is_respected() {
        let pool = ScratchPool::new(2);
        assert_eq!(pool.cap(), 2);
        assert_eq!(pool.idle_len(), 0);

        {
            let _l1 = pool.lease();
            let _l2 = pool.lease();
            let _l3 = pool.lease();
            let _l4 = pool.lease();
            // All outstanding — nothing is resting.
            assert_eq!(pool.idle_len(), 0);
        }
        // Four returned, cap 2.
        assert_eq!(pool.idle_len(), 2, "pool must not exceed cap at rest");

        // Draining and returning again stays at cap.
        {
            let _a = pool.lease();
            assert_eq!(pool.idle_len(), 1);
            let _b = pool.lease();
            assert_eq!(pool.idle_len(), 0);
            let _c = pool.lease();
            assert_eq!(pool.idle_len(), 0, "empty pool mints a fresh buffer");
        }
        assert_eq!(pool.idle_len(), 2);
    }

    #[test]
    fn zero_cap_pool_never_retains() {
        let pool = ScratchPool::new(0);
        {
            let _l = pool.lease();
        }
        assert_eq!(pool.idle_len(), 0);
    }

    #[test]
    fn pool_is_send_and_sync() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<ScratchPool>();
        assert_send_sync::<ScratchBuf>();
        // A lease must be Send so it can be held across a rayon boundary.
        fn assert_send<T: Send>() {}
        assert_send::<ScratchLease<'_>>();
    }

    #[test]
    fn poisoned_pool_still_leases() {
        use std::sync::Arc;
        let pool = Arc::new(ScratchPool::new(2));
        {
            let p = Arc::clone(&pool);
            let _ = std::thread::spawn(move || {
                let _l = p.lease();
                panic!("poison the mutex");
            })
            .join();
        }
        // into_inner() absorption: this must not panic.
        let mut lease = pool.lease();
        assert!(lease.buf_mut().f32_zeroed(Slot::A, 4).iter().all(|&v| v == 0.0));
    }

    #[test]
    fn lease_survives_a_rayon_join() {
        let pool = ScratchPool::new(4);
        let (x, y) = rayon::join(
            || {
                let mut l = pool.lease();
                l.buf_mut().f32_zeroed(Slot::A, 128).len()
            },
            || {
                let mut l = pool.lease();
                l.buf_mut().f32_zeroed(Slot::B, 64).len()
            },
        );
        assert_eq!((x, y), (128, 64));
        assert!(pool.idle_len() <= pool.cap());
    }
}
