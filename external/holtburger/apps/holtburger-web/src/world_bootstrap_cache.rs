//! Phase B (cold-boot plan, 2026-05-21) — page-scoped memoization of
//! `WorldBootstrap` so the 5-table prefetch+parse runs at most once per
//! page load, no matter how many `start_session` calls fire.
//!
//! # Why memoize globally
//!
//! Before this module, every `start_session` invocation spawned its own
//! `load_world_bootstrap()` future. The double-connect dance (see
//! `[[holtburger-login-double-connect]]`) means the user routinely
//! fires `start_session` TWICE in ~10s — once to kick a stale ACE
//! session and once to actually log in. Each invocation re-fetched +
//! re-parsed SkillTable / SpellTable / XpTable / MotionKinematics /
//! ChatPoseTable, ~5-6s of wasted work per repeat.
//!
//! The cache also lets `index.html` eagerly prefetch on page init (see
//! `prefetch_world_bootstrap`) so the tables overlap with the
//! login-form interaction rather than serially gating Connect.
//!
//! # Coalescer shape
//!
//! Multiple concurrent callers race: the eager page-init prefetch may
//! still be in flight when the user clicks Connect. `LoadState::
//! Loading(waiters)` parks every late caller on a `oneshot` until the
//! first caller's load resolves; on resolve the first caller drains
//! the waiters and fans out the `Arc`. `Loaded` short-circuits — no
//! double-fetch.
//!
//! Wasm32 is single-threaded so the entire cache lives in a
//! `thread_local! { RefCell<Rc<RefCell<LoadState>>> }` (same shape as
//! `global_source::SOURCE`). No `Mutex` / `OnceCell` / `Send` traits
//! involved.

#![cfg(target_arch = "wasm32")]

use std::cell::RefCell;
use std::rc::Rc;
use std::sync::Arc;

use futures::channel::oneshot;

/// Internal cache state machine. Lives behind `Rc<RefCell<_>>` because
/// the load future needs to mutate it after the `.await` (single
/// borrow re-acquired per state transition).
enum LoadState {
    /// No load attempted yet (or a previous attempt failed and was
    /// dropped). The next caller transitions to `Loading` and drives
    /// the fetch.
    Idle,
    /// First caller is fetching. Subsequent callers park their
    /// oneshot senders in this vec; the driver drains it on
    /// completion. Empty vec is allowed (the driver itself doesn't
    /// add a sender — it gets the result directly).
    Loading(Vec<oneshot::Sender<Arc<holtburger_world::WorldBootstrap>>>),
    /// Cache hit. All future callers short-circuit to this `Arc`.
    Loaded(Arc<holtburger_world::WorldBootstrap>),
}

thread_local! {
    static CACHE: RefCell<Rc<RefCell<LoadState>>> = RefCell::new(Rc::new(RefCell::new(LoadState::Idle)));
}

/// Outcome of the latch decision. Cheap to construct — the loader
/// matches on this without holding any borrow.
enum LatchDecision {
    /// Caller is the first; drive the load and call
    /// [`publish_loaded`] / [`publish_failure`] on completion.
    Drive(Rc<RefCell<LoadState>>),
    /// Caller arrived while a load was in flight; await this oneshot
    /// for the shared `Arc`.
    Wait(oneshot::Receiver<Arc<holtburger_world::WorldBootstrap>>),
    /// Cache hit — done.
    Cached(Arc<holtburger_world::WorldBootstrap>),
}

/// Briefly borrows the thread-local cache to compute the latch
/// decision. Does NOT hold any borrow across `.await`.
fn latch() -> LatchDecision {
    CACHE.with(|outer| {
        let state_rc = outer.borrow().clone();
        let mut state = state_rc.borrow_mut();
        match &mut *state {
            LoadState::Loaded(bootstrap) => LatchDecision::Cached(bootstrap.clone()),
            LoadState::Loading(waiters) => {
                let (tx, rx) = oneshot::channel();
                waiters.push(tx);
                LatchDecision::Wait(rx)
            }
            LoadState::Idle => {
                *state = LoadState::Loading(Vec::new());
                drop(state);
                LatchDecision::Drive(state_rc)
            }
        }
    })
}

