//! Diagnostic trace facility for the swept-step driver/resolver (2026-07-20,
//! academy-wedge investigation). Off by default and ZERO cost when disabled
//! (the `enabled` check happens before the closure that formats the message
//! ever runs, so a disabled trace point never allocates).
//!
//! This is investigation tooling, NOT a retail port: nothing here corresponds
//! to an `acclient.c` symbol. It exists so a downstream test (in
//! `holtburger-world`, a separate crate — `cfg(test)` in THIS crate would not
//! be visible there) can flip on a thread-local log, run one
//! `find_valid_position` call, and read back an ordered trace of the
//! `transitional_insert` retry ladder / resolver branch decisions without
//! threading a logger through every function signature.
//!
//! Call sites use [`trace`] with a closure so the `format!` only runs when a
//! trace is actually being captured.

use std::cell::RefCell;

thread_local! {
    static TRACE: RefCell<(bool, Vec<String>)> = const { RefCell::new((false, Vec::new())) };
}

/// Enable (or disable) the trace for this thread. Enabling clears any prior
/// log so a fresh capture starts empty; DISABLING deliberately does NOT
/// clear — the typical caller pattern is `enable → run → disable → read`, and
/// clearing on disable would wipe the very log the caller is about to read.
/// Call [`transition_trace_log`] to read, then `set_transition_trace(true)`
/// again to start the next capture.
pub fn set_transition_trace(enabled: bool) {
    TRACE.with(|t| {
        let mut t = t.borrow_mut();
        if enabled {
            t.1.clear();
        }
        t.0 = enabled;
    });
}

/// Snapshot the accumulated trace lines (insertion order).
pub fn transition_trace_log() -> Vec<String> {
    TRACE.with(|t| t.borrow().1.clone())
}

/// Record one trace line iff tracing is enabled. `msg` is only invoked when
/// enabled, so call sites can pass an arbitrarily detailed `format!` closure
/// with no cost in the (default, production) disabled path.
#[inline]
pub(crate) fn trace(msg: impl FnOnce() -> String) {
    TRACE.with(|t| {
        let mut t = t.borrow_mut();
        if t.0 {
            let line = msg();
            t.1.push(line);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn trace_records_when_enabled() {
        set_transition_trace(true);
        trace(|| "hello".to_string());
        let log = transition_trace_log();
        assert_eq!(log, vec!["hello".to_string()]);
        // Disabling does NOT clear (the enable -> run -> disable -> read
        // caller pattern reads AFTER disabling) — "world" is dropped because
        // tracing is off, but "hello" survives untouched.
        set_transition_trace(false);
        trace(|| "world".to_string());
        assert_eq!(transition_trace_log(), vec!["hello".to_string()]);
        // Re-enabling clears the prior capture and starts fresh.
        set_transition_trace(true);
        assert_eq!(transition_trace_log(), Vec::<String>::new());
    }
}
