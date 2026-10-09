//! Shared HTTP fetch primitive used by both `HttpResourceSource`
//! (legacy single-HBA path) and `ManifestResourceSource` (Phase 5.0
//! manifest+shards path).

use std::cell::RefCell;

use js_sys::{ArrayBuffer, Function, Promise, Reflect, Uint8Array};
use wasm_bindgen::JsCast;
use wasm_bindgen::prelude::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::Response;

use crate::shard_route;

/// Failure modes for HTTP fetch + body read. Distinguishes the
/// surfaces a caller might want to display differently (network vs.
/// HTTP status vs. body read).
#[derive(Debug)]
pub enum HttpError {
    NoFetchGlobal,
    Network(String),
    Http { status: u16, status_text: String },
    Body(String),
}

impl std::fmt::Display for HttpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            HttpError::NoFetchGlobal => write!(f, "no fetch() in global scope"),
            HttpError::Network(s) => write!(f, "fetch network error: {s}"),
            HttpError::Http { status, status_text } => {
                write!(f, "fetch HTTP {status} {status_text}")
            }
            HttpError::Body(s) => write!(f, "fetch body read error: {s}"),
        }
    }
}

impl std::error::Error for HttpError {}

/// Fetch a URL and return the response body as a `Vec<u8>`.
///
/// Resolves `fetch` from the runtime's global across three
/// environments: browser tabs (`Window`), Web Workers
/// (`WorkerGlobalScope`), and Node 18+ (global `fetch` reached via
/// `Reflect::get`). The Node path is the one the smoke test under
/// `apps/holtburger-web/smoke_test.cjs` takes.
pub async fn fetch_bytes(url: &str) -> Result<Vec<u8>, HttpError> {
    fetch_bytes_with_priority(url, FetchPriority::Auto).await
}

/// Browser fetch-priority hint (the `priority` member of `RequestInit`
/// — https://fetch.spec.whatwg.org/#request-priority). Chromium maps
/// same-origin `fetch()` to HIGH network priority by default, so a
/// bulk speculative prefetch flood (ring bakers) FIFO-starves player-
/// blocking loads behind the 6-connection/origin HTTP/1.1 cap. `Low`
/// demotes the flood so urgent batches (current-LB interior records,
/// namespace catalogs) schedule first; browsers that don't implement
/// the member simply ignore it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FetchPriority {
    Auto,
    Low,
}

/// [`fetch_bytes`] with an explicit browser fetch-priority hint. The
/// hint is set via `Reflect::set` on the `RequestInit` object (plain
/// JS member — no unstable `web_sys` API needed); runtimes without
/// fetch-priority support ignore the extra member.
pub async fn fetch_bytes_with_priority(
    url: &str,
    priority: FetchPriority,
) -> Result<Vec<u8>, HttpError> {
    let init = web_sys::RequestInit::new();
    if priority == FetchPriority::Low {
        let _ = Reflect::set(
            init.as_ref(),
            &JsValue::from_str("priority"),
            &JsValue::from_str("low"),
        );
    }
    let global = js_sys::global();
    let fetch_promise = if let Ok(window) = global.clone().dyn_into::<web_sys::Window>() {
        window.fetch_with_str_and_init(url, &init)
    } else if let Ok(worker) = global.clone().dyn_into::<web_sys::WorkerGlobalScope>() {
        worker.fetch_with_str_and_init(url, &init)
    } else {
        let fetch_fn_value = Reflect::get(&global, &JsValue::from_str("fetch"))
            .map_err(|_| HttpError::NoFetchGlobal)?;
        let fetch_fn: Function = fetch_fn_value
            .dyn_into()
            .map_err(|_| HttpError::NoFetchGlobal)?;
        let promise_value = fetch_fn
            .call1(&JsValue::UNDEFINED, &JsValue::from_str(url))
            .map_err(|e| HttpError::Network(jsval_string(&e)))?;
        promise_value.dyn_into::<Promise>().map_err(|e| {
            HttpError::Network(format!(
                "fetch did not return a Promise: {}",
                jsval_string(&e)
            ))
        })?
    };

    let resp_value = JsFuture::from(fetch_promise)
        .await
        .map_err(|e| HttpError::Network(jsval_string(&e)))?;
    let resp: Response = resp_value
        .dyn_into()
        .map_err(|e| HttpError::Network(format!("not a Response: {}", jsval_string(&e))))?;

    if !resp.ok() {
        return Err(HttpError::Http {
            status: resp.status(),
            status_text: resp.status_text(),
        });
    }

    let buf_promise = resp
        .array_buffer()
        .map_err(|e| HttpError::Body(jsval_string(&e)))?;
    let buf_value = JsFuture::from(buf_promise)
        .await
        .map_err(|e| HttpError::Body(jsval_string(&e)))?;
    let array_buffer: ArrayBuffer = buf_value
        .dyn_into()
        .map_err(|e| HttpError::Body(format!("not an ArrayBuffer: {}", jsval_string(&e))))?;
    Ok(Uint8Array::new(&array_buffer).to_vec())
}

