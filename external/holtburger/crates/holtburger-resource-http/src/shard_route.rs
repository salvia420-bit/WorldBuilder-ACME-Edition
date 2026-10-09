//! Workstream B (`?shardFetchWorker`, 2026-10-09) — the pure decisions of the
//! registered-shard-fetcher route, kept target-agnostic so `cargo test` pins
//! them natively. The wasm-only glue lives in `http.rs`
//! (`http::fetch_shard_bytes`) and `manifest_source.rs` (Step D/E of
//! `prefetch_impl`).
//!
//! The contract with the JS fetcher (`scene3d/shard_fetch_client.js`):
//!
//! - call: `f(url, "low" | "auto", expectedShaHex | null)`;
//! - resolve: a `Uint8Array` (unverified) or `{ verified: true, bytes }`
//!   (the worker hashed the body and its first 32 hex chars equal
//!   `expectedShaHex`);
//! - reject: `{ status, statusText }` → `HttpError::Http`, anything else →
//!   `HttpError::Network`.
//!
//! A worker-side sha MISMATCH is not a rejection: the body resolves
//! unverified and Step E re-hashes it on the main thread exactly as before the
//! worker existed, so the failed-key message and the `__hbVerifyShards`
//! semantics stay byte for byte today's.
//!
//! Latched waiters (2026-10-09 follow-up, same `?shardFetchWorker` feature):
//! the v2 shard in-flight map shares a [`SharedShardBody`] — the body plus the
//! catalog hash the fetcher verified it against ([`verified_against`]) — with
//! EVERY caller that latched onto the fetch, not only the one whose factory
//! ran. Step E skips its re-hash exactly when that hash equals the task's own
//! expected hash ([`verified_for_task`]). Before this, a waiter that latched
//! onto another caller's in-flight fetch (the early-bake deps call and the
//! interior build share every LandblockInfo/EnvCell request; entity rigs share
//! mesh and texture records) re-hashed the body on the main thread: 48 ms of
//! `sha2::compress256` inside the academy walk window (1070, acad-diagF). A
//! MISMATCH shares `verified_against: None`, so every waiter still re-hashes
//! and fails its own key with today's message.

// The callers are wasm32-only; natively only the tests below use these.
#![cfg_attr(not(target_arch = "wasm32"), allow(dead_code))]

/// What the v2 SHARD in-flight map hands every waiter of one fetch: the body,
/// plus the truncated catalog sha256 (16 bytes) the registered fetcher verified
/// it against. `None` = nobody verified it: no fetcher (the direct path),
/// verification off, no hash sent (convention-URL task), a worker-side
/// mismatch, a hash-engine failure in the worker.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SharedShardBody {
    pub bytes: Vec<u8>,
    pub verified_against: Option<[u8; 16]>,
}

/// The hash a producing fetch records for its waiters: the hash its OWN
/// request sent, iff the fetcher's `verified` claim was accepted for that
/// request (see [`accept_verified_claim`]); else `None`.
pub(crate) fn verified_against(fetcher_verified: bool, sent_hash: Option<[u8; 16]>) -> Option<[u8; 16]> {
    if fetcher_verified { sent_hash } else { None }
}

/// May THIS task skip Step E's main-thread re-hash on the strength of the
/// shared body's verification? Only when the body was verified against exactly
/// the hash this task expects (a shard URL embeds its hash, so in practice
/// every waiter of one URL expects the same one — compared anyway, so a
/// template without `{sha256}` can never smuggle another record's verification
/// in). Feed the result to [`needs_main_thread_verify`] as `fetcher_verified`.
pub(crate) fn verified_for_task(
    task_expected: Option<&[u8; 16]>,
    verified_against: Option<&[u8; 16]>,
) -> bool {
    matches!((task_expected, verified_against), (Some(want), Some(got)) if want == got)
}

/// The `priority` hint string forwarded to the JS fetcher. `"auto"` means "do
/// not set the `RequestInit.priority` member" (today's urgent-lane request).
pub(crate) fn priority_hint(low: bool) -> &'static str {
    if low { "low" } else { "auto" }
}

/// An HTTP status carried by a JS rejection value, or `None` when the value
/// does not describe an HTTP response (network failure, worker death, a
/// thrown `Error`) — those map to `HttpError::Network`. Only an integral
/// status in 100..=999 counts; `0` (the fetch spec's network-error status)
/// and garbage do not.
pub(crate) fn http_status_from_js_number(n: f64) -> Option<u16> {
    if n.is_finite() && n.fract() == 0.0 && (100.0..=999.0).contains(&n) {
        Some(n as u16)
    } else {
        None
    }
}