/// Drain waiters and install the `Arc` as the new `Loaded` state.
/// Called by the driver caller after the inner load future resolves
/// successfully.
fn publish_loaded(
    state_rc: &Rc<RefCell<LoadState>>,
    bootstrap: Arc<holtburger_world::WorldBootstrap>,
) {
    let waiters = {
        let mut state = state_rc.borrow_mut();
        // Snapshot the waiter list before overwriting state.
        let waiters = match std::mem::replace(&mut *state, LoadState::Loaded(bootstrap.clone())) {
            LoadState::Loading(w) => w,
            // `latch()` should have left `Loading` here; if we landed
            // on Idle or Loaded the contract was violated by a
            // re-entrant caller. Treat as empty waiter list and
            // continue — the next caller will short-circuit on the
            // now-Loaded state.
            _ => Vec::new(),
        };
        waiters
    };
    for tx in waiters {
        let _ = tx.send(bootstrap.clone());
    }
}

/// Reset state to `Idle` so a subsequent caller retries the load.
/// Dropping the waiters' senders rejects each waiter's `.await` with
/// `Canceled`; the caller surface (`load_world_bootstrap_cached`)
/// converts that into a retry attempt.
fn publish_failure(state_rc: &Rc<RefCell<LoadState>>) {
    let mut state = state_rc.borrow_mut();
    // Reset to Idle. Any waiters in the previous Loading vec are
    // dropped along with the old state, which cancels their oneshots.
    *state = LoadState::Idle;
}

/// Get the cached `WorldBootstrap`, loading it (and memoizing the
/// result) on first call. Concurrent callers coalesce on a shared
/// load; the second, third, … caller awaits a oneshot that the
/// first caller fans out on completion.
///
/// `loader` is the uncached inner — `load_world_bootstrap()` in
/// `lib.rs`. Threading it through as an `FnOnce` keeps this module
/// agnostic of the actual prefetch+parse pipeline (and avoids a
/// circular dep on `holtburger-dat`).
pub async fn get_or_load<F, Fut>(
    loader: F,
) -> anyhow::Result<Arc<holtburger_world::WorldBootstrap>>
where
    F: FnOnce() -> Fut,
    Fut: std::future::Future<Output = anyhow::Result<Arc<holtburger_world::WorldBootstrap>>>,
{
    match latch() {
        LatchDecision::Cached(bootstrap) => Ok(bootstrap),
        LatchDecision::Wait(rx) => match rx.await {
            Ok(bootstrap) => Ok(bootstrap),
            // Driver failed; surface a tagged error. Caller code in
            // `start_session` already logs+continues on bootstrap
            // failure (it falls back to `WorldBootstrap::synthetic`
            // upstream), so a tagged anyhow is sufficient.
            Err(_canceled) => Err(anyhow::anyhow!(
                "world_bootstrap_cache: driver task failed; see prior log line"
            )),
        },
        LatchDecision::Drive(state_rc) => {
            let result = loader().await;
            match result {
                Ok(bootstrap) => {
                    publish_loaded(&state_rc, bootstrap.clone());
                    Ok(bootstrap)
                }
                Err(e) => {
                    publish_failure(&state_rc);
                    Err(e)
                }
            }
        }
    }
}

/// Test-only / introspection helper — `true` iff a `Loaded` state is
/// currently installed. Lets future smoke tests assert eager-prefetch
/// timing without poking the internal enum.
#[allow(dead_code)]
pub fn is_cached() -> bool {
    CACHE.with(|outer| {
        let state_rc = outer.borrow().clone();
        let state = state_rc.borrow();
        matches!(&*state, LoadState::Loaded(_))
    })
}