// ---------------------------------------------------------------------------
// Workstream B (`?shardFetchWorker`, 2026-10-09): a registered JS shard fetcher.
//
// `fetch_bytes_with_priority` costs two main-thread turns per record (the
// `fetch()` promise, then `array_buffer()`), and on the 1070 academy load the
// main thread is 90–97 % busy, so a body the network had finished waited a
// median 0.09–0.32 s / p90 0.35–0.56 s before wasm saw it — longer than the
// network itself took. When the page registers a fetcher
// (`register_shard_fetcher` in apps/holtburger-web/src/lib.rs; the page side is
// scene3d/shard_fetch_client.js → scene3d/shard_fetch_worker.js), Step D of
// `ManifestResourceSource::prefetch_impl` calls it instead: the worker fetches
// with the same priority hint, reads the body, sha256-verifies it against the
// catalog hash off the main thread, and hands bodies back in batches as
// transferred ArrayBuffers. Catalog / manifest / boot fetches never take this
// route. Unregistered (the default until the page registers, `?shardFetchWorker
// =off`, a stale page, the bake worker's instance) = exactly
// `fetch_bytes_with_priority`.
// ---------------------------------------------------------------------------

thread_local! {
    /// The page-registered shard fetcher, if any. Read (cloned) at call time,
    /// so an unregister mid-flight sends every LATER fetch direct while the
    /// ones already handed to the fetcher settle through it.
    static SHARD_FETCHER: RefCell<Option<Function>> = const { RefCell::new(None) };
}

/// Install (`Some`) or remove (`None`) the JS shard fetcher for this wasm
/// instance. See the section comment above for the call contract.
pub fn set_shard_fetcher(f: Option<Function>) {
    SHARD_FETCHER.with(|slot| *slot.borrow_mut() = f);
}

/// True while a JS shard fetcher is registered in this instance.
pub fn shard_fetcher_registered() -> bool {
    SHARD_FETCHER.with(|slot| slot.borrow().is_some())
}

/// A shard body plus whether the registered fetcher verified it against the
/// expected hash this request sent. `verified` is always `false` on the direct
/// path and whenever no hash was sent.
pub struct ShardBody {
    pub bytes: Vec<u8>,
    pub verified: bool,
}

/// Fetch one shard body: through the registered JS fetcher when there is one,
/// else exactly [`fetch_bytes_with_priority`].
///
/// Fetcher contract: `f(url, "low" | "auto", expectedShaHex | null)` returns a
/// Promise (a non-Promise return is wrapped with `Promise.resolve`) that
/// resolves to a `Uint8Array` / `ArrayBuffer` (unverified) or
/// `{ verified: true, bytes }`, and rejects with `{ status, statusText }`
/// (→ [`HttpError::Http`], so `tolerate_404` keeps working) or anything else
/// (→ [`HttpError::Network`]). A synchronous throw is a `Network` error too.
/// `expected_sha_hex` is the catalog's truncated sha256 (32 lowercase hex);
/// `None` asks for no verification.
pub async fn fetch_shard_bytes(
    url: &str,
    priority: FetchPriority,
    expected_sha_hex: Option<&str>,
) -> Result<ShardBody, HttpError> {
    // Clone the handle out of the slot BEFORE calling into JS, so a fetcher
    // that (un)registers re-entrantly can never hit a RefCell borrow panic.
    let fetcher: Option<Function> = SHARD_FETCHER.with(|slot| slot.borrow().clone());
    let fetcher = match fetcher {
        Some(f) => f,
        None => {
            let bytes = fetch_bytes_with_priority(url, priority).await?;
            return Ok(ShardBody {
                bytes,
                verified: false,
            });
        }
    };
    let prio = shard_route::priority_hint(priority == FetchPriority::Low);
    let sha_arg = match expected_sha_hex {
        Some(h) => JsValue::from_str(h),
        None => JsValue::NULL,
    };
    let returned = fetcher
        .call3(
            &JsValue::UNDEFINED,
            &JsValue::from_str(url),
            &JsValue::from_str(prio),
            &sha_arg,
        )
        .map_err(|e| HttpError::Network(format!("shard fetcher threw: {}", js_error_text(&e))))?;
    let promise: Promise = match returned.dyn_into::<Promise>() {
        Ok(p) => p,
        Err(v) => Promise::resolve(&v),
    };
    let value = JsFuture::from(promise)
        .await
        .map_err(|e| shard_fetcher_rejection(&e))?;
    shard_body_from_js(&value, expected_sha_hex.is_some())
}