/// Should Step D ask the JS fetcher to verify the body? Only when a fetcher is
/// registered AND per-shard verification is on (`__hbVerifyShards` not
/// explicitly falsy) AND the task has an expected hash (catalog mode; a
/// convention-URL task has none). With verification off the worker is not
/// asked to hash anything — Step E would not have hashed either.
pub(crate) fn ask_fetcher_to_verify(
    fetcher_registered: bool,
    verify_enabled: bool,
    has_expected_hash: bool,
) -> bool {
    fetcher_registered && verify_enabled && has_expected_hash
}

/// Does Step E still have to sha256 this body on the main thread? Exactly when
/// verification is on, the task carries an expected hash, and the body was NOT
/// verified by the fetcher against THIS task's expected hash
/// ([`verified_for_task`] over the shared body — a waiter that latched onto
/// another caller's in-flight fetch sees that fetch's verification too).
pub(crate) fn needs_main_thread_verify(
    verify_enabled: bool,
    has_expected_hash: bool,
    fetcher_verified: bool,
) -> bool {
    verify_enabled && has_expected_hash && !fetcher_verified
}

/// Normalise a fetcher's `verified` claim: it only counts when this request
/// actually asked for verification (an expected hash was sent). A fetcher that
/// answers `verified: true` to a request without a hash is ignored.
pub(crate) fn accept_verified_claim(sha_requested: bool, claimed: Option<bool>) -> bool {
    sha_requested && claimed == Some(true)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn priority_hint_maps_lanes() {
        assert_eq!(priority_hint(true), "low");
        assert_eq!(priority_hint(false), "auto");
    }

    #[test]
    fn http_status_only_for_real_statuses() {
        assert_eq!(http_status_from_js_number(404.0), Some(404));
        assert_eq!(http_status_from_js_number(200.0), Some(200));
        assert_eq!(http_status_from_js_number(503.0), Some(503));
        assert_eq!(http_status_from_js_number(100.0), Some(100));
        assert_eq!(http_status_from_js_number(999.0), Some(999));
        // network-error status, garbage, non-integral → Network
        assert_eq!(http_status_from_js_number(0.0), None);
        assert_eq!(http_status_from_js_number(-1.0), None);
        assert_eq!(http_status_from_js_number(99.0), None);
        assert_eq!(http_status_from_js_number(1000.0), None);
        assert_eq!(http_status_from_js_number(404.5), None);
        assert_eq!(http_status_from_js_number(f64::NAN), None);
        assert_eq!(http_status_from_js_number(f64::INFINITY), None);
    }

    #[test]
    fn worker_verify_requested_only_with_fetcher_verify_and_hash() {
        assert!(ask_fetcher_to_verify(true, true, true));
        assert!(
            !ask_fetcher_to_verify(false, true, true),
            "unregistered: direct fetch, Step E verifies"
        );
        assert!(
            !ask_fetcher_to_verify(true, false, true),
            "__hbVerifyShards=false: nobody hashes"
        );
        assert!(
            !ask_fetcher_to_verify(true, true, false),
            "convention-URL task: no hash to check"
        );
    }

    #[test]
    fn main_thread_verify_skipped_only_for_fetcher_verified_bodies() {
        // Today's behaviour (unregistered / unverified): verify iff on + hash.
        assert!(needs_main_thread_verify(true, true, false));
        assert!(!needs_main_thread_verify(false, true, false));
        assert!(!needs_main_thread_verify(true, false, false));
        // Worker-verified body: skip the re-hash.
        assert!(!needs_main_thread_verify(true, true, true));
        // Verification off: never hash, whatever the flag says.
        assert!(!needs_main_thread_verify(false, true, true));
    }

    #[test]
    fn verified_claim_needs_a_requested_hash() {
        assert!(accept_verified_claim(true, Some(true)));
        assert!(!accept_verified_claim(true, Some(false)));
        assert!(!accept_verified_claim(true, None));
        assert!(
            !accept_verified_claim(false, Some(true)),
            "no hash sent: a claim is ignored"
        );
    }

    #[test]
    fn producer_records_the_hash_it_sent_only_when_verified() {
        let h = [0x5A; 16];
        assert_eq!(verified_against(true, Some(h)), Some(h));
        assert_eq!(verified_against(false, Some(h)), None, "mismatch / unverified");
        assert_eq!(verified_against(true, None), None, "no hash sent");
        assert_eq!(verified_against(false, None), None);
    }

    #[test]
    fn task_skips_only_for_its_own_hash() {
        let h = [0x11; 16];
        let other = [0x22; 16];
        assert!(verified_for_task(Some(&h), Some(&h)));
        assert!(!verified_for_task(Some(&h), Some(&other)), "another record's verification");
        assert!(!verified_for_task(Some(&h), None), "nobody verified (mismatch, direct path)");
        assert!(!verified_for_task(None, Some(&h)), "convention-URL task: never skips");
        assert!(!verified_for_task(None, None));
        // Composed with the Step E gate.
        assert!(!needs_main_thread_verify(true, true, verified_for_task(Some(&h), Some(&h))));
        assert!(needs_main_thread_verify(true, true, verified_for_task(Some(&h), None)));
        assert!(needs_main_thread_verify(true, true, verified_for_task(Some(&h), Some(&other))));
    }
}