/// Map a fetcher rejection: `{ status, statusText }` with a real HTTP status →
/// [`HttpError::Http`]; anything else (an `Error`, a string, `status: 0`) →
/// [`HttpError::Network`].
fn shard_fetcher_rejection(e: &JsValue) -> HttpError {
    if e.is_object() {
        let status = Reflect::get(e, &JsValue::from_str("status"))
            .ok()
            .and_then(|v| v.as_f64())
            .and_then(shard_route::http_status_from_js_number);
        if let Some(status) = status {
            let status_text = Reflect::get(e, &JsValue::from_str("statusText"))
                .ok()
                .and_then(|v| v.as_string())
                .unwrap_or_default();
            return HttpError::Http {
                status,
                status_text,
            };
        }
    }
    HttpError::Network(js_error_text(e))
}

/// A resolved fetcher value → body bytes + the verified flag (only honoured
/// when this request sent an expected hash).
fn shard_body_from_js(value: &JsValue, sha_requested: bool) -> Result<ShardBody, HttpError> {
    if let Some(bytes) = js_bytes(value) {
        return Ok(ShardBody {
            bytes,
            verified: false,
        });
    }
    if value.is_object() {
        let inner = Reflect::get(value, &JsValue::from_str("bytes"))
            .map_err(|e| HttpError::Body(js_error_text(&e)))?;
        if let Some(bytes) = js_bytes(&inner) {
            let claimed = Reflect::get(value, &JsValue::from_str("verified"))
                .ok()
                .and_then(|v| v.as_bool());
            return Ok(ShardBody {
                bytes,
                verified: shard_route::accept_verified_claim(sha_requested, claimed),
            });
        }
    }
    Err(HttpError::Body(format!(
        "shard fetcher resolved without bytes: {}",
        jsval_string(value)
    )))
}

/// Copy a `Uint8Array` / `ArrayBuffer` into wasm memory; `None` for anything
/// else.
fn js_bytes(v: &JsValue) -> Option<Vec<u8>> {
    if let Some(view) = v.dyn_ref::<Uint8Array>() {
        return Some(view.to_vec());
    }
    if let Some(buf) = v.dyn_ref::<ArrayBuffer>() {
        return Some(Uint8Array::new(buf).to_vec());
    }
    None
}

/// Best message for a JS error value: a string as-is, an object's string
/// `message` (an `Error` JSON-stringifies to `{}`), else [`jsval_string`].
fn js_error_text(v: &JsValue) -> String {
    if let Some(s) = v.as_string() {
        return s;
    }
    if v.is_object()
        && let Ok(m) = Reflect::get(v, &JsValue::from_str("message"))
        && let Some(s) = m.as_string()
    {
        return s;
    }
    jsval_string(v)
}

pub fn jsval_string(v: &JsValue) -> String {
    v.as_string()
        .or_else(|| js_sys::JSON::stringify(v).ok().and_then(|s| s.as_string()))
        .unwrap_or_else(|| format!("{v:?}"))
}

/// Resolve a relative URL against a base. Mirrors browser URL
/// resolution rules well enough for the manifest+shard case:
///
/// - Absolute (`http://...`, `/...`): returned as-is.
/// - Relative: appended to the base's directory portion (everything
///   before the last `/`).
pub fn join_url(base_url: &str, relative: &str) -> String {
    if relative.starts_with("http://")
        || relative.starts_with("https://")
        || relative.starts_with('/')
    {
        return relative.to_owned();
    }
    let dir = base_url.rsplit_once('/').map(|(d, _)| d).unwrap_or("");
    if dir.is_empty() {
        relative.to_owned()
    } else {
        format!("{dir}/{relative}")
    }
}