/// The latched-waiter contract, end to end through the REAL dedup primitive:
/// one producer fetch, several concurrent waiters on the same key, each running
/// Step E's skip decision on what the map handed it.
#[cfg(all(test, not(target_arch = "wasm32")))]
mod latch_tests {
    use super::*;
    use crate::inflight::InflightMap;
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::Duration;

    #[derive(Debug)]
    #[allow(dead_code)] // only ever a type parameter: no test fetch fails
    struct TestErr;

    /// Spawn `waiters` concurrent `get_or_fetch` calls on one key whose single
    /// underlying fetch resolves to `produced`; return what each waiter got and
    /// how many times a factory actually ran.
    async fn run(
        produced: SharedShardBody,
        waiters: usize,
    ) -> (Vec<SharedShardBody>, usize) {
        let map: Arc<InflightMap<TestErr, SharedShardBody>> = Arc::new(InflightMap::new());
        let runs = Arc::new(AtomicUsize::new(0));
        let mut handles = Vec::new();
        for i in 0..waiters {
            let map = map.clone();
            let runs = runs.clone();
            // Only the first factory to latch should ever run; every other one
            // would answer an UNVERIFIED body if it did.
            let mine = if i == 0 {
                produced.clone()
            } else {
                SharedShardBody { bytes: produced.bytes.clone(), verified_against: None }
            };
            handles.push(tokio::spawn(async move {
                map.get_or_fetch("urgent:https://x/shards/ab/abcd.bin", move || async move {
                    runs.fetch_add(1, Ordering::SeqCst);
                    tokio::time::sleep(Duration::from_millis(50)).await;
                    Ok::<_, TestErr>(mine)
                })
                .await
            }));
            if i == 0 {
                // Let the producer install its Shared first.
                tokio::task::yield_now().await;
            }
        }
        let mut out = Vec::new();
        for h in handles {
            out.push(h.await.expect("task panicked").expect("fetch ok"));
        }
        (out, runs.load(Ordering::SeqCst))
    }

    #[tokio::test]
    async fn every_latched_waiter_sees_the_producers_verification() {
        let h = [0xC3; 16];
        let (got, runs) = run(
            SharedShardBody { bytes: vec![1, 2, 3], verified_against: Some(h) },
            6,
        )
        .await;
        assert_eq!(runs, 1, "one underlying fetch");
        assert_eq!(got.len(), 6);
        for b in &got {
            assert_eq!(b.bytes, vec![1, 2, 3]);
            assert!(
                !needs_main_thread_verify(true, true, verified_for_task(Some(&h), b.verified_against.as_ref())),
                "a latched waiter skips the main-thread re-hash"
            );
        }
    }

    #[tokio::test]
    async fn a_mismatch_reaches_every_waiter_unverified() {
        let h = [0xC3; 16];
        let (got, runs) = run(SharedShardBody { bytes: vec![9], verified_against: None }, 4).await;
        assert_eq!(runs, 1);
        for b in &got {
            assert!(
                needs_main_thread_verify(true, true, verified_for_task(Some(&h), b.verified_against.as_ref())),
                "every waiter re-hashes (and so fails its own key)"
            );
        }
    }
}
